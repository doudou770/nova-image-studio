'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  CheckCircle2,
  ChevronsUpDown,
  Database,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  ImageIcon,
  Info,
  Plus,
  RefreshCw,
  Save,
  Settings,
  Trash2,
  Upload,
  Video,
  XCircle,
} from 'lucide-react';
import { Combobox } from '@base-ui/react/combobox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { BackupProgress } from '@/components/BackupProgress';
import {
  BUILTIN_IMAGE_PRESETS,
  applyBuiltinImagePresetModelIds,
  BUILTIN_IMAGE_PRESET_OPTIONS,
  DEFAULT_DEFAULTS,
  generateModelId,
  getDefaultTextModelTemplate,
  getCompleteImageModels,
  getCompleteVideoModels,
  getImageModelOutputSizes,
  getResolvedImageModelId,
  isCompleteVideoModel,
  isXaiImaginePresetId,
  loadRegistry,
  saveRegistry,
  type DefaultModels,
  type ImageModelConfig,
  type ProviderProtocol,
  type TextModelConfig,
  type VideoModelConfig,
  type PublicVideoProtocol,
  type VideoProtocol,
} from '@/lib/flyreq-models';
import {
  getExternalImageModelMatch,
  getExternalTextModelMatch,
  getExternalVideoModelMatch,
  type ExternalImageModelConfig,
  type ExternalModelConfig,
  type ExternalTextModelConfig,
  type ExternalVideoModelConfig,
} from '@/lib/external-model-config';
import { syncDynamicModelExports } from '@/lib/gemini-config';
import { exportAllData, importAllData, downloadBlob, generateBackupFilename, type BackupProgress as BackupProgressType } from '@/lib/backup-utils';
import { checkModelsAvailability, fetchRemoteModels, type ModelStatus, type RemoteModelOption } from '@/lib/flyreq-task-client';
import { hasConfiguredImageModel, isPromptOptimizeEnabled, setPromptOptimizeEnabled } from '@/lib/settings-storage';
import { saveFirstImageModelAsFormDefault } from '@/lib/form-settings';
import { notifyImageModelDefaultUpdated } from '@/hooks/useImageModelDefaultRefresh';
import { BA_RANDOM_URL, BING_WALLPAPER_URL, IMAGE_MODEL_KEY_GUIDE } from '@/lib/constants';
import { PROMPT_DATA_SOURCES, getPromptSourceLabel } from '@/lib/prompt-gallery-data';
import { getOutputSizeLabel } from '@/lib/model-capabilities';
import { getVideoProtocolConfig } from '@/lib/video-config';
import { useBranding } from '@/components/BrandProvider';
import { useI18n } from '@/components/LanguageProvider';
import { clearModelCatalogCache, getModelCatalogCache, isModelCatalogCacheStale, loadModelCatalogCache, pruneModelCatalogCache, saveModelCatalogCache } from '@/lib/model-catalog-cache';

type ImageModelKeyGuide = typeof IMAGE_MODEL_KEY_GUIDE;

/**
 * 从后端下发的协议能力配置读取设置页模板。
 * @param protocol 设置页选择的公开视频协议。
 * @returns 当前部署为该协议配置的基础地址与预设模型 ID。
 */
function getVideoProtocolTemplate(protocol: VideoProtocol): { baseUrl: string; presetModelId: string } {
  return getVideoProtocolConfig().protocols[protocol].settings;
}

/**
 * 读取视频协议的创建接口，并兼容尚未下发接口元数据的后端配置。
 * @param protocol 当前视频模型协议。
 * @returns 创建视频使用的固定请求方法与接口路径。
 */
function getVideoCreateEndpoint(protocol: VideoProtocol): { method: 'POST'; path: string } {
  const configuredEndpoint = getVideoProtocolConfig().protocols[protocol]?.createEndpoint;
  if (configuredEndpoint) return configuredEndpoint;
  if (protocol === 'new-api') return { method: 'POST', path: '/v1/video/generations' };
  if (protocol === 'openai') return { method: 'POST', path: '/v1/videos' };
  return { method: 'POST', path: '/v1/videos/generations' };
}

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onApiKeyChange?: (hasKey: boolean) => void;
  externalModelConfig?: ExternalModelConfig | null;
  onExternalModelConfigConsumed?: () => void;
}

function cloneImageModel(model: ImageModelConfig): ImageModelConfig {
  return { ...model };
}

function cloneTextModel(model: TextModelConfig): TextModelConfig {
  return { ...model };
}

interface SettingsDraftSnapshot {
  imageModels: ImageModelConfig[];
  videoModels: VideoModelConfig[];
  textModels: TextModelConfig[];
  defaults: DefaultModels;
  promptOptimizeEnabled: boolean;
}

interface ModelCatalogState {
  loading: boolean;
  options: RemoteModelOption[];
  error: string | null;
  loaded: boolean;
  fetchedAt?: number;
}

interface ModelCatalogControlsProps {
  state?: ModelCatalogState;
  catalogId: string;
  modelId: string;
  modelIdLabel: string;
  modelIdPlaceholder?: string;
  modelIdHint?: string;
  fetchLabel: string;
  fetchingLabel: string;
  successMessage: string;
  emptyMessage: string;
  staleMessage: string;
  onFetch: () => void;
  onModelIdChange: (modelId: string) => void;
}

/**
 * 渲染单个模型配置的模型 ID 输入、远端模型获取和候选建议。
 * @param props 模型目录标识、模型 ID、按钮文案、目录状态及编辑和获取回调。
 * @returns 可复用于图片、视频和文本模型的目录选择控件。
 */
function ModelCatalogControls({ state, catalogId, modelId, modelIdLabel, modelIdPlaceholder, modelIdHint, fetchLabel, fetchingLabel, successMessage, emptyMessage, staleMessage, onFetch, onModelIdChange }: ModelCatalogControlsProps) {
  const modelListId = `model-catalog-${catalogId}`;
  const catalogOptions = useMemo(() => {
    const options = [...(state?.options || [])];
    if (modelId.trim() && !options.some(option => option.id === modelId)) {
      options.unshift({ id: modelId, name: modelId });
    }
    return options;
  }, [modelId, state?.options]);
  const selectedOption = catalogOptions.find(option => option.id === modelId) || null;
  const optionLabel = (option: RemoteModelOption) => option.name === option.id ? option.id : `${option.name} (${option.id})`;

  return (
    <div className="space-y-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1 space-y-1.5">
          <label className="text-xs text-muted-foreground">{modelIdLabel}</label>
          <Combobox.Root
            id={modelListId}
            items={catalogOptions}
            value={selectedOption}
            onValueChange={(option) => {
              if (option) onModelIdChange(option.id);
            }}
            itemToStringLabel={(option) => option ? optionLabel(option) : ''}
            itemToStringValue={(option) => option?.id || ''}
          >
            <div className="relative">
              <Combobox.Input aria-label={modelIdLabel} placeholder={modelIdPlaceholder} className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 py-1 pr-9 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30" />
              <Combobox.Trigger aria-label={modelIdLabel} className="absolute top-1/2 right-1 flex size-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground">
                <ChevronsUpDown className="size-3.5" />
              </Combobox.Trigger>
            </div>
            <Combobox.Portal>
              <Combobox.Positioner sideOffset={4} className="z-[70] outline-none">
                <Combobox.Popup className="max-h-[min(24rem,var(--available-height))] min-w-[var(--anchor-width)] overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none">
                  <Combobox.List>
                    {(option: RemoteModelOption, index: number) => (
                      <Combobox.Item key={option.id} value={option} index={index} className="relative flex cursor-pointer items-center gap-2 rounded-md py-1.5 pr-8 pl-2.5 text-sm outline-none select-none data-[highlighted]:bg-muted">
                        <span className="truncate">{optionLabel(option)}</span>
                        <Combobox.ItemIndicator className="absolute right-2 flex items-center text-primary">
                          <Check className="size-4" />
                        </Combobox.ItemIndicator>
                      </Combobox.Item>
                    )}
                  </Combobox.List>
                </Combobox.Popup>
              </Combobox.Positioner>
            </Combobox.Portal>
          </Combobox.Root>
        </div>
        <Button type="button" variant="outline" size="default" className="shrink-0 gap-2 sm:mb-1.5" disabled={state?.loading} onClick={onFetch}>
          <RefreshCw className={`size-4 ${state?.loading ? 'animate-spin' : ''}`} />
          {state?.loading ? fetchingLabel : fetchLabel}
        </Button>
      </div>
      {modelIdHint && <p className="text-xs text-muted-foreground">{modelIdHint}</p>}
      {state?.error && <p className="text-xs text-destructive">{state.error}</p>}
      {state?.loaded && state.options.length === 0 && <p className="text-xs text-muted-foreground">{emptyMessage}</p>}
      {state?.fetchedAt && isModelCatalogCacheStale(state.fetchedAt) && <p className="text-xs text-amber-600 dark:text-amber-400">{staleMessage}</p>}
      {state && state.options.length > 0 && <p className="text-xs text-muted-foreground">{successMessage}</p>}
    </div>
  );
}

/**
 * 创建用于判断设置是否变化的表单快照。
 * @param imageModels 当前图片模型草稿。
 * @param videoModels 当前视频模型草稿。
 * @param textModels 当前文本模型草稿。
 * @param defaults 当前默认模型选择。
 * @param promptOptimizeEnabled 当前提示词优化开关状态。
 * @returns 与持久化设置字段一一对应的独立快照。
 */
function createSettingsSnapshot(
  imageModels: ImageModelConfig[],
  videoModels: VideoModelConfig[],
  textModels: TextModelConfig[],
  defaults: DefaultModels,
  promptOptimizeEnabled: boolean,
): SettingsDraftSnapshot {
  return {
    imageModels: imageModels.map(cloneImageModel),
    videoModels: videoModels.map(cloneVideoModel),
    textModels: textModels.map(cloneTextModel),
    defaults: { ...defaults },
    promptOptimizeEnabled,
  };
}

/**
 * 将设置快照序列化为可稳定比较的字符串。
 * @param snapshot 待序列化的设置快照。
 * @returns 保留模型顺序和全部配置字段的 JSON 字符串。
 */
