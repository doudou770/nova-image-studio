const defaultConfig = require('./video-protocol-capabilities.json');
const sharp = require('sharp');

const PUBLIC_VIDEO_PROTOCOLS = new Set(['new-api', 'openai', 'xai']);
const ALL_VIDEO_PROTOCOLS = new Set(PUBLIC_VIDEO_PROTOCOLS);
const MAX_VIDEO_DURATION_SECONDS = 60;
const MIN_VIDEO_RESOLUTION = 144;
const MAX_VIDEO_RESOLUTION = 4320;
const MAX_VIDEO_REFERENCE_FILES = 20;
let cachedOverride = null;
let cachedConfig = null;

/**
 * 创建可安全修改的 JSON 数据副本。
 * @param {unknown} value 待复制的数据。
 * @returns {any} 与输入内容等价的独立 JSON 数据。
 */
function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * 按 RFC 7396 语义应用 JSON Merge Patch，数组整体替换。
 * @param {any} target 原始配置节点。
 * @param {any} patch 环境变量提供的覆盖节点。
 * @returns {any} 合并后的新节点。
 */
function applyJsonMergePatch(target, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return cloneJson(patch);
  const result = target && typeof target === 'object' && !Array.isArray(target) ? cloneJson(target) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else result[key] = applyJsonMergePatch(result[key], value);
  }
  return result;
}

/**
 * 判断能力配置中的视频尺寸能否通过任务入口的通用尺寸校验。
 * @param {unknown} value 待校验的尺寸字符串。
 * @returns {boolean} auto 或合法的宽高尺寸返回 true。
 */
function isValidConfiguredVideoSize(value) {
  if (value === 'auto') return true;
  if (typeof value !== 'string') return false;
  const match = value.match(/^(\d+)x(\d+)$/);
  if (!match) return false;
  return [Number(match[1]), Number(match[2])].every(side => Number.isInteger(side) && side >= 64 && side <= 4096);
}

/**
 * 判断能力配置中的宽高比是否为两个正整数组成的比例。
 * @param {unknown} value 待校验的宽高比字符串。
 * @returns {boolean} 符合“宽:高”格式且两侧均为正整数时返回 true。
 */
function isValidConfiguredAspectRatio(value) {
  return typeof value === 'string' && /^[1-9]\d*:[1-9]\d*$/.test(value);
}

/**
 * 判断能力配置中的参考媒体 MIME 规则是否合法。
 * @param {unknown} value 待校验的 MIME 规则。
 * @param {'image' | 'video' | 'audio'} mediaType 规则必须匹配的媒体主类型。
 * @returns {boolean} 值为对应类型通配符或合法子类型时返回 true。
 */
function isValidConfiguredMediaMimeType(value, mediaType) {
  return typeof value === 'string' && new RegExp(`^${mediaType}\\/(?:\\*|[a-z0-9][a-z0-9!#$&^_.+-]*)$`).test(value);
}

/**
 * 判断时长预设是否属于当前协议声明的有效时长集合。
 * @param {number} value 待校验的秒数。
 * @param {any} duration 当前协议时长能力。
 * @returns {boolean} 秒数同时满足工作台与协议约束时返回 true。
 */
function isValidDurationPreset(value, duration) {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_VIDEO_DURATION_SECONDS) return false;
  return duration.mode === 'enum'
    ? Array.isArray(duration.values) && duration.values.includes(value)
    : value >= duration.min && value <= duration.max;
}

/**
 * 校验单个协议能力配置包含页面与后端所需的完整字段。
 * @param {string} protocol 协议标识。
 * @param {any} profile 待校验的协议能力。
 * @returns {void} 配置无效时抛出错误。
 */
