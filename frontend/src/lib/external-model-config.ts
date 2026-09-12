import {
  getResolvedImageModelId,
  getResolvedVideoModelId,
  type BuiltinImagePresetId,
  type ImageModelConfig,
  type ImageOutputSize,
  type ProviderProtocol,
  type TextModelConfig,
  type VideoModelConfig,
  type PublicVideoProtocol,
  type VideoProtocol,
} from '@/lib/flyreq-models';

interface ExternalModelConfigBase {
  modelKey?: string;
  name?: string;
  modelId?: string;
  baseUrl?: string;
  apiKey?: string;
}

export type ExternalImageModelConfig = ExternalModelConfigBase & {
  type: 'image';
  preset?: BuiltinImagePresetId;
  protocol?: ProviderProtocol;
  maxRefImages?: number;
  maxOutputSize?: ImageOutputSize;
  /** 是否允许向 Google 图片接口发送温度参数。 */
  supportsTemperature?: boolean;
  streamImages?: boolean;
};

export type ExternalTextModelConfig = ExternalModelConfigBase & {
  type: 'text';
  protocol?: ProviderProtocol;
  note?: string;
};

export type ExternalVideoModelConfig = ExternalModelConfigBase & {
  type: 'video';
  protocol?: VideoProtocol;
};

export type ExternalModelConfig = ExternalImageModelConfig | ExternalTextModelConfig | ExternalVideoModelConfig;

const CONFIG_QUERY_KEYS = new Set([
  'provider',
  'configureModel',
  'type',
  'modelKey',
  'preset',
  'protocol',
  'name',
  'modelId',
  'baseUrl',
  'apiKey',
  'maxRefImages',
  'maxOutputSize',
  'supportsTemperature',
  'streamImages',
  'note',
]);

function normalizePreset(value: string | null): BuiltinImagePresetId | undefined {
  return value === 'gemini-2.5-flash-image'
    || value === 'gemini-3-pro-image-preview'
    || value === 'gemini-3.1-flash-image-preview'
    || value === 'gemini-3.1-flash-lite-image'
    || value === 'gpt-image-2'
    || value === 'grok-imagine-image'
    || value === 'grok-imagine-image-quality'
    ? value
    : undefined;
}

function normalizeProvider(value: string | null): ProviderProtocol | undefined {
  return value === 'openai' || value === 'google' ? value : undefined;
}

/**
 * 将外链协议值规范化为受支持的视频协议。
 * @param value 外链中的协议字符串。
 * @returns 有效视频协议；无法识别时返回 undefined。
 */
function normalizeVideoProtocol(value: string | null): PublicVideoProtocol | undefined {
  return value === 'new-api' || value === 'openai' || value === 'xai' ? value : undefined;
}

/**
 * 将显式协议字段与历史 provider 字段统一解析为当前支持的视频协议。
 * @param explicitProtocol 新版外链显式提供的 protocol 字段。
 * @param legacyProvider 旧版外链提供的 provider 字段。
 * @returns 当前支持的公开视频协议；字段非法时返回 undefined。
 */
function resolveExternalVideoProtocol(explicitProtocol: string | null, legacyProvider: string | null): VideoProtocol | undefined {
  if (explicitProtocol) return normalizeVideoProtocol(explicitProtocol);
  if (!legacyProvider || legacyProvider === 'openai') return 'openai';
  return normalizeVideoProtocol(legacyProvider);
}

function normalizeOutputSize(value: string | null): ImageOutputSize | undefined {
  return value === '512' || value === '1K' || value === '2K' || value === '4K' ? value : undefined;
}