function serializeSettingsSnapshot(snapshot: SettingsDraftSnapshot): string {
  return JSON.stringify(snapshot);
}

/**
 * 创建视频模型配置副本。
 * @param model 原始视频模型。
 * @returns 可在设置表单中独立修改的副本。
 */
function cloneVideoModel(model: VideoModelConfig): VideoModelConfig {
  return { ...model };
}

/**
 * 创建新增视频模型的默认草稿。
 * @returns 使用 OpenAI Videos 协议的未完成视频模型配置。
 */
function createVideoModelDraft(): VideoModelConfig {
  const template = getVideoProtocolTemplate('openai');
  return {
    id: generateModelId('video'),
    protocol: 'openai',
    name: '',
    modelId: '',
    usesPresetModelId: true,
    presetModelId: template.presetModelId,
    apiKey: '',
    baseUrl: template.baseUrl,
  };
}

/**
 * 切换视频协议并保留用户已经填写的全部可见配置。
 * @param model 当前视频模型配置。
 * @param protocol 用户选择的新视频协议。
 * @returns 仅更新协议与对应隐藏预设信息的视频模型副本。
 */
export function patchVideoModelProtocol(model: VideoModelConfig, protocol: PublicVideoProtocol): VideoModelConfig {
  const template = getVideoProtocolTemplate(protocol);
  return {
    ...model,
    protocol,
    presetModelId: template.presetModelId,
    usesPresetModelId: model.modelId.trim() ? undefined : Boolean(template.presetModelId) || undefined,
  };
}

/**
 * 创建新增图片模型的默认草稿。
 * @returns 使用默认内置预设的未完成配置。
 */
function createImageModelDraft(): ImageModelConfig {
  const preset = BUILTIN_IMAGE_PRESETS['gpt-image-2'];
  return {
    id: generateModelId('img'),
    protocol: preset.protocol,
    name: '',
    modelId: '',
    usesPresetModelId: true,
    apiKey: '',
    baseUrl: preset.baseUrl,
    builtinPreset: preset.id,
    maxRefImages: preset.maxRefImages,
    maxOutputSize: preset.maxOutputSize,
    supportsAdvancedParams: preset.supportsAdvancedParams,
    supportsTemperature: false,
    streamImages: true,
  };
}

function getExternalImagePresetId(config: ExternalImageModelConfig, fallback: ImageModelConfig['builtinPreset']) {
  if (config.preset) return config.preset;
  return isXaiImaginePresetId(config.modelId || '')
    ? config.modelId as ImageModelConfig['builtinPreset']
    : fallback;
}

function createExternalImageModelDraft(config: ExternalImageModelConfig): ImageModelConfig {
  const preset = BUILTIN_IMAGE_PRESETS[getExternalImagePresetId(config, 'gpt-image-2')];
  const isXaiImagine = isXaiImaginePresetId(preset.id);
  const protocol = isXaiImagine ? preset.protocol : (config.protocol || preset.protocol);
  const isGptImage = preset.id === 'gpt-image-2';
  const configuredModelId = config.modelId?.trim() || '';
  const usesPresetModelId = !configuredModelId || configuredModelId === preset.modelId;
  return {
    id: config.modelKey || generateModelId('img'),
    protocol,
    name: config.name || preset.name,
    modelId: usesPresetModelId ? '' : (configuredModelId || preset.modelId),
    usesPresetModelId: usesPresetModelId || undefined,
    apiKey: config.apiKey || '',
    baseUrl: config.baseUrl || preset.baseUrl,
    builtinPreset: preset.id,
    maxRefImages: isXaiImagine ? preset.maxRefImages : (config.maxRefImages || preset.maxRefImages),
    maxOutputSize: isXaiImagine && config.maxOutputSize !== '1K' ? preset.maxOutputSize : (config.maxOutputSize || preset.maxOutputSize),
    supportsAdvancedParams: protocol === 'openai' && isGptImage ? preset.supportsAdvancedParams : false,
    supportsTemperature: protocol === 'google' && Boolean(config.supportsTemperature ?? (usesPresetModelId ? preset.supportsTemperature : false)),
    streamImages: protocol === 'openai' && isGptImage ? Boolean(config.streamImages ?? preset.streamImages) : false,
  };
}

function patchImageModelFromExternal(model: ImageModelConfig, config: ExternalImageModelConfig): ImageModelConfig {
  const preset = BUILTIN_IMAGE_PRESETS[getExternalImagePresetId(config, model.builtinPreset)];
  const isXaiImagine = isXaiImaginePresetId(preset.id);
  const protocol = isXaiImagine ? preset.protocol : (config.protocol || model.protocol || preset.protocol);
  const isGptImage = preset.id === 'gpt-image-2';
  const configuredModelId = config.modelId === undefined
    ? model.modelId.trim()
    : config.modelId.trim();
  const usesPresetModelId = !configuredModelId || configuredModelId === preset.modelId;
  return {
    ...model,
    protocol,
    builtinPreset: preset.id,
    name: config.name || model.name || preset.name,
    modelId: usesPresetModelId ? '' : (configuredModelId || preset.modelId),
    usesPresetModelId: usesPresetModelId || undefined,
    baseUrl: config.baseUrl || model.baseUrl || preset.baseUrl,
    apiKey: config.apiKey ?? model.apiKey,
    maxRefImages: isXaiImagine ? preset.maxRefImages : (config.maxRefImages || model.maxRefImages || preset.maxRefImages),
    maxOutputSize: isXaiImagine && config.maxOutputSize !== '1K'
      ? preset.maxOutputSize
      : (config.maxOutputSize || model.maxOutputSize || preset.maxOutputSize),
    supportsAdvancedParams: protocol === 'openai' && isGptImage ? model.supportsAdvancedParams || preset.supportsAdvancedParams : false,
    supportsTemperature: protocol === 'google' && Boolean(config.supportsTemperature ?? (usesPresetModelId ? model.supportsTemperature ?? preset.supportsTemperature : false)),
    streamImages: protocol === 'openai' && isGptImage ? Boolean(config.streamImages ?? model.streamImages ?? preset.streamImages) : false,
  };
}

function createTextModelDraft(): TextModelConfig {
  const template = getDefaultTextModelTemplate('openai');
  return {
    id: generateModelId('txt'),
    protocol: template.protocol,
    name: '',
    modelId: '',
    apiKey: '',
    baseUrl: template.baseUrl,
    note: template.note,
  };
}

function isCompleteImageModel(model: ImageModelConfig): boolean {
  return Boolean(model.name.trim() && getResolvedImageModelId(model) && model.apiKey.trim() && model.baseUrl.trim());
}

function isCompleteTextModel(model: TextModelConfig): boolean {
  return Boolean(model.name.trim() && model.modelId.trim() && model.apiKey.trim() && model.baseUrl.trim());
}

function getImageModelLabel(models: ImageModelConfig[], id: string): string | undefined {
  return models.find((model) => model.id === id)?.name;
}

function getTextModelLabel(models: TextModelConfig[], id: string): string | undefined {
  return models.find((model) => model.id === id)?.name;
}

function normalizeDefaults(
  defaults: DefaultModels,
  imageModels: ImageModelConfig[],
  videoModels: VideoModelConfig[],
  textModels: TextModelConfig[],
): DefaultModels {
  const completeImageModels = imageModels.filter(isCompleteImageModel);
  const completeTextModels = textModels.filter(isCompleteTextModel);
  const firstImageModelId = completeImageModels[0]?.id || '';
  const firstTextModelId = completeTextModels[0]?.id || '';
  const completeVideoModels = getCompleteVideoModels({ schemaVersion: 2, imageModels: [], videoModels, textModels: [], defaults: DEFAULT_DEFAULTS });
  const firstVideoModelId = completeVideoModels[0]?.id || '';

  return {
    textToImage: completeImageModels.some((model) => model.id === defaults.textToImage) ? defaults.textToImage : firstImageModelId,
    imageToImage: completeImageModels.some((model) => model.id === defaults.imageToImage) ? defaults.imageToImage : firstImageModelId,
    reversePrompt: completeTextModels.some((model) => model.id === defaults.reversePrompt) ? defaults.reversePrompt : firstTextModelId,
    agent: completeTextModels.some((model) => model.id === defaults.agent) ? defaults.agent : firstTextModelId,
    promptOptimize: completeTextModels.some((model) => model.id === defaults.promptOptimize) ? defaults.promptOptimize : firstTextModelId,
    imageDescribe: completeTextModels.some((model) => model.id === defaults.imageDescribe) ? defaults.imageDescribe : firstTextModelId,
    videoGeneration: completeVideoModels.some((model) => model.id === defaults.videoGeneration) ? defaults.videoGeneration : firstVideoModelId,
  };
}

/**
 * 切换文本协议并保留用户已经填写的全部模型内容。
 * @param model 当前文本模型配置。
 * @param protocol 用户选择的新文本协议。
 * @returns 仅更新协议字段的文本模型副本。
 */
export function patchTextModelProtocol(model: TextModelConfig, protocol: ProviderProtocol): TextModelConfig {
  return { ...model, protocol };
}

/**
 * 根据外链数据创建文本模型草稿。
 * @param config 已规范化的外链文本模型配置。
 * @returns 可在设置页继续补充并手动保存的文本模型。
 */
function createExternalTextModelDraft(config: ExternalTextModelConfig): TextModelConfig {
  const template = getDefaultTextModelTemplate(config.protocol || 'openai');
  return {
    id: config.modelKey || generateModelId('txt'),
    protocol: config.protocol || template.protocol,
    name: config.name || '',
    modelId: config.modelId || '',
    apiKey: config.apiKey || '',
    baseUrl: config.baseUrl || template.baseUrl,
    note: config.note || template.note,
  };
}

/**
 * 使用外链中明确提供的字段更新现有文本模型。
 * @param model 已匹配的文本模型。
 * @param config 外链文本模型配置。
 * @returns 保留未提供字段的更新后模型。
 */
function patchTextModelFromExternal(model: TextModelConfig, config: ExternalTextModelConfig): TextModelConfig {
  return {
    ...model,
    protocol: config.protocol || model.protocol,
    name: config.name ?? model.name,
    modelId: config.modelId ?? model.modelId,
    apiKey: config.apiKey ?? model.apiKey,
    baseUrl: config.baseUrl ?? model.baseUrl,
    note: config.note ?? model.note,
  };
}