function validateProtocolProfile(protocol, profile) {
  if (!ALL_VIDEO_PROTOCOLS.has(protocol) || !profile || typeof profile !== 'object') throw new Error(`无效的视频协议配置: ${protocol}`);
  const parameters = profile.parameters;
  const references = profile.references;
  if (!['official', 'workspace-default', 'legacy'].includes(profile.constraintSource)) throw new Error(`视频协议约束来源无效: ${protocol}`);
  if (!profile.settings || !String(profile.settings.baseUrl || '').trim() || typeof profile.settings.presetModelId !== 'string') throw new Error(`视频协议设置模板无效: ${protocol}`);
  if (profile.createEndpoint?.method !== 'POST' || !/^\/v1\/[a-z0-9/-]+$/.test(String(profile.createEndpoint?.path || ''))) throw new Error(`视频协议创建接口无效: ${protocol}`);
  if (!parameters?.duration || !parameters?.size || !parameters?.aspectRatio || !parameters?.resolution) throw new Error(`视频协议参数不完整: ${protocol}`);
  if (!references || !Number.isInteger(references.images) || references.images < 0 || references.images > MAX_VIDEO_REFERENCE_FILES || !Number.isInteger(references.videos) || references.videos < 0 || references.videos > MAX_VIDEO_REFERENCE_FILES || !Number.isInteger(references.audios) || references.audios < 0 || references.audios > MAX_VIDEO_REFERENCE_FILES) throw new Error(`视频协议附件限制无效: ${protocol}`);
  if (!Array.isArray(references.imageMimeTypes) || references.imageMimeTypes.length === 0 || references.imageMimeTypes.some(value => !isValidConfiguredMediaMimeType(value, 'image')) || !Array.isArray(references.videoMimeTypes) || references.videoMimeTypes.length === 0 || references.videoMimeTypes.some(value => !isValidConfiguredMediaMimeType(value, 'video')) || !Array.isArray(references.audioMimeTypes) || references.audioMimeTypes.length === 0 || references.audioMimeTypes.some(value => !isValidConfiguredMediaMimeType(value, 'audio')) || typeof references.imageSizeMustMatchOutput !== 'boolean') throw new Error(`视频协议参考附件配置无效: ${protocol}`);
  const duration = parameters.duration;
  if (!['enum', 'range'].includes(duration.mode) || !Array.isArray(duration.presets) || duration.presets.length === 0) throw new Error(`视频协议时长配置无效: ${protocol}`);
  if (duration.mode === 'enum' && (!Array.isArray(duration.values) || duration.values.length === 0 || duration.values.some(value => !Number.isInteger(value) || value <= 0 || value > MAX_VIDEO_DURATION_SECONDS))) throw new Error(`视频协议时长枚举无效: ${protocol}`);
  if (duration.mode === 'range' && (!Number.isInteger(duration.min) || !Number.isInteger(duration.max) || duration.min <= 0 || duration.max > MAX_VIDEO_DURATION_SECONDS || duration.max < duration.min)) throw new Error(`视频协议时长范围无效: ${protocol}`);
  if (duration.presets.some(value => !isValidDurationPreset(value, duration))) throw new Error(`视频协议时长预设无效: ${protocol}`);
  if (!['enum', 'dimensions'].includes(parameters.size.mode) || typeof parameters.size.visible !== 'boolean' || typeof parameters.size.allowCustom !== 'boolean') throw new Error(`视频协议尺寸配置无效: ${protocol}`);
  if (!Array.isArray(parameters.size.values) || parameters.size.values.some(value => !isValidConfiguredVideoSize(value)) || !Array.isArray(parameters.aspectRatio.values) || parameters.aspectRatio.values.some(value => !isValidConfiguredAspectRatio(value)) || !Array.isArray(parameters.resolution.values) || parameters.resolution.values.some(value => !Number.isInteger(value) || value < MIN_VIDEO_RESOLUTION || value > MAX_VIDEO_RESOLUTION)) throw new Error(`视频协议参数枚举无效: ${protocol}`);
  if (typeof parameters.aspectRatio.visible !== 'boolean' || typeof parameters.resolution.visible !== 'boolean' || typeof parameters.resolution.allowCustom !== 'boolean') throw new Error(`视频协议控件配置无效: ${protocol}`);
  if (!Array.isArray(profile.modelProfiles)) throw new Error(`视频模型能力规则无效: ${protocol}`);
  if (profile.modelProfiles.some(rule => !rule || typeof rule.modelPrefix !== 'string' || typeof rule.requiresImage !== 'boolean' || !rule.patch || typeof rule.patch !== 'object' || Array.isArray(rule.patch))) throw new Error(`视频模型能力规则无效: ${protocol}`);
}

/**
 * 校验模型条件规则在全部输入上下文中合并后的最终能力配置。
 * @param {any} config 已完成环境变量覆盖合并的完整配置。
 * @param {string} protocol 待校验的视频协议。
 * @returns {void} 任一模型规则产生不完整或非法配置时抛出错误。
 */
