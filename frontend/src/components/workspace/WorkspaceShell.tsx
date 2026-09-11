'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import { ImageGenerationWorkbench } from '@/components/ImageGenerationWorkbench';
import { VideoGenerationWorkspace } from '@/components/VideoGenerationWorkspace';
import { ReversePromptForm } from '@/components/ReversePromptForm';
import { GifGenerationWorkspace } from '@/components/GifGenerationWorkspace';
import { AgentChatWorkspace } from '@/components/agent/AgentChatWorkspace';
import { AssetsWorkspace } from '@/components/assets/AssetsWorkspace';
import { CanvasWorkspace } from '@/components/canvas/CanvasWorkspace';
import { PromptGallery } from '@/components/PromptGallery';
import { SettingsModal } from '@/components/SettingsModal';
import { MissingApiKeyDialog } from '@/components/MissingApiKeyDialog';
import { useQueueStatus } from '@/hooks/useQueueStatus';
import { useServerTaskPolling } from '@/hooks/useServerTaskPolling';
import { useWorkspaceJobs } from '@/hooks/useWorkspaceJobs';
import { useNavigationSidebar } from '@/hooks/useNavigationSidebar';
import { WorkspaceHeader, type WorkspaceHeaderRef } from '@/components/workspace/WorkspaceHeader';
import { WorkspaceModeTabs } from '@/components/workspace/WorkspaceModeTabs';
import { HistoryJobList, type GenerationHistoryFilter, type HistoryClearScope } from '@/components/workspace/results/HistoryJobList';
import { PromptGalleryAccessDialog, usePromptGalleryAccess } from '@/components/workspace/PromptGalleryAccess';
import { usePromptGalleryConfig } from '@/hooks/usePromptGalleryConfig';
import { ConfirmDialog } from '@/components/workspace/dialogs/ConfirmDialog';
import { Toast, type ToastData } from '@/components/workspace/Toast';
import { useI18n } from '@/components/LanguageProvider';
import { getFlyreqTask } from '@/lib/flyreq-task-client';
import { finalizeCompletedServerTask, getTaskSseMetadata } from '@/lib/workspace-task-service';
import { classifyTaskFailure } from '@/lib/task-failure';
import { compareStoredJobsByDisplayOrder, type RefImageData, type StoredJob } from '@/lib/job-store';
import { subscribeImageActionToasts, subscribeUseAsImageReference } from '@/lib/image-actions';
import {
  submitImageToImage,
  submitTextToImage,
  type SubmitActions,
} from '@/lib/workspace-task-service';
import { cn } from '@/lib/utils';
import { getCleanUrlAfterExternalModelConfig, parseExternalModelConfig, type ExternalModelConfig } from '@/lib/external-model-config';

