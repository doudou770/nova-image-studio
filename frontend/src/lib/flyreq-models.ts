'use client';

import { BUILTIN_IMAGE_PRESETS } from '@/lib/builtin-image-presets';
import { LOCAL_STORAGE_KEYS } from '@/lib/storage-contract';
export { BUILTIN_IMAGE_PRESETS, applyBuiltinImagePresetModelIds } from '@/lib/builtin-image-presets';
export type { BuiltinImagePreset, BuiltinImagePresetId, BuiltinImagePresetModelIds, ImageOutputSize, ProviderProtocol } from '@/lib/builtin-image-presets';
import type { BuiltinImagePresetId, ImageOutputSize, ProviderProtocol } from '@/lib/builtin-image-presets';

export type ImageApiFlavor = 'xai-imagine';

export interface ImageModelConfig {
  id: string;
  protocol: ProviderProtocol;
  name: string;
  modelId: string;
  /** 模型 ID 留空时是否使用内置模板的默认模型 ID。 */
  usesPresetModelId?: boolean;
  apiKey: string;
  baseUrl: string;
  builtinPreset: BuiltinImagePresetId;
  maxRefImages: number;
  maxOutputSize: ImageOutputSize;
  supportsAdvancedParams: boolean;
  /** 是否允许向上游发送温度参数。未配置时按内置模板迁移。 */
  supportsTemperature?: boolean;
  streamImages?: boolean;
}

export interface TextModelConfig {
  id: string;
  protocol: ProviderProtocol;
  name: string;
  modelId: string;
  apiKey: string;
  baseUrl: string;
  note?: string;
}

export type PublicVideoProtocol = 'new-api' | 'openai' | 'xai';
export type VideoProtocol = PublicVideoProtocol;

export interface VideoModelConfig {
  id: string;
  protocol: VideoProtocol;
  name: string;
  modelId: string;
  /** 模型 ID 留空时是否使用视频预设的默认模型 ID。 */
  usesPresetModelId?: boolean;
  /** 当前部署或内置配置提供的视频预设模型 ID。 */
  presetModelId?: string;
  apiKey: string;
  baseUrl: string;
}

export interface DefaultModels {
  textToImage: string;
  imageToImage: string;
  reversePrompt: string;
  agent: string;
  promptOptimize: string;
  imageDescribe: string;
  videoGeneration: string;
}

export interface FlyreqModelRegistry {
  schemaVersion: 2;
  imageModels: ImageModelConfig[];
  videoModels: VideoModelConfig[];
  textModels: TextModelConfig[];
  defaults: DefaultModels;
}

const REGISTRY_KEY = LOCAL_STORAGE_KEYS.modelRegistry;
const DEFAULT_FLYREQ_IMAGE_MODEL_ID = 'flyreq-gpt-image-2';
const DEFAULT_FLYREQ_VIDEO_MODEL_ID = 'flyreq-sora-2';
export const DEFAULT_VIDEO_GENERATION_MODEL_ID = 'sora-2';

export const BUILTIN_IMAGE_PRESET_OPTIONS = Object.values(BUILTIN_IMAGE_PRESETS).map((preset) => ({
  value: preset.id,
  label: preset.name,
}));

export const DEFAULT_TEXT_MODEL_TEMPLATES = [
  {
    protocol: 'openai' as const,
    name: 'GPT 5.4 Mini',
    modelId: 'gpt-5.4-mini',
    baseUrl: 'https://api.openai.com',
    note: 'OpenAI Response',
  },
  {
    protocol: 'google' as const,
    name: 'Gemini 2.5 Flash',
    modelId: 'gemini-2.5-flash',
    baseUrl: 'https://generativelanguage.googleapis.com',
    note: 'Google Gemini',
  },
];

export function getDefaultTextModelTemplate(protocol: ProviderProtocol) {
  return DEFAULT_TEXT_MODEL_TEMPLATES.find((item) => item.protocol === protocol) || DEFAULT_TEXT_MODEL_TEMPLATES[0];
}

export const DEFAULT_DEFAULTS: DefaultModels = {
  textToImage: '',
  imageToImage: '',
  reversePrompt: '',
  agent: '',
  promptOptimize: '',
  imageDescribe: '',
  videoGeneration: '',
};

