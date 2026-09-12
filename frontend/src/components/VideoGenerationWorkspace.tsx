'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowUp, Check, ChevronDown, CircleStop, Clock3, CloudUpload, Copy, Download, FileAudio, FileImage, FileVideo, FolderPlus, Images, Info, Loader2, Maximize, RefreshCw, ScanLine, SlidersHorizontal, Sparkles, Trash2, Video, X } from 'lucide-react';
import { useI18n } from '@/components/LanguageProvider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import { Select } from '@/components/ui/select';
import { AgentAssetPickerDialog, UnifiedAssetPickerDialog } from '@/components/agent/AgentAssetPickerDialog';
import { AttachmentChips } from '@/components/AttachmentChips';
import { PromptOptimizeDialog } from '@/components/PromptOptimizeDialog';
import { PromptSubmissionShortcutMenu } from '@/components/PromptSubmissionShortcutMenu';
import { usePromptOptimizeSetting } from '@/hooks/usePromptOptimizeSetting';
import { getEffectivePromptSubmissionShortcutLabels, usePromptSubmissionShortcut } from '@/hooks/usePromptSubmissionShortcut';
import { getCompleteVideoModels, getDefaultVideoModel, getResolvedVideoModelId, loadRegistry, updateRegistryDefaults, type VideoModelConfig } from '@/lib/flyreq-models';
import { acknowledgeVideoTask, cancelVideoTask, createVideoTask, createVideoTasks, getVideoTask } from '@/lib/video-task-client';
import {
  cacheVideoBlob,
  cacheVideoReferenceFiles,
  deleteVideoBlob,
  deleteVideoReferenceFiles,
  fetchVideoBlob,
  loadVideoJobs,
  restoreVideoBlobUrl,
  restoreVideoReferenceFiles,
  saveVideoJobs,
  storeVideoBlob,
  type StoredVideoJob,
  type VideoReferenceFiles,
} from '@/lib/video-job-store';
import { getVideoProtocolDurations, getVideoResolutionLabel, getVideoWorkspaceConfig, isAllowedVideoReferenceMimeType, isValidVideoDuration, isValidVideoProtocolDuration, isValidVideoResolution, isValidVideoSize, resolveVideoProtocolProfile } from '@/lib/video-config';
import { generateModelId } from '@/lib/flyreq-models';
import { requireDefaultConfiguredTextModel } from '@/lib/model-endpoints';
import { streamPromptOptimize, type StreamPromptOptimizeHandle } from '@/lib/prompt-optimize-client';
import { addMediaAsset, getAssetBlob, type AssetItem, type ImageAsset, type MediaAsset } from '@/lib/asset-store';
import { cn } from '@/lib/utils';
import { normalizePastedFileName } from '@/lib/pasted-file-naming';
import { MAX_PARALLEL_COUNT, PARALLEL_COUNT_OPTIONS, type ParallelCount } from '@/lib/model-capabilities';
import { composeEffectiveVideoPrompt } from '@/lib/video-prompt-variants';
import { getModelCatalogCache, MODEL_CATALOG_CACHE_UPDATED_EVENT, saveModelCatalogCache } from '@/lib/model-catalog-cache';
import { fetchRemoteModels } from '@/lib/flyreq-task-client';

interface VideoGenerationWorkspaceProps {
  wideMode?: boolean;
  onConfigureApiKey: () => void;
  showToast: (message: string, type: 'success' | 'error' | 'info') => void;
}

interface MediaAttachmentTileProps {
  file: File;
  onRemove: () => void;
}

interface VideoReferenceImageChipsProps {
  files: File[];
  onRemove: (id: string) => void;
  prompt: string;
}

interface VideoSizePreviewProps {
  size: string;
  selected: boolean;
}

const VIDEO_ASPECT_RATIO_OPTIONS = ['1:1', '3:4', '4:3', '3:2', '2:3', '9:16', '16:9', '21:9'] as const;

type VideoPlaybackState = 'loading' | 'ready' | 'error' | 'repairing';

/**
 * 获取视频任务可以重新请求的服务端地址，并兼容旧版本地任务记录。
 * @param job 视频任务记录。
 * @returns 服务端视频地址；任务没有服务端标识时返回空值。
 */
function getVideoJobSourceUrl(job: StoredVideoJob): string | undefined {
  if (job.videoSourceUrl?.trim()) return job.videoSourceUrl;
  if (job.serverTaskId?.trim()) return `/api/flyreq/videos/${encodeURIComponent(job.serverTaskId)}`;
  return undefined;
}

/**
 * 为视频重新加载地址追加一次性查询参数，绕过浏览器对失败响应的缓存。
 * @param url 原始视频地址。
 * @returns 带重试标识的视频地址；对象 URL 保持不变。
 */