export function WorkspaceShell() {
  const { locale, t } = useI18n();
  const queueStatus = useQueueStatus();
  // 统一采用全铺满工作台布局，桌面双栏与移动单栏由 CSS 响应式断点控制。
  const wideMode = true;
  const { collapsed: navigationCollapsed, toggleCollapsed: toggleNavigationCollapsed } = useNavigationSidebar();
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [externalModelConfig, setExternalModelConfig] = useState<ExternalModelConfig | null>(null);
  const [missingApiKeyDialogOpen, setMissingApiKeyDialogOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'image-generation' | 'video-generation' | 'agent' | 'canvas' | 'assets' | 'reverse-prompt' | 'gif' | 'prompt-gallery'>('image-generation');
  const [generationHistoryFilter, setGenerationHistoryFilter] = useState<GenerationHistoryFilter>('all');
  const [generationClearScope, setGenerationClearScope] = useState<HistoryClearScope | null>(null);
  const [referenceDraft, setReferenceDraft] = useState<{ id: number; refImages: RefImageData[]; prompt?: string } | null>(null);
  const workspace = useWorkspaceJobs();
  const galleryConfig = usePromptGalleryConfig();
  const promptGallery = usePromptGalleryAccess(galleryConfig.mode, galleryConfig.passwordEnabled, setError, () => setActiveTab('prompt-gallery'), locale);


  // Toast state
  const [toasts, setToasts] = useState<ToastData[]>([]);
  const toastIdRef = useRef(0);
  const headerRef = useRef<WorkspaceHeaderRef>(null);
  const referenceDraftIdRef = useRef(0);
  const externalConfigParsedRef = useRef(false);

  const showToast = useCallback((message: string, type: ToastData['type']) => {
    const id = `toast-${++toastIdRef.current}`;
    setToasts(prev => [...prev, { id, message, type }]);
  }, []);
  const dismissToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  useEffect(() => subscribeImageActionToasts(detail => showToast(detail.message, detail.type)), [showToast]);

  useEffect(() => {
    if (externalConfigParsedRef.current) return;

    const url = new URL(window.location.href);
    const config = parseExternalModelConfig(url);
    if (!config) return;

    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      externalConfigParsedRef.current = true;
      setExternalModelConfig(config);
      setSettingsOpen(true);
      window.history.replaceState(null, '', getCleanUrlAfterExternalModelConfig(url));
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => subscribeUseAsImageReference(detail => {
    workspace.setRetryData(null);
    setReferenceDraft({ id: ++referenceDraftIdRef.current, refImages: detail.refImages, prompt: detail.prompt });
    setActiveTab('image-generation');
  }), [workspace]);

  const handleImageDraftConsumed = useCallback(() => {
    workspace.setRetryData(null);
    setReferenceDraft(null);
  }, [workspace]);

  // Checking debounce state
  const [checkingJobIds, setCheckingJobIds] = useState<Set<string>>(new Set());
  // Cooldown state: jobId -> cooldown end timestamp
  const [cooldowns, setCooldowns] = useState<Map<string, number>>(new Map());

  const submitActions = useMemo<SubmitActions>(() => ({
    addJob: workspace.addJob,
    replaceJob: workspace.replaceJob,
    completeJob: workspace.completeJob,
    failJob: workspace.failJob,
    getJob: workspace.getJob,
  }), [workspace.addJob, workspace.completeJob, workspace.failJob, workspace.replaceJob, workspace.getJob]);

  useServerTaskPolling(workspace.jobs, submitActions, workspace.hasJob);

  const handleSubmitError = useCallback((message: string) => {
    if (message === '请先配置 API 密钥' || message === 'Please configure an API key first') {
      setError(null);
      setMissingApiKeyDialogOpen(true);
      return;
    }
    showToast(message, 'error');
  }, [showToast]);

  const handleCheckStatus = useCallback(async (job: StoredJob) => {
    if (!job.serverTaskId || checkingJobIds.has(job.id) || cooldowns.has(job.id)) return;
    setCheckingJobIds(prev => new Set(prev).add(job.id));
    // Set 5s cooldown
    setCooldowns(prev => new Map(prev).set(job.id, Date.now() + 5000));
    try {
      const task = await getFlyreqTask(job.serverTaskId);
      if (task.status === 'completed') {
        showToast(locale === 'zh' ? '生成完成，正在下载图片…' : 'Generation complete. Downloading images...', 'success');
        await finalizeCompletedServerTask(job, task, submitActions);
      } else if (task.status === 'failed' || task.status === 'expired') {
        const { terminal } = classifyTaskFailure(task);
        const message = task.error || task.warning
          || (task.status === 'expired' ? (locale === 'zh' ? '该任务已超出取回时间' : 'This task has expired') : t('history.failed'));
        void submitActions.failJob(job.id, message, { terminal, completedAt: task.completedAt, ...getTaskSseMetadata(task) });
        showToast(locale === 'zh' ? `任务失败：${message}` : `Task failed: ${message}`, 'error');
      } else if (task.status === 'processing') {
        submitActions.replaceJob(job.id, cur => ({
          ...cur,
          ...getTaskSseMetadata(task),
          status: 'processing',
          created_at: task.createdAt || cur.created_at,
        }));
        showToast(locale === 'zh' ? '任务正在生成中，请稍候…' : 'The task is still generating. Please wait...', 'info');
      } else if (task.status === 'queued' || task.status === '排队中') {
        submitActions.replaceJob(job.id, cur => ({ ...cur, status: '排队中', created_at: task.createdAt || cur.created_at }));
        showToast(locale === 'zh' ? '任务排队中，请耐心等待…' : 'The task is queued. Please wait...', 'info');
      }
    } catch {
      showToast(locale === 'zh' ? '查询失败，请稍后重试' : 'Status check failed. Please try again later.', 'error');
    } finally {
      setCheckingJobIds(prev => { const next = new Set(prev); next.delete(job.id); return next; });
      // Cleanup cooldown after 5s
      setTimeout(() => {
        setCooldowns(prev => {
          const next = new Map(prev);
          next.delete(job.id);
          return next;
        });
      }, 5000);
    }
  }, [checkingJobIds, cooldowns, locale, submitActions, showToast, t]);

  const generationInitialData = useMemo(() => (
    workspace.retryData
      ? {
        prompt: workspace.retryData.prompt,
        outputSize: workspace.retryData.outputSize,
        customSize: workspace.retryData.customSize,
        aspectRatio: workspace.retryData.aspectRatio,
        temperature: workspace.retryData.temperature,
        model: workspace.retryData.model,
        modelId: workspace.retryData.remoteModelId,
        gptImageQuality: workspace.retryData.gptImageQuality,
        gptImageStyle: workspace.retryData.gptImageStyle,
        gptImageBackground: workspace.retryData.gptImageBackground,
        gptImageOutputFormat: workspace.retryData.gptImageOutputFormat,
        parallelCount: workspace.retryData.parallelCount,
        promptVariants: workspace.retryData.promptVariants,
        refImages: workspace.retryData.refImages,
      }
      : undefined
  ), [workspace.retryData]);

  const generationJobs = useMemo(
    () => [...workspace.textJobs, ...workspace.imageJobs].sort(compareStoredJobsByDisplayOrder),
    [workspace.imageJobs, workspace.textJobs]
  );
  const filteredGenerationJobs = useMemo(
    () => generationHistoryFilter === 'all'
      ? generationJobs
      : generationJobs.filter(job => job.mode === generationHistoryFilter),
    [generationHistoryFilter, generationJobs]
  );
  const generationEmptyDescription = generationHistoryFilter === 'text-to-image'
    ? t('history.emptyTextToImage')
    : generationHistoryFilter === 'image-to-image'
      ? t('history.emptyImageToImage')
      : t('history.emptyGenerationAll');
  const clearScopeLabel = generationClearScope === 'all'
    ? `${t('history.filterTextToImage')} / ${t('history.filterImageToImage')}`
    : generationClearScope === 'text-to-image'
      ? t('history.filterTextToImage')
      : generationClearScope === 'image-to-image'
        ? t('history.filterImageToImage')
        : locale === 'zh' ? '当前模式' : 'current mode';

  const handleConfirmClearGeneration = useCallback(() => {
    if (!generationClearScope) return;
    const scope = generationClearScope;
    setGenerationClearScope(null);
    if (scope === 'all') {
      void Promise.all([
        workspace.clearJobsByMode('text-to-image'),
        workspace.clearJobsByMode('image-to-image'),
      ]);
      return;
    }
    if (scope === 'text-to-image' || scope === 'image-to-image') {
      void workspace.clearJobsByMode(scope);
    }
  }, [generationClearScope, workspace]);

  useEffect(() => {
    // 运行时配置加载完成后再移除根布局启动遮罩，确保整个启动阶段只显示一个加载状态。
    if (galleryConfig.ready) {
      document.getElementById('app-boot-loader')?.remove();
    }
  }, [galleryConfig.ready]);

  if (!galleryConfig.ready) {
    // 启动遮罩由根布局统一负责；这里不再渲染第二个加载动画，避免重复显示。
    return null;
  }

  return (
    <div className="flex h-dvh min-h-0 w-full overflow-hidden bg-background">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className={cn(
          'flex min-h-0 flex-1 flex-col gap-4 p-3 sm:p-4 lg:p-6'
        )}>
          <WorkspaceHeader
            ref={headerRef}
            queueStatus={queueStatus}
            onOpenSettings={() => setSettingsOpen(true)}
            onLogoClick={promptGallery.handlePromptGalleryEntry}
            onOpenNavigation={() => setMobileNavigationOpen(true)}
            sidebarMode
          />

          <Tabs
            value={activeTab}
            onValueChange={value => setActiveTab(value as typeof activeTab)}
            orientation="vertical"
            className="relative min-h-0 flex-1 gap-3 lg:flex-row"
          >
            <WorkspaceModeTabs
              activeTab={activeTab}
              collapsed={navigationCollapsed}
              mobileOpen={mobileNavigationOpen}
              queueStatus={queueStatus}
              showPromptGalleryEntry={galleryConfig.mode !== '3'}
              onMobileOpenChange={setMobileNavigationOpen}
              onToggleCollapsed={toggleNavigationCollapsed}
              onOpenSettings={() => setSettingsOpen(true)}
              onOpenPromptGallery={promptGallery.handlePromptGalleryEntry}
              onOpenRandomImage={(url, title) => headerRef.current?.openRandomImage(url, title)}
            />

            <div className={cn(
              // 主内容在移动端和中等 PC 宽度下承担页面滚动，大屏工作区再切换到内部滚动。
              'flex min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto lg:min-h-0',
              !wideMode && (activeTab === 'agent' ? 'lg:overflow-hidden' : 'lg:overflow-x-hidden lg:overflow-y-auto'),
              wideMode && 'xl:flex xl:flex-1 xl:min-h-0 xl:min-w-0',
              wideMode && (activeTab === 'image-generation' || activeTab === 'video-generation' || activeTab === 'agent'
                ? 'xl:overflow-hidden'
                : 'xl:overflow-y-auto xl:overflow-x-hidden')
            )}>
              <TabsContent value="image-generation" keepMounted className={cn(wideMode ? 'space-y-6 xl:flex xl:min-h-0 xl:space-y-0' : 'space-y-3')}>
                <div className={cn(wideMode ? 'grid items-start gap-5 xl:h-full xl:min-h-0 xl:flex-1 xl:grid-cols-[minmax(460px,0.95fr)_minmax(0,1.35fr)] xl:items-stretch' : 'space-y-3')}>
                  <div className={cn(wideMode && 'xl:h-full xl:min-h-0 xl:overflow-y-auto xl:pr-1')}>
                    <ImageGenerationWorkbench
                      wideMode={wideMode}
                      onSubmitText={data => void submitTextToImage(data, submitActions, handleSubmitError)}
                      onSubmitImage={data => void submitImageToImage(data, submitActions, handleSubmitError)}
                      disabled={!workspace.hasApiKey}
                      onConfigureApiKey={() => setSettingsOpen(true)}
                      onDraftConsumed={handleImageDraftConsumed}
                      initialData={generationInitialData}
                      referenceDraft={referenceDraft}
                    />
                  </div>
                  <HistoryJobList
                    wideMode={wideMode}
                    singleColumn
                    largeThumbnail
                    active={activeTab === 'image-generation'}
                    title={t('history.generationTitle')}
                    mode="text-to-image"
                    historyFilter={generationHistoryFilter}
                    onHistoryFilterChange={setGenerationHistoryFilter}
                    hasAnyJobs={generationJobs.length > 0}
                    emptyDescription={generationEmptyDescription}
                    jobs={filteredGenerationJobs}
                    loadedImages={workspace.loadedImages}
                    checkingJobIds={checkingJobIds}
                    cooldowns={cooldowns}
                    onRetry={job => {
                      workspace.retryJob(job);
                      setActiveTab('image-generation');
                    }}
                    onRetryDownload={workspace.retryDownload}
                    onClear={jobId => void workspace.removeJob(jobId)}
                    onClearAll={scope => setGenerationClearScope(scope)}
                    onCancel={jobId => workspace.setCancelJobId(jobId)}
                    onCheckStatus={handleCheckStatus}
                  />
                </div>
              </TabsContent>

              <TabsContent value="video-generation" keepMounted className={cn(wideMode ? 'xl:flex xl:min-h-0 xl:min-w-0 xl:flex-1' : 'space-y-3')}>
                <VideoGenerationWorkspace
                  wideMode={wideMode}
                  onConfigureApiKey={() => setSettingsOpen(true)}
                  showToast={showToast}
                />
              </TabsContent>

              <TabsContent
                value="agent"
                keepMounted
                className={cn('flex-1 flex flex-col min-h-0', wideMode && 'xl:flex xl:min-h-0 xl:flex-1 xl:flex-col')}
              >
                <AgentChatWorkspace
                  wideMode={wideMode}
                  disabled={false}
                  onConfigureApiKey={() => setSettingsOpen(true)}
                />
              </TabsContent>

              <TabsContent value="canvas" keepMounted className={cn('min-h-0', wideMode ? 'xl:flex xl:min-h-0 xl:flex-1 xl:flex-col' : 'space-y-6')}>
                <CanvasWorkspace
                  onConfigureApiKey={() => setSettingsOpen(true)}
                  showToast={showToast}
                  showPromptGallery={promptGallery.showPromptGallery}
                />
              </TabsContent>

              <TabsContent value="assets" keepMounted className={cn(wideMode ? 'space-y-6 xl:min-h-0 xl:min-w-0 xl:flex xl:flex-col' : 'space-y-6')}>
                <AssetsWorkspace wideMode={wideMode} active={activeTab === 'assets'} />
              </TabsContent>

              <TabsContent value="reverse-prompt" keepMounted className={cn(wideMode ? 'space-y-6 xl:min-h-0 xl:flex xl:flex-col' : 'space-y-6')}>
                <ReversePromptForm
                  wideMode={wideMode}
                  disabled={false}
                  onConfigureApiKey={() => setSettingsOpen(true)}
                />
              </TabsContent>

              <TabsContent value="gif" keepMounted className={cn(wideMode ? 'space-y-6 xl:min-h-0 xl:flex xl:flex-col' : 'space-y-6')}>
                <GifGenerationWorkspace
                  wideMode={wideMode}
                  hasApiKey={workspace.hasApiKey}
                  onConfigureApiKey={() => setSettingsOpen(true)}
                  onError={message => showToast(message, 'error')}
                  showToast={showToast}
                />
              </TabsContent>

              {promptGallery.showPromptGallery && (
                <TabsContent value="prompt-gallery" keepMounted>
                  <div className={cn('bg-transparent p-0 shadow-none sm:rounded-2xl sm:bg-card sm:p-4 sm:shadow-sm sm:border sm:border-border', wideMode && 'sm:p-5')}>
                    <PromptGallery wideMode={wideMode} />
                  </div>
                </TabsContent>
              )}
            </div>
          </Tabs>
        </div>
      </div>

      <SettingsModal
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onApiKeyChange={workspace.setHasApiKey}
        externalModelConfig={externalModelConfig}
        onExternalModelConfigConsumed={() => setExternalModelConfig(null)}
      />

      <MissingApiKeyDialog
        open={missingApiKeyDialogOpen}
        onOpenChange={setMissingApiKeyDialogOpen}
        onConfigure={() => setSettingsOpen(true)}
      />

      <PromptGalleryAccessDialog
        open={promptGallery.passwordDialogOpen}
        passwordInput={promptGallery.passwordInput}
        onPasswordChange={promptGallery.setPasswordInput}
        onClose={() => promptGallery.setPasswordDialogOpen(false)}
        onSubmit={() => void promptGallery.handlePasswordSubmit()}
        locale={locale}
      />

      {workspace.cancelJobId && createPortal(
        <ConfirmDialog
          title={locale === 'zh' ? '取消生成任务' : 'Cancel generation task'}
          message={
            <>
              {locale === 'zh' ? '取消后会删除本地任务记录并停止前端等待流程。' : 'Cancelling will delete the local task record and stop the frontend waiting flow.'}
              <span className="mt-1 block text-warning">
                {locale === 'zh' ? '如果任务已进入服务端队列，可能仍会继续执行。' : 'If the task already entered the server queue, it may still continue running.'}
              </span>
            </>
          }
          confirmText={locale === 'zh' ? '取消并删除' : 'Cancel and delete'}
          onConfirm={() => {
            const jobId = workspace.cancelJobId;
            workspace.setCancelJobId(null);
            if (jobId) {
              void workspace.removeJob(jobId);
            }
          }}
          onCancel={() => workspace.setCancelJobId(null)}
        />,
        document.body
      )}

      {generationClearScope && createPortal(
        <ConfirmDialog
          title={locale === 'zh' ? '清空记录' : 'Clear records'}
          message={locale === 'zh' ? `确定要清空${clearScopeLabel}历史记录吗？此操作无法撤销。` : `Clear ${clearScopeLabel} history records? This cannot be undone.`}
          confirmText={locale === 'zh' ? '清空' : 'Clear'}
          onConfirm={handleConfirmClearGeneration}
          onCancel={() => setGenerationClearScope(null)}
        />,
        document.body
      )}

      {error && createPortal(
        <div className="fixed bottom-4 right-4 z-[10000] max-w-sm rounded-xl border border-destructive/20 bg-card px-4 py-3 text-sm text-destructive shadow-lg">
          {error}
        </div>,
        document.body
      )}

      {toasts.map(toast => (
        <Toast key={toast.id} toast={toast} onDismiss={dismissToast} />
      ))}
    </div>
  );
}