export const DEFAULT_IMAGE_MODELS: ImageModelConfig[] = [
  {
    id: DEFAULT_FLYREQ_IMAGE_MODEL_ID,
    protocol: 'openai',
    name: 'FlyReq',
    modelId: '',
    usesPresetModelId: true,
    apiKey: '',
    baseUrl: 'https://flyreq.com',
    builtinPreset: 'gpt-image-2',
    maxRefImages: 16,
    maxOutputSize: '4K',
    supportsAdvancedParams: true,
    supportsTemperature: false,
    streamImages: true,
  },
];

export const DEFAULT_VIDEO_MODELS: VideoModelConfig[] = [{
  id: DEFAULT_FLYREQ_VIDEO_MODEL_ID,
  protocol: 'openai',
  name: 'FlyReq',
  modelId: '',
  usesPresetModelId: true,
  presetModelId: DEFAULT_VIDEO_GENERATION_MODEL_ID,
  apiKey: '',
  baseUrl: 'https://flyreq.com',
}];

/** 部署级下发的首次图片模型配置不携带 API Key。 */
export type DeploymentDefaultImageModelConfig = Omit<ImageModelConfig, 'apiKey'>;

let deploymentDefaultImageModel: ImageModelConfig = { ...DEFAULT_IMAGE_MODELS[0] };
/** 部署级下发的首次视频模型配置不携带 API Key。 */
export type DeploymentDefaultVideoModelConfig = Omit<VideoModelConfig, 'apiKey'>;
let deploymentDefaultVideoModel: VideoModelConfig = { ...DEFAULT_VIDEO_MODELS[0] };

export function isXaiImaginePresetId(presetId: string): boolean {
  return presetId === 'grok-imagine-image' || presetId === 'grok-imagine-image-quality';
}

export function getImageApiFlavor(model: Pick<ImageModelConfig, 'builtinPreset' | 'modelId'>): ImageApiFlavor | undefined {
  return isXaiImaginePresetId(model.builtinPreset) || isXaiImaginePresetId(model.modelId)
    ? 'xai-imagine'
    : undefined;
}

/**
 * 解析图片模型实际发送给上游的模型 ID。
 * @param model 包含模板、用户自定义模型 ID 与预设标记的图片模型配置。
 * @returns 用户填写的模型 ID；启用预设时返回配置文件中的默认模型 ID。
 */
export function getResolvedImageModelId(
  model: Pick<ImageModelConfig, 'builtinPreset' | 'modelId' | 'usesPresetModelId'>,
): string {
  const customModelId = String(model.modelId || '').trim();
  if (customModelId) return customModelId;
  return model.usesPresetModelId
    ? BUILTIN_IMAGE_PRESETS[model.builtinPreset].modelId
    : '';
}

/**
 * 解析视频模型实际发送给上游的模型 ID。
 * @param model 包含自定义模型 ID、预设标记和预设模型 ID的视频模型配置。
 * @returns 用户填写的模型 ID；留空并启用预设时返回部署或内置的默认模型 ID。
 */
export function getResolvedVideoModelId(
  model: Pick<VideoModelConfig, 'modelId' | 'usesPresetModelId' | 'presetModelId'>,
): string {
  const customModelId = String(model.modelId || '').trim();
  if (customModelId) return customModelId;
  return model.usesPresetModelId
    ? String(model.presetModelId || DEFAULT_VIDEO_GENERATION_MODEL_ID).trim()
    : '';
}

function isProviderProtocol(value: unknown): value is ProviderProtocol {
  return value === 'google' || value === 'openai';
}

function isBuiltinImagePresetId(value: unknown): value is BuiltinImagePresetId {
  return typeof value === 'string' && value in BUILTIN_IMAGE_PRESETS;
}

function normalizeImageOutputSize(value: unknown, fallback: ImageOutputSize): ImageOutputSize {
  return value === '512' || value === '1K' || value === '2K' || value === '4K'
    ? value
    : fallback;
}

function inferBuiltinPresetId(raw: Partial<ImageModelConfig>): BuiltinImagePresetId {
  for (const candidate of [raw.builtinPreset, raw.modelId, raw.id]) {
    if (isBuiltinImagePresetId(candidate)) return candidate;
  }
  if (String(raw.protocol || '').trim() === 'google') return 'gemini-3-pro-image-preview';
  return 'gpt-image-2';
}