function validateResolvedModelProfiles(config, protocol) {
  const profile = config.protocols[protocol];
  for (const rule of profile.modelProfiles) {
    for (const hasImage of [false, true]) {
      const resolved = resolveVideoProtocolProfile(config, protocol, rule.modelPrefix, { hasImage });
      try {
        validateProtocolProfile(protocol, resolved);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`视频模型能力规则合并结果无效: ${protocol}/${rule.modelPrefix || '*'}（${reason}）`, { cause: error });
      }
    }
  }
}

/**
 * 解析部署环境变量中的协议能力覆盖并执行严格校验。
 * @param {Record<string, string | undefined>} env 当前运行时环境变量。
 * @returns {any} 可下发前端并供后端校验的完整协议配置。
 */
function resolveVideoProtocolConfig(env = process.env) {
  const rawOverride = String(env.FLYREQ_VIDEO_PROTOCOL_CONFIG_OVERRIDES || '').trim();
  if (cachedConfig && rawOverride === cachedOverride) return cloneJson(cachedConfig);
  let override = {};
  if (rawOverride) {
    override = JSON.parse(rawOverride);
    if (!override || typeof override !== 'object' || Array.isArray(override)) throw new Error('FLYREQ_VIDEO_PROTOCOL_CONFIG_OVERRIDES 必须是 JSON 对象');
    const overriddenProtocols = Object.keys(override.protocols || {});
    if (overriddenProtocols.some(protocol => !ALL_VIDEO_PROTOCOLS.has(protocol))) throw new Error('环境变量包含未知视频协议');
  }
  const merged = applyJsonMergePatch(defaultConfig, override);
  if (merged.version !== defaultConfig.version) throw new Error('环境变量不能覆盖视频协议配置版本');
  for (const protocol of ALL_VIDEO_PROTOCOLS) {
    validateProtocolProfile(protocol, merged.protocols?.[protocol]);
    validateResolvedModelProfiles(merged, protocol);
  }
  cachedOverride = rawOverride;
  cachedConfig = merged;
  return cloneJson(merged);
}

/**
 * 根据模型和参考图状态应用声明式模型能力规则。
 * @param {any} config 完整视频协议配置。
 * @param {string} protocol 视频协议。
 * @param {string} modelId 实际模型 ID。
 * @param {{ hasImage?: boolean }} context 当前生成上下文。
 * @returns {any} 已应用模型规则的协议能力副本。
 */
function resolveVideoProtocolProfile(config, protocol, modelId, context = {}) {
  const base = config?.protocols?.[protocol];
  if (!base) return null;
  let resolved = cloneJson(base);
  for (const rule of base.modelProfiles || []) {
    if (!String(modelId || '').startsWith(String(rule.modelPrefix || ''))) continue;
    if (rule.requiresImage && !context.hasImage) continue;
    resolved = applyJsonMergePatch(resolved, rule.patch || {});
  }
  return resolved;
}

/**
 * 判断协议是否属于设置页允许新建的三种公开协议。
 * @param {unknown} value 待校验的协议值。
 * @returns {boolean} 值属于公开视频协议时返回 true。
 */
function isPublicVideoProtocol(value) {
  return typeof value === 'string' && PUBLIC_VIDEO_PROTOCOLS.has(value);
}

/**
 * 判断协议是否可由运行时执行，包括只用于迁移的旧协议。
 * @param {unknown} value 待校验的协议值。
 * @returns {boolean} 值属于可执行视频协议时返回 true。
 */
function isVideoProtocol(value) {
  return typeof value === 'string' && ALL_VIDEO_PROTOCOLS.has(value);
}

/**
 * 使用协议能力配置校验一次视频生成请求。
 * @param {any} config 完整视频协议配置。
 * @param {string} protocol 视频协议。
 * @param {string} modelId 实际模型 ID。
 * @param {{ seconds: number, size: string, aspectRatio: string, resolution: number }} request 视频参数。
 * @param {{ images: any[], videos: any[], audios: any[] }} files 已解析的参考附件。
 * @returns {any} 本次请求实际生效的协议能力。
 */