/**
 * 根据外链数据创建视频模型草稿。
 * @param config 已规范化的外链视频模型配置。
 * @returns 可在设置页继续补充并手动保存的视频模型。
 */
function createExternalVideoModelDraft(config: ExternalVideoModelConfig): VideoModelConfig {
  const protocol = config.protocol || 'openai';
  const template = getVideoProtocolTemplate(protocol);
  const presetModelId = template.presetModelId;
  const configuredModelId = config.modelId?.trim() || '';
  const usesPresetModelId = !configuredModelId || configuredModelId === presetModelId;
  return {
    id: config.modelKey || generateModelId('video'),
    protocol,
    name: config.name || '',
    modelId: usesPresetModelId ? '' : configuredModelId,
    usesPresetModelId: usesPresetModelId || undefined,
    presetModelId,
    apiKey: config.apiKey || '',
    baseUrl: config.baseUrl || template.baseUrl,
  };
}

/**
 * 使用外链中明确提供的字段更新现有视频模型。
 * @param model 已匹配的视频模型。
 * @param config 外链视频模型配置。
 * @returns 保留未提供字段的更新后模型。
 */
function patchVideoModelFromExternal(model: VideoModelConfig, config: ExternalVideoModelConfig): VideoModelConfig {
  const protocol = config.protocol || model.protocol;
  const protocolChanged = protocol !== model.protocol;
  const template = getVideoProtocolTemplate(protocol);
  const presetModelId = protocolChanged ? template.presetModelId : (model.presetModelId ?? template.presetModelId);
  const configuredModelId = config.modelId === undefined ? (protocolChanged ? '' : model.modelId.trim()) : config.modelId.trim();
  const usesPresetModelId = config.modelId === undefined
    ? (protocolChanged || Boolean(model.usesPresetModelId))
    : (!configuredModelId || configuredModelId === presetModelId);
  return {
    ...model,
    protocol,
    name: config.name ?? model.name,
    modelId: usesPresetModelId ? '' : configuredModelId,
    usesPresetModelId: usesPresetModelId || undefined,
    presetModelId,
    apiKey: config.apiKey ?? model.apiKey,
    baseUrl: config.baseUrl ?? (protocolChanged ? template.baseUrl : model.baseUrl),
  };
}

/**
 * 返回设置页打开时应展示的模型标识。
 * @param defaultModelId 当前工作流保存的默认模型标识。
 * @param models 当前类型的模型列表。
 * @returns 默认模型仍存在时返回其标识，否则返回首个模型标识或空字符串。
 */
function getSelectedDefaultModelId<T extends { id: string }>(defaultModelId: string, models: T[]): string {
  return models.some(model => model.id === defaultModelId) ? defaultModelId : (models[0]?.id || '');
}