/**
 * 归一化图片模型配置，并保留所有内置预设的留空模型 ID 状态。
 * @param raw 从本地存储或外部配置读取的原始图片模型数据。
 * @returns 规范化后的图片模型；缺少内部标识时返回 null。
 */
function normalizeImageModelConfig(raw: Partial<ImageModelConfig>): ImageModelConfig | null {
  const presetId = inferBuiltinPresetId(raw);
  const preset = BUILTIN_IMAGE_PRESETS[presetId];
  const id = String(raw.id || '').trim();
  if (!id) return null;

  const isXaiImagine = isXaiImaginePresetId(presetId);
  const protocol = isXaiImagine
    ? preset.protocol
    : (isProviderProtocol(raw.protocol) ? raw.protocol : preset.protocol);
  const configuredModelId = String(raw.modelId || '').trim();
  const usesPresetModelId = raw.usesPresetModelId === true
    || (Boolean(raw.builtinPreset) && (!configuredModelId || configuredModelId === preset.modelId));
  return {
    id,
    protocol,
    name: String(raw.name || '').trim(),
    modelId: usesPresetModelId ? '' : configuredModelId,
    usesPresetModelId: usesPresetModelId || undefined,
    apiKey: String(raw.apiKey || '').trim(),
    baseUrl: String(raw.baseUrl || preset.baseUrl).trim(),
    builtinPreset: presetId,
    maxRefImages: isXaiImagine
      ? preset.maxRefImages
      : (Number.isFinite(raw.maxRefImages) && Number(raw.maxRefImages) > 0
        ? Math.max(1, Math.floor(Number(raw.maxRefImages)))
        : preset.maxRefImages),
    maxOutputSize: isXaiImagine
      ? (raw.maxOutputSize === '1K' ? '1K' : preset.maxOutputSize)
      : normalizeImageOutputSize(raw.maxOutputSize, preset.maxOutputSize),
    supportsAdvancedParams: protocol === 'openai' && preset.supportsAdvancedParams
      ? (typeof raw.supportsAdvancedParams === 'boolean' ? raw.supportsAdvancedParams : preset.supportsAdvancedParams)
      : false,
    supportsTemperature: protocol === 'google'
      ? (typeof raw.supportsTemperature === 'boolean' ? raw.supportsTemperature : Boolean(usesPresetModelId && preset.supportsTemperature))
      : false,
    streamImages: protocol === 'openai' && preset.id === 'gpt-image-2'
      ? Boolean(raw.streamImages ?? preset.streamImages)
      : false,
  };
}

/**
 * 应用部署级首次图片模型配置，仅影响没有本地模型注册表的新浏览器。
 * @param config 后端配置接口下发的默认图片模型；缺失时恢复内置默认值。
 * @returns 无返回值，后续首次读取模型注册表会使用最新配置。
 */
export function applyDeploymentDefaultImageModel(config?: Partial<DeploymentDefaultImageModelConfig>): void {
  if (!config) {
    deploymentDefaultImageModel = { ...DEFAULT_IMAGE_MODELS[0] };
    return;
  }
  const normalized = normalizeImageModelConfig({ ...DEFAULT_IMAGE_MODELS[0], ...config, apiKey: '' });
  deploymentDefaultImageModel = normalized || { ...DEFAULT_IMAGE_MODELS[0] };
}

/**
 * 创建当前部署生效的首次图片模型副本，避免调用方修改全局默认对象。
 * @returns 仅包含一个首次默认图片模型的数组。
 */
function getDeploymentDefaultImageModels(): ImageModelConfig[] {
  return [{ ...deploymentDefaultImageModel }];
}

/**
 * 归一化视频模型配置并限制为当前支持的公开视频协议。
 * @param raw 从本地存储或部署配置读取的原始视频模型数据。
 * @returns 规范化后的视频模型；缺少内部标识时返回 null。
 */