function appendVideoRetryToken(url: string): string {
  if (url.startsWith('blob:')) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}video_retry=${Date.now()}`;
}

/**
 * 将视频尺寸换算为固定预览区域内的像素尺寸。
 * @param size 视频尺寸，格式为“宽x高”或“auto”。
 * @returns 不超过 48×36 像素的画幅预览框宽高。
 */
function getVideoSizePreviewDimensions(size: string): { width: number; height: number } {
  if (size === 'auto') return { width: 38, height: 28 };
  const match = size.match(/^(\d+)x(\d+)$/i);
  if (!match) return { width: 32, height: 32 };
  const widthRatio = Number(match[1]);
  const heightRatio = Number(match[2]);
  const scale = Math.min(48 / widthRatio, 36 / heightRatio);
  return {
    width: Math.max(6, widthRatio * scale),
    height: Math.max(6, heightRatio * scale),
  };
}

/**
 * 计算宽高比卡片中的预览框尺寸，保持不同画幅在同一网格中可比较。
 * @param ratio 视频宽高比字符串。
 * @returns 不超过 48×36 像素的预览框宽高。
 */
function getVideoAspectRatioPreviewDimensions(ratio: string): { width: number; height: number } {
  const match = ratio.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (!match) return { width: 32, height: 32 };
  const widthRatio = Number(match[1]);
  const heightRatio = Number(match[2]);
  const scale = Math.min(48 / widthRatio, 36 / heightRatio);
  return {
    width: Math.max(6, widthRatio * scale),
    height: Math.max(6, heightRatio * scale),
  };
}

/**
 * 根据比例和清晰度计算视频尺寸，清晰度代表较短边像素数，并将最长边限制在 4096 内。
 * @param ratio 视频宽高比。
 * @param resolution 当前清晰度数值。
 * @returns 可提交的视频尺寸字符串。
 */
function getVideoDimensionsForAspectRatio(ratio: string, resolution: number): string {
  const match = ratio.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (!match || !Number.isInteger(resolution) || resolution <= 0) return '';
  const ratioWidth = Number(match[1]);
  const ratioHeight = Number(match[2]);
  const shortRatio = Math.min(ratioWidth, ratioHeight);
  const longRatio = Math.max(ratioWidth, ratioHeight);
  const maxShortEdge = Math.floor((4096 * shortRatio) / longRatio);
  const shortEdge = Math.max(64, Math.min(resolution, maxShortEdge));
  const roundEven = (value: number) => Math.max(64, Math.round(value / 2) * 2);
  const longEdge = roundEven(shortEdge * longRatio / shortRatio);
  const normalizedShortEdge = ratioWidth >= ratioHeight ? roundEven(longEdge * ratioHeight / ratioWidth) : roundEven(longEdge * ratioWidth / ratioHeight);
  return ratioWidth >= ratioHeight
    ? `${longEdge}x${normalizedShortEdge}`
    : `${normalizedShortEdge}x${longEdge}`;
}

/**
 * 判断协议比例列表是否包含工作台约定的常见比例。
 * @param ratio 待判断的比例字符串。
 * @returns 是否属于工作台常见比例集合。
 */
function isCommonVideoAspectRatio(ratio: string): ratio is typeof VIDEO_ASPECT_RATIO_OPTIONS[number] {
  return (VIDEO_ASPECT_RATIO_OPTIONS as readonly string[]).includes(ratio);
}

/**
 * 将具体视频尺寸约分为可展示的宽高比。
 * @param size 视频尺寸，格式为“宽x高”。
 * @returns 约分后的“宽:高”比例；尺寸无效或为自动时返回空字符串。
 */
function getVideoSizeAspectRatio(size: string): string {
  const match = size.match(/^(\d+)x(\d+)$/i);
  if (!match) return '';
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return '';
  let left = width;
  let right = height;
  while (right !== 0) {
    const remainder = left % right;
    left = right;
    right = remainder;
  }
  return `${width / left}:${height / left}`;
}

/**
 * 从视频尺寸字符串中提取宽度和高度，供尺寸卡片同步自定义输入框使用。
 * @param size 视频尺寸，格式为“宽x高”。
 * @returns 可直接写入输入框的宽高字符串；无法解析时返回空字符串。
 */
function getVideoSizeDimensions(size: string): { width: string; height: string } {
  const match = size.match(/^(\d+)x(\d+)$/i);
  return match ? { width: match[1], height: match[2] } : { width: '', height: '' };
}

/**
 * 判断参考图单边尺寸是否可直接作为视频输出尺寸。
 * @param value 参考图原始宽度或高度。
 * @returns 64 至 4096 范围内返回原值，否则返回 0。
 */
function normalizeReferenceImageDimension(value: number): number {
  return Number.isInteger(value) && value >= 64 && value <= 4096 ? value : 0;
}

/**
 * 读取参考图尺寸并转换为可直接提交的视频尺寸字符串。
 * @param file 首张参考图片文件。
 * @returns 规范化后的“宽x高”；无法读取图片时返回空字符串。
 */
async function readReferenceImageVideoSize(file: File): Promise<string> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file);
      const width = normalizeReferenceImageDimension(bitmap.width);
      const height = normalizeReferenceImageDimension(bitmap.height);
      const size = width && height ? `${width}x${height}` : '';
      bitmap.close();
      return size;
    } catch {
      return '';
    }
  }
  return new Promise(resolve => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      const width = normalizeReferenceImageDimension(image.naturalWidth);
      const height = normalizeReferenceImageDimension(image.naturalHeight);
      resolve(width && height ? `${width}x${height}` : '');
      URL.revokeObjectURL(url);
    };
    image.onerror = () => {
      resolve('');
      URL.revokeObjectURL(url);
    };
    image.src = url;
  });
}

/**
 * 渲染能够直观看出视频输出方向的画幅预览框。
 * @param props 当前视频尺寸和选中状态。
 * @returns 固定区域内按真实宽高比缩放的轮廓框。
 */
function VideoSizePreview({ size, selected }: VideoSizePreviewProps) {
  const dimensions = getVideoSizePreviewDimensions(size);
  return (
    <div className="flex h-10 w-full items-center justify-center" aria-hidden="true">
      <span
        data-testid={`video-size-preview-${size.replace(/[^0-9a-z]+/gi, '-')}`}
        className={cn(
          'flex items-center justify-center rounded-[3px] border-2 transition-colors',
          selected ? 'border-primary bg-primary/10' : 'border-muted-foreground/70 bg-background',
          size === 'auto' && 'border-dashed',
        )}
        style={{ width: dimensions.width, height: dimensions.height }}
      >
        {size === 'auto' && <Sparkles className="size-3 text-muted-foreground" />}
      </span>
    </div>
  );
}

/**
 * 渲染比例卡片中的画幅预览框。
 * @param props 比例和选中状态。
 * @returns 固定区域内按比例缩放的轮廓框。
 */
function VideoAspectRatioPreview({ ratio, selected }: { ratio: string; selected: boolean }) {
  const dimensions = getVideoAspectRatioPreviewDimensions(ratio);
  return (
    <div className="flex h-10 w-full items-center justify-center" aria-hidden="true">
      <span
        data-testid={`video-aspect-ratio-preview-${ratio.replace(/[^0-9a-z]+/gi, '-')}`}
        className={cn('block shrink-0 rounded-[3px] border-2 transition-colors', selected ? 'border-primary bg-primary/10' : 'border-muted-foreground/70 bg-background')}
        style={{ width: dimensions.width, height: dimensions.height }}
      />
    </div>
  );
}

/**
 * 渲染参考图片、视频或音频附件缩略块。
 * @param props 媒体文件和删除回调。
 * @returns 带预览或类型图标、类型标记和删除按钮的固定尺寸附件块。
 */
function MediaAttachmentTile({ file, onRemove }: MediaAttachmentTileProps) {
  const [previewUrl] = useState(() => URL.createObjectURL(file));
  const mediaType = file.type.startsWith('video/') ? 'VIDEO' : file.type.startsWith('audio/') ? 'AUDIO' : 'IMG';

  useEffect(() => {
    return () => { if (previewUrl) URL.revokeObjectURL(previewUrl); };
  }, [previewUrl]);

  return (
    <div className="group relative h-16 w-16 shrink-0 overflow-visible">
      <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-lg bg-muted">
        {mediaType === 'IMG' && <img src={previewUrl} alt={file.name} className="h-full w-full object-cover" />}
        {mediaType === 'VIDEO' && <video src={previewUrl} aria-label={file.name} className="h-full w-full object-cover" muted playsInline preload="metadata" />}
        {mediaType === 'AUDIO' && <FileAudio aria-label={file.name} className="size-7 text-muted-foreground" />}
      </div>
      <div className="absolute bottom-0.5 left-0.5 max-w-[60px] truncate rounded bg-black/70 px-1 py-0.5 text-[9px] leading-none text-white">{mediaType}</div>
      <Button type="button" variant="secondary" size="icon-xs" onClick={onRemove} className="absolute -right-1 -top-1 z-10 rounded-full" title={file.name}>
        <X className="size-3" />
      </Button>
    </div>
  );
}

/**
 * 将视频参考图片适配到工作台统一的图片附件交互模块。
 * @param props 参考图片列表、删除回调和当前提示词。
 * @returns 复用生图工作台能力的图片缩略图、预览、复制及素材库操作区域。
 */
function VideoReferenceImageChips({ files, onRemove, prompt }: VideoReferenceImageChipsProps) {
  const [attachmentFiles, setAttachmentFiles] = useState<Array<{ id: string; name: string; file: File; preview: string; dataUrl: string; mimeType: string }>>([]);

  useEffect(() => {
    const nextFiles = files.map(file => {
      const preview = URL.createObjectURL(file);
      return { id: `${file.name}-${file.lastModified}`, name: file.name, file, preview, dataUrl: preview, mimeType: file.type };
    });
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setAttachmentFiles(nextFiles);
    });
    return () => {
      cancelled = true;
      for (const file of nextFiles) URL.revokeObjectURL(file.preview);
    };
  }, [files]);

  return (
    <AttachmentChips
      files={attachmentFiles}
      onRemove={onRemove}
      sourceKind="upload"
      sourceLabel="视频参考图片"
      prompt={prompt}
      showDownload={false}
      showCopy
      showAddToAssets
      showUseAsReference={false}
    />
  );
}

/**
 * 将任务时间转换为当前语言环境的短日期时间。
 * @param value ISO 时间文本。
 * @param locale 当前界面语言。
 * @returns 本地化日期时间文本。
 */
function formatJobTime(value: string, locale: 'en' | 'zh'): string {
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
}

/**
 * 计算并格式化视频任务从创建到当前或终态的总耗时。
 * @param durationMs 服务端最近一次计算的任务耗时毫秒数。
 * @param durationUpdatedAt 最近一次同步耗时的浏览器时间。
 * @param active 任务是否仍在排队或处理中。
 * @param createdAt 旧版历史任务的创建时间回退值。
 * @param completedAt 旧版历史任务的终态时间回退值。
 * @param nowMs 当前时间戳，用于实时更新活动任务。
 * @param locale 当前界面语言。
 * @returns 紧凑的本地化时分秒文本。
 */
function formatVideoJobDuration(durationMs: number | undefined, durationUpdatedAt: string | undefined, active: boolean, createdAt: string, completedAt: string | undefined, nowMs: number, locale: 'en' | 'zh'): string {
  let baseDurationMs = durationMs;
  if (!Number.isFinite(baseDurationMs)) {
    const startedAtMs = Date.parse(createdAt);
    const finishedAtMs = completedAt ? Date.parse(completedAt) : nowMs;
    baseDurationMs = Number.isFinite(startedAtMs) && Number.isFinite(finishedAtMs)
      ? Math.max(0, finishedAtMs - startedAtMs)
      : undefined;
  }
  if (!Number.isFinite(baseDurationMs)) return '--';
  const syncedAtMs = Date.parse(durationUpdatedAt || '');
  const liveDeltaMs = active && Number.isFinite(syncedAtMs) ? Math.max(0, nowMs - syncedAtMs) : 0;
  const totalSeconds = Math.max(0, Math.floor(((baseDurationMs || 0) + liveDeltaMs) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (locale === 'zh') {
    if (hours > 0) return `${hours}小时${minutes}分${seconds}秒`;
    if (minutes > 0) return `${minutes}分${seconds}秒`;
    return `${seconds}秒`;
  }
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * 读取视频任务实际发送给上游的模型 ID，并兼容升级前保存的历史任务。
 * @param job 当前视频任务记录。
 * @param models 设置注册表中仍可用的视频模型配置。
 * @returns 任务保存的 API 模型 ID；旧任务尝试从关联配置解析，无法解析时返回占位符。
 */
function getVideoJobApiModelId(job: StoredVideoJob, models: VideoModelConfig[]): string {
  if (job.apiModelId?.trim()) return job.apiModelId.trim();
  const configuredModel = models.find(model => model.id === job.modelId);
  return configuredModel ? getResolvedVideoModelId(configuredModel) : '--';
}

/**
 * 渲染完整的视频生成工作台和任务历史。
 * @param props 宽屏状态、设置入口和全局提示回调。
 * @returns 响应式视频工作台。
 */
export function VideoGenerationWorkspace({ wideMode = false, onConfigureApiKey, showToast }: VideoGenerationWorkspaceProps) {
  const { locale, t } = useI18n();
  const config = useMemo(() => getVideoWorkspaceConfig(), []);
  const initialVideoSize = config.sizes[0] || '1280x720';
  const initialVideoDimensions = getVideoSizeDimensions(initialVideoSize);
  const [models, setModels] = useState<VideoModelConfig[]>([]);
  const [modelId, setModelId] = useState('');
  const [remoteModelId, setRemoteModelId] = useState('');
  const [refreshingModels, setRefreshingModels] = useState(false);
  const [prompt, setPrompt] = useState('');
  // 移动端默认收起参数区以节省首屏空间，桌面端默认展开并允许用户主动切换。
  const [parametersExpanded, setParametersExpanded] = useState(() => typeof window === 'undefined' || typeof window.matchMedia !== 'function' || !window.matchMedia('(max-width: 767px)').matches);
  const [referenceImages, setReferenceImages] = useState<File[]>([]);
  const [referenceVideos, setReferenceVideos] = useState<File[]>([]);
  const [referenceAudios, setReferenceAudios] = useState<File[]>([]);
  const [assetPickerOpen, setAssetPickerOpen] = useState(false);
  const [mediaAssetPickerOpen, setMediaAssetPickerOpen] = useState(false);
  const [resolution, setResolution] = useState(config.resolutions[0] || 720);
  const [customResolution, setCustomResolution] = useState('');
  const [resolutionMode, setResolutionMode] = useState<'preset' | 'custom'>('preset');
  const [videoSize, setVideoSize] = useState(initialVideoSize);
  const [sizeAspectRatio, setSizeAspectRatio] = useState(() => getVideoSizeAspectRatio(initialVideoSize) || '16:9');
  const [referenceImageSize, setReferenceImageSize] = useState('');
  const [aspectRatio, setAspectRatio] = useState('16:9');
  const [customWidth, setCustomWidth] = useState(initialVideoDimensions.width);
  const [customHeight, setCustomHeight] = useState(initialVideoDimensions.height);
  const [sizeMode, setSizeMode] = useState<'preset' | 'custom' | 'reference'>('preset');
  const [seconds, setSeconds] = useState(config.durations[0] || 6);
  const [parallelCount, setParallelCount] = useState<ParallelCount>(1);
  const [parallelPopoverOpen, setParallelPopoverOpen] = useState(false);
  const [promptVariants, setPromptVariants] = useState<string[]>([]);
  const [promptVariantsOpen, setPromptVariantsOpen] = useState(false);
  const [customSeconds, setCustomSeconds] = useState('');
  const [durationMode, setDurationMode] = useState<'preset' | 'custom'>('preset');
  const [, setCatalogVersion] = useState(0);
  const [jobs, setJobs] = useState<StoredVideoJob[]>(() => loadVideoJobs());
  const [copiedPromptJobId, setCopiedPromptJobId] = useState<string | null>(null);
  const [durationNowMs, setDurationNowMs] = useState(() => Date.now());
  const [submitting, setSubmitting] = useState(false);
  const [restoringJobId, setRestoringJobId] = useState<string | null>(null);
  const [cancellingTaskIds, setCancellingTaskIds] = useState<Set<string>>(new Set());
  const [dragging, setDragging] = useState(false);
  const [optimizeOpen, setOptimizeOpen] = useState(false);
  const [optimizedText, setOptimizedText] = useState('');
  const [optimizing, setOptimizing] = useState(false);
  const [optimizeError, setOptimizeError] = useState<string | null>(null);
  const [videoPlaybackStates, setVideoPlaybackStates] = useState<Record<string, VideoPlaybackState>>({});
  const [downloadingVideoJobIds, setDownloadingVideoJobIds] = useState<Set<string>>(new Set());
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const optimizeHandleRef = useRef<StreamPromptOptimizeHandle | null>(null);
  const jobsRef = useRef(jobs);
  const componentMountedRef = useRef(false);
  const videoRecoveryAttemptsRef = useRef<Set<string>>(new Set());
  const synchronizingVideoJobIdsRef = useRef<Set<string>>(new Set());
  const downloadingVideoJobIdsRef = useRef<Set<string>>(new Set());
  const videoTransferAbortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const videoBlobDeletionPromisesRef = useRef<Map<string, Promise<void>>>(new Map());
  const videoBlobWritePromisesRef = useRef<Map<string, Promise<void>>>(new Map());
  const videoBlobInvalidationVersionsRef = useRef<Map<string, number>>(new Map());
  const referenceFilesRef = useRef<Map<string, VideoReferenceFiles>>(new Map());
  const referenceCachePromisesRef = useRef<Map<string, Promise<void>>>(new Map());
  const { enabled: promptOptimizeEnabled, available: promptOptimizeAvailable } = usePromptOptimizeSetting();
  const promptOptimizeUsable = promptOptimizeEnabled && promptOptimizeAvailable;
  const { submissionShortcut, isSmallViewport, updateSubmissionShortcut } = usePromptSubmissionShortcut();
  const shortcutLabels = getEffectivePromptSubmissionShortcutLabels(submissionShortcut, isSmallViewport, {
    submission: t('workbench.mobileSend'),
    newline: t('workbench.mobileNewline'),
  });
  const selectedModel = useMemo(() => models.find(model => model.id === modelId), [modelId, models]);
  const configuredRemoteModelId = selectedModel ? getResolvedVideoModelId(selectedModel) : '';
  const cachedModelCatalog = selectedModel
    ? getModelCatalogCache(selectedModel.id, { protocol: 'openai', baseUrl: selectedModel.baseUrl })
    : undefined;
  const remoteModelOptions = useMemo(() => [
    ...(cachedModelCatalog?.options || []),
    ...(remoteModelId && !(cachedModelCatalog?.options || []).some(option => option.id === remoteModelId)
      ? [{ id: remoteModelId, name: remoteModelId }]
      : []),
    ...(!cachedModelCatalog?.options?.length && configuredRemoteModelId && configuredRemoteModelId !== remoteModelId
      ? [{ id: configuredRemoteModelId, name: configuredRemoteModelId }]
      : []),
  ].filter((option, index, options) => options.findIndex(candidate => candidate.id === option.id) === index), [cachedModelCatalog, configuredRemoteModelId, remoteModelId]);
  const requestModel = useMemo(() => {
    if (!selectedModel || !remoteModelId || remoteModelId === configuredRemoteModelId) return selectedModel;
    return { ...selectedModel, modelId: remoteModelId, usesPresetModelId: false };
  }, [configuredRemoteModelId, remoteModelId, selectedModel]);

  /**
   * 使用当前视频渠道的凭据获取远端模型，并写入与设置页相同的目录缓存。
   * @returns 请求完成后刷新模型选项并显示操作结果的 Promise。
   */
  const handleRefreshModels = async (): Promise<void> => {
    if (!selectedModel || refreshingModels) return;
    setRefreshingModels(true);
    try {
      const options = await fetchRemoteModels({
        baseUrl: selectedModel.baseUrl,
        apiKey: selectedModel.apiKey,
        // 视频协议的模型目录统一按 OpenAI 兼容接口获取，与设置页保持一致。
        protocol: 'openai',
      });
      saveModelCatalogCache({
        channelId: selectedModel.id,
        protocol: 'openai',
        baseUrl: selectedModel.baseUrl,
        options,
      });
      showToast(t('workbench.modelsRefreshed', { count: options.length }), 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('workbench.refreshModelsFailed'), 'error');
    } finally {
      setRefreshingModels(false);
    }
  };

  /**
   * 使指定任务的当前视频缓存失效，并串行删除 IndexedDB 记录。
   * @param jobId 本地视频任务标识。
   * @returns 本次缓存删除完成后兑现的 Promise。
   */
  const invalidateVideoBlobCache = useCallback((jobId: string): Promise<void> => {
    const nextVersion = (videoBlobInvalidationVersionsRef.current.get(jobId) || 0) + 1;
    videoBlobInvalidationVersionsRef.current.set(jobId, nextVersion);
    const previousDeletion = videoBlobDeletionPromisesRef.current.get(jobId) || Promise.resolve();
    const pendingWrite = videoBlobWritePromisesRef.current.get(jobId) || Promise.resolve();
    const deletion = Promise.allSettled([previousDeletion, pendingWrite]).then(() => deleteVideoBlob(jobId)).catch(() => undefined);
    videoBlobDeletionPromisesRef.current.set(jobId, deletion);
    void deletion.finally(() => {
      if (videoBlobDeletionPromisesRef.current.get(jobId) === deletion) videoBlobDeletionPromisesRef.current.delete(jobId);
    });
    return deletion;
  }, []);

  useEffect(() => {
    if (!jobs.some(job => job.status === '排队中' || job.status === 'processing')) return;
    const initialUpdate = window.setTimeout(() => setDurationNowMs(Date.now()), 0);
    const timer = window.setInterval(() => setDurationNowMs(Date.now()), 1000);
    return () => {
      window.clearTimeout(initialUpdate);
      window.clearInterval(timer);
    };
  }, [jobs]);

  /**
   * 选择视频模型并同步设置中的视频生成默认模型。
   * @param nextModelId 用户选择的视频模型内部标识。
   * @returns 无返回值；本地选择与模型注册表会同步更新。
   */
  const handleModelChange = (nextModelId: string): void => {
    setModelId(nextModelId);
    const nextModel = models.find(model => model.id === nextModelId);
    setRemoteModelId(nextModel ? getResolvedVideoModelId(nextModel) : '');
    updateRegistryDefaults({ videoGeneration: nextModelId });
  };

  /** 选择当前视频渠道下实际提交的远端模型 ID。
   * @param nextModelId 当前渠道目录中的远端模型 ID。
   * @returns 无返回值，通过本地状态更新提交模型。
   */
  const handleRemoteModelChange = (nextModelId: string): void => {
    setRemoteModelId(nextModelId);
  };

  /**
   * 更新批量视频数量，并同步逐视频附加提示词区域的可见状态。
   * @param count 用户选择的独立视频任务数量。
   * @returns 无返回值；数量为一时清空逐视频附加提示词。
   */
  const handleParallelCountChange = useCallback((count: ParallelCount): void => {
    setParallelCount(count);
    setParallelPopoverOpen(false);
    if (count > 1) {
      setPromptVariantsOpen(true);
    } else {
      setPromptVariants([]);
      setPromptVariantsOpen(false);
    }
  }, []);

  /**
   * 更新指定视频的附加提示词，并保留当前最大批量数量范围内的数据。
   * @param index 当前视频在批次中的从零开始序号。
   * @param value 用户输入的附加提示词。
   * @returns 无返回值；对应输入值会写入组件状态。
   */
  const handlePromptVariantChange = useCallback((index: number, value: string): void => {
    setPromptVariants(current => {
      const next = current.slice(0, MAX_PARALLEL_COUNT);
      next[index] = value;
      return next;
    });
  }, []);
  const protocolProfile = useMemo(
    () => resolveVideoProtocolProfile(requestModel?.protocol || 'new-api', requestModel ? getResolvedVideoModelId(requestModel) : '', referenceImages.length > 0),
    [referenceImages.length, requestModel],
  );
  const maxReferenceImages = Math.min(config.maxRefImages, protocolProfile.references.images);
  const maxReferenceVideos = Math.min(config.maxRefVideos, protocolProfile.references.videos);
  const maxReferenceAudios = Math.min(config.maxRefAudios, protocolProfile.references.audios);
  const durationOptions = useMemo(() => {
    const options = getVideoProtocolDurations(protocolProfile);
    if (!options.includes(15) && isValidVideoProtocolDuration(protocolProfile, 15)) options.push(15);
    return [...new Set(options)].sort((left, right) => left - right);
  }, [protocolProfile]);
  const durationPlaceholder = protocolProfile.parameters.duration.mode === 'enum'
    ? durationOptions.join('/')
    : `${protocolProfile.parameters.duration.min}-${protocolProfile.parameters.duration.max} ${t('video.secondsUnit')}`;

  /** 当模型或协议改变附件约束时，立即移除格式不兼容或超过数量上限的参考图。 */
  useEffect(() => {
    let cancelled = false;
    const supportedImages = referenceImages.filter(file => isAllowedVideoReferenceMimeType(file.type, protocolProfile.references.imageMimeTypes));
    const nextImages = supportedImages.slice(0, maxReferenceImages);
    const removedUnsupportedImages = supportedImages.length !== referenceImages.length;
    const removedExcessImages = supportedImages.length > maxReferenceImages;
    if (removedUnsupportedImages || removedExcessImages) {
      queueMicrotask(() => {
        if (cancelled) return;
        setReferenceImages(nextImages);
        if (removedUnsupportedImages) showToast(t('video.unsupportedReferenceImageFormat'), 'error');
        if (removedExcessImages) showToast(t('video.imageLimit', { max: maxReferenceImages }), 'error');
      });
    }
    return () => { cancelled = true; };
  }, [maxReferenceImages, protocolProfile.references.imageMimeTypes, referenceImages, showToast, t]);

  /** 读取首张参考图尺寸，并在参考图移除或读取失败时退出参考尺寸模式。 */
  useEffect(() => {
    const image = referenceImages[0];
    let cancelled = false;
    if (!image) {
      queueMicrotask(() => {
        if (cancelled) return;
        setReferenceImageSize('');
        if (sizeMode === 'reference') {
          setSizeMode('preset');
          setVideoSize(protocolProfile.parameters.size.values[0] || '1280x720');
        }
      });
      return () => { cancelled = true; };
    }
    void readReferenceImageVideoSize(image).then(size => {
      if (cancelled) return;
      setReferenceImageSize(size);
      if (!size && sizeMode === 'reference') setSizeMode('preset');
    });
    return () => { cancelled = true; };
  }, [protocolProfile.parameters.size.values, referenceImages, sizeMode]);

  /** 当模型或协议改变附件约束时，立即移除格式不兼容或超过数量上限的视频和音频。 */
  useEffect(() => {
    let cancelled = false;
    const nextVideos = referenceVideos.filter(file => isAllowedVideoReferenceMimeType(file.type, protocolProfile.references.videoMimeTypes)).slice(0, maxReferenceVideos);
    const nextAudios = referenceAudios.filter(file => isAllowedVideoReferenceMimeType(file.type, protocolProfile.references.audioMimeTypes)).slice(0, maxReferenceAudios);
    if (nextVideos.length !== referenceVideos.length || nextAudios.length !== referenceAudios.length) {
      queueMicrotask(() => {
        if (cancelled) return;
        if (nextVideos.length !== referenceVideos.length) {
          setReferenceVideos(nextVideos);
          showToast(t('video.unsupportedReferenceVideo'), 'error');
        }
        if (nextAudios.length !== referenceAudios.length) {
          setReferenceAudios(nextAudios);
          showToast(t('video.unsupportedReferenceAudio'), 'error');
        }
      });
    }
    return () => { cancelled = true; };
  }, [maxReferenceAudios, maxReferenceVideos, protocolProfile.references.audioMimeTypes, protocolProfile.references.videoMimeTypes, referenceAudios, referenceVideos, showToast, t]);

  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);

  useEffect(() => {
    componentMountedRef.current = true;
    const transferAbortControllers = videoTransferAbortControllersRef.current;
    return () => {
      componentMountedRef.current = false;
      // 第一步终止仍在读取的提示词优化流，避免卸载后继续执行状态回调。
      optimizeHandleRef.current?.abort();
      optimizeHandleRef.current = null;
      // 第二步终止视频缓存与下载请求，防止离开工作台后继续创建对象 URL 或触发下载。
      for (const controller of transferAbortControllers.values()) controller.abort();
      transferAbortControllers.clear();
      // 第三步释放历史任务创建的对象 URL；IndexedDB 中的原始 Blob 保持不变，可在下次进入时重新恢复。
      for (const job of jobsRef.current) {
        if (job.videoUrl?.startsWith('blob:')) URL.revokeObjectURL(job.videoUrl);
      }
    };
  }, []);

  useEffect(() => {
    /** 从本地注册表同步视频模型列表和默认模型。 */
    const refreshModels = () => {
      const registry = loadRegistry();
      const complete = getCompleteVideoModels(registry);
      setModels(complete);
      const nextChannelId = complete.some(model => model.id === modelId) ? modelId : getDefaultVideoModel(registry)?.id || complete[0]?.id || '';
      const nextChannel = complete.find(model => model.id === nextChannelId);
      setModelId(nextChannelId);
      setRemoteModelId(nextChannel ? getResolvedVideoModelId(nextChannel) : '');
    };
    refreshModels();
    window.addEventListener('flyreq-model-registry-updated', refreshModels);
    return () => window.removeEventListener('flyreq-model-registry-updated', refreshModels);
  }, [modelId]);

  useEffect(() => {
    /** 监听设置页更新的模型目录缓存，使远端模型选择即时刷新。 */
    const handleCatalogUpdate = () => setCatalogVersion(version => version + 1);
    window.addEventListener(MODEL_CATALOG_CACHE_UPDATED_EVENT, handleCatalogUpdate);
    return () => window.removeEventListener(MODEL_CATALOG_CACHE_UPDATED_EVENT, handleCatalogUpdate);
  }, []);

  useEffect(() => { saveVideoJobs(jobs); }, [jobs]);

  useEffect(() => {
    let cancelled = false;
    const pendingRestore = jobs.filter(job => job.cached && !job.videoUrl);
    if (pendingRestore.length === 0) return;
    Promise.all(pendingRestore.map(async job => {
      try {
        return { id: job.id, url: await restoreVideoBlobUrl(job.id) };
      } catch {
        return { id: job.id, url: undefined };
      }
    }))
      .then(restored => {
        if (cancelled) {
          // 恢复完成前组件已卸载时，立即释放刚创建且不会进入界面的对象 URL。
          for (const item of restored) {
            if (item.url?.startsWith('blob:')) URL.revokeObjectURL(item.url);
          }
          return;
        }
        setJobs(current => current.map(job => {
          const restoredItem = restored.find(item => item.id === job.id);
          if (!restoredItem) return job;
          if (restoredItem.url) return { ...job, videoUrl: restoredItem.url, cached: true };
          const sourceUrl = getVideoJobSourceUrl(job);
          if (sourceUrl) {
            // 本地 Blob 缺失时保留已完成任务，回退到服务端完整文件继续播放。
            return { ...job, status: 'completed', videoUrl: sourceUrl, cached: false, error: undefined };
          }
          // 没有服务端回退地址时只写入一次终态，避免 effect 持续恢复和更新。
          return {
            ...job,
            status: 'failed',
            completedAt: job.completedAt || new Date().toISOString(),
            cached: false,
            error: t('video.cachedResultMissing'),
          };
        }));
      });
    return () => { cancelled = true; };
  }, [jobs, t]);

  /**
   * 查询所有未结束任务，并在完成后缓存视频结果。
   * @returns 无返回值，任务状态通过 React 状态更新。
   */
  const refreshPendingJobs = useCallback(async (): Promise<void> => {
    const pending = jobs.filter(job => job.serverTaskId && (job.status === '排队中' || job.status === 'processing'));
    await Promise.all(pending.map(async job => {
      if (synchronizingVideoJobIdsRef.current.has(job.id)) return;
      synchronizingVideoJobIdsRef.current.add(job.id);
      let transferController: AbortController | undefined;
      try {
        const task = await getVideoTask(job.serverTaskId!);
        if (!componentMountedRef.current || !jobsRef.current.some(item => item.id === job.id)) return;
        if (task.status === 'completed' && task.result?.videoUrl) {
          let videoUrl = task.result.videoUrl;
          let cached = false;
          try {
            transferController = new AbortController();
            videoTransferAbortControllersRef.current.set(job.id, transferController);
            videoUrl = await cacheVideoBlob(job.id, task.result.videoUrl, transferController.signal);
            cached = true;
          } catch {
            cached = false;
          }
          if (!componentMountedRef.current || !jobsRef.current.some(item => item.id === job.id)) {
            if (videoUrl.startsWith('blob:')) {
              // 异步缓存完成后任务可能已删除或工作台已卸载，同时清理对象 URL 和刚写回的 IndexedDB Blob。
              URL.revokeObjectURL(videoUrl);
              void invalidateVideoBlobCache(job.id);
            }
            return;
          }
          setJobs(current => current.map(item => item.id === job.id ? { ...item, status: 'completed', completedAt: task.completedAt, durationMs: task.durationMs, durationUpdatedAt: new Date().toISOString(), videoUrl, videoSourceUrl: task.result!.videoUrl, cached } : item));
          if (cached) {
            // 只有任务仍存在且本地缓存成功时才缩短服务端保留期，确认失败不影响本地完成状态。
            void acknowledgeVideoTask(job.serverTaskId!).catch(() => undefined);
          }
        } else if (task.status === 'cancelled') {
          setJobs(current => current.map(item => item.id === job.id ? { ...item, status: 'cancelled', completedAt: task.completedAt || new Date().toISOString(), durationMs: task.durationMs, durationUpdatedAt: new Date().toISOString(), error: task.error || t('video.cancelled') } : item));
        } else if (task.status === 'failed' || task.status === 'expired') {
          setJobs(current => current.map(item => item.id === job.id ? { ...item, status: 'failed', completedAt: task.completedAt || new Date().toISOString(), durationMs: task.durationMs, durationUpdatedAt: new Date().toISOString(), error: task.error || t('video.failed') } : item));
        } else {
          setJobs(current => current.map(item => item.id === job.id ? { ...item, status: task.status === 'queued' ? '排队中' : task.status as '排队中' | 'processing', durationMs: task.durationMs, durationUpdatedAt: new Date().toISOString() } : item));
        }
      } catch (error) {
        if (!componentMountedRef.current || !jobsRef.current.some(item => item.id === job.id)) return;
        showToast(error instanceof Error ? error.message : t('video.failed'), 'error');
      } finally {
        if (transferController && videoTransferAbortControllersRef.current.get(job.id) === transferController) {
          videoTransferAbortControllersRef.current.delete(job.id);
        }
        synchronizingVideoJobIdsRef.current.delete(job.id);
      }
    }));
  }, [invalidateVideoBlobCache, jobs, showToast, t]);

  /**
   * 处理视频元素播放失败，首次失败自动清理坏缓存并切换到服务端文件。
   * @param jobId 本地视频任务标识。
   * @returns 无返回值；播放器状态和视频地址通过任务状态更新。
   */
  const handleVideoPlaybackError = useCallback((jobId: string): void => {
    const job = jobsRef.current.find(item => item.id === jobId);
    if (!job) return;
    if (job.videoUrl?.startsWith('blob:')) {
      URL.revokeObjectURL(job.videoUrl);
      void invalidateVideoBlobCache(job.id);
    }
    const sourceUrl = getVideoJobSourceUrl(job);
    if (sourceUrl && !videoRecoveryAttemptsRef.current.has(jobId)) {
      videoRecoveryAttemptsRef.current.add(jobId);
      setVideoPlaybackStates(current => ({ ...current, [jobId]: 'repairing' }));
      setJobs(current => current.map(item => item.id === jobId
        ? { ...item, videoUrl: appendVideoRetryToken(sourceUrl), videoSourceUrl: sourceUrl, cached: false }
        : item));
      return;
    }
    if (!sourceUrl) {
      setJobs(current => current.map(item => item.id === jobId
        ? { ...item, videoUrl: undefined, cached: false }
        : item));
    }
    setVideoPlaybackStates(current => ({ ...current, [jobId]: 'error' }));
  }, [invalidateVideoBlobCache]);

  /**
   * 记录视频已具备播放条件，并清除本次自动恢复标记。
   * @param jobId 本地视频任务标识。
   * @returns 无返回值。
   */
  const handleVideoCanPlay = useCallback((jobId: string): void => {
    videoRecoveryAttemptsRef.current.delete(jobId);
    setVideoPlaybackStates(current => ({ ...current, [jobId]: 'ready' }));
  }, []);

  /**
   * 手动重新加载视频，不重新提交生成任务。
   * @param job 待重新加载的视频任务。
   * @returns 无返回值；重新加载地址通过任务状态更新。
   */
  const handleReloadVideo = useCallback((job: StoredVideoJob): void => {
    const sourceUrl = getVideoJobSourceUrl(job);
    if (!sourceUrl) {
      setVideoPlaybackStates(current => ({ ...current, [job.id]: 'error' }));
      return;
    }
    if (job.videoUrl?.startsWith('blob:') && job.videoUrl !== sourceUrl) URL.revokeObjectURL(job.videoUrl);
    void invalidateVideoBlobCache(job.id);
    videoRecoveryAttemptsRef.current.delete(job.id);
    setVideoPlaybackStates(current => ({ ...current, [job.id]: 'repairing' }));
    setJobs(current => current.map(item => item.id === job.id
      ? { ...item, videoUrl: appendVideoRetryToken(sourceUrl), videoSourceUrl: sourceUrl, cached: false }
      : item));
  }, [invalidateVideoBlobCache]);

  /**
   * 下载完整视频并同步修复页面播放器，避免下载成功后仍停留在坏资源。
   * @param job 待下载的视频任务。
   * @returns 下载、缓存和播放器地址更新完成后兑现的 Promise。
   */
  const handleDownloadVideo = useCallback(async (job: StoredVideoJob): Promise<void> => {
    if (downloadingVideoJobIdsRef.current.has(job.id)) return;
    const currentBlobUrl = job.videoUrl?.startsWith('blob:') ? job.videoUrl : undefined;
    const sourceUrl = currentBlobUrl || getVideoJobSourceUrl(job);
    if (!sourceUrl) {
      showToast(t('video.downloadFailed'), 'error');
      return;
    }
    if (currentBlobUrl) {
      const anchor = document.createElement('a');
      anchor.href = currentBlobUrl;
      anchor.download = `video-${job.id}.mp4`;
      anchor.click();
      return;
    }
    downloadingVideoJobIdsRef.current.add(job.id);
    const transferController = new AbortController();
    videoTransferAbortControllersRef.current.set(job.id, transferController);
    setDownloadingVideoJobIds(current => new Set(current).add(job.id));
    try {
      const blob = await fetchVideoBlob(appendVideoRetryToken(sourceUrl), transferController.signal);
      if (!componentMountedRef.current || !jobsRef.current.some(item => item.id === job.id)) return;
      const pendingDeletion = videoBlobDeletionPromisesRef.current.get(job.id);
      if (pendingDeletion) await pendingDeletion;
      if (!componentMountedRef.current || !jobsRef.current.some(item => item.id === job.id)) return;
      const blobUrl = URL.createObjectURL(blob);
      const cacheInvalidationVersion = videoBlobInvalidationVersionsRef.current.get(job.id) || 0;
      const latestJob = jobsRef.current.find(item => item.id === job.id);
      if (latestJob?.videoUrl?.startsWith('blob:') && latestJob.videoUrl !== blobUrl) URL.revokeObjectURL(latestJob.videoUrl);
      setJobs(current => current.map(item => item.id === job.id
        ? { ...item, videoUrl: blobUrl, videoSourceUrl: getVideoJobSourceUrl(item) || sourceUrl, cached: false, error: undefined }
        : item));
      videoRecoveryAttemptsRef.current.delete(job.id);
      setVideoPlaybackStates(current => ({ ...current, [job.id]: 'ready' }));
      const anchor = document.createElement('a');
      anchor.href = blobUrl;
      anchor.download = `video-${job.id}.mp4`;
      anchor.click();
      const storePromise = storeVideoBlob(job.id, blob);
      videoBlobWritePromisesRef.current.set(job.id, storePromise);
      void storePromise.then(() => {
        if (videoBlobWritePromisesRef.current.get(job.id) === storePromise) videoBlobWritePromisesRef.current.delete(job.id);
      }, () => {
        if (videoBlobWritePromisesRef.current.get(job.id) === storePromise) videoBlobWritePromisesRef.current.delete(job.id);
      });
      void storePromise.then(
        () => {
          const cacheWasInvalidated = (videoBlobInvalidationVersionsRef.current.get(job.id) || 0) !== cacheInvalidationVersion;
          if (cacheWasInvalidated || !componentMountedRef.current || !jobsRef.current.some(item => item.id === job.id)) {
            // 缓存写入期间记录被删除或工作台卸载时，清理无法再由界面管理的缓存和对象 URL。
            void invalidateVideoBlobCache(job.id);
            URL.revokeObjectURL(blobUrl);
            return;
          }
          setJobs(current => current.map(item => item.id === job.id ? { ...item, cached: true } : item));
          if (job.serverTaskId) void acknowledgeVideoTask(job.serverTaskId).catch(() => undefined);
        },
        error => {
          // 本地缓存失败不能撤销已经完成的下载和当前页面播放。
          console.error('保存视频缓存失败', error);
          if (!componentMountedRef.current || !jobsRef.current.some(item => item.id === job.id)) URL.revokeObjectURL(blobUrl);
        },
      );
    } catch (error) {
      if (transferController.signal.aborted || !componentMountedRef.current || !jobsRef.current.some(item => item.id === job.id)) return;
      console.error('下载视频失败', error);
      showToast(t('video.downloadFailed'), 'error');
      setVideoPlaybackStates(current => ({ ...current, [job.id]: 'error' }));
    } finally {
      if (videoTransferAbortControllersRef.current.get(job.id) === transferController) {
        videoTransferAbortControllersRef.current.delete(job.id);
      }
      downloadingVideoJobIdsRef.current.delete(job.id);
      if (componentMountedRef.current) {
        setDownloadingVideoJobIds(current => {
          const next = new Set(current);
          next.delete(job.id);
          return next;
        });
      }
    }
  }, [invalidateVideoBlobCache, showToast, t]);

  /** 将已完成的视频任务保存为素材库视频，优先复用本地缓存。 */
  const handleSaveVideoToAssets = useCallback(async (job: StoredVideoJob): Promise<void> => {
    const source = job.videoUrl || getVideoJobSourceUrl(job);
    if (!source) return;
    try {
      const response = await fetch(source);
      if (!response.ok) throw new Error('视频读取失败');
      const blob = await response.blob();
      await addMediaAsset({ blob, kind: 'video', name: `video-${job.id}.mp4`, sourceKind: 'video-generation', sourceLabel: t('video.title'), sourceRef: job.serverTaskId || job.id });
      showToast(t('video.savedToAssets'), 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('video.assetImportFailed'), 'error');
    }
  }, [showToast, t]);

  useEffect(() => {
    if (!jobs.some(job => job.status === '排队中' || job.status === 'processing')) return;
    const timer = window.setInterval(() => void refreshPendingJobs(), 5000);
    return () => window.clearInterval(timer);
  }, [jobs, refreshPendingJobs]);

  /**
   * 按 MIME 类型分类、校验并添加用户选择或拖入的参考媒体。
   * @param files 待分类处理的文件列表。
   * @returns 无返回值，合法文件会追加到对应状态。
   */
  const addReferenceFiles = useCallback((files: File[]) => {
    const images = files.filter(file => file.type.startsWith('image/'));
    const videos = files.filter(file => file.type.startsWith('video/'));
    const audios = files.filter(file => file.type.startsWith('audio/'));
    if (images.length + videos.length + audios.length !== files.length) showToast(t('video.unsupportedReferenceMedia'), 'error');
    const supportedImages = images.filter(file => isAllowedVideoReferenceMimeType(file.type, protocolProfile.references.imageMimeTypes));
    if (supportedImages.length !== images.length) showToast(t('video.unsupportedReferenceImageFormat'), 'error');
    const validImages = supportedImages.filter(file => {
      if (file.size <= config.maxReferenceImageBytes) return true;
      showToast(t('video.imageTooLarge', { size: Math.round(config.maxReferenceImageBytes / 1024 / 1024) }), 'error');
      return false;
    });
    setReferenceImages(current => {
      if (current.length + validImages.length > maxReferenceImages) showToast(t('video.imageLimit', { max: maxReferenceImages }), 'error');
      return [...current, ...validImages].slice(0, maxReferenceImages);
    });
    const validVideos = videos.filter(file => isAllowedVideoReferenceMimeType(file.type, protocolProfile.references.videoMimeTypes) && file.size <= config.maxReferenceVideoBytes);
    if (validVideos.length !== videos.length) showToast(t('video.unsupportedReferenceVideo'), 'error');
    setReferenceVideos(current => {
      if (current.length + validVideos.length > maxReferenceVideos) showToast(t('video.videoLimit', { max: maxReferenceVideos }), 'error');
      return [...current, ...validVideos].slice(0, maxReferenceVideos);
    });
    const validAudios = audios.filter(file => isAllowedVideoReferenceMimeType(file.type, protocolProfile.references.audioMimeTypes) && file.size <= config.maxReferenceAudioBytes);
    if (validAudios.length !== audios.length) showToast(t('video.unsupportedReferenceAudio'), 'error');
    setReferenceAudios(current => {
      if (current.length + validAudios.length > maxReferenceAudios) showToast(t('video.audioLimit', { max: maxReferenceAudios }), 'error');
      return [...current, ...validAudios].slice(0, maxReferenceAudios);
    });
  }, [config.maxReferenceAudioBytes, config.maxReferenceImageBytes, config.maxReferenceVideoBytes, maxReferenceAudios, maxReferenceImages, maxReferenceVideos, protocolProfile.references.audioMimeTypes, protocolProfile.references.imageMimeTypes, protocolProfile.references.videoMimeTypes, showToast, t]);

  useEffect(() => {
    /**
     * 接收视频工作台范围内粘贴的媒体文件，并复用统一的参考素材校验入口。
     * @param event 浏览器派发的剪贴板粘贴事件。
     * @returns 无返回值；剪贴板不含媒体文件时保留浏览器默认粘贴行为。
     */
    const handlePaste = (event: ClipboardEvent): void => {
      const target = event.target;
      if (!(target instanceof Node) || !workspaceRef.current?.contains(target)) return;
      const items = event.clipboardData?.items;
      if (!items) return;
      const mediaFiles = Array.from(items)
        .filter(item => item.kind === 'file' && /^(image|video|audio)\//.test(item.type))
        .map(item => item.getAsFile())
        .filter((file): file is File => Boolean(file));
      if (mediaFiles.length === 0) return;
      event.preventDefault();
      let imageIndex = referenceImages.length;
      let videoIndex = referenceVideos.length;
      let audioIndex = referenceAudios.length;
      const namedMediaFiles = mediaFiles.map(file => {
        if (file.type.startsWith('image/')) return normalizePastedFileName(file, imageIndex++);
        if (file.type.startsWith('video/')) return normalizePastedFileName(file, videoIndex++);
        return normalizePastedFileName(file, audioIndex++);
      });
      addReferenceFiles(namedMediaFiles);
    };
    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, [addReferenceFiles, referenceAudios.length, referenceImages.length, referenceVideos.length]);

  /**
   * 将素材库图片转换为参考图文件并追加到上传列表。
   * @param selectedAssets 用户在素材库中确认的图片素材。
   * @returns 无返回值，素材读取完成后更新参考图状态。
   */
  const handleImportImageAssets = useCallback(async (selectedAssets: ImageAsset[]): Promise<void> => {
    const remaining = Math.max(0, maxReferenceImages - referenceImages.length);
    if (remaining === 0) {
      showToast(t('video.imageLimit', { max: maxReferenceImages }), 'error');
      return;
    }
    try {
      const imported: File[] = [];
      for (const asset of selectedAssets.slice(0, remaining)) {
        const blob = await getAssetBlob(asset.id);
        if (!blob) continue;
        const file = new File([blob], asset.name, { type: asset.mimeType || blob.type || 'image/png' });
        if (file.size > config.maxReferenceImageBytes) {
          showToast(t('video.imageTooLarge', { size: Math.round(config.maxReferenceImageBytes / 1024 / 1024) }), 'error');
          continue;
        }
        if (!isAllowedVideoReferenceMimeType(file.type, protocolProfile.references.imageMimeTypes)) {
          showToast(t('video.unsupportedReferenceImageFormat'), 'error');
          continue;
        }
        imported.push(file);
      }
      setReferenceImages(current => [...current, ...imported].slice(0, maxReferenceImages));
      if (selectedAssets.length > remaining) showToast(t('video.imageLimit', { max: maxReferenceImages }), 'error');
    } catch {
      showToast(t('video.assetImportFailed'), 'error');
    }
  }, [config.maxReferenceImageBytes, maxReferenceImages, protocolProfile.references.imageMimeTypes, referenceImages.length, showToast, t]);

  /** 将统一素材库选择结果按类型转换为参考文件，并复用当前协议校验规则。 */
  const handleImportMediaAssets = useCallback(async (selectedAssets: AssetItem[]): Promise<void> => {
    const imageAssets = selectedAssets.filter((asset): asset is ImageAsset => asset.kind === 'image' || !asset.kind);
    const videoAssets = selectedAssets.filter((asset): asset is MediaAsset => asset.kind === 'video');
    const audioAssets = selectedAssets.filter((asset): asset is MediaAsset => asset.kind === 'audio');
    /** 按工作流上限和协议 MIME 白名单读取素材二进制文件。 */
    const importFiles = async (items: MediaAsset[] | ImageAsset[], maxCount: number, currentCount: number, maxBytes: number, mimeTypes: readonly string[]): Promise<File[]> => {
      const imported: File[] = [];
      for (const asset of items.slice(0, Math.max(0, maxCount - currentCount))) {
        const blob = await getAssetBlob(asset.id);
        if (!blob) continue;
        const file = new File([blob], asset.name, { type: asset.mimeType || blob.type || 'application/octet-stream' });
        if (file.size <= maxBytes && isAllowedVideoReferenceMimeType(file.type, [...mimeTypes])) imported.push(file);
      }
      return imported;
    };
    const [images, videos, audios] = await Promise.all([
      importFiles(imageAssets, maxReferenceImages, referenceImages.length, config.maxReferenceImageBytes, protocolProfile.references.imageMimeTypes),
      importFiles(videoAssets, maxReferenceVideos, referenceVideos.length, config.maxReferenceVideoBytes, protocolProfile.references.videoMimeTypes),
      importFiles(audioAssets, maxReferenceAudios, referenceAudios.length, config.maxReferenceAudioBytes, protocolProfile.references.audioMimeTypes),
    ]);
    if (images.length) setReferenceImages(current => [...current, ...images].slice(0, maxReferenceImages));
    if (videos.length) setReferenceVideos(current => [...current, ...videos].slice(0, maxReferenceVideos));
    if (audios.length) setReferenceAudios(current => [...current, ...audios].slice(0, maxReferenceAudios));
  }, [config.maxReferenceAudioBytes, config.maxReferenceImageBytes, config.maxReferenceVideoBytes, maxReferenceAudios, maxReferenceImages, maxReferenceVideos, protocolProfile.references.audioMimeTypes, protocolProfile.references.imageMimeTypes, protocolProfile.references.videoMimeTypes, referenceAudios.length, referenceImages.length, referenceVideos.length]);

  const activeResolution = resolutionMode === 'custom' ? Number(customResolution) : resolution;
  const resolutionCapability = protocolProfile.parameters.resolution;
  const activeProtocolResolution = resolutionCapability.visible && resolutionCapability.values.includes(activeResolution)
    ? activeResolution
    : (resolutionCapability.values[0] || activeResolution);
  const sizeCapability = protocolProfile.parameters.size;
  /**
   * 根据选中的比例和清晰度同步视频尺寸及自定义宽高输入框。
   * @param ratio 目标视频比例。
   * @param resolutionValue 用于计算尺寸的清晰度数值。
   * @returns 无返回值，通过状态更新当前尺寸。
   */
  const updateVideoSizeFromAspectRatio = useCallback((ratio: string, resolutionValue: number): void => {
    setSizeAspectRatio(ratio);
    if (protocolProfile.parameters.aspectRatio.values.includes(ratio)) setAspectRatio(ratio);
    if (sizeCapability.allowCustom) {
      const dimensions = getVideoDimensionsForAspectRatio(ratio, resolutionValue);
      const parsed = getVideoSizeDimensions(dimensions);
      if (!parsed.width || !parsed.height) return;
      setVideoSize(dimensions);
      setCustomWidth(parsed.width);
      setCustomHeight(parsed.height);
      setSizeMode('custom');
      return;
    }
    const matchingPreset = sizeCapability.values.find(value => getVideoSizeAspectRatio(value) === ratio);
    if (matchingPreset) {
      const dimensions = getVideoSizeDimensions(matchingPreset);
      setVideoSize(matchingPreset);
      setCustomWidth(dimensions.width);
      setCustomHeight(dimensions.height);
      setSizeMode('preset');
    }
  }, [protocolProfile.parameters.aspectRatio.values, sizeCapability.allowCustom, sizeCapability.values]);
  const sizeAspectRatioOptions = useMemo(
    () => sizeCapability.allowCustom
      ? [...VIDEO_ASPECT_RATIO_OPTIONS]
      : VIDEO_ASPECT_RATIO_OPTIONS.filter(ratio => sizeCapability.values.some(value => getVideoSizeAspectRatio(value) === ratio)),
    [sizeCapability.allowCustom, sizeCapability.values],
  );
  const protocolAspectRatioOptions = useMemo(
    () => protocolProfile.parameters.aspectRatio.values.filter(isCommonVideoAspectRatio),
    [protocolProfile.parameters.aspectRatio.values],
  );
  const activeVideoSize = sizeMode === 'custom'
    ? `${customWidth}x${customHeight}`
    : sizeMode === 'reference'
      ? referenceImageSize
      : (sizeCapability.values.includes(videoSize) ? videoSize : (sizeCapability.values[0] || 'auto'));
  const activeAspectRatio = protocolAspectRatioOptions.some(value => value === aspectRatio)
    ? aspectRatio
    : (protocolAspectRatioOptions[0] || '');
  const activeSeconds = durationMode === 'custom'
    ? Number(customSeconds)
    : (durationOptions.includes(seconds) ? seconds : durationOptions[0]);
  const activeResolutionValid = !resolutionCapability.visible
    || resolutionCapability.values.includes(activeProtocolResolution)
    || (resolutionCapability.allowCustom && isValidVideoResolution(activeProtocolResolution));
  const activeVideoSizeValid = !sizeCapability.visible
    || sizeCapability.values.includes(activeVideoSize)
    || (sizeCapability.allowCustom && isValidVideoSize(activeVideoSize));
  const activeAspectRatioValid = !protocolProfile.parameters.aspectRatio.visible || protocolProfile.parameters.aspectRatio.values.includes(activeAspectRatio);
  const activeDurationValid = Boolean(selectedModel && isValidVideoProtocolDuration(protocolProfile, activeSeconds));
  const activeReferenceImageCountValid = referenceImages.length <= maxReferenceImages;
  const activeReferenceImageMimeTypesValid = referenceImages.every(file => isAllowedVideoReferenceMimeType(file.type, protocolProfile.references.imageMimeTypes));
  const activeReferenceImagesValid = activeReferenceImageCountValid && activeReferenceImageMimeTypesValid;
  const activeReferenceVideosValid = referenceVideos.length <= maxReferenceVideos && referenceVideos.every(file => isAllowedVideoReferenceMimeType(file.type, protocolProfile.references.videoMimeTypes));
  const activeReferenceAudiosValid = referenceAudios.length <= maxReferenceAudios && referenceAudios.every(file => isAllowedVideoReferenceMimeType(file.type, protocolProfile.references.audioMimeTypes));
  const activePromptVariants = useMemo(
    () => Array.from({ length: parallelCount }, (_, index) => promptVariants[index] || ''),
    [parallelCount, promptVariants],
  );
  const submitPromptVariants = useMemo(() => {
    const values = activePromptVariants.map(item => item.trim());
    return values.some(Boolean) ? values : undefined;
  }, [activePromptVariants]);

  /**
   * 校验表单并创建视频任务。
   * @returns 无返回值，成功后追加本地历史任务。
   */
  const handleSubmit = useCallback(async () => {
    if (!selectedModel) { onConfigureApiKey(); return; }
    if (!prompt.trim()) { showToast(t('video.promptRequired'), 'error'); return; }
    if (!activeResolutionValid) { showToast(t('video.invalidResolution'), 'error'); return; }
    if (!activeVideoSizeValid || !activeAspectRatioValid) { showToast(t('video.invalidSize'), 'error'); return; }
    if (!activeDurationValid) { showToast(t('video.invalidDuration'), 'error'); return; }
    if (!activeReferenceImageCountValid) { showToast(t('video.imageLimit', { max: maxReferenceImages }), 'error'); return; }
    if (!activeReferenceImageMimeTypesValid) { showToast(t('video.unsupportedReferenceImageFormat'), 'error'); return; }
    if (!activeReferenceVideosValid) { showToast(t('video.unsupportedReferenceVideo'), 'error'); return; }
    if (!activeReferenceAudiosValid) { showToast(t('video.unsupportedReferenceAudio'), 'error'); return; }
    const batchId = parallelCount > 1 ? generateModelId('video_batch') : undefined;
    const hasReferenceFiles = referenceImages.length + referenceVideos.length + referenceAudios.length > 0;
    const referenceStorageId = hasReferenceFiles ? generateModelId('video_refs') : undefined;
    const referenceFileSnapshot: VideoReferenceFiles = {
      images: [...referenceImages],
      videos: [...referenceVideos],
      audios: [...referenceAudios],
    };
    const batchCreatedAt = new Date().toISOString();
    const batchJobs: StoredVideoJob[] = Array.from({ length: parallelCount }, (_, batchIndex) => ({
      id: generateModelId('video_job'),
      batchId,
      batchIndex: batchId ? batchIndex : undefined,
      status: '排队中',
      prompt: prompt.trim(),
      promptVariant: submitPromptVariants?.[batchIndex],
      effectivePrompt: composeEffectiveVideoPrompt(prompt, submitPromptVariants?.[batchIndex]),
      modelId: selectedModel.id,
      modelName: selectedModel.name,
      apiModelId: getResolvedVideoModelId(requestModel || selectedModel),
      protocol: selectedModel.protocol,
      resolution: activeProtocolResolution,
      videoSize: activeVideoSize,
      aspectRatio: activeAspectRatio,
      seconds: activeSeconds,
      referenceVideos: referenceVideos.map(file => ({ name: file.name, type: file.type, size: file.size, lastModified: file.lastModified })),
      referenceAudios: referenceAudios.map(file => ({ name: file.name, type: file.type, size: file.size, lastModified: file.lastModified })),
      referenceImages: referenceImages.map(file => ({ name: file.name, type: file.type, size: file.size, lastModified: file.lastModified })),
      referenceStorageId,
      createdAt: batchCreatedAt,
    }));
    if (referenceStorageId) {
      // 内存快照保证当前页面可立即重试；IndexedDB 快照负责刷新页面后的长期恢复。
      referenceFilesRef.current.set(referenceStorageId, referenceFileSnapshot);
      const cachePromise = cacheVideoReferenceFiles(referenceStorageId, referenceFileSnapshot);
      referenceCachePromisesRef.current.set(referenceStorageId, cachePromise);
      void cachePromise.then(
        () => {
          // 持久化成功后释放大文件引用，避免任务历史增长导致页面内存持续上升。
          referenceFilesRef.current.delete(referenceStorageId);
          if (referenceCachePromisesRef.current.get(referenceStorageId) === cachePromise) {
            referenceCachePromisesRef.current.delete(referenceStorageId);
          }
        },
        error => {
          // IndexedDB 配额或权限失败时保留当前页兜底文件，刷新页面后仍按旧记录兼容为空。
          console.error('保存视频参考素材失败', error);
          referenceCachePromisesRef.current.delete(referenceStorageId);
        },
      );
    }
    setJobs(current => [...batchJobs].reverse().concat(current));
    setSubmitting(true);
    try {
      const input = { model: requestModel || selectedModel, prompt: prompt.trim(), resolution: activeProtocolResolution, size: activeVideoSize, aspectRatio: activeAspectRatio, seconds: activeSeconds, referenceImages, referenceVideos, referenceAudios, promptVariants: submitPromptVariants };
      const tasks = parallelCount > 1 ? await createVideoTasks(input, parallelCount) : [await createVideoTask(input)];
      const taskByJobId = new Map(batchJobs.map((job, index) => [job.id, tasks[index]]));
      setJobs(current => current.map(item => {
        const task = taskByJobId.get(item.id);
        return task ? { ...item, serverTaskId: task.id, createdAt: task.createdAt || item.createdAt, durationMs: task.durationMs || 0, durationUpdatedAt: new Date().toISOString() } : item;
      }));
      setReferenceImages([]);
      setReferenceVideos([]);
      setReferenceAudios([]);
      setPromptVariants([]);
      setPromptVariantsOpen(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : t('video.failed');
      const failedJobIds = new Set(batchJobs.map(job => job.id));
      setJobs(current => current.map(item => failedJobIds.has(item.id) ? { ...item, status: 'failed', completedAt: new Date().toISOString(), error: message } : item));
      showToast(message, 'error');
    } finally {
      setSubmitting(false);
    }
  }, [activeAspectRatio, activeAspectRatioValid, activeDurationValid, activeProtocolResolution, activeReferenceAudiosValid, activeReferenceImageCountValid, activeReferenceImageMimeTypesValid, activeReferenceVideosValid, activeResolutionValid, activeSeconds, activeVideoSize, activeVideoSizeValid, maxReferenceImages, onConfigureApiKey, parallelCount, prompt, referenceAudios, referenceImages, requestModel, selectedModel, referenceVideos, showToast, submitPromptVariants, t]);

  /**
   * 使用默认文本模型流式优化当前视频提示词。
   * @returns 无返回值，优化过程和结果通过弹窗状态展示。
   */
  const handleOptimize = useCallback(() => {
    if (!prompt.trim() || !promptOptimizeUsable) return;
    let textModel;
    try {
      textModel = requireDefaultConfiguredTextModel('promptOptimize');
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('workbench.configureDefaultTextModel'), 'error');
      return;
    }

    optimizeHandleRef.current?.abort();
    setOptimizedText('');
    setOptimizeError(null);
    setOptimizing(true);
    setOptimizeOpen(true);
    optimizeHandleRef.current = streamPromptOptimize(
      { apiKey: textModel.apiKey, protocol: textModel.protocol, model: textModel.modelId, mode: 'video', prompt: prompt.trim() },
      {
        onDelta(token) { setOptimizedText(current => current + token); },
        onDone() { setOptimizing(false); },
        onError(error) { setOptimizeError(error.message); setOptimizing(false); },
      },
      textModel.baseUrl,
    );
  }, [prompt, promptOptimizeUsable, showToast, t]);

  /**
   * 取消当前视频提示词优化并清理临时结果。
   * @returns 无返回值。
   */
  const handleOptimizeCancel = useCallback(() => {
    optimizeHandleRef.current?.abort();
    optimizeHandleRef.current = null;
    setOptimizing(false);
    setOptimizedText('');
    setOptimizeError(null);
  }, []);

  /**
   * 接受优化后的视频提示词并写回输入框。
   * @returns 无返回值。
   */
  const handleOptimizeAccept = useCallback(() => {
    if (optimizedText) setPrompt(optimizedText);
    optimizeHandleRef.current = null;
    setOptimizedText('');
    setOptimizeError(null);
  }, [optimizedText]);

  /**
   * 根据共享快捷键设置处理视频提示词的发送与换行。
   * @param event 视频提示词输入框的键盘事件。
   * @returns 无返回值。
   */
  const handlePromptKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isSmallViewport) return;
    const shouldSubmit = submissionShortcut === 'enter' ? !event.shiftKey : event.shiftKey;
    if (event.key === 'Enter' && shouldSubmit && !event.ctrlKey && !event.metaKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (!prompt.trim() || !modelId || submitting || restoringJobId) return;
      void handleSubmit();
    }
  }, [handleSubmit, isSmallViewport, modelId, prompt, restoringJobId, submissionShortcut, submitting]);

  /**
   * 删除任务记录和对应浏览器视频缓存。
   * @param job 待删除的视频任务。
   * @returns 无返回值。
   */
  const removeJob = useCallback((job: StoredVideoJob) => {
    videoTransferAbortControllersRef.current.get(job.id)?.abort();
    videoTransferAbortControllersRef.current.delete(job.id);
    videoRecoveryAttemptsRef.current.delete(job.id);
    downloadingVideoJobIdsRef.current.delete(job.id);
    if (job.videoUrl?.startsWith('blob:')) URL.revokeObjectURL(job.videoUrl);
    void invalidateVideoBlobCache(job.id);
    // 先同步更新引用，保证连续删除操作始终基于最新任务列表。
    const remainingJobs = jobsRef.current.filter(item => item.id !== job.id);
    jobsRef.current = remainingJobs;
    if (job.referenceStorageId) {
      const storageId = job.referenceStorageId;
      const hasSharedJob = remainingJobs.some(item => item.referenceStorageId === storageId);
      if (!hasSharedJob) {
        const pendingCache = referenceCachePromisesRef.current.get(storageId);
        void (pendingCache || Promise.resolve()).catch(() => undefined).then(() => {
          referenceFilesRef.current.delete(storageId);
          return deleteVideoReferenceFiles(storageId, {
            images: job.referenceImages,
            videos: job.referenceVideos,
            audios: job.referenceAudios,
          });
        }).catch(() => undefined);
      }
    }
    setJobs(current => current.filter(item => item.id !== job.id));
  }, [invalidateVideoBlobCache]);

  /**
   * 将视频任务实际发送给上游的完整提示词复制到系统剪贴板。
   * @param job 待复制提示词的视频任务记录。
   * @returns 无返回值；复制成功时显示成功提示和短暂的完成图标。
   */
  const copyVideoPrompt = useCallback(async (job: StoredVideoJob): Promise<void> => {
    const effectivePrompt = job.effectivePrompt || job.prompt;
    if (!effectivePrompt.trim()) return;
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error(t('task.copyPromptUnsupported'));
      }
      await navigator.clipboard.writeText(effectivePrompt);
      setCopiedPromptJobId(job.id);
      showToast(t('task.promptCopied'), 'success');
      window.setTimeout(() => {
        setCopiedPromptJobId(current => current === job.id ? null : current);
      }, 2000);
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('task.copyPromptFailed'), 'error');
    }
  }, [showToast, t]);

  /**
   * 请求后端取消排队中或处理中的视频任务，并同步本地历史终态。
   * @param job 待取消的视频任务记录。
   * @returns 无返回值；取消结果通过任务状态和全局提示展示。
   */
  const handleCancelJob = useCallback(async (job: StoredVideoJob): Promise<void> => {
    if (!job.serverTaskId || cancellingTaskIds.has(job.id)) return;
    setCancellingTaskIds(current => new Set(current).add(job.id));
    try {
      const task = await cancelVideoTask(job.serverTaskId);
      setJobs(current => current.map(item => item.id === job.id ? {
        ...item,
        status: 'cancelled',
        completedAt: task.completedAt || new Date().toISOString(),
        durationMs: task.durationMs,
        durationUpdatedAt: new Date().toISOString(),
        error: task.error || t('video.cancelled'),
      } : item));
      showToast(t('video.cancelled'), 'info');
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('video.cancelFailed'), 'error');
    } finally {
      setCancellingTaskIds(current => {
        const next = new Set(current);
        next.delete(job.id);
        return next;
      });
    }
  }, [cancellingTaskIds, showToast, t]);

  /**
   * 将历史任务参数和已缓存的参考素材完整恢复到表单。
   * @param job 待重试的视频任务。
   * @returns 素材读取和表单恢复完成后兑现的 Promise。
   */
  const restoreJob = useCallback(async (job: StoredVideoJob): Promise<void> => {
    if (restoringJobId) return;
    setRestoringJobId(job.id);
    const restoredModel = models.find(model => model.id === job.modelId);
    const emptyReferences: VideoReferenceFiles = { images: [], videos: [], audios: [] };
    let restoredReferences = emptyReferences;
    try {
      if (job.referenceStorageId) {
        try {
          await referenceCachePromisesRef.current.get(job.referenceStorageId)?.catch(() => undefined);
          const memoryReferences = referenceFilesRef.current.get(job.referenceStorageId);
          restoredReferences = memoryReferences || await restoreVideoReferenceFiles(job.referenceStorageId, {
            images: job.referenceImages,
            videos: job.referenceVideos,
            audios: job.referenceAudios,
          });
        } catch (error) {
          console.error('恢复视频参考素材失败', error);
          showToast(t('video.referenceRestoreFailed'), 'error');
          return;
        }
      }
      // 参考图可能改变模型的协议能力，必须用恢复后的素材状态计算参数模式。
      const restoredProfile = resolveVideoProtocolProfile(
        restoredModel?.protocol || 'new-api',
        restoredModel ? getResolvedVideoModelId(restoredModel) : '',
        restoredReferences.images.length > 0,
      );
      setPrompt(job.effectivePrompt || job.prompt);
      setModelId(job.modelId);
      setRemoteModelId(job.apiModelId || (restoredModel ? getResolvedVideoModelId(restoredModel) : ''));
      setResolution(job.resolution);
      setVideoSize(job.videoSize);
      const restoredDimensions = getVideoSizeDimensions(job.videoSize);
      const restoredSizeRatio = getVideoSizeAspectRatio(job.videoSize);
      setCustomWidth(restoredDimensions.width);
      setCustomHeight(restoredDimensions.height);
      setSizeAspectRatio(isCommonVideoAspectRatio(restoredSizeRatio) ? restoredSizeRatio : '16:9');
      setAspectRatio(job.aspectRatio || '16:9');
      setSeconds(job.seconds);
      setParallelCount(1);
      setPromptVariants([]);
      setPromptVariantsOpen(false);
      setReferenceImages(restoredReferences.images);
      setReferenceVideos(restoredReferences.videos);
      setReferenceAudios(restoredReferences.audios);
      const resolutionIsPreset = restoredProfile.parameters.resolution.values.includes(job.resolution);
      setResolutionMode(resolutionIsPreset ? 'preset' : 'custom');
      if (!resolutionIsPreset) setCustomResolution(String(job.resolution));
      setSizeMode(config.sizes.includes(job.videoSize) ? 'preset' : 'custom');
      const restoredDurations = getVideoProtocolDurations(restoredProfile);
      setDurationMode(restoredDurations.includes(job.seconds) ? 'preset' : 'custom');
      if (!restoredDurations.includes(job.seconds)) setCustomSeconds(String(job.seconds));
    } finally {
      setRestoringJobId(current => current === job.id ? null : current);
    }
  }, [config, models, restoringJobId, showToast, t]);

  /**
   * 清空当前提示词和全部参考附件，保留用户选择的视频参数。
   * @returns 无返回值。
   */
  const handleClearDraft = useCallback(() => {
    setPrompt('');
    setReferenceImages([]);
    setReferenceVideos([]);
    setReferenceAudios([]);
    setPromptVariants([]);
    setPromptVariantsOpen(false);
  }, []);

  const parameterButton = 'h-8 shrink-0 rounded-md border border-border bg-background px-2.5 text-xs transition-colors hover:bg-muted';
  const canClear = Boolean(prompt.trim() || activePromptVariants.some(value => value.trim()) || referenceImages.length || referenceVideos.length || referenceAudios.length);
  const canSubmit = Boolean(
    prompt.trim()
    && modelId
    && !submitting
    && !restoringJobId
    && activeResolutionValid
    && activeVideoSizeValid
    && activeAspectRatioValid
    && activeDurationValid
    && activeReferenceImagesValid
    && activeReferenceVideosValid
    && activeReferenceAudiosValid
  );
  const isGrokVideoModel = Boolean(
    selectedModel
    && (selectedModel.protocol === 'xai' || getResolvedVideoModelId(selectedModel).toLowerCase().startsWith('grok-imagine-video'))
  );
  const grokReferenceAspectRatio = activeVideoSize !== 'auto' ? getVideoSizeAspectRatio(activeVideoSize) : activeAspectRatio;
  const hasReferenceMedia = referenceImages.length + referenceVideos.length + referenceAudios.length > 0;

  return (
    <div ref={workspaceRef} className={cn('grid min-h-0 w-full min-w-0 gap-5', wideMode && 'xl:h-full xl:flex-1 xl:grid-cols-[minmax(460px,0.95fr)_minmax(0,1.35fr)]')}>
      <section className={cn('space-y-4', wideMode && 'xl:overflow-y-auto xl:pr-1')}>
        <div className="space-y-1">
          <div className="flex items-center gap-2"><Video className="size-5 text-primary" /><h2 className="text-lg font-semibold">{t('video.title')}</h2></div>
          <p className="text-sm text-muted-foreground">{t('video.subtitle')}</p>
        </div>
        <div
          className={cn('overflow-hidden rounded-xl border border-border bg-muted/50 shadow-md transition-colors', dragging && 'ring-2 ring-primary/40')}
          onDragOver={event => { event.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={event => { event.preventDefault(); setDragging(false); addReferenceFiles(Array.from(event.dataTransfer.files)); }}
        >
          <>
              <div className="p-4 pb-2">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <div className="col-span-2 flex flex-col justify-center rounded-lg border-2 border-dashed border-primary/30 bg-primary/5 px-3 py-3 transition-colors hover:border-primary/50 hover:bg-primary/[0.07] sm:col-span-4">
                    <div className="mb-3 flex items-center justify-center gap-2 text-center">
                      <CloudUpload className="size-5 text-muted-foreground" />
                      <span className="text-sm font-medium">{t('video.referenceMediaOptional')}</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                    <label htmlFor="image-reference-input" className={cn('group flex min-w-0 cursor-pointer flex-col items-center justify-center gap-1 rounded-md px-2 py-1.5 text-center hover:bg-primary/10', maxReferenceImages === 0 && 'pointer-events-none opacity-40')}>
                      <FileImage className="size-5 text-muted-foreground transition-colors group-hover:text-primary" />
                      <span className="max-w-full truncate text-xs font-medium sm:text-sm">{t('video.addImage')}</span>
                      <span className="text-[10px] text-muted-foreground">{t('video.attachmentCount', { count: referenceImages.length, max: maxReferenceImages })}</span>
                    </label>
                    <label htmlFor="video-reference-input" className={cn('group flex min-w-0 cursor-pointer flex-col items-center justify-center gap-1 rounded-md px-2 py-1.5 text-center hover:bg-primary/10', maxReferenceVideos === 0 && 'pointer-events-none opacity-40')}>
                      <FileVideo className="size-5 text-muted-foreground transition-colors group-hover:text-primary" />
                      <span className="max-w-full truncate text-xs font-medium sm:text-sm">{t('video.addVideo')}</span>
                      <span className="text-[10px] text-muted-foreground">{t('video.attachmentCount', { count: referenceVideos.length, max: maxReferenceVideos })}</span>
                    </label>
                    <label htmlFor="audio-reference-input" className={cn('group flex min-w-0 cursor-pointer flex-col items-center justify-center gap-1 rounded-md px-2 py-1.5 text-center hover:bg-primary/10', maxReferenceAudios === 0 && 'pointer-events-none opacity-40')}>
                      <FileAudio className="size-5 text-muted-foreground transition-colors group-hover:text-primary" />
                      <span className="max-w-full truncate text-xs font-medium sm:text-sm">{t('video.addAudio')}</span>
                      <span className="text-[10px] text-muted-foreground">{t('video.attachmentCount', { count: referenceAudios.length, max: maxReferenceAudios })}</span>
                    </label>
                    </div>
                  </div>
                  <button type="button" onClick={() => setMediaAssetPickerOpen(true)} disabled={referenceImages.length >= maxReferenceImages && referenceVideos.length >= maxReferenceVideos && referenceAudios.length >= maxReferenceAudios} className="col-span-2 flex min-h-14 items-center justify-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-center text-sm font-medium transition-colors hover:bg-primary/10 disabled:opacity-40 sm:col-span-4"><Images className="size-5" />{t('video.imageAssets')}</button>
                </div>
              </div>
              {(referenceImages.length > 0 || referenceVideos.length > 0 || referenceAudios.length > 0) && (
                <div className="flex flex-wrap gap-2 px-4 pb-2">
                  {referenceImages.length > 0 && <VideoReferenceImageChips files={referenceImages} prompt={prompt} onRemove={id => setReferenceImages(current => current.filter(file => `${file.name}-${file.lastModified}` !== id))} />}
                  {referenceVideos.map((file, index) => <MediaAttachmentTile key={`video-${file.name}-${file.lastModified}`} file={file} onRemove={() => setReferenceVideos(current => current.filter((_, itemIndex) => itemIndex !== index))} />)}
                  {referenceAudios.map((file, index) => <MediaAttachmentTile key={`audio-${file.name}-${file.lastModified}`} file={file} onRemove={() => setReferenceAudios(current => current.filter((_, itemIndex) => itemIndex !== index))} />)}
                </div>
              )}
              <div className="mx-3 mt-1 overflow-hidden rounded-xl border-2 border-primary/35 bg-background/70 shadow-sm transition-colors focus-within:border-primary focus-within:ring-3 focus-within:ring-primary/15 sm:mx-4">
                <label htmlFor="video-generation-prompt" className="block px-3 pt-3 text-xs font-semibold text-primary sm:px-4 sm:pt-4">{t('video.prompt')}</label>
                <Textarea id="video-generation-prompt" value={prompt} onChange={event => setPrompt(event.target.value)} onKeyDown={handlePromptKeyDown} placeholder={t('video.promptPlaceholder')} rows={6} className="min-h-40 resize-none rounded-none border-0 bg-transparent px-3 pt-2.5 placeholder:text-placeholder focus-visible:border-0 focus-visible:ring-0 sm:px-4 sm:pt-2.5" />
                <p className="px-3 pb-3 text-xs text-muted-foreground sm:px-4" aria-live="polite">{t('workbench.shortcutHint', { submission: shortcutLabels.submission, newline: shortcutLabels.newline })}</p>
              </div>
              {isGrokVideoModel && hasReferenceMedia && grokReferenceAspectRatio && (
                <div className="mx-3 mt-2 flex items-start gap-2 rounded-md border border-amber-300/60 bg-amber-50/70 px-2.5 py-2 text-left text-[11px] leading-relaxed text-amber-900 dark:border-amber-400/30 dark:bg-amber-950/30 dark:text-amber-100 sm:mx-4">
                  <Info className="mt-0.5 size-3.5 shrink-0" />
                  <span>{t('video.grokReferenceAspectNotice', { ratio: grokReferenceAspectRatio })}</span>
                </div>
              )}
              <div className="px-3 pb-2 pt-2 sm:px-4">
                <div className="rounded-xl border border-border bg-muted/30 p-3 sm:p-4">
                  <button type="button" className="flex w-full items-center justify-between text-left" onClick={() => setParametersExpanded(current => !current)} aria-expanded={parametersExpanded} aria-controls="video-generation-params-content">
                    <span className="flex items-center gap-2 text-sm font-semibold"><SlidersHorizontal className="size-4 text-primary" />{t('workbench.generationParams')}</span>
                    <ChevronDown className={cn('size-4 text-muted-foreground transition-transform', parametersExpanded && 'rotate-180')} />
                  </button>
                  <div id="video-generation-params-content" className={cn('mt-4 space-y-3', !parametersExpanded && 'hidden')}>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <label className="text-xs font-medium text-muted-foreground">{t('workbench.channel')}</label>
                        <Select<string> value={modelId} onValueChange={handleModelChange} size="sm" disabled={models.length === 0} options={models.map(model => ({ value: model.id, label: model.name }))} placeholder={t('common.notConfigured')} />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-xs font-medium text-muted-foreground">{t('workbench.model')}</label>
                        <div className="flex min-w-0 gap-1.5">
                          <Select<string> value={remoteModelId} onValueChange={handleRemoteModelChange} size="sm" disabled={!selectedModel || remoteModelOptions.length === 0} options={remoteModelOptions.map(option => ({ value: option.id, label: option.name === option.id ? option.id : `${option.name} (${option.id})` }))} placeholder={t('workbench.selectRemoteModel')} className="min-w-0 flex-1" />
                          <button
                            type="button"
                            onClick={() => void handleRefreshModels()}
                            disabled={!selectedModel || refreshingModels}
                            aria-label={t('workbench.refreshModels')}
                            title={t('workbench.refreshModels')}
                            className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <RefreshCw className={cn('size-3.5', refreshingModels && 'animate-spin')} />
                          </button>
                        </div>
                      </div>
                    </div>
                    <div data-testid="video-parameter-grid" className="space-y-4">
                  {resolutionCapability.visible && <div className="min-w-0 space-y-1.5">
                    <span className="flex h-5 items-center gap-1 text-xs font-medium text-muted-foreground"><ScanLine data-testid="video-resolution-icon" className="size-3" />{t('video.resolution')}</span>
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                      {resolutionCapability.values.map(value => <button type="button" key={value} className={cn(parameterButton, resolutionMode === 'preset' && activeProtocolResolution === value && 'border-primary bg-primary/10 text-primary')} onClick={() => { setResolution(value); setResolutionMode('preset'); updateVideoSizeFromAspectRatio(sizeAspectRatio, value); }}>{getVideoResolutionLabel(value)}</button>)}
                      {resolutionCapability.allowCustom && <Input className="h-8 w-24 shrink-0 rounded-md px-2 text-xs" inputMode="numeric" value={customResolution} placeholder={t('video.customResolution')} onChange={event => { setCustomResolution(event.target.value); const value = Number(event.target.value); if (isValidVideoResolution(value)) { setResolution(value); setResolutionMode('custom'); updateVideoSizeFromAspectRatio(sizeAspectRatio, value); } }} />}
                    </div>
                  </div>}
                  <div className="min-w-0 space-y-1.5">
                    <span className="flex h-5 items-center gap-1 text-xs font-medium text-muted-foreground"><Clock3 className="size-3" />{t('video.seconds')}</span>
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                      {durationOptions.map(value => <button type="button" key={value} className={cn(parameterButton, durationMode === 'preset' && activeSeconds === value && 'border-primary bg-primary/10 text-primary')} onClick={() => { setSeconds(value); setDurationMode('preset'); }}>{value}s</button>)}
                      {protocolProfile.parameters.duration.mode === 'range' && <Input className="h-8 w-28 shrink-0 rounded-md px-2 text-xs" inputMode="numeric" value={customSeconds} placeholder={durationPlaceholder} onChange={event => { setCustomSeconds(event.target.value); const value = Number(event.target.value); if (isValidVideoDuration(value)) { setSeconds(value); setDurationMode('custom'); } }} />}
                    </div>
                  </div>
                  {sizeCapability.visible && <div className="min-w-0 space-y-1.5">
                    <span className="flex h-5 items-center gap-1 text-xs font-medium text-muted-foreground"><Maximize className="size-3" />{t('video.size')}</span>
                    <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
                      {sizeAspectRatioOptions.map(ratio => {
                        const selected = sizeAspectRatio === ratio;
                        return (
                          <button type="button" key={ratio} aria-label={ratio} onClick={() => updateVideoSizeFromAspectRatio(ratio, activeProtocolResolution)} className={cn('relative flex h-24 min-w-0 flex-col items-center justify-between rounded-md border border-border bg-background px-2.5 py-3 text-center text-xs transition-colors hover:bg-muted', selected && 'border-primary bg-primary/10 font-medium text-primary')}>
                            {selected && <Check className="absolute right-1.5 top-1.5 size-3" />}
                            <span className="flex min-h-0 flex-1 items-center justify-center"><VideoAspectRatioPreview ratio={ratio} selected={selected} /></span>
                            <span className="mt-1 shrink-0 font-medium">{ratio}</span>
                          </button>
                        );
                      })}
                      {referenceImageSize && <button type="button" aria-label={`${getVideoSizeAspectRatio(referenceImageSize) || t('video.referenceImageSize')} ${referenceImageSize}`} onClick={() => { const dimensions = getVideoSizeDimensions(referenceImageSize); setSizeAspectRatio(getVideoSizeAspectRatio(referenceImageSize) || sizeAspectRatio); setVideoSize(referenceImageSize); setCustomWidth(dimensions.width); setCustomHeight(dimensions.height); setSizeMode('reference'); }} className={cn('relative flex h-24 min-w-0 flex-col items-center justify-between rounded-md border border-border bg-background px-2.5 py-3 text-center text-xs transition-colors hover:bg-muted', sizeMode === 'reference' && 'border-primary bg-primary/10 font-medium text-primary')}>
                        {sizeMode === 'reference' && <Check className="absolute right-1.5 top-1.5 size-3" />}
                        <span className="flex min-h-0 flex-1 items-center justify-center"><VideoSizePreview size={referenceImageSize} selected={sizeMode === 'reference'} /></span>
                        <span className="mt-1 shrink-0 font-medium">{getVideoSizeAspectRatio(referenceImageSize) || t('video.referenceImageSize')}</span>
                        <span className="shrink-0 text-[10px] leading-4 text-muted-foreground">{referenceImageSize}</span>
                      </button>}
                    </div>
                    {sizeCapability.allowCustom && <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-end gap-2 pt-1">
                      <label className="space-y-1"><span className="text-[11px] text-muted-foreground">{t('video.customWidth')}</span><Input className="h-8 w-full rounded-md px-2 text-xs" inputMode="numeric" value={customWidth} placeholder={t('video.customWidth')} onChange={event => { const width = event.target.value; setCustomWidth(width); const value = `${width}x${customHeight}`; if (isValidVideoSize(value)) { setVideoSize(value); setSizeMode('custom'); const ratio = getVideoSizeAspectRatio(value); if (isCommonVideoAspectRatio(ratio)) { setSizeAspectRatio(ratio); if (protocolProfile.parameters.aspectRatio.values.includes(ratio)) setAspectRatio(ratio); } } }} /></label>
                      <span className="pb-2 text-sm text-muted-foreground">×</span>
                      <label className="space-y-1"><span className="text-[11px] text-muted-foreground">{t('video.customHeight')}</span><Input className="h-8 w-full rounded-md px-2 text-xs" inputMode="numeric" value={customHeight} placeholder={t('video.customHeight')} onChange={event => { const height = event.target.value; setCustomHeight(height); const value = `${customWidth}x${height}`; if (isValidVideoSize(value)) { setVideoSize(value); setSizeMode('custom'); const ratio = getVideoSizeAspectRatio(value); if (isCommonVideoAspectRatio(ratio)) { setSizeAspectRatio(ratio); if (protocolProfile.parameters.aspectRatio.values.includes(ratio)) setAspectRatio(ratio); } } }} /></label>
                    </div>}
                  </div>}
                  {protocolProfile.parameters.aspectRatio.visible && <div className="min-w-0 space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">{t('video.aspectRatio')}</label>
                    <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                      {protocolAspectRatioOptions.map(value => <button type="button" key={value} aria-label={value} onClick={() => setAspectRatio(value)} className={cn('relative flex h-24 flex-col items-center justify-between rounded-md border border-border bg-background px-2.5 py-3 text-xs transition-colors hover:bg-muted', activeAspectRatio === value && 'border-primary bg-primary/10 font-medium text-primary')}>
                        {activeAspectRatio === value && <Check className="absolute right-1.5 top-1.5 size-3" />}
                        <span className="flex min-h-0 flex-1 items-center justify-center"><span className="block shrink-0 rounded-[2px] border-2 border-current" style={getVideoAspectRatioPreviewDimensions(value)} /></span>
                        <span className="shrink-0 text-[10px] leading-4 text-muted-foreground">{value}</span>
                      </button>)}
                    </div>
                  </div>}
                  <div className="space-y-1.5">
                    <label className="flex items-center gap-1 text-xs font-medium text-muted-foreground"><Copy className="size-3" />{t('video.quantity')}</label>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Popover open={parallelPopoverOpen} onOpenChange={setParallelPopoverOpen}>
                        <PopoverTrigger className={cn(parameterButton, 'inline-flex min-w-16 items-center justify-between gap-2', parallelCount > 1 && 'border-primary bg-primary/10 text-primary')} aria-label={t('video.quantity')}>
                          <span className="font-medium">x{parallelCount}</span>
                          <ChevronDown className={cn('size-3 transition-transform', parallelPopoverOpen && 'rotate-180')} />
                        </PopoverTrigger>
                        <PopoverContent className="w-56 p-2" align="start">
                          <div className="grid grid-cols-5 gap-1">
                            {PARALLEL_COUNT_OPTIONS.map(count => <button type="button" key={count} onClick={() => handleParallelCountChange(count)} className={cn('flex h-8 items-center justify-center rounded-md border border-transparent text-sm hover:bg-muted', parallelCount === count && 'border-primary bg-primary/10 font-medium text-primary')}>{count}</button>)}
                          </div>
                        </PopoverContent>
                      </Popover>
                    </div>
                  </div>
                </div>
                  </div>
                </div>
              </div>
              {parallelCount > 1 && (
                <div className="px-3 pb-2 sm:px-4">
                  <button
                    type="button"
                    onClick={() => setPromptVariantsOpen(open => !open)}
                    className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <span className="font-medium">
                      {t('video.perVideoInstructions')}
                      {submitPromptVariants && <span className="ml-1 font-normal text-primary">{submitPromptVariants.filter(Boolean).length}/{parallelCount}</span>}
                    </span>
                    <ChevronDown className={cn('size-3.5 transition-transform', promptVariantsOpen && 'rotate-180')} />
                  </button>
                  {promptVariantsOpen && (
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      {activePromptVariants.map((value, index) => (
                        <Textarea
                          key={index}
                          value={value}
                          onChange={event => handlePromptVariantChange(index, event.target.value)}
                          placeholder={t('video.additionalInstructionPlaceholder', { index: index + 1 })}
                          rows={2}
                          className="min-h-14 resize-none text-xs placeholder:text-placeholder"
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}
              {models.length === 0 && (
                <div className="mx-3 mb-2 flex flex-col gap-3 rounded-lg border border-primary/25 bg-primary/5 px-3 py-2.5 sm:mx-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 items-start gap-2.5">
                    <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                      <Info className="size-4" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground">{t('video.modelRequiredTitle')}</p>
                      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{t('video.modelRequiredDescription')}</p>
                    </div>
                  </div>
                  <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={onConfigureApiKey}>
                    {t('video.configureVideoModel')}
                  </Button>
                </div>
              )}
              <div className="sticky bottom-0 z-20 ml-auto flex w-full justify-end gap-2 border-t border-border/70 bg-muted/95 px-3 py-2 backdrop-blur-sm sm:w-auto sm:px-4">
                <PromptSubmissionShortcutMenu value={submissionShortcut} isSmallViewport={isSmallViewport} onValueChange={updateSubmissionShortcut} />
                <Button type="button" variant="ghost" size="icon" onClick={handleOptimize} disabled={!prompt.trim() || !promptOptimizeUsable} title={promptOptimizeUsable ? t('workbench.optimizePrompt') : promptOptimizeAvailable ? t('workbench.enablePromptOptimizeSetting') : t('workbench.configureDefaultTextModel')}><Sparkles className="size-4" /></Button>
                <Button type="button" variant="outline" size="icon" onClick={handleClearDraft} disabled={!canClear} title={t('workbench.clearDraft')}><X className="size-5" /></Button>
                <Button type="button" size="icon" onClick={() => void handleSubmit()} disabled={!canSubmit} title={models.length === 0 ? t('video.configureVideoModel') : t('video.generate')}>{submitting ? <Loader2 className="size-5 animate-spin" /> : <ArrowUp className="size-5" />}</Button>
              </div>
              <input id="image-reference-input" hidden type="file" accept={protocolProfile.references.imageMimeTypes.join(',')} multiple onChange={event => { addReferenceFiles(Array.from(event.target.files || [])); event.target.value = ''; }} />
              <input id="video-reference-input" hidden type="file" accept={protocolProfile.references.videoMimeTypes.join(',')} multiple onChange={event => { addReferenceFiles(Array.from(event.target.files || [])); event.target.value = ''; }} />
              <input id="audio-reference-input" hidden type="file" accept={protocolProfile.references.audioMimeTypes.join(',')} multiple onChange={event => { addReferenceFiles(Array.from(event.target.files || [])); event.target.value = ''; }} />
          </>
        </div>
      </section>

      <section className={cn('min-h-80 rounded-lg border bg-muted/20 p-3 sm:p-4', wideMode && 'xl:h-full xl:overflow-y-auto')}>
        <div className="mb-4 flex items-center justify-between"><h2 className="font-semibold">{t('video.history')}</h2><span className="text-xs text-muted-foreground">{jobs.length}</span></div>
        {jobs.length === 0 ? <div className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">{t('video.emptyHistory')}</div> : <div className="space-y-3">{jobs.map(job => (
          <article key={job.id} className="overflow-hidden rounded-lg border bg-card">
            {job.status === 'completed' && (job.videoUrl || (getVideoJobSourceUrl(job) && !job.cached)) ? <div className="relative">
              <video
                key={job.videoUrl || getVideoJobSourceUrl(job)}
                className="aspect-video w-full bg-black object-contain"
                src={job.videoUrl || getVideoJobSourceUrl(job)}
                controls
                playsInline
                preload="metadata"
                onCanPlay={() => handleVideoCanPlay(job.id)}
                onError={() => handleVideoPlaybackError(job.id)}
              />
              {videoPlaybackStates[job.id] === 'repairing' && <div className="absolute inset-x-0 bottom-0 bg-black/70 px-3 py-2 text-center text-xs text-white">{t('video.reloading')}</div>}
              {videoPlaybackStates[job.id] === 'error' && <div className="absolute inset-x-0 bottom-0 bg-black/70 px-3 py-2 text-center text-xs text-destructive-foreground">{t('video.playbackFailed')}</div>}
            </div> : <div className="flex aspect-video items-center justify-center bg-muted"><div className="flex items-center gap-2 text-sm text-muted-foreground">{job.status === 'failed' || job.status === 'cancelled' ? <X className="size-5 text-destructive" /> : <Loader2 className="size-5 animate-spin" />}{job.status === 'cancelled' ? t('video.cancelled') : job.status === 'failed' ? t('video.failed') : job.status === 'completed' && job.cached ? t('video.caching') : job.status === '排队中' ? t('video.queued') : t('video.processing')}</div></div>}
            <div className="space-y-3 p-3">
              {job.batchId && typeof job.batchIndex === 'number' && <p className="text-xs font-medium text-primary">{t('video.batchVideo', { index: job.batchIndex + 1 })}</p>}
              <div className="flex items-start gap-2">
                <p className="min-w-0 flex-1 line-clamp-3 whitespace-pre-line text-sm">{job.effectivePrompt || job.prompt}</p>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0"
                  onClick={() => void copyVideoPrompt(job)}
                  disabled={!(job.effectivePrompt || job.prompt).trim()}
                  title={t('task.copyPrompt')}
                  aria-label={t('task.copyPrompt')}
                >
                  {copiedPromptJobId === job.id ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
                </Button>
              </div>
              <dl className="grid min-w-0 grid-cols-2 gap-x-3 gap-y-2 border-y py-2 text-xs sm:grid-cols-4">
                <div className="min-w-0"><dt className="text-muted-foreground">{t('workbench.channel')}</dt><dd className="truncate font-medium text-foreground" title={job.modelName || models.find(model => model.id === job.modelId)?.name || job.modelId}>{job.modelName || models.find(model => model.id === job.modelId)?.name || job.modelId}</dd></div>
                <div className="min-w-0"><dt className="text-muted-foreground">{t('workbench.model')}</dt><dd className="truncate font-mono text-[11px] font-medium text-foreground" title={getVideoJobApiModelId(job, models)}>{getVideoJobApiModelId(job, models)}</dd></div>
                <div className="min-w-0"><dt className="text-muted-foreground">{t('video.resolution')}</dt><dd className="font-medium text-foreground">{getVideoResolutionLabel(job.resolution)}</dd></div>
                <div className="min-w-0"><dt className="text-muted-foreground">{t('video.seconds')}</dt><dd className="flex items-center gap-1 font-medium text-foreground"><Clock3 className="size-3" />{job.seconds}s</dd></div>
                <div className="min-w-0"><dt className="text-muted-foreground">{t('video.size')}</dt><dd className="font-medium text-foreground">{job.videoSize || '--'}</dd></div>
                <div className="min-w-0"><dt className="text-muted-foreground">{t('video.totalDuration')}</dt><dd className="font-medium text-foreground">{formatVideoJobDuration(job.durationMs, job.durationUpdatedAt, job.status === '排队中' || job.status === 'processing', job.createdAt, job.completedAt, durationNowMs, locale)}</dd></div>
                <div className="col-span-2 min-w-0 sm:col-span-4"><dt className="text-muted-foreground">{t('video.taskId')}</dt><dd className="select-all break-all font-mono text-[11px] text-foreground">{job.serverTaskId || t('video.taskIdPending')}</dd></div>
              </dl>
              <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">{job.aspectRatio && <span>{job.aspectRatio}</span>}<span>{t('video.createdAt', { time: formatJobTime(job.createdAt, locale) })}</span></div>
              {job.error && <p className="rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">{job.error}</p>}
              <div className="flex flex-wrap gap-2">
                {job.status === 'completed' && (job.videoUrl || (getVideoJobSourceUrl(job) && !job.cached)) && <Button variant="outline" size="sm" className="gap-2" disabled={downloadingVideoJobIds.has(job.id)} onClick={() => void handleDownloadVideo(job)}>{downloadingVideoJobIds.has(job.id) ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}{t('video.download')}</Button>}
                {job.status === 'completed' && (job.videoUrl || getVideoJobSourceUrl(job)) && <Button variant="outline" size="sm" className="gap-2" onClick={() => void handleSaveVideoToAssets(job)}><FolderPlus className="size-4" />{t('task.saveToAssets')}</Button>}
                {job.status === 'completed' && videoPlaybackStates[job.id] === 'error' && getVideoJobSourceUrl(job) && <Button variant="outline" size="sm" className="gap-2" onClick={() => handleReloadVideo(job)}><RefreshCw className="size-4" />{t('video.reload')}</Button>}
                {(job.status === '排队中' || job.status === 'processing') && <Button variant="outline" size="sm" className="gap-2" onClick={() => void refreshPendingJobs()}><RefreshCw className="size-4" />{t('video.checkStatus')}</Button>}
                {(job.status === '排队中' || job.status === 'processing') && job.serverTaskId && <Button variant="outline" size="sm" className="gap-2 text-destructive hover:text-destructive" disabled={cancellingTaskIds.has(job.id)} onClick={() => void handleCancelJob(job)}>{cancellingTaskIds.has(job.id) ? <Loader2 className="size-4 animate-spin" /> : <CircleStop className="size-4" />}{t('video.cancel')}</Button>}
                <Button variant="outline" size="sm" className="gap-2" disabled={Boolean(restoringJobId)} onClick={() => void restoreJob(job)}>{restoringJobId === job.id ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}{t('video.retry')}</Button>
                {job.status !== '排队中' && job.status !== 'processing' && <Button variant="ghost" size="sm" className="ml-auto gap-2 text-destructive" onClick={() => removeJob(job)}><Trash2 className="size-4" />{t('video.remove')}</Button>}
              </div>
            </div>
          </article>
        ))}</div>}
      </section>
      <AgentAssetPickerDialog
        open={assetPickerOpen}
        maxSelected={Math.max(1, maxReferenceImages - referenceImages.length)}
        onOpenChange={setAssetPickerOpen}
        onConfirm={assets => void handleImportImageAssets(assets)}
      />
      <UnifiedAssetPickerDialog
        open={mediaAssetPickerOpen}
        maxSelected={Math.max(1, maxReferenceImages - referenceImages.length + maxReferenceVideos - referenceVideos.length + maxReferenceAudios - referenceAudios.length)}
        onOpenChange={setMediaAssetPickerOpen}
        onConfirm={assets => void handleImportMediaAssets(assets)}
      />
      <PromptOptimizeDialog
        open={optimizeOpen}
        onOpenChange={setOptimizeOpen}
        originalPrompt={prompt}
        optimizedPrompt={optimizedText}
        loading={optimizing}
        error={optimizeError}
        onAccept={handleOptimizeAccept}
        onCancel={handleOptimizeCancel}
      />
    </div>
  );
}