function validateVideoProtocolRequest(config, protocol, modelId, request, files) {
  const profile = resolveVideoProtocolProfile(config, protocol, modelId, { hasImage: files.images.length > 0 });
  if (!profile) throw new Error('视频协议无效');
  const duration = profile.parameters.duration;
  const durationValid = duration.mode === 'enum'
    ? Array.isArray(duration.values) && duration.values.includes(request.seconds)
    : Number.isInteger(request.seconds) && request.seconds >= duration.min && request.seconds <= duration.max;
  if (!durationValid) throw new Error('视频时长不符合当前协议限制');
  const size = profile.parameters.size;
  if (size.visible && !size.values.includes(request.size) && !(size.allowCustom && /^\d+x\d+$/.test(request.size))) throw new Error('视频尺寸不符合当前协议限制');
  const aspectRatio = profile.parameters.aspectRatio;
  if (aspectRatio.visible && !aspectRatio.values.includes(request.aspectRatio)) throw new Error('视频宽高比不符合当前协议限制');
  const resolution = profile.parameters.resolution;
  if (resolution.visible && !resolution.values.includes(request.resolution) && !(resolution.allowCustom && Number.isInteger(request.resolution) && request.resolution >= 144 && request.resolution <= 4320)) throw new Error('视频清晰度不符合当前协议限制');
  if (files.images.length > profile.references.images || files.videos.length > profile.references.videos || files.audios.length > profile.references.audios) throw new Error('参考附件不符合当前协议限制');
  return profile;
}

/**
 * 判断附件 MIME 类型是否符合协议配置，支持 image/*、video/*、audio/* 形式的通配规则。
 * @param {string} mimeType 附件声明的 MIME 类型。
 * @param {string[]} allowedTypes 协议允许的 MIME 类型列表。
 * @returns {boolean} MIME 类型命中精确值或类型通配规则时返回 true。
 */
function isAllowedMediaMimeType(mimeType, allowedTypes) {
  return allowedTypes.some(allowed => allowed === mimeType || (allowed.endsWith('/*') && mimeType.startsWith(allowed.slice(0, -1))));
}

/**
 * 按协议能力配置校验三类参考附件格式，并按需校验参考图像素尺寸。
 * @param {any} profile 本次请求已解析的协议能力。
 * @param {{ size: string }} request 视频生成参数。
 * @param {{ images: Array<{ mimeType: string, buffer: Buffer }>, videos: Array<{ mimeType: string, buffer: Buffer }>, audios: Array<{ mimeType: string, buffer: Buffer }> }} files 已解析的参考附件。
 * @returns {Promise<void>} 校验通过时完成；格式、图片内容或尺寸不符时抛出错误。
 */
async function validateVideoProtocolReferences(profile, request, files) {
  if (files.images.some(file => !isAllowedMediaMimeType(file.mimeType, profile.references.imageMimeTypes))) throw new Error('参考图格式不符合当前协议限制');
  if (files.videos.some(file => !isAllowedMediaMimeType(file.mimeType, profile.references.videoMimeTypes))) throw new Error('参考视频格式不符合当前协议限制');
  if (files.audios.some(file => !isAllowedMediaMimeType(file.mimeType, profile.references.audioMimeTypes))) throw new Error('参考音频格式不符合当前协议限制');
  if (files.images.length === 0) return;
  if (!profile.references.imageSizeMustMatchOutput) return;
  const target = String(request.size || '').match(/^(\d+)x(\d+)$/);
  if (!target) throw new Error('当前协议要求明确的视频尺寸');
  const expectedWidth = Number(target[1]);
  const expectedHeight = Number(target[2]);

  // 逐张读取实际像素信息，防止只有第一张参考图通过校验、后续图片绕过格式或尺寸约束。
  for (const [index, image] of files.images.entries()) {
    let metadata;
    try {
      metadata = await sharp(image.buffer).metadata();
    } catch {
      throw new Error(`第 ${index + 1} 张参考图内容无效`);
    }
    const detectedMimeType = metadata.format === 'jpeg' ? 'image/jpeg' : `image/${metadata.format || 'unknown'}`;
    if (!isAllowedMediaMimeType(detectedMimeType, profile.references.imageMimeTypes)) throw new Error(`第 ${index + 1} 张参考图实际格式不符合当前协议限制`);
    if (metadata.width !== expectedWidth || metadata.height !== expectedHeight) {
      throw new Error(`第 ${index + 1} 张参考图尺寸必须与视频尺寸一致（需要 ${expectedWidth}x${expectedHeight}，实际 ${metadata.width || 0}x${metadata.height || 0}）`);
    }
  }
}

module.exports = {
  applyJsonMergePatch,
  isPublicVideoProtocol,
  isVideoProtocol,
  resolveVideoProtocolConfig,
  resolveVideoProtocolProfile,
  validateVideoProtocolReferences,
  validateVideoProtocolRequest,
};