function normalizeVideoModelConfig(raw: Partial<VideoModelConfig>): VideoModelConfig | null {
  const id = String(raw.id || '').trim();
  if (!id) return null;
  const configuredModelId = String(raw.modelId || '').trim();
  const presetModelId = String(raw.presetModelId === undefined ? DEFAULT_VIDEO_GENERATION_MODEL_ID : raw.presetModelId).trim();
  const usesPresetModelId = raw.usesPresetModelId === true
    || !configuredModelId
    || configuredModelId === presetModelId;
  return {
    id,
    protocol: raw.protocol === 'new-api' || raw.protocol === 'xai' || raw.protocol === 'openai' ? raw.protocol : 'openai',
    name: String(raw.name || '').trim(),
    modelId: usesPresetModelId ? '' : configuredModelId,
    usesPresetModelId: usesPresetModelId || undefined,
    presetModelId,
    apiKey: String(raw.apiKey || '').trim(),
    baseUrl: String(raw.baseUrl || DEFAULT_VIDEO_MODELS[0].baseUrl).trim(),
  };
}

/**
 * 应用部署级首次视频模型配置，仅影响没有本地模型注册表的新浏览器。
 * @param config 后端配置接口下发的默认视频模型；缺失时恢复内置默认值。
 * @returns 无返回值，后续首次读取模型注册表会使用最新配置。
 */
export function applyDeploymentDefaultVideoModel(config?: Partial<DeploymentDefaultVideoModelConfig>): void {
  if (!config) {
    deploymentDefaultVideoModel = { ...DEFAULT_VIDEO_MODELS[0] };
    return;
  }
  const presetModelId = String(config.modelId || DEFAULT_VIDEO_GENERATION_MODEL_ID).trim();
  const raw = { ...DEFAULT_VIDEO_MODELS[0], ...config, modelId: '', usesPresetModelId: true, presetModelId, apiKey: '' };
  deploymentDefaultVideoModel = normalizeVideoModelConfig(raw) || { ...DEFAULT_VIDEO_MODELS[0] };
}

/**
 * 创建当前部署生效的首次视频模型副本。
 * @returns 仅包含一个首次默认视频模型的数组。
 */
function getDeploymentDefaultVideoModels(): VideoModelConfig[] {
  return [{ ...deploymentDefaultVideoModel }];
}

function normalizeTextModelConfig(raw: Partial<TextModelConfig>): TextModelConfig | null {
  const id = String(raw.id || '').trim();
  if (!id) return null;
  const protocol = isProviderProtocol(raw.protocol) ? raw.protocol : 'openai';
  const template = getDefaultTextModelTemplate(protocol);
  return {
    id,
    protocol,
    name: String(raw.name || '').trim(),
    modelId: String(raw.modelId || '').trim(),
    apiKey: String(raw.apiKey || '').trim(),
    baseUrl: String(raw.baseUrl || template.baseUrl).trim(),
    note: typeof raw.note === 'string' ? raw.note : template.note,
  };
}

function isCompleteImageModel(model: Partial<ImageModelConfig>): model is ImageModelConfig {
  return Boolean(
    model.id
    && model.name?.trim()
    && getResolvedImageModelId({
      builtinPreset: model.builtinPreset || 'gpt-image-2',
      modelId: model.modelId || '',
      usesPresetModelId: model.usesPresetModelId,
    })
    && model.apiKey?.trim()
    && model.baseUrl?.trim()
  );
}

function isCompleteTextModel(model: Partial<TextModelConfig>): model is TextModelConfig {
  return Boolean(
    model.id
    && model.name?.trim()
    && model.modelId?.trim()
    && model.apiKey?.trim()
    && model.baseUrl?.trim()
  );
}

/**
 * 判断视频模型是否具备发起生成所需的全部字段。
 * @param model 待检查的视频模型配置。
 * @returns 全部必填字段有效时返回 true。
 */
export function isCompleteVideoModel(model: Partial<VideoModelConfig>): model is VideoModelConfig {
  return Boolean(
    model.id
    && model.name?.trim()
    && getResolvedVideoModelId({
      modelId: model.modelId || '',
      usesPresetModelId: model.usesPresetModelId,
      presetModelId: model.presetModelId,
    })
    && model.apiKey?.trim()
    && model.baseUrl?.trim()
  );
}

function ensureImageModels(raw?: unknown): ImageModelConfig[] {
  if (!Array.isArray(raw)) return getDeploymentDefaultImageModels();
  if (raw.length === 0) return [];
  const models = raw
    .map((item) => normalizeImageModelConfig((item || {}) as Partial<ImageModelConfig>))
    .filter((item): item is ImageModelConfig => Boolean(item))
    .filter((item, index, list) => list.findIndex((candidate) => candidate.id === item.id) === index);
  return models.length > 0 ? models : getDeploymentDefaultImageModels();
}