function readTrimmed(params: URLSearchParams, key: string): string | undefined {
  const value = params.get(key)?.trim();
  return value || undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

function parseProviderJson(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function normalizeProviderPayload(payload: Record<string, unknown>): ExternalModelConfig | null {
  const type = readString(payload.type) || 'image';
  const provider = readString(payload.provider);
  const explicitProtocol = readString(payload.protocol);
  const protocol = provider || explicitProtocol;
  const common = {
    modelKey: readString(payload.modelKey),
    name: readString(payload.name),
    modelId: readString(payload.modelId),
    baseUrl: readString(payload.baseUrl),
    apiKey: readString(payload.apiKey),
  };

  if (type === 'text') {
    return {
      type: 'text',
      ...common,
      protocol: normalizeProvider(protocol || null),
      note: readString(payload.note),
    };
  }

  if (type === 'video') {
    const normalizedProtocol = resolveExternalVideoProtocol(explicitProtocol || null, provider || null);
    if (!normalizedProtocol) return null;
    return { type: 'video', ...common, protocol: normalizedProtocol };
  }

  if (type !== 'image') return null;

  return {
    type: 'image',
    ...common,
    preset: normalizePreset(readString(payload.preset) || null),
    protocol: normalizeProvider(protocol || null),
    maxRefImages: readNumber(payload.maxRefImages),
    maxOutputSize: normalizeOutputSize(readString(payload.maxOutputSize) || null),
    supportsTemperature: readBoolean(payload.supportsTemperature),
    streamImages: readBoolean(payload.streamImages),
  };
}

export function parseExternalModelConfig(url: URL): ExternalModelConfig | null {
  const providerPayload = parseProviderJson(url.searchParams.get('provider'));
  if (providerPayload) return normalizeProviderPayload(providerPayload);

  if (url.searchParams.get('configureModel') !== '1') return null;
  const type = url.searchParams.get('type') || 'image';
  if (type !== 'image' && type !== 'text' && type !== 'video') return null;

  const common = {
    modelKey: readTrimmed(url.searchParams, 'modelKey'),
    name: readTrimmed(url.searchParams, 'name'),
    modelId: readTrimmed(url.searchParams, 'modelId'),
    baseUrl: readTrimmed(url.searchParams, 'baseUrl'),
    apiKey: readTrimmed(url.searchParams, 'apiKey'),
  };
  const protocol = normalizeProvider(url.searchParams.get('protocol') || url.searchParams.get('provider'));
  if (type === 'text') {
    return { type: 'text', ...common, protocol, note: readTrimmed(url.searchParams, 'note') };
  }
  if (type === 'video') {
    const videoProtocol = resolveExternalVideoProtocol(url.searchParams.get('protocol'), url.searchParams.get('provider'));
    if (!videoProtocol) return null;
    return { type: 'video', ...common, protocol: videoProtocol };
  }

  const maxRefImagesRaw = Number(url.searchParams.get('maxRefImages'));
  const maxRefImages = Number.isFinite(maxRefImagesRaw) && maxRefImagesRaw > 0
    ? Math.floor(maxRefImagesRaw)
    : undefined;

  return {
    type: 'image',
    ...common,
    preset: normalizePreset(url.searchParams.get('preset')),
    protocol,
    maxRefImages,
    maxOutputSize: normalizeOutputSize(url.searchParams.get('maxOutputSize')),
    supportsTemperature: readBoolean(url.searchParams.get('supportsTemperature') ?? undefined),
    streamImages: readBoolean(url.searchParams.get('streamImages') ?? undefined),
  };
}

export function getCleanUrlAfterExternalModelConfig(url: URL): string {
  const clean = new URL(url.toString());
  for (const key of CONFIG_QUERY_KEYS) {
    clean.searchParams.delete(key);
  }
  clean.hash = '';
  return `${clean.pathname}${clean.search}${clean.hash}`;
}

export function getExternalImageModelMatch(models: ImageModelConfig[], config: ExternalImageModelConfig): ImageModelConfig | undefined {
  if (config.modelKey) {
    const byKey = models.find((model) => model.id === config.modelKey);
    if (byKey) return byKey;
  }

  const name = config.name?.trim().toLowerCase();
  const modelId = (config.modelId || (config.preset === 'gpt-image-2' ? 'gpt-image-2' : '')).trim().toLowerCase();
  const baseUrl = config.baseUrl?.trim().replace(/\/+$/, '').toLowerCase();
  if (!name || !modelId || !baseUrl) return undefined;

  return models.find((model) => (
    model.name.trim().toLowerCase() === name
    && getResolvedImageModelId(model).toLowerCase() === modelId
    && model.baseUrl.trim().replace(/\/+$/, '').toLowerCase() === baseUrl
  ));
}

/**
 * 按稳定标识或模型签名查找外链对应的文本模型。
 * @param models 当前文本模型列表。
 * @param config 外链文本模型配置。
 * @returns 匹配的现有模型；没有匹配时返回 undefined。
 */
export function getExternalTextModelMatch(models: TextModelConfig[], config: ExternalTextModelConfig): TextModelConfig | undefined {
  if (config.modelKey) {
    const byKey = models.find(model => model.id === config.modelKey);
    if (byKey) return byKey;
  }
  const name = config.name?.trim().toLowerCase();
  const modelId = config.modelId?.trim().toLowerCase();
  const baseUrl = config.baseUrl?.trim().replace(/\/+$/, '').toLowerCase();
  if (!name || !modelId || !baseUrl) return undefined;
  return models.find(model => model.name.trim().toLowerCase() === name
    && model.modelId.trim().toLowerCase() === modelId
    && model.baseUrl.trim().replace(/\/+$/, '').toLowerCase() === baseUrl);
}

/**
 * 按稳定标识或模型签名查找外链对应的视频模型。
 * @param models 当前视频模型列表。
 * @param config 外链视频模型配置。
 * @returns 匹配的现有模型；没有匹配时返回 undefined。
 */
export function getExternalVideoModelMatch(models: VideoModelConfig[], config: ExternalVideoModelConfig): VideoModelConfig | undefined {
  if (config.modelKey) {
    const byKey = models.find(model => model.id === config.modelKey);
    if (byKey) return byKey;
  }
  const protocol = config.protocol || 'openai';
  const name = config.name?.trim().toLowerCase();
  const modelId = config.modelId?.trim().toLowerCase();
  const baseUrl = config.baseUrl?.trim().replace(/\/+$/, '').toLowerCase();
  if (!name || !modelId || !baseUrl) return undefined;
  return models.find(model => model.name.trim().toLowerCase() === name
    && getResolvedVideoModelId(model).toLowerCase() === modelId
    && model.baseUrl.trim().replace(/\/+$/, '').toLowerCase() === baseUrl
    && model.protocol === protocol);
}