export function SettingsModal({ isOpen, onClose, onApiKeyChange, externalModelConfig, onExternalModelConfigConsumed }: SettingsModalProps) {
  const { t } = useI18n();
  const { platformName, platformVersion } = useBranding();
  const [imageModels, setImageModels] = useState<ImageModelConfig[]>([]);
  const [textModels, setTextModels] = useState<TextModelConfig[]>([]);
  const [videoModels, setVideoModels] = useState<VideoModelConfig[]>([]);
  const [defaults, setDefaults] = useState<DefaultModels>(DEFAULT_DEFAULTS);
  const [selectedImageModelId, setSelectedImageModelId] = useState('');
  const [selectedTextModelId, setSelectedTextModelId] = useState('');
  const [selectedVideoModelId, setSelectedVideoModelId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [externalConfigNotice, setExternalConfigNotice] = useState<string | null>(null);
  const [checkingModels, setCheckingModels] = useState(false);
  const [modelStatuses, setModelStatuses] = useState<ModelStatus[] | null>(null);
  const [modelCheckError, setModelCheckError] = useState<string | null>(null);
  const [modelCatalogs, setModelCatalogs] = useState<Record<string, ModelCatalogState>>({});
  const [showImageApiKey, setShowImageApiKey] = useState(false);
  const [showTextApiKey, setShowTextApiKey] = useState(false);
  const [showVideoApiKey, setShowVideoApiKey] = useState(false);
  const [promptOptimizeEnabled, setPromptOptimizeEnabledState] = useState(false);
  const [imageModelKeyGuide, setImageModelKeyGuide] = useState<ImageModelKeyGuide>(IMAGE_MODEL_KEY_GUIDE);
  const [initialSnapshot, setInitialSnapshot] = useState<string | null>(null);
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saved'>('idle');
  const savedStateTimerRef = useRef<number | null>(null);
  const pendingModelCatalogClearsRef = useRef<Set<string>>(new Set());
  const modelCatalogRequestVersionsRef = useRef<Map<string, number>>(new Map());

  const [backupProgress, setBackupProgress] = useState<BackupProgressType>({ percent: 0, message: '' });
  const [isBackupActive, setIsBackupActive] = useState(false);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [backupSuccess, setBackupSuccess] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const registry = loadRegistry();
    const optimizeEnabled = isPromptOptimizeEnabled();
    if (savedStateTimerRef.current !== null) {
      window.clearTimeout(savedStateTimerRef.current);
      savedStateTimerRef.current = null;
    }
    let cancelled = false;
    pendingModelCatalogClearsRef.current.clear();
    queueMicrotask(() => {
      if (cancelled) return;
      setImageModels(registry.imageModels.map(cloneImageModel));
      setTextModels(registry.textModels.map(cloneTextModel));
      setVideoModels(registry.videoModels.map(cloneVideoModel));
      setDefaults({ ...registry.defaults });
      setSelectedImageModelId(getSelectedDefaultModelId(registry.defaults.textToImage, registry.imageModels));
      setSelectedTextModelId(getSelectedDefaultModelId(registry.defaults.promptOptimize, registry.textModels));
      setSelectedVideoModelId(getSelectedDefaultModelId(registry.defaults.videoGeneration, registry.videoModels));
      setError(null);
      setSuccess(null);
      setExternalConfigNotice(null);
      setModelStatuses(null);
      setModelCheckError(null);
      const cachedCatalogs = loadModelCatalogCache();
      const catalogSources = new Map<string, { protocol: string; baseUrl: string }>();
      registry.imageModels.forEach(model => catalogSources.set(model.id, { protocol: model.protocol, baseUrl: model.baseUrl }));
      registry.textModels.forEach(model => catalogSources.set(model.id, { protocol: model.protocol, baseUrl: model.baseUrl }));
      registry.videoModels.forEach(model => catalogSources.set(model.id, { protocol: 'openai', baseUrl: model.baseUrl }));
      const restoredCatalogs = Object.keys(cachedCatalogs).flatMap(channelId => {
        const source = catalogSources.get(channelId);
        const matchingEntry = source ? getModelCatalogCache(channelId, source) : undefined;
        if (!matchingEntry) return [];
        return [[channelId, {
          loading: false,
          options: matchingEntry.options,
          error: null,
          loaded: true,
          fetchedAt: matchingEntry.fetchedAt,
        }] as const];
      });
      setModelCatalogs(Object.fromEntries(restoredCatalogs));
      pruneModelCatalogCache([...registry.imageModels, ...registry.videoModels, ...registry.textModels].map(model => model.id));
      setBackupError(null);
      setBackupSuccess(null);
      setPromptOptimizeEnabledState(optimizeEnabled);
      setCloseConfirmOpen(false);
      setSaveState('idle');
      setInitialSnapshot(serializeSettingsSnapshot(createSettingsSnapshot(
        registry.imageModels,
        registry.videoModels,
        registry.textModels,
        registry.defaults,
        optimizeEnabled,
      )));
    });
    return () => { cancelled = true; };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;

    fetch('/api/flyreq/config', { cache: 'no-store' })
      .then((res) => res.json())
      .then((data: { imageModelKeyGuide?: Partial<ImageModelKeyGuide>; imagePresetModelIds?: Parameters<typeof applyBuiltinImagePresetModelIds>[0] }) => {
        if (cancelled) return;
        applyBuiltinImagePresetModelIds(data.imagePresetModelIds);
        const guide = data.imageModelKeyGuide || {};
        setImageModelKeyGuide({
          title: guide.title || IMAGE_MODEL_KEY_GUIDE.title,
          description: guide.description || IMAGE_MODEL_KEY_GUIDE.description,
          ctaLabel: guide.ctaLabel || IMAGE_MODEL_KEY_GUIDE.ctaLabel,
          url: guide.url || IMAGE_MODEL_KEY_GUIDE.url,
        });
      })
      .catch(() => {
        if (!cancelled) setImageModelKeyGuide(IMAGE_MODEL_KEY_GUIDE);
      });

    return () => { cancelled = true; };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !externalModelConfig) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      if (externalModelConfig.type === 'image') {
        setImageModels((prev) => {
          const existing = getExternalImageModelMatch(prev, externalModelConfig);
          const nextModel = existing
            ? patchImageModelFromExternal(existing, externalModelConfig)
            : createExternalImageModelDraft(externalModelConfig);
          setSelectedImageModelId(nextModel.id);
          // 图片外链目标预先成为两个生图工作流默认值，最终保存时再执行完整性校验。
          setDefaults((current) => ({ ...current, textToImage: nextModel.id, imageToImage: nextModel.id }));
          return existing ? prev.map(model => model.id === existing.id ? nextModel : model) : [...prev, nextModel];
        });
      } else if (externalModelConfig.type === 'text') {
        setTextModels((prev) => {
          const existing = getExternalTextModelMatch(prev, externalModelConfig);
          const nextModel = existing
            ? patchTextModelFromExternal(existing, externalModelConfig)
            : createExternalTextModelDraft(externalModelConfig);
          setSelectedTextModelId(nextModel.id);
          // 单个外链文本模型作为全部文本工作流的初始默认值，用户仍可在保存前分别调整。
          setDefaults((current) => ({
            ...current,
            reversePrompt: nextModel.id,
            agent: nextModel.id,
            promptOptimize: nextModel.id,
            imageDescribe: nextModel.id,
          }));
          return existing ? prev.map(model => model.id === existing.id ? nextModel : model) : [...prev, nextModel];
        });
      } else {
        setVideoModels((prev) => {
          const existing = getExternalVideoModelMatch(prev, externalModelConfig);
          const nextModel = existing
            ? patchVideoModelFromExternal(existing, externalModelConfig)
            : createExternalVideoModelDraft(externalModelConfig);
          setSelectedVideoModelId(nextModel.id);
          // 视频外链目标预先成为视频生成默认值，缺少 API Key 时作为未激活草稿保留。
          setDefaults((current) => ({ ...current, videoGeneration: nextModel.id }));
          return existing ? prev.map(model => model.id === existing.id ? nextModel : model) : [...prev, nextModel];
        });
      }
      const readyNoticeKey = externalModelConfig.type === 'image'
        ? 'settings.externalImageConfigReady'
        : externalModelConfig.type === 'text'
          ? 'settings.externalTextConfigReady'
          : 'settings.externalVideoConfigReady';
      const needsKeyNoticeKey = externalModelConfig.type === 'image'
        ? 'settings.externalImageConfigNeedsKey'
        : externalModelConfig.type === 'text'
          ? 'settings.externalTextConfigNeedsKey'
          : 'settings.externalVideoConfigNeedsKey';
      setExternalConfigNotice(
        externalModelConfig.apiKey
          ? t(readyNoticeKey)
          : t(needsKeyNoticeKey),
      );
      setError(null);
      setSuccess(null);
      onExternalModelConfigConsumed?.();
    });
    return () => { cancelled = true; };
  }, [externalModelConfig, isOpen, onExternalModelConfigConsumed, t]);

  const currentSerializedSnapshot = useMemo(
    () => serializeSettingsSnapshot(createSettingsSnapshot(
      imageModels,
      videoModels,
      textModels,
      defaults,
      promptOptimizeEnabled,
    )),
    [defaults, imageModels, promptOptimizeEnabled, textModels, videoModels],
  );
  const isDirty = initialSnapshot !== null && currentSerializedSnapshot !== initialSnapshot;

  useEffect(() => {
    if (isOpen) return;
    if (savedStateTimerRef.current !== null) {
      window.clearTimeout(savedStateTimerRef.current);
      savedStateTimerRef.current = null;
    }
  }, [isOpen]);

  useEffect(() => () => {
    if (savedStateTimerRef.current !== null) window.clearTimeout(savedStateTimerRef.current);
  }, []);

  const selectedImageModel = useMemo(
    () => imageModels.find((model) => model.id === selectedImageModelId) || null,
    [imageModels, selectedImageModelId],
  );
  const selectedTextModel = useMemo(
    () => textModels.find((model) => model.id === selectedTextModelId) || null,
    [selectedTextModelId, textModels],
  );
  const selectedVideoModel = useMemo(
    () => videoModels.find(model => model.id === selectedVideoModelId) || null,
    [selectedVideoModelId, videoModels],
  );
  const selectedVideoCreateEndpoint = selectedVideoModel ? getVideoCreateEndpoint(selectedVideoModel.protocol) : null;

  /**
   * 清除指定配置此前从旧协议、地址或密钥获取的模型目录。
   * @param modelId 需要清理目录状态的内部模型标识。
   * @returns 无返回值；状态不存在时保持当前目录集合不变。
   */
  const clearModelCatalog = (modelId: string): void => {
    const nextRequestVersion = (modelCatalogRequestVersionsRef.current.get(modelId) || 0) + 1;
    modelCatalogRequestVersionsRef.current.set(modelId, nextRequestVersion);
    pendingModelCatalogClearsRef.current.add(modelId);
    setModelCatalogs(previous => {
      if (!previous[modelId]) return previous;
      const next = { ...previous };
      delete next[modelId];
      return next;
    });
  };

  /**
   * 使用当前模型的 Base URL 和 API Key 拉取远端模型目录。
   * @param model 当前正在配置的图片、视频或文本模型。
   * @param protocol 模型目录端点使用的鉴权协议。
   * @returns 请求完成后更新对应模型的目录状态，无直接返回值。
   */
  const handleFetchModels = async (model: { id: string; baseUrl: string; apiKey: string }, protocol: ProviderProtocol): Promise<void> => {
    // 每个渠道独立递增请求版本，来源字段变化时旧响应会因版本不匹配而被丢弃。
    const requestVersion = (modelCatalogRequestVersionsRef.current.get(model.id) || 0) + 1;
    modelCatalogRequestVersionsRef.current.set(model.id, requestVersion);
    setModelCatalogs(previous => ({
      ...previous,
      [model.id]: { loading: true, options: previous[model.id]?.options || [], error: null, loaded: false },
    }));
    try {
      const options = await fetchRemoteModels({ baseUrl: model.baseUrl, apiKey: model.apiKey, protocol });
      if (modelCatalogRequestVersionsRef.current.get(model.id) !== requestVersion) return;
      saveModelCatalogCache({ channelId: model.id, protocol, baseUrl: model.baseUrl, options });
      pendingModelCatalogClearsRef.current.delete(model.id);
      setModelCatalogs(previous => ({ ...previous, [model.id]: { loading: false, options, error: null, loaded: true, fetchedAt: Date.now() } }));
    } catch (requestError) {
      if (modelCatalogRequestVersionsRef.current.get(model.id) !== requestVersion) return;
      setModelCatalogs(previous => ({
        ...previous,
        [model.id]: {
          loading: false,
          options: [],
          error: requestError instanceof Error ? requestError.message : t('settings.fetchModelsFailed'),
          loaded: true,
        },
      }));
    }
  };

  const handleAddImageModel = () => {
    const draft = createImageModelDraft();
    setImageModels((prev) => [...prev, draft]);
    setSelectedImageModelId(draft.id);
  };

  /**
   * 更新指定图片模型，并同步模板所约束的默认参数。
   * @param id 待更新图片模型的内部标识。
   * @param patch 用户本次修改的字段集合。
   * @returns 无返回值；通过状态更新渲染最新配置。
   */
  const handleUpdateImageModel = (id: string, patch: Partial<ImageModelConfig>) => {
    if ('protocol' in patch || 'baseUrl' in patch || 'apiKey' in patch || 'builtinPreset' in patch) clearModelCatalog(id);
    setImageModels((prev) => prev.map((model) => {
      if (model.id !== id) return model;
      const next = { ...model, ...patch };
      if (patch.builtinPreset) {
        const preset = BUILTIN_IMAGE_PRESETS[patch.builtinPreset];
        next.protocol = preset.protocol;
        next.name = preset.name;
        next.modelId = '';
        next.usesPresetModelId = true;
        next.baseUrl = preset.baseUrl;
        next.maxRefImages = preset.maxRefImages;
        next.maxOutputSize = preset.maxOutputSize;
        next.supportsAdvancedParams = preset.supportsAdvancedParams;
        next.supportsTemperature = preset.supportsTemperature;
        next.streamImages = preset.streamImages;
      }
      if ('modelId' in patch) {
        next.usesPresetModelId = !next.modelId.trim();
        if (next.protocol === 'google' && !next.usesPresetModelId) next.supportsTemperature = false;
      }
      if (isXaiImaginePresetId(next.builtinPreset)) {
        const preset = BUILTIN_IMAGE_PRESETS[next.builtinPreset];
        next.protocol = preset.protocol;
        next.maxRefImages = preset.maxRefImages;
        next.maxOutputSize = next.maxOutputSize === '1K' ? '1K' : preset.maxOutputSize;
        next.supportsAdvancedParams = false;
        next.supportsTemperature = false;
        next.streamImages = false;
      } else if (patch.protocol === 'google') {
        next.supportsAdvancedParams = false;
        next.streamImages = false;
        next.supportsTemperature = false;
      } else if (patch.protocol === 'openai') {
        next.supportsTemperature = false;
      }
      return next;
    }));
  };

  const handleDeleteImageModel = (id: string) => {
    clearModelCatalog(id);
    const nextModels = imageModels.filter((model) => model.id !== id);
    setImageModels(nextModels);
    setDefaults((prev) => ({
      ...prev,
      textToImage: prev.textToImage === id ? '' : prev.textToImage,
      imageToImage: prev.imageToImage === id ? '' : prev.imageToImage,
    }));
    if (selectedImageModelId === id) {
      setSelectedImageModelId(nextModels[0]?.id || '');
    }
  };

  const handleAddTextModel = () => {
    const draft = createTextModelDraft();
    setTextModels((prev) => [...prev, draft]);
    setSelectedTextModelId(draft.id);
  };

  /** 创建并选中一个新的视频模型草稿。 */
  const handleAddVideoModel = () => {
    const draft = createVideoModelDraft();
    setVideoModels(previous => [...previous, draft]);
    setSelectedVideoModelId(draft.id);
  };

  /**
   * 更新指定视频模型字段。
   * @param id 待更新模型的内部标识。
   * @param patch 本次字段变更。
   * @returns 无返回值。
   */
  const handleUpdateVideoModel = (id: string, patch: Partial<VideoModelConfig>) => {
    if ('baseUrl' in patch || 'apiKey' in patch) clearModelCatalog(id);
    setVideoModels(previous => previous.map(model => {
      if (model.id !== id) return model;
      const next = { ...model, ...patch };
      if ('modelId' in patch) next.usesPresetModelId = !next.modelId.trim();
      return next;
    }));
  };

  /**
   * 切换公开视频协议并应用匹配的基础地址和默认模型模板。
   * @param id 待更新视频模型的内部标识。
   * @param protocol 用户选择的公开视频协议。
   * @returns 无返回值。
   */
  const handleChangeVideoProtocol = (id: string, protocol: PublicVideoProtocol) => {
    clearModelCatalog(id);
    setVideoModels(previous => previous.map(model => model.id === id ? patchVideoModelProtocol(model, protocol) : model));
  };

  /**
   * 删除指定视频模型并清理默认值。
   * @param id 待删除模型的内部标识。
   * @returns 无返回值。
   */
  const handleDeleteVideoModel = (id: string) => {
    clearModelCatalog(id);
    const nextModels = videoModels.filter(model => model.id !== id);
    setVideoModels(nextModels);
    setDefaults(previous => ({ ...previous, videoGeneration: previous.videoGeneration === id ? '' : previous.videoGeneration }));
    if (selectedVideoModelId === id) setSelectedVideoModelId(nextModels[0]?.id || '');
  };

  const handleUpdateTextModel = (id: string, patch: Partial<TextModelConfig>) => {
    if ('baseUrl' in patch || 'apiKey' in patch) clearModelCatalog(id);
    setTextModels((prev) => prev.map((model) => (model.id === id ? { ...model, ...patch } : model)));
  };

  const handleDeleteTextModel = (id: string) => {
    clearModelCatalog(id);
    const nextModels = textModels.filter((model) => model.id !== id);
    setTextModels(nextModels);
    setDefaults((prev) => ({
      ...prev,
      reversePrompt: prev.reversePrompt === id ? '' : prev.reversePrompt,
      agent: prev.agent === id ? '' : prev.agent,
      promptOptimize: prev.promptOptimize === id ? '' : prev.promptOptimize,
      imageDescribe: prev.imageDescribe === id ? '' : prev.imageDescribe,
    }));
    if (selectedTextModelId === id) {
      setSelectedTextModelId(nextModels[0]?.id || '');
    }
  };

  /**
   * 保存当前模型注册表和默认模型选择。
   * @param showSavedFeedback 保存后是否显示短暂成功状态。
   * @returns 保存成功时返回 true；校验失败时返回 false 并更新错误提示。
   */
  const persistRegistry = (showSavedFeedback: boolean = true): boolean => {
    const hasNoCompleteImageModelBeforeSave = getCompleteImageModels(loadRegistry()).length === 0;
    if (promptOptimizeEnabled && !textModels.some(isCompleteTextModel)) {
      setError(t('settings.promptOptimizeRequiresTextModel'));
      return false;
    }

    // 第一步只把完整模型写入默认工作流，未完成模型仍作为草稿保存在注册表中。
    const normalizedDefaults = normalizeDefaults(defaults, imageModels, videoModels, textModels);
    const registry = {
      schemaVersion: 2 as const,
      imageModels,
      videoModels,
      textModels,
      defaults: normalizedDefaults,
    };

    // 第二步持久化全部草稿，再同步依赖注册表的工作台缓存与跨组件事件。
    saveRegistry(registry);
    for (const modelId of pendingModelCatalogClearsRef.current) clearModelCatalogCache(modelId);
    pendingModelCatalogClearsRef.current.clear();
    const persistedRegistry = loadRegistry();
    if (hasNoCompleteImageModelBeforeSave && persistedRegistry.defaults.textToImage) {
      saveFirstImageModelAsFormDefault(persistedRegistry.defaults.textToImage);
      notifyImageModelDefaultUpdated();
    }
    if (!setPromptOptimizeEnabled(promptOptimizeEnabled)) {
      setError(t('settings.promptOptimizeRequiresTextModel'));
      return false;
    }
    syncDynamicModelExports();
    window.dispatchEvent(new Event('flyreq-model-registry-updated'));
    onApiKeyChange?.(hasConfiguredImageModel());
    setImageModels(persistedRegistry.imageModels.map(cloneImageModel));
    setVideoModels(persistedRegistry.videoModels.map(cloneVideoModel));
    setTextModels(persistedRegistry.textModels.map(cloneTextModel));
    setDefaults({ ...persistedRegistry.defaults });
    setSuccess(null);
    setExternalConfigNotice(null);
    setError(null);
    setModelStatuses(null);
    setModelCheckError(null);
    // 第三步用实际写入的数据刷新比较基线，确保保存栏立即进入成功状态并自动收起。
    setInitialSnapshot(serializeSettingsSnapshot(createSettingsSnapshot(
      persistedRegistry.imageModels,
      persistedRegistry.videoModels,
      persistedRegistry.textModels,
      persistedRegistry.defaults,
      promptOptimizeEnabled,
    )));
    if (savedStateTimerRef.current !== null) window.clearTimeout(savedStateTimerRef.current);
    savedStateTimerRef.current = null;
    setSaveState(showSavedFeedback ? 'saved' : 'idle');
    if (showSavedFeedback) savedStateTimerRef.current = window.setTimeout(() => {
      setSaveState('idle');
      savedStateTimerRef.current = null;
    }, 1500);
    return true;
  };

  /**
   * 处理设置弹窗关闭请求，存在未保存内容时先打开三选项确认层。
   * @returns 无返回值；根据脏状态关闭弹窗或显示确认层。
   */
  const requestClose = (): void => {
    if (isDirty) {
      setCloseConfirmOpen(true);
      return;
    }
    onClose();
  };

  /**
   * 保存当前配置并在成功后关闭设置弹窗。
   * @returns 无返回值；校验失败时保留弹窗供用户继续修改。
   */
  const handleSaveAndClose = (): void => {
    if (!persistRegistry(false)) return;
    setCloseConfirmOpen(false);
    onClose();
  };

  /**
   * 放弃本次未保存修改并关闭设置弹窗。
   * @returns 无返回值。
   */
  const handleDiscardAndClose = (): void => {
    pendingModelCatalogClearsRef.current.clear();
    setCloseConfirmOpen(false);
    onClose();
  };

  const handlePromptOptimizeToggle = (checked: boolean) => {
    if (checked && !textModels.some(isCompleteTextModel)) {
      setError(t('settings.promptOptimizeRequiresTextModel'));
      setPromptOptimizeEnabledState(false);
      return;
    }
    setPromptOptimizeEnabledState(checked);
    setError(null);
  };

  const handleCheckModels = async () => {
    const configuredModels = [
      ...imageModels.filter(isCompleteImageModel),
      ...videoModels.filter(isCompleteVideoModel),
      ...textModels.filter(isCompleteTextModel),
    ];
    if (configuredModels.length === 0) {
      setModelCheckError(t('settings.checkModelsRequiresModel'));
      return;
    }

    setCheckingModels(true);
    setModelCheckError(null);
    setModelStatuses(null);
    try {
      const statuses = await checkModelsAvailability(configuredModels.map((model) => model.id));
      setModelStatuses(statuses);
    } catch (err) {
      setModelCheckError(err instanceof Error ? err.message : t('settings.checkModelsFailed'));
    } finally {
      setCheckingModels(false);
    }
  };

  const handleExport = async () => {
    setIsBackupActive(true);
    setBackupError(null);
    setBackupSuccess(null);
    try {
      const blob = await exportAllData((progress) => setBackupProgress({ ...progress, message: t(progress.message as Parameters<typeof t>[0], progress.values) }), platformVersion);
      const filename = generateBackupFilename();
      downloadBlob(blob, filename);
      setBackupSuccess(t('settings.exportSuccess', { filename }));
    } catch (err) {
      setBackupError(err instanceof Error ? err.message : t('settings.exportFailed'));
    } finally {
      setIsBackupActive(false);
    }
  };

  const handleImport = async (file: File) => {
    if (!file.name.endsWith('.zip')) {
      setBackupError(t('settings.invalidBackup'));
      return;
    }

    setIsBackupActive(true);
    setBackupError(null);
    setBackupSuccess(null);
    try {
      await importAllData(file, (progress) => setBackupProgress({ ...progress, message: t(progress.message as Parameters<typeof t>[0], progress.values) }));
      setBackupSuccess(t('settings.importSuccess'));
      setTimeout(() => window.location.reload(), 2000);
    } catch (err) {
      setBackupError(err instanceof Error ? err.message : t('settings.importFailed'));
      setIsBackupActive(false);
    }
  };

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) handleImport(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const completeImageOptions = imageModels.filter(isCompleteImageModel).map((model) => ({ value: model.id, label: model.name }));
  const completeTextOptions = textModels.filter(isCompleteTextModel).map((model) => ({ value: model.id, label: model.name }));
  const completeVideoOptions = videoModels.filter(isCompleteVideoModel).map(model => ({ value: model.id, label: model.name }));
  const needsImageModelKeyGuide = !imageModels.some(isCompleteImageModel);
  const selectedImageOutputSizes: ImageModelConfig['maxOutputSize'][] = selectedImageModel
    ? getImageModelOutputSizes({
        ...selectedImageModel,
        maxOutputSize: BUILTIN_IMAGE_PRESETS[selectedImageModel.builtinPreset].maxOutputSize,
      })
    : ['1K'];

  return (
    <Dialog open={isOpen} onOpenChange={(open) => {
      if (!open && isBackupActive) return;
      if (!open) requestClose();
    }}>
      <DialogContent className="flex max-h-[92vh] flex-col overflow-hidden p-0 pt-0 gap-0 sm:max-w-5xl">
        <DialogHeader className="p-4 pb-3">
          <div className="flex items-center gap-2">
            <Settings className="w-5 h-5 text-muted-foreground" />
            <DialogTitle>{t('settings.title')}</DialogTitle>
          </div>
          <DialogDescription>{t('settings.description')}</DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="models" className="min-h-0 flex-1 gap-0">
          <TabsList className="w-full rounded-none border-b bg-transparent h-auto p-0">
            <TabsTrigger value="models" className="gap-2 rounded-none border-b-2 border-transparent data-active:border-primary data-active:bg-transparent data-active:shadow-none px-4 py-3">
              <ImageIcon className="w-4 h-4" />
              {t('settings.modelsTab')}
            </TabsTrigger>
            <TabsTrigger value="backup" className="gap-2 rounded-none border-b-2 border-transparent data-active:border-primary data-active:bg-transparent data-active:shadow-none px-4 py-3">
              <Database className="w-4 h-4" />
              {t('settings.backupTab')}
            </TabsTrigger>
            <TabsTrigger value="about" className="gap-2 rounded-none border-b-2 border-transparent data-active:border-primary data-active:bg-transparent data-active:shadow-none px-4 py-3">
              <Info className="w-4 h-4" />
              {t('settings.aboutTab')}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="models" className="min-h-0 overflow-y-auto p-4 sm:p-6 mt-0 space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="space-y-1">
                <p className="text-sm font-medium">{t('settings.independentModels')}</p>
                <p className="text-xs text-muted-foreground">{t('settings.independentModelsDescription')}</p>
              </div>
              <Button onClick={() => persistRegistry()} className="gap-2" disabled={!isDirty}>
                <Save className="w-4 h-4" />
                {t('settings.saveNow')}
              </Button>
            </div>

            {error && <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
            {success && <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-400">{success}</div>}
            {externalConfigNotice && (
              <div className="rounded-lg border border-primary/20 bg-primary/10 p-3 text-sm text-primary">
                {externalConfigNotice}
              </div>
            )}

            {needsImageModelKeyGuide && (
              <div className="flex flex-col gap-3 rounded-xl border border-primary/30 bg-primary/10 p-4 text-sm sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                    <KeyRound className="h-4 w-4" />
                  </div>
                  <div className="space-y-1">
                    <p className="font-medium text-foreground">{imageModelKeyGuide.title}</p>
                    <p className="text-muted-foreground">{imageModelKeyGuide.description}</p>
                  </div>
                </div>
                <a
                  href={imageModelKeyGuide.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={buttonVariants({ className: 'shrink-0 gap-2' })}
                >
                  {imageModelKeyGuide.ctaLabel}
                  <ExternalLink className="h-4 w-4" />
                </a>
              </div>
            )}

            <div className="rounded-xl border p-4 space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-medium">{t('settings.imageModels')}</p>
                  <p className="text-xs text-muted-foreground">{t('settings.imageModelsDescription')}</p>
                </div>
                <Button variant="outline" size="sm" className="gap-2" onClick={handleAddImageModel}>
                  <Plus className="w-4 h-4" />
                  {t('settings.addImageModel')}
                </Button>
              </div>

              <div className="grid gap-4 xl:grid-cols-[220px_minmax(0,1fr)]">
                <div className="space-y-2">
                  {imageModels.map((model) => (
                    <button
                      key={model.id}
                      type="button"
                      onClick={() => setSelectedImageModelId(model.id)}
                      className={`w-full rounded-lg border px-3 py-2 text-left text-sm ${selectedImageModelId === model.id ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'}`}
                    >
                      <span className="block truncate font-medium">{model.name || t('settings.unnamedModel')}</span>
                      <div className="text-xs text-muted-foreground">{isCompleteImageModel(model) ? t('settings.configurationComplete') : t('settings.configurationIncomplete')}</div>
                    </button>
                  ))}
                </div>

                {selectedImageModel && (
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">{t('settings.builtinPreset')}</label>
                      <Select
                        value={selectedImageModel.builtinPreset}
                        onValueChange={(value) => handleUpdateImageModel(selectedImageModel.id, { builtinPreset: value as ImageModelConfig['builtinPreset'] })}
                        options={BUILTIN_IMAGE_PRESET_OPTIONS}
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">{t('settings.protocol')}</label>
                      <Select
                        value={selectedImageModel.protocol}
                        disabled={isXaiImaginePresetId(selectedImageModel.builtinPreset)}
                        onValueChange={(value) => handleUpdateImageModel(selectedImageModel.id, { protocol: value as ProviderProtocol })}
                        options={[
                          { value: 'google', label: 'Google' },
                          { value: 'openai', label: 'OpenAI Images' },
                        ]}
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">{t('settings.displayName')}</label>
                      <Input value={selectedImageModel.name} onChange={(event) => handleUpdateImageModel(selectedImageModel.id, { name: event.target.value })} />
                    </div>
                    <div className="md:col-span-2">
                      <ModelCatalogControls
                        state={modelCatalogs[selectedImageModel.id]}
                        catalogId={selectedImageModel.id}
                        modelId={selectedImageModel.modelId}
                        modelIdLabel={t('settings.modelId')}
                        modelIdPlaceholder={BUILTIN_IMAGE_PRESETS[selectedImageModel.builtinPreset].modelId}
                        modelIdHint={t('settings.modelIdPresetHint')}
                        fetchLabel={t('settings.fetchModels')}
                        fetchingLabel={t('settings.fetchingModels')}
                        successMessage={t('settings.modelsFetched', { count: modelCatalogs[selectedImageModel.id]?.options.length || 0 })}
                        emptyMessage={t('settings.noRemoteModels')}
                        staleMessage={t('settings.modelsCacheStale')}
                        onFetch={() => void handleFetchModels(selectedImageModel, selectedImageModel.protocol)}
                        onModelIdChange={(modelId) => handleUpdateImageModel(selectedImageModel.id, { modelId, usesPresetModelId: !modelId.trim() })}
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">{t('settings.baseUrl')}</label>
                      <Input value={selectedImageModel.baseUrl} onChange={(event) => handleUpdateImageModel(selectedImageModel.id, { baseUrl: event.target.value })} />
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">{t('settings.apiKey')}</label>
                      <div className="relative">
                        <Input
                          type={showImageApiKey ? "text" : "password"}
                          value={selectedImageModel.apiKey}
                          onChange={(event) => handleUpdateImageModel(selectedImageModel.id, { apiKey: event.target.value })}
                          className="pr-8"
                        />
                        <button
                          type="button"
                          onClick={() => setShowImageApiKey(!showImageApiKey)}
                          aria-label={t('settings.toggleApiKeyVisibility')}
                          className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center justify-center w-6 h-6 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                          tabIndex={-1}
                        >
                          {showImageApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">{t('settings.maxReferenceImages')}</label>
                      <Input
                        type="number"
                        min={1}
                        max={isXaiImaginePresetId(selectedImageModel.builtinPreset) ? 1 : undefined}
                        disabled={isXaiImaginePresetId(selectedImageModel.builtinPreset)}
                        value={selectedImageModel.maxRefImages}
                        onChange={(event) => handleUpdateImageModel(selectedImageModel.id, { maxRefImages: Number(event.target.value) || 1 })}
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">{t('settings.maxResolution')}</label>
                      <Select
                        value={selectedImageModel.maxOutputSize}
                        onValueChange={(value) => handleUpdateImageModel(selectedImageModel.id, { maxOutputSize: value as ImageModelConfig['maxOutputSize'] })}
                        options={selectedImageOutputSizes.map((size) => ({ value: size, label: getOutputSizeLabel(size) }))}
                      />
                    </div>
                    {selectedImageModel.protocol === 'google' && (
                      <div className="md:col-span-2 flex items-center justify-between rounded-lg border px-3 py-2">
                        <div>
                          <p className="text-sm font-medium">{t('settings.temperatureTitle')}</p>
                          <p className="text-xs text-muted-foreground">{t('settings.temperatureDescription')}</p>
                        </div>
                        <Switch
                          checked={Boolean(selectedImageModel.supportsTemperature)}
                          onCheckedChange={(checked) => handleUpdateImageModel(selectedImageModel.id, { supportsTemperature: checked })}
                        />
                      </div>
                    )}
                    {selectedImageModel.protocol === 'openai' && selectedImageModel.builtinPreset === 'gpt-image-2' && (
                      <div className="grid gap-3 md:col-span-2">
                        <div className="flex items-center justify-between rounded-lg border px-3 py-2">
                          <div>
                            <p className="text-sm font-medium">{t('settings.advancedImageTitle')}</p>
                            <p className="text-xs text-muted-foreground">{t('settings.advancedImageDescription')}</p>
                          </div>
                          <Switch
                            checked={selectedImageModel.supportsAdvancedParams}
                            onCheckedChange={(checked) => handleUpdateImageModel(selectedImageModel.id, { supportsAdvancedParams: checked })}
                          />
                        </div>
                        <div className="flex items-center justify-between rounded-lg border px-3 py-2">
                          <div>
                            <p className="text-sm font-medium">{t('settings.streamingImageTitle')}</p>
                            <p className="text-xs text-muted-foreground">{t('settings.streamingImageDescription')}</p>
                          </div>
                          <Switch
                            checked={Boolean(selectedImageModel.streamImages)}
                            onCheckedChange={(checked) => handleUpdateImageModel(selectedImageModel.id, { streamImages: checked })}
                          />
                        </div>
                      </div>
                    )}
                    <div className="md:col-span-2 flex justify-end">
                      <Button variant="outline" size="sm" className="gap-2 text-destructive hover:text-destructive" onClick={() => handleDeleteImageModel(selectedImageModel.id)}>
                        <Trash2 className="w-4 h-4" />
                        {t('settings.deleteModel')}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-xl border p-4 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="flex items-center gap-2 font-medium"><Video className="size-4" />{t('settings.videoModels')}</p>
                  <p className="text-xs text-muted-foreground">{t('settings.videoModelsDescription')}</p>
                </div>
                <Button variant="outline" size="sm" className="gap-2" onClick={handleAddVideoModel}>
                  <Plus className="w-4 h-4" />{t('settings.addVideoModel')}
                </Button>
              </div>

              <div className="grid gap-4 xl:grid-cols-[220px_minmax(0,1fr)]">
                <div className="space-y-2">
                  {videoModels.map(model => {
                    const complete = isCompleteVideoModel(model);
                    return (
                      <button key={model.id} type="button" onClick={() => setSelectedVideoModelId(model.id)} className={`w-full rounded-lg border px-3 py-2 text-left text-sm ${selectedVideoModelId === model.id ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'}`}>
                        <span className="block truncate font-medium">{model.name || t('settings.unnamedModel')}</span>
                        <div className="text-xs text-muted-foreground">{complete ? t('settings.configurationComplete') : t('settings.configurationIncomplete')}</div>
                      </button>
                    );
                  })}
                </div>

                {selectedVideoModel && (
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">{t('settings.protocol')}</label>
                      <Select
                        value={selectedVideoModel.protocol}
                        onValueChange={(value) => handleChangeVideoProtocol(selectedVideoModel.id, value as PublicVideoProtocol)}
                        options={[
                          { value: 'new-api', label: 'New API' },
                          { value: 'openai', label: 'OpenAI Videos (Sora)' },
                          { value: 'xai', label: 'xAI Videos' },
                        ]}
                      />
                      {selectedVideoCreateEndpoint && <p className="text-xs text-muted-foreground">
                        {t('settings.videoCreateEndpoint')}: <code className="font-mono text-foreground">{selectedVideoCreateEndpoint.method} {selectedVideoCreateEndpoint.path}</code>
                      </p>}
                      {selectedVideoModel.protocol === 'new-api' && <p className="text-xs text-muted-foreground">{t('settings.newApiResolutionDescription')}</p>}
                    </div>
                    <div className="space-y-2"><label className="text-xs text-muted-foreground">{t('settings.displayName')}</label><Input value={selectedVideoModel.name} onChange={event => handleUpdateVideoModel(selectedVideoModel.id, { name: event.target.value })} /></div>
                    <div className="space-y-2"><label className="text-xs text-muted-foreground">{t('settings.baseUrl')}</label><Input value={selectedVideoModel.baseUrl} onChange={event => handleUpdateVideoModel(selectedVideoModel.id, { baseUrl: event.target.value })} /></div>
                    <div className="space-y-2 md:col-span-2"><label className="text-xs text-muted-foreground">{t('settings.apiKey')}</label><div className="relative"><Input type={showVideoApiKey ? 'text' : 'password'} value={selectedVideoModel.apiKey} onChange={event => handleUpdateVideoModel(selectedVideoModel.id, { apiKey: event.target.value })} className="pr-9" /><button type="button" onClick={() => setShowVideoApiKey(value => !value)} className="absolute right-1 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-muted" aria-label={t('settings.apiKey')}>{showVideoApiKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</button></div></div>
                    <div className="md:col-span-2">
                      <ModelCatalogControls
                        state={modelCatalogs[selectedVideoModel.id]}
                        catalogId={selectedVideoModel.id}
                        modelId={selectedVideoModel.modelId}
                        modelIdLabel={t('settings.modelId')}
                        modelIdPlaceholder={selectedVideoModel.presetModelId || 'grok-imagine-video'}
                        modelIdHint={t('settings.modelIdPresetHint')}
                        fetchLabel={t('settings.fetchModels')}
                        fetchingLabel={t('settings.fetchingModels')}
                        successMessage={t('settings.modelsFetched', { count: modelCatalogs[selectedVideoModel.id]?.options.length || 0 })}
                        emptyMessage={t('settings.noRemoteModels')}
                        staleMessage={t('settings.modelsCacheStale')}
                        onFetch={() => void handleFetchModels(selectedVideoModel, 'openai')}
                        onModelIdChange={(modelId) => handleUpdateVideoModel(selectedVideoModel.id, { modelId, usesPresetModelId: !modelId.trim() })}
                      />
                    </div>
                    <div className="flex justify-end md:col-span-2"><Button variant="outline" size="sm" className="gap-2 text-destructive hover:text-destructive" onClick={() => handleDeleteVideoModel(selectedVideoModel.id)}><Trash2 className="size-4" />{t('settings.deleteModel')}</Button></div>
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-xl border p-4 space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-medium">{t('settings.textModels')}</p>
                  <p className="text-xs text-muted-foreground">{t('settings.textModelsDescription')}</p>
                </div>
                <Button variant="outline" size="sm" className="gap-2" onClick={handleAddTextModel}>
                  <Plus className="w-4 h-4" />
                  {t('settings.addTextModel')}
                </Button>
              </div>

              <div className="grid gap-4 xl:grid-cols-[220px_minmax(0,1fr)]">
                <div className="space-y-2">
                  {textModels.map((model) => (
                    <button
                      key={model.id}
                      type="button"
                      onClick={() => setSelectedTextModelId(model.id)}
                      className={`w-full rounded-lg border px-3 py-2 text-left text-sm ${selectedTextModelId === model.id ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'}`}
                    >
                      <span className="block truncate font-medium">{model.name || t('settings.unnamedModel')}</span>
                      <div className="text-xs text-muted-foreground">{isCompleteTextModel(model) ? t('settings.configurationComplete') : t('settings.configurationIncomplete')}</div>
                    </button>
                  ))}
                </div>

                {selectedTextModel && (
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">{t('settings.protocol')}</label>
                      <Select
                        value={selectedTextModel.protocol}
                        onValueChange={(value) => {
                          const protocol = value as ProviderProtocol;
                          clearModelCatalog(selectedTextModel.id);
                          setTextModels(previous => previous.map(model => model.id === selectedTextModel.id ? patchTextModelProtocol(model, protocol) : model));
                        }}
                        options={[
                          { value: 'openai', label: 'OpenAI Response' },
                          { value: 'google', label: 'Google Gemini' },
                        ]}
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">{t('settings.displayName')}</label>
                      <Input value={selectedTextModel.name} onChange={(event) => handleUpdateTextModel(selectedTextModel.id, { name: event.target.value })} />
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">{t('settings.baseUrl')}</label>
                      <Input value={selectedTextModel.baseUrl} onChange={(event) => handleUpdateTextModel(selectedTextModel.id, { baseUrl: event.target.value })} />
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground">{t('settings.apiKey')}</label>
                      <div className="relative">
                        <Input
                          type={showTextApiKey ? "text" : "password"}
                          value={selectedTextModel.apiKey}
                          onChange={(event) => handleUpdateTextModel(selectedTextModel.id, { apiKey: event.target.value })}
                          className="pr-8"
                        />
                        <button
                          type="button"
                          onClick={() => setShowTextApiKey(!showTextApiKey)}
                          aria-label={t('settings.toggleApiKeyVisibility')}
                          className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center justify-center w-6 h-6 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                          tabIndex={-1}
                        >
                          {showTextApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>
                    <div className="md:col-span-2">
                      <ModelCatalogControls
                        state={modelCatalogs[selectedTextModel.id]}
                        catalogId={selectedTextModel.id}
                        modelId={selectedTextModel.modelId}
                        modelIdLabel={t('settings.modelId')}
                        fetchLabel={t('settings.fetchModels')}
                        fetchingLabel={t('settings.fetchingModels')}
                        successMessage={t('settings.modelsFetched', { count: modelCatalogs[selectedTextModel.id]?.options.length || 0 })}
                        emptyMessage={t('settings.noRemoteModels')}
                        staleMessage={t('settings.modelsCacheStale')}
                        onFetch={() => void handleFetchModels(selectedTextModel, selectedTextModel.protocol)}
                        onModelIdChange={(modelId) => handleUpdateTextModel(selectedTextModel.id, { modelId })}
                      />
                    </div>
                    <div className="space-y-2 md:col-span-2">
                      <label className="text-xs text-muted-foreground">{t('settings.protocolDescription')}</label>
                      <Input value={selectedTextModel.note || ''} onChange={(event) => handleUpdateTextModel(selectedTextModel.id, { note: event.target.value })} />
                    </div>
                    <div className="md:col-span-2 flex justify-end">
                      <Button variant="outline" size="sm" className="gap-2 text-destructive hover:text-destructive" onClick={() => handleDeleteTextModel(selectedTextModel.id)}>
                        <Trash2 className="w-4 h-4" />
                        {t('settings.deleteModel')}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-xl border p-4 space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-medium">{t('settings.defaultModels')}</p>
                  <p className="text-xs text-muted-foreground">{t('settings.defaultModelsDescription')}</p>
                </div>
                <Button variant="outline" size="sm" className="gap-2" onClick={handleCheckModels} disabled={checkingModels}>
                  <RefreshCw className={`w-4 h-4 ${checkingModels ? 'animate-spin' : ''}`} />
                  {checkingModels ? t('settings.checkingModels') : t('settings.checkModels')}
                </Button>
              </div>

              <div className="flex items-center justify-between gap-4 rounded-lg border bg-muted/30 px-3 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{t('settings.promptOptimizeToggle')}</p>
                  <p className="text-xs text-muted-foreground">{t('settings.promptOptimizeToggleDescription')}</p>
                </div>
                <Switch
                  checked={promptOptimizeEnabled}
                  onCheckedChange={handlePromptOptimizeToggle}
                  aria-label={t('settings.promptOptimizeToggle')}
                />
              </div>

              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                <div className="space-y-2">
                  <label className="text-xs text-muted-foreground">{t('settings.textToImageDefault')}</label>
                  <Select value={defaults.textToImage} onValueChange={(value) => { setDefaults((prev) => ({ ...prev, textToImage: value })); setSelectedImageModelId(value); }} options={completeImageOptions} />
                </div>
                <div className="space-y-2">
                  <label className="text-xs text-muted-foreground">{t('settings.imageToImageDefault')}</label>
                  <Select value={defaults.imageToImage} onValueChange={(value) => { setDefaults((prev) => ({ ...prev, imageToImage: value })); setSelectedImageModelId(value); }} options={completeImageOptions} />
                </div>
                <div className="space-y-2">
                  <label className="text-xs text-muted-foreground">{t('settings.videoDefault')}</label>
                  <Select value={defaults.videoGeneration} onValueChange={(value) => { setDefaults((prev) => ({ ...prev, videoGeneration: value })); setSelectedVideoModelId(value); }} options={completeVideoOptions} />
                </div>
                <div className="space-y-2">
                  <label className="text-xs text-muted-foreground">{t('settings.reversePromptDefault')}</label>
                  <Select value={defaults.reversePrompt} onValueChange={(value) => { setDefaults((prev) => ({ ...prev, reversePrompt: value })); setSelectedTextModelId(value); }} options={completeTextOptions} />
                </div>
                <div className="space-y-2">
                  <label className="text-xs text-muted-foreground">{t('settings.agentDefault')}</label>
                  <Select value={defaults.agent} onValueChange={(value) => { setDefaults((prev) => ({ ...prev, agent: value })); setSelectedTextModelId(value); }} options={completeTextOptions} />
                </div>
                <div className="space-y-2">
                  <label className="text-xs text-muted-foreground">{t('settings.promptOptimizeDefault')}</label>
                  <Select value={defaults.promptOptimize} onValueChange={(value) => { setDefaults((prev) => ({ ...prev, promptOptimize: value })); setSelectedTextModelId(value); }} options={completeTextOptions} />
                </div>
                <div className="space-y-2">
                  <label className="text-xs text-muted-foreground">{t('settings.imageDescribeDefault')}</label>
                  <Select value={defaults.imageDescribe} onValueChange={(value) => { setDefaults((prev) => ({ ...prev, imageDescribe: value })); setSelectedTextModelId(value); }} options={completeTextOptions} />
                </div>
              </div>

              {modelCheckError && <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">{modelCheckError}</div>}
              {modelStatuses && (
                <div className="grid gap-2 md:grid-cols-2">
                  {modelStatuses.map((status) => (
                    <div key={status.modelId} className="flex items-center justify-between rounded-lg bg-muted/50 px-3 py-2 text-sm">
                      <div className="min-w-0">
                        <div className="truncate font-medium">{getTextModelLabel(textModels, status.modelId) ?? getImageModelLabel(imageModels, status.modelId) ?? status.actualName ?? status.modelId}</div>
                        <div className="truncate text-xs text-muted-foreground">{status.message || status.actualName || status.modelId}</div>
                      </div>
                      {status.available ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> : <XCircle className="w-4 h-4 text-destructive" />}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </TabsContent>

          <TabsContent value="backup" className="min-h-0 overflow-y-auto p-4 sm:p-6 space-y-6 mt-0">
            <div className="space-y-4">
              <div className="space-y-2">
                <h3 className="text-base font-medium">{t('settings.backupTitle')}</h3>
                <p className="text-sm text-muted-foreground">{t('settings.backupDescription')}</p>
              </div>

              <BackupProgress percent={backupProgress.percent} message={backupProgress.message} isActive={isBackupActive} />

              {backupSuccess && !isBackupActive && (
                <div className="flex items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-800 dark:bg-emerald-950/30">
                  <CheckCircle2 className="w-5 h-5 flex-shrink-0 text-emerald-600 dark:text-emerald-500 mt-0.5" />
                  <p className="text-sm text-emerald-900 dark:text-emerald-100">{backupSuccess}</p>
                </div>
              )}

              {backupError && !isBackupActive && (
                <div className="flex items-start gap-3 rounded-lg border border-destructive/20 bg-destructive/10 p-4">
                  <XCircle className="w-5 h-5 text-destructive flex-shrink-0 mt-0.5" />
                  <p className="text-sm text-destructive break-all">{backupError}</p>
                </div>
              )}

              <div className="space-y-3 rounded-lg border p-4">
                <div className="flex items-start gap-3">
                  <Download className="w-5 h-5 text-muted-foreground mt-0.5" />
                  <div className="flex-1 space-y-2">
                    <h4 className="font-medium">{t('settings.exportTitle')}</h4>
                    <p className="text-sm text-muted-foreground">{t('settings.exportDescription')}</p>
                    <Button onClick={handleExport} disabled={isBackupActive} className="gap-2">
                      <Download className="w-4 h-4" />
                      {t('settings.fullBackup')}
                    </Button>
                  </div>
                </div>
              </div>

              <div className="space-y-3 rounded-lg border p-4">
                <div className="flex items-start gap-3">
                  <Upload className="w-5 h-5 text-muted-foreground mt-0.5" />
                  <div className="flex-1 space-y-2">
                    <h4 className="font-medium">{t('settings.importTitle')}</h4>
                    <p className="text-sm text-muted-foreground">{t('settings.importDescription')} <span className="font-medium text-destructive">{t('settings.importWarning')}</span></p>
                    <input ref={fileInputRef} type="file" accept=".zip" onChange={handleFileSelect} className="hidden" />
                    <Button onClick={() => fileInputRef.current?.click()} disabled={isBackupActive} variant="outline" className="gap-2">
                      <Upload className="w-4 h-4" />
                      {t('settings.selectBackup')}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="about" className="min-h-0 overflow-y-auto p-4 sm:p-6 space-y-4 mt-0">
            <div className="space-y-4 text-sm">
              <h3 className="text-lg font-medium">{platformName} <span className="text-xs text-muted-foreground font-normal">v{platformVersion}</span></h3>
              <div className="rounded-lg border border-primary/20 bg-primary/10 p-3">
                <p className="font-medium text-foreground">{imageModelKeyGuide.title}</p>
                <p className="mt-1 text-sm text-muted-foreground">{imageModelKeyGuide.description}</p>
                <a
                  href={imageModelKeyGuide.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 inline-flex items-center gap-1 text-primary hover:underline"
                >
                  {imageModelKeyGuide.ctaLabel}
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>

              <details className="group rounded-lg bg-muted/50 p-3">
                <summary className="flex cursor-pointer select-none items-center gap-2 font-medium">
                  <span className="text-[10px] opacity-60 transition-transform group-open:rotate-90">▶</span>
                  {t('settings.usage')}
                </summary>
                <ol className="mt-3 list-decimal list-inside space-y-2 text-muted-foreground">
                  <li>{t('settings.usageStep1')}</li>
                  <li>{t('settings.usageStep2')}</li>
                  <li>{t('settings.usageStep3')}</li>
                </ol>
              </details>

              <details className="group rounded-lg bg-muted/50 p-3">
                <summary className="flex cursor-pointer select-none items-center gap-2 font-medium">
                  <span className="text-[10px] opacity-60 transition-transform group-open:rotate-90">▶</span>
                  {t('settings.dataSources')}
                </summary>
                <ul className="mt-3 list-disc list-inside space-y-2 text-muted-foreground">
                  <li>
                    <span className="text-foreground">{t('settings.promptGallerySource')}</span>
                    <ul className="mt-1 ml-5 list-disc list-inside space-y-1">
                      {PROMPT_DATA_SOURCES.map((source) => (
                        <li key={source.name}>
                          <a href={source.sourceUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                            {getPromptSourceLabel(source.sourceUrl)} <ExternalLink className="w-3 h-3" />
                          </a>
                        </li>
                      ))}
                    </ul>
                  </li>
                  <li>
                    <span className="text-foreground">{t('settings.randomBaSource')}</span> -{' '}
                    <a href={BA_RANDOM_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                      img.catcdn.cn <ExternalLink className="w-3 h-3" />
                    </a>
                  </li>
                  <li>
                    <span className="text-foreground">{t('settings.randomBingSource')}</span> -{' '}
                    <a href={BING_WALLPAPER_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                      bing.img.run <ExternalLink className="w-3 h-3" />
                    </a>
                  </li>
                </ul>
              </details>

              <details className="group rounded-lg bg-muted/50 p-3">
                <summary className="flex cursor-pointer select-none items-center gap-2 font-medium">
                  <span className="text-[10px] opacity-60 transition-transform group-open:rotate-90">▶</span>
                  {t('settings.privacy')}
                </summary>
                <ul className="mt-3 list-disc list-inside space-y-2 text-muted-foreground">
                  <li>{t('settings.privacyLocal')}</li>
                  <li>{t('settings.privacyCredentials')}</li>
                  <li>{t('settings.privacyRequests')}</li>
                  <li>{t('settings.privacyBackup')}</li>
                </ul>
              </details>

              <details className="group rounded-lg bg-muted/50 p-3">
                <summary className="flex cursor-pointer select-none items-center gap-2 font-medium">
                  <span className="text-[10px] opacity-60 transition-transform group-open:rotate-90">▶</span>
                  {t('settings.references')}
                </summary>
                <ul className="mt-3 list-disc list-inside space-y-2 text-muted-foreground">
                  <li>
                    {t('settings.projectRepository')}
                    {' '}
                    <a href="https://github.com/doudou770/flyreq-image-studio" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                      doudou770/flyreq-image-studio <ExternalLink className="w-3 h-3" />
                    </a>
                  </li>
                  <li>
                    {t('settings.basedOnPrefix')}
                    {' '}
                    <a href="https://github.com/tianjiangqiji/flyreq-image-studio" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                      tianjiangqiji/flyreq-image-studio <ExternalLink className="w-3 h-3" />
                    </a>
                    {' '}
                    {t('settings.basedOnSuffix')}
                  </li>
                  <li>
                    {t('settings.basedOnPrefix')}
                    {' '}
                    <a href="https://github.com/aaronkwhite/nanobanana-studio-web" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                      aaronkwhite/nanobanana-studio-web <ExternalLink className="w-3 h-3" />
                    </a>
                    {' '}
                    {t('settings.basedOnSuffix')}
                  </li>
                  <li>
                    {t('settings.canvasReference')}
                    {' '}
                    <a href="https://github.com/basketikun/infinite-canvas" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                      basketikun/infinite-canvas <ExternalLink className="w-3 h-3" />
                    </a>
                    。
                  </li>
                </ul>
              </details>
            </div>
          </TabsContent>
        </Tabs>

        {(isDirty || saveState === 'saved') && (
          <div
            className="flex shrink-0 flex-col gap-3 border-t bg-popover/95 px-4 py-3 shadow-[0_-10px_28px_-18px_rgba(0,0,0,0.45)] backdrop-blur sm:flex-row sm:items-center sm:justify-between sm:px-6"
            role="status"
            aria-live="polite"
          >
            <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
              {saveState === 'saved' && !isDirty ? (
                <CheckCircle2 className="size-4 shrink-0 text-emerald-600" />
              ) : (
                <span className="size-2 shrink-0 rounded-full bg-amber-500" />
              )}
              <span className="truncate">
                {saveState === 'saved' && !isDirty ? t('settings.configurationSaved') : t('settings.unsavedChanges')}
              </span>
            </div>
            {isDirty && (
              <Button onClick={() => persistRegistry()} className="w-full shrink-0 gap-2 sm:w-auto">
                <Save className="size-4" />
                {t('settings.saveConfiguration')}
              </Button>
            )}
          </div>
        )}

        {closeConfirmOpen && (
          <div className="absolute inset-0 z-20 flex items-end justify-center bg-black/50 p-3 sm:items-center sm:p-6">
            <div
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="settings-unsaved-title"
              aria-describedby="settings-unsaved-description"
              className="w-full max-w-md rounded-lg border bg-popover p-4 text-popover-foreground shadow-xl sm:p-5"
            >
              <h3 id="settings-unsaved-title" className="text-base font-semibold">{t('settings.unsavedCloseTitle')}</h3>
              <p id="settings-unsaved-description" className="mt-2 text-sm text-muted-foreground">{t('settings.unsavedCloseDescription')}</p>
              <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={handleDiscardAndClose}>
                  {t('settings.discardChanges')}
                </Button>
                <Button variant="outline" onClick={() => setCloseConfirmOpen(false)}>
                  {t('settings.continueEditing')}
                </Button>
                <Button onClick={handleSaveAndClose} className="gap-2">
                  <Save className="size-4" />
                  {t('settings.saveAndClose')}
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