function ensureTextModels(raw?: unknown): TextModelConfig[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => normalizeTextModelConfig((item || {}) as Partial<TextModelConfig>))
    .filter((item): item is TextModelConfig => Boolean(item))
    .filter((item, index, list) => list.findIndex((candidate) => candidate.id === item.id) === index);
}

/**
 * 归一化视频模型数组并兼容旧注册表缺少 videoModels 的情况。
 * @param raw 本地存储中的视频模型原始值。
 * @returns 去重后的模型列表；缺失时返回部署默认模型。
 */
function ensureVideoModels(raw?: unknown): VideoModelConfig[] {
  if (!Array.isArray(raw)) return getDeploymentDefaultVideoModels();
  if (raw.length === 0) return [];
  const models = raw
    .map(item => {
      const candidate = { ...(item || {}) } as Partial<VideoModelConfig>;
      return normalizeVideoModelConfig(candidate);
    })
    .filter((item): item is VideoModelConfig => Boolean(item))
    .filter((item, index, list) => list.findIndex(candidate => candidate.id === item.id) === index);
  return models.length > 0 ? models : getDeploymentDefaultVideoModels();
}

function ensureDefaults(raw: Partial<DefaultModels> | undefined, imageModels: ImageModelConfig[], videoModels: VideoModelConfig[], textModels: TextModelConfig[]): DefaultModels {
  const completeImageModels = imageModels.filter(isCompleteImageModel);
  const completeVideoModels = videoModels.filter(isCompleteVideoModel);
  const completeTextModels = textModels.filter(isCompleteTextModel);
  const firstImageModelId = completeImageModels[0]?.id || '';
  const firstVideoModelId = completeVideoModels[0]?.id || '';
  const firstTextModelId = completeTextModels[0]?.id || '';
  const next = { ...DEFAULT_DEFAULTS, ...raw };

  if (!completeImageModels.some((model) => model.id === next.textToImage)) next.textToImage = firstImageModelId;
  if (!completeImageModels.some((model) => model.id === next.imageToImage)) next.imageToImage = firstImageModelId;
  if (!completeTextModels.some((model) => model.id === next.reversePrompt)) next.reversePrompt = firstTextModelId;
  if (!completeTextModels.some((model) => model.id === next.agent)) next.agent = firstTextModelId;
  if (!completeTextModels.some((model) => model.id === next.promptOptimize)) next.promptOptimize = firstTextModelId;
  if (!completeTextModels.some((model) => model.id === next.imageDescribe)) next.imageDescribe = firstTextModelId;
  if (!completeVideoModels.some((model) => model.id === next.videoGeneration)) next.videoGeneration = firstVideoModelId;

  return next;
}

function getInitialRegistry(): FlyreqModelRegistry {
  return {
    schemaVersion: 2,
    imageModels: getDeploymentDefaultImageModels(),
    videoModels: getDeploymentDefaultVideoModels(),
    textModels: [],
    defaults: DEFAULT_DEFAULTS,
  };
}

function getBrowserStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  const storage = window.localStorage;
  return storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function'
    ? storage
    : null;
}

export function loadRegistry(): FlyreqModelRegistry {
  const storage = getBrowserStorage();
  if (!storage) return getInitialRegistry();

  try {
    const raw = storage.getItem(REGISTRY_KEY);
    if (!raw) {
      return getInitialRegistry();
    }

    const parsed = JSON.parse(raw) as Partial<FlyreqModelRegistry>;
    const imageModels = ensureImageModels(parsed.imageModels);
    const videoModels = ensureVideoModels(parsed.videoModels);
    const textModels = ensureTextModels(parsed.textModels);
    const defaults = ensureDefaults(parsed.defaults, imageModels, videoModels, textModels);
    return { schemaVersion: 2, imageModels, videoModels, textModels, defaults };
  } catch {
    return getInitialRegistry();
  }
}

export function saveRegistry(registry: FlyreqModelRegistry): void {
  const storage = getBrowserStorage();
  if (!storage) return;

  const imageModels = ensureImageModels(registry.imageModels);
  const videoModels = ensureVideoModels(registry.videoModels);
  const textModels = ensureTextModels(registry.textModels);
  const normalized: FlyreqModelRegistry = {
    schemaVersion: 2,
    imageModels,
    videoModels,
    textModels,
    defaults: ensureDefaults(registry.defaults, imageModels, videoModels, textModels),
  };

  storage.setItem(REGISTRY_KEY, JSON.stringify(normalized));
}

/**
 * 更新工作流默认模型并通知当前页面中的模型消费者刷新。
 * @param patch 需要变更的默认模型字段；未提供的工作流保持原值。
 * @returns 注册表实际保存后的默认模型配置。
 */
export function updateRegistryDefaults(patch: Partial<DefaultModels>): DefaultModels {
  const registry = loadRegistry();
  saveRegistry({ ...registry, defaults: { ...registry.defaults, ...patch } });
  const persistedDefaults = loadRegistry().defaults;
  const changed = Object.keys(patch).some(key => {
    const task = key as keyof DefaultModels;
    return registry.defaults[task] !== persistedDefaults[task];
  });
  if (changed && typeof window !== 'undefined') window.dispatchEvent(new Event('flyreq-model-registry-updated'));
  return persistedDefaults;
}

export function getImageModelById(registry: FlyreqModelRegistry, id: string): ImageModelConfig | undefined {
  return registry.imageModels.find((model) => model.id === id);
}

export function getTextModelById(registry: FlyreqModelRegistry, id: string): TextModelConfig | undefined {
  return registry.textModels.find((model) => model.id === id);
}

/**
 * 按内部标识读取视频模型。
 * @param registry 当前模型注册表。
 * @param id 视频模型内部标识。
 * @returns 匹配的视频模型；不存在时返回 undefined。
 */
export function getVideoModelById(registry: FlyreqModelRegistry, id: string): VideoModelConfig | undefined {
  return registry.videoModels.find(model => model.id === id);
}

/**
 * 读取视频工作台默认模型。
 * @param registry 当前模型注册表。
 * @returns 配置为默认值的视频模型；不存在时返回 undefined。
 */
export function getDefaultVideoModel(registry: FlyreqModelRegistry): VideoModelConfig | undefined {
  return getVideoModelById(registry, registry.defaults.videoGeneration);
}

/**
 * 返回配置完整、可用于视频生成的模型列表。
 * @param registry 当前模型注册表。
 * @returns 配置完整的视频模型数组。
 */
export function getCompleteVideoModels(registry: FlyreqModelRegistry): VideoModelConfig[] {
  return registry.videoModels.filter(isCompleteVideoModel);
}

export function getDefaultImageModel(
  registry: FlyreqModelRegistry,
  task: keyof Pick<DefaultModels, 'textToImage' | 'imageToImage'>,
): ImageModelConfig | undefined {
  return getImageModelById(registry, registry.defaults[task]);
}

export function getDefaultTextModel(
  registry: FlyreqModelRegistry,
  task: keyof Pick<DefaultModels, 'reversePrompt' | 'agent' | 'promptOptimize' | 'imageDescribe'>,
): TextModelConfig | undefined {
  return getTextModelById(registry, registry.defaults[task]);
}

export function getCompleteImageModels(registry: FlyreqModelRegistry): ImageModelConfig[] {
  return registry.imageModels.filter(isCompleteImageModel);
}

export function getCompleteTextModels(registry: FlyreqModelRegistry): TextModelConfig[] {
  return registry.textModels.filter(isCompleteTextModel);
}

export function getImageModelOutputSizes(model: ImageModelConfig): ImageOutputSize[] {
  switch (model.maxOutputSize) {
    case '4K':
      return model.builtinPreset === 'gemini-3.1-flash-image-preview'
        ? ['512', '1K', '2K', '4K']
        : ['1K', '2K', '4K'];
    case '2K':
      return model.builtinPreset === 'gemini-3.1-flash-image-preview'
        ? ['512', '1K', '2K']
        : ['1K', '2K'];
    case '512':
      return ['512'];
    case '1K':
    default:
      return model.builtinPreset === 'gemini-3.1-flash-image-preview'
        ? ['512', '1K']
        : ['1K'];
  }
}

export function generateModelId(prefix: string = 'model'): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
