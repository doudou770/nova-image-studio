const http = require('http');
const { createHash, randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');
const next = process.env.NODE_ENV !== 'production' ? require('next') : null;
const Database = require('better-sqlite3');
const sharp = require('sharp');
const { WebSocketServer } = require('ws');
const Busboy = require('busboy');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { createXaiImagineRequestInit, getXaiImagineEndpoint } = require('./xai-imagine');
const { flushDailyFileLogs, installDailyFileLogger, isDailyFileLogEnabled } = require('./daily-file-logger');
const { createVideoRequest, formatVideoResolution, getCreatedVideoTaskId, getVideoDownloadHeaders, getVideoPollPath, normalizeVideoPollResult } = require('./video-protocols');
const { isPublicVideoProtocol, isVideoProtocol, resolveVideoProtocolConfig, validateVideoProtocolReferences, validateVideoProtocolRequest } = require('./video-protocol-config');
const {
  getVideoUpstreamLogMaxChars,
  isVideoUpstreamLogEnabled,
  logVideoUpstreamRequest,
  logVideoUpstreamResponse,
  logVideoTaskSummary,
} = require('./video-upstream-logger');
const {
  getImageUpstreamLogMaxChars,
  isImageUpstreamLogEnabled,
  logImageUpstreamRequest,
  logImageUpstreamResponse,
} = require('./image-upstream-logger');

const ENV_FILE_PATHS = [...new Set([
  path.join(__dirname, '.env'),
  path.join(process.cwd(), '.env'),
  path.join(__dirname, '..', '.env'),
])];
const TASK_STATUS = {
  QUEUED: '排队中',
  LEGACY_QUEUED: 'queued',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};
const GLOBAL_TASK_CONCURRENCY = 50;
const MAX_PARALLEL_COUNT = 20;
const MAX_IMAGE_PARALLEL_COUNT = 50;
const DEFAULT_LIMIT_CONFIG = {
  maxQueueSize: 200,
  rateLimitWindowMs: 60 * 1000,
  maxRequestsPerIp: 20,
  maxRequestsPerApiKey: 20,
  maxPendingTasksPerIp: 50,
  maxPendingTasksPerApiKey: 50,
  retryAfterSeconds: 30,
};
const LIMIT_ERROR_MESSAGES = {
  queueFull: '当前排队任务较多，请稍后再试。',
  rateLimited: '请求太频繁，请稍后再试。',
  tooManyPending: '你已有较多任务正在排队或生成，请稍后再提交。',
  notAcceptingTasks: '服务器正在升级维护，暂不接受新任务。未完成任务将继续完成。',
};
const DEFAULT_IMAGE_MODEL_KEY_GUIDE = {
  title: '还没有图片模型 API Key？',
  description: '默认已为你准备 FlyReq 的 GPT Image 2 图片模型，只需要前往 FlyReq 获取 API Key，填入后保存即可开始生成图片。1元=20张4k图。',
  ctaLabel: '前往 flyreq.com',
  url: 'https://flyreq.com',
};
const DEFAULT_PLATFORM_BRANDING = {
  platformName: 'FlyReq Image',
  logoUrl: '/favicon.png',
  iconUrl: '/favicon.png',
  pwaIcon192Url: '/icon-192.png',
  pwaIcon512Url: '/icon-512.png',
  pwaMaskableIcon512Url: '/icon-maskable-512.png',
  platformVersion: process.env.APP_VERSION || require(path.join(__dirname, '..', 'package.json')).version || '0.0.0',
};
const DEFAULT_IMAGE_MODEL_DEPLOYMENT_CONFIG = {
  id: 'flyreq-gpt-image-2',
  protocol: 'openai',
  name: 'FlyReq',
  modelId: '',
  usesPresetModelId: true,
  baseUrl: 'https://flyreq.com',
  builtinPreset: 'gpt-image-2',
  maxRefImages: 16,
  maxOutputSize: '4K',
  supportsAdvancedParams: true,
  supportsTemperature: false,
  streamImages: true,
};
const DEFAULT_VIDEO_MODEL_DEPLOYMENT_CONFIG = {
  id: 'flyreq-sora-2',
  protocol: 'openai',
  name: 'FlyReq',
  modelId: 'sora-2',
  baseUrl: 'https://flyreq.com',
};
const DEFAULT_VIDEO_WORKSPACE_CONFIG = {
  maxRefImages: 9,
  maxRefVideos: 3,
  maxRefAudios: 3,
  resolutions: [720, 480, 1080, 2160],
  sizes: ['1280x720', '720x1280', '1024x1024', '1792x1024', '1024x1792', 'auto'],
  durations: [6, 10, 12, 15, 20],
  maxReferenceVideoBytes: 104857600,
  maxReferenceAudioBytes: 26214400,
  maxReferenceImageBytes: 10485760,
};
const BUILTIN_IMAGE_PRESET_IDS = new Set([
  'gemini-2.5-flash-image', 'gemini-3-pro-image-preview', 'gemini-3.1-flash-image-preview',
  'gemini-3.1-flash-lite-image', 'gpt-image-2', 'grok-imagine-image', 'grok-imagine-image-quality',
]);
const DEFAULT_OUTBOUND_USER_AGENT = 'FlyReq-Image-Studio/1.5.1';

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};

  const values = {};
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    const value = rawValue.replace(/^['"]|['"]$/g, '');
    values[key] = value;
  }
  return values;
}

/**
 * 合并后端目录与项目根目录的环境变量文件。
 * @returns 后加载文件覆盖先加载文件后的环境变量对象。
 */
function parseEnvFiles() {
  return ENV_FILE_PATHS.reduce((values, filePath) => ({ ...values, ...parseEnvFile(filePath) }), {});
}

// .env 运行期读取加 1 秒 TTL 缓存：原本每次调用都同步 readFileSync，而
// getQueueStats / 建任务 / 队列广播 / WS 订阅 / 出图前都走它（单次 getQueueStats
// 触发 3 次读盘），在事件循环上造成不必要的同步 IO。1 秒对"改 .env 实时生效"
// 而言对人类无感，符合 README 承诺。
let _runtimeEnvCache = { values: null, expiresAt: 0 };

function getRuntimeEnv() {
  const now = Date.now();
  if (!_runtimeEnvCache.values || now >= _runtimeEnvCache.expiresAt) {
    _runtimeEnvCache = {
      values: { ...process.env, ...parseEnvFiles() },
      expiresAt: now + 1000,
    };
  }
  return _runtimeEnvCache.values;
}

function loadEnvFile() {
  const values = parseEnvFiles();
  for (const [key, value] of Object.entries(values)) {
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadEnvFile();

/**
 * 生成带时区标识的 ISO 8601 日志时间戳，便于按时间检索线上日志。
 * @returns 当前 UTC 时间的 ISO 8601 字符串。
 */
function getLogTimestamp() {
  return new Date().toISOString();
}

/**
 * 为后端标准日志统一添加时间戳，同时保留原始 console 的对象和错误输出格式。
 * @returns 无返回值。
 */
function installTimestampedConsole() {
  for (const method of ['log', 'info', 'warn', 'error']) {
    const write = console[method].bind(console);
    console[method] = (...args) => write(`[${getLogTimestamp()}]`, ...args);
  }
}

installTimestampedConsole();
installDailyFileLogger({
  enabled: isDailyFileLogEnabled(process.env.FLYREQ_FILE_LOG_ENABLED),
  logDir: process.env.FLYREQ_LOG_DIR,
});

function normalizeBaseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function normalizeProtocolBaseUrl(protocol, url) {
  return normalizeBaseUrl(url);
}

function getProtocolApiPrefix(protocol) {
  return protocol === 'google' ? '/v1beta' : '/v1';
}

function getProtocolVersionSuffix(protocol, url) {
  const normalized = normalizeBaseUrl(url);
  if (!normalized) return '';
  const apiPrefix = getProtocolApiPrefix(protocol);
  return normalized.toLowerCase().endsWith(apiPrefix) ? apiPrefix : '';
}

function stripProtocolVersionSuffix(protocol, url) {
  const normalized = normalizeBaseUrl(url);
  const suffix = getProtocolVersionSuffix(protocol, normalized);
  return suffix ? normalized.slice(0, -suffix.length) : normalized;
}

function appendProtocolApiPath(protocol, baseUrl, apiPath) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const normalizedPath = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
  const apiPrefix = getProtocolApiPrefix(protocol);
  if (normalizedBaseUrl.toLowerCase().endsWith(apiPrefix) && normalizedPath.toLowerCase().startsWith(`${apiPrefix}/`)) {
    return `${normalizedBaseUrl}${normalizedPath.slice(apiPrefix.length)}`;
  }
  return `${normalizedBaseUrl}${normalizedPath}`;
}

function resolveFlyreqApiBaseUrl() {
  return normalizeBaseUrl(getRuntimeEnv().FLYREQ_API_BASE_URL) || 'https://api.openai.com';
}

/**
 * 解析用于上游请求的稳定服务标识，过滤非法字符以避免请求头注入。
 * @param env 运行时环境变量，用于读取可配置的服务标识。
 * @returns 可安全写入 User-Agent 请求头的服务标识。
 */
function resolveOutboundUserAgent(env = getRuntimeEnv()) {
  const configured = sanitizeOutboundHeaderValue(String(env.FLYREQ_OUTBOUND_USER_AGENT || ''))
    .trim()
    .slice(0, 256);
  return configured || DEFAULT_OUTBOUND_USER_AGENT;
}

/**
 * 将 HTTP 请求头中不允许出现的控制字符替换为空格，避免 Headers 构造失败。
 * @param value 待清理的请求头值。
 * @returns 不含 HTTP 控制字符的请求头值。
 */
function sanitizeOutboundHeaderValue(value) {
  let sanitized = '';
  for (const character of value) {
    const code = character.charCodeAt(0);
    sanitized += code <= 31 || code === 127 ? ' ' : character;
  }
  return sanitized;
}

/**
 * 合并上游请求头并确保携带稳定的服务标识，不覆盖调用方显式提供的 User-Agent。
 * @param headers 调用方提供的请求头。
 * @param env 运行时环境变量，用于读取服务标识配置。
 * @returns 可直接传给 fetch 的完整请求头对象。
 */
function createOutboundHeaders(headers, env = getRuntimeEnv()) {
  const mergedHeaders = new Headers(headers || {});
  if (!mergedHeaders.has('user-agent')) {
    mergedHeaders.set('user-agent', resolveOutboundUserAgent(env));
  }
  return mergedHeaders;
}

function parseBaseUrlRewriteMap(rawValue) {
  const raw = String(rawValue || '').trim();
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .map(item => Array.isArray(item)
          ? { from: item[0], to: item[1] }
          : { from: item?.from ?? item?.source, to: item?.to ?? item?.target })
        .filter(item => item.from && item.to);
    }
    if (parsed && typeof parsed === 'object') {
      return Object.entries(parsed).map(([from, to]) => ({ from, to }));
    }
  } catch {
    // Fall through to the compact text format.
  }

  return raw
    .split(/[,\n;]/)
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const separator = part.includes('=>') ? '=>' : '=';
      const index = part.indexOf(separator);
      if (index <= 0) return null;
      return {
        from: part.slice(0, index).trim(),
        to: part.slice(index + separator.length).trim(),
      };
    })
    .filter(Boolean);
}

function resolveOutboundBaseUrl(protocol, baseUrl, env = getRuntimeEnv()) {
  return resolveOutboundBaseUrlDetails(protocol, baseUrl, env).baseUrl;
}

function resolveOutboundBaseUrlDetails(protocol, baseUrl, env = getRuntimeEnv()) {
  const normalizedBaseUrl = normalizeProtocolBaseUrl(protocol, baseUrl);
  const matchBaseUrl = stripProtocolVersionSuffix(protocol, normalizedBaseUrl);
  const sourceVersionSuffix = getProtocolVersionSuffix(protocol, normalizedBaseUrl);
  const rewrites = parseBaseUrlRewriteMap(env.FLYREQ_BASE_URL_REWRITE_MAP);

  for (const rewrite of rewrites) {
    const from = stripProtocolVersionSuffix(protocol, rewrite.from);
    if (!from || from.toLowerCase() !== matchBaseUrl.toLowerCase()) continue;
    const to = normalizeProtocolBaseUrl(protocol, rewrite.to);
    if (to) {
      const targetVersionSuffix = getProtocolVersionSuffix(protocol, to);
      const rewrittenBaseUrl = sourceVersionSuffix && !targetVersionSuffix
        ? `${to}${sourceVersionSuffix}`
        : to;
      return { baseUrl: rewrittenBaseUrl, originalBaseUrl: normalizedBaseUrl, rewritten: true, rewriteCount: rewrites.length };
    }
  }

  return { baseUrl: normalizedBaseUrl, originalBaseUrl: normalizedBaseUrl, rewritten: false, rewriteCount: rewrites.length };
}

/**
 * 为即将发送到上游的请求解析 Base URL，并记录完整的映射诊断信息。
 * @param requestType 上游请求类别，用于在日志中区分图片生成、文本代理或模型列表请求。
 * @param protocol 上游 API 协议标识。
 * @param baseUrl 用户配置的原始 Base URL。
 * @param env 运行时环境变量，用于读取 Base URL 映射表。
 * @returns 包含实际出站 Base URL、原始 Base URL 与映射命中状态的解析结果。
 */
function resolveAndLogOutboundBaseUrl(requestType, protocol, baseUrl, env = getRuntimeEnv()) {
  const details = resolveOutboundBaseUrlDetails(protocol, baseUrl, env);
  const status = details.rewritten ? '已应用' : details.rewriteCount > 0 ? '未命中' : '未配置';
  console.info(`[base-url-rewrite] 状态=${status} 请求=${requestType} 协议=${protocol} 原始Base URL=${details.originalBaseUrl} 最终Base URL=${details.baseUrl} 映射规则数=${details.rewriteCount}`);
  return details;
}

/**
 * 在服务启动时输出实际加载的 Base URL 映射，排除部署环境未挂载配置文件的可能。
 * @returns 无返回值；日志仅包含映射地址，不包含 API Key 等敏感信息。
 */
function logBaseUrlRewriteConfiguration() {
  const rewrites = parseBaseUrlRewriteMap(getRuntimeEnv().FLYREQ_BASE_URL_REWRITE_MAP);
  const mappings = rewrites
    .map(rewrite => `${normalizeBaseUrl(rewrite.from)}=>${normalizeBaseUrl(rewrite.to)}`)
    .join(' | ');
  console.info(`[base-url-rewrite] 启动配置 规则数=${rewrites.length}${mappings ? ` 规则=${mappings}` : ''}`);
}

function getUrlOrigin(value) {
  try {
    return new URL(normalizeBaseUrl(value)).origin.toLowerCase();
  } catch {
    return '';
  }
}

function getSafeUrlLabel(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return String(value || '').slice(0, 120);
  }
}

function shouldAuthorizeRemoteImageDownload(imageUrl, request, env = getRuntimeEnv()) {
  const imageOrigin = getUrlOrigin(imageUrl);
  if (!imageOrigin) return false;

  const allowedOrigins = new Set([
    getUrlOrigin(request?.baseUrl),
    getUrlOrigin(request?.baseUrl ? resolveOutboundBaseUrl(request.protocol, request.baseUrl, env) : resolveFlyreqApiBaseUrl()),
  ].filter(Boolean));

  return allowedOrigins.has(imageOrigin);
}

function resolveImageModelKeyGuide(env = getRuntimeEnv()) {
  const title = String(env.FLYREQ_IMAGE_MODEL_KEY_GUIDE_TITLE || '').trim();
  const description = String(env.FLYREQ_IMAGE_MODEL_KEY_GUIDE_DESCRIPTION || '').trim();
  const ctaLabel = String(env.FLYREQ_IMAGE_MODEL_KEY_GUIDE_CTA_LABEL || '').trim();
  const url = String(env.FLYREQ_IMAGE_MODEL_KEY_GUIDE_URL || '').trim();
  return {
    title: title || DEFAULT_IMAGE_MODEL_KEY_GUIDE.title,
    description: description || DEFAULT_IMAGE_MODEL_KEY_GUIDE.description,
    ctaLabel: ctaLabel || DEFAULT_IMAGE_MODEL_KEY_GUIDE.ctaLabel,
    url: url || DEFAULT_IMAGE_MODEL_KEY_GUIDE.url,
  };
}

function hashPromptGalleryPassword(password) {
  return createHash('sha256')
    .update(`${PROMPT_GALLERY_PASSWORD_SALT}${String(password || '')}`)
    .digest('hex');
}

const PORT = Number(process.env.PORT || 3001);
const HOSTNAME = process.env.HOSTNAME || '0.0.0.0';
const DB_PATH = process.env.FLYREQ_TASK_DB || path.join(__dirname, 'flyreq-tasks.sqlite');
const TASK_TTL_MS = 12 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_REMOTE_IMAGE_MAX_BYTES = 50 * 1024 * 1024;
const XAI_IMAGINE_MAX_REQUESTS_PER_SECOND = 5;
const XAI_IMAGINE_REQUEST_INTERVAL_MS = 1000 / XAI_IMAGINE_MAX_REQUESTS_PER_SECOND;
const XAI_IMAGINE_MAX_RETRIES = 1;
const XAI_IMAGINE_DEFAULT_RETRY_DELAY_MS = 1000;
// 开源版：不再硬编码模型列表，由前端通过 protocol 字段指定协议类型
const VALID_PROTOCOLS = new Set(['google', 'openai']);
const GPT_IMAGE_QUALITIES = new Set(['auto', 'high', 'medium', 'low']);
const GPT_IMAGE_STYLES = new Set(['auto', 'vivid', 'natural']);
const GPT_IMAGE_BACKGROUNDS = new Set(['auto', 'transparent', 'opaque']);
const GPT_IMAGE_OUTPUT_FORMATS = new Set(['png', 'jpeg', 'webp']);
const IMAGE_OUTPUT_SIZES = new Set(['auto', '512', '1K', '2K', '4K']);
const IMAGE_API_FLAVORS = new Set(['xai-imagine']);
const XAI_IMAGINE_OUTPUT_SIZES = new Set(['1K', '2K']);
const XAI_IMAGINE_ASPECT_RATIOS = new Set([
  'auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3',
  '2:1', '1:2', '19.5:9', '9:19.5', '20:9', '9:20',
]);
const DEFAULT_GPT_IMAGE_ADVANCED_PARAMS = {
  quality: 'auto',
  style: 'auto',
  background: 'auto',
  outputFormat: 'png',
};
const PROMPT_GALLERY_PASSWORD_SALT = 'flyreq-pg-2026';
const CUSTOM_IMAGE_SIZE_LIMITS = {
  multiple: 16,
  maxAspectRatio: 3,
  minPixels: 655360,
  maxPixels: 8294400,
};
const IS_DEV = process.env.NODE_ENV !== 'production';
const STATIC_DIR = path.join(__dirname, '..', 'frontend', 'out');
const IMAGE_DIR = process.env.FLYREQ_IMAGE_DIR || path.join(__dirname, 'flyreq-images');
const VIDEO_DIR = process.env.FLYREQ_VIDEO_DIR || path.join(__dirname, 'flyreq-videos');
const taskRefImages = new Map();
const taskVideoFiles = new Map();
const videoTaskAbortControllers = new Map();

const app = IS_DEV ? next({ dev: IS_DEV, hostname: HOSTNAME, port: PORT, dir: path.join(__dirname, '..', 'frontend') }) : null;
const handle = app ? app.getRequestHandler() : null;
const db = new Database(DB_PATH);
const apiKeys = new Map();
const taskSources = new Map(); // taskId -> { ip, apiKeyHash }
const rateLimitBuckets = new Map(); // key -> { windowStart: number, count: number }
const pendingCountByIp = new Map(); // ip -> count
const pendingCountByApiKeyHash = new Map(); // apiKeyHash -> count
const xaiImagineNextRequestAtByApiKeyHash = new Map(); // apiKeyHash -> next request start timestamp
const queue = [];
let activeCount = 0;
const videoQueue = [];
let activeVideoCount = 0;

// ===== WebSocket subscription state =====
const taskSubscriptions = new Map(); // WebSocket -> Set<taskId>
const queueSubscribers = new Set(); // Set<WebSocket>
const wsAlive = new WeakMap(); // WebSocket -> { lastPong: number, missed: number }
const WS_HEARTBEAT_INTERVAL_MS = 30 * 1000;
const WS_PONG_GRACE_MS = 10 * 1000;
// 单条 subscribeTasks 消息最多处理的 taskId 数，以及单连接订阅总量上限，
// 防止一条消息被放大成大量 DB 查询（DoS 面）。
const WS_MAX_TASK_IDS_PER_MESSAGE = 200;
const WS_MAX_SUBSCRIPTIONS_PER_SOCKET = 500;
const WS_MAX_PAYLOAD_BYTES = 64 * 1024;
let queueBroadcastTimer = null;
let queueBroadcastPending = false;

function getMaxServerConcurrency() {
  const configured = Number(getRuntimeEnv().FLYREQ_TASK_CONCURRENCY || GLOBAL_TASK_CONCURRENCY);
  const safeConfigured = Number.isFinite(configured) ? configured : GLOBAL_TASK_CONCURRENCY;
  return Math.max(1, Math.min(GLOBAL_TASK_CONCURRENCY, safeConfigured));
}

function parseIntegerEnv(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function getLimitConfig() {
  const env = getRuntimeEnv();
  return {
    maxQueueSize: parseIntegerEnv(env.FLYREQ_MAX_QUEUE_SIZE, DEFAULT_LIMIT_CONFIG.maxQueueSize, { min: 0, max: 100000 }),
    rateLimitWindowMs: parseIntegerEnv(env.FLYREQ_RATE_LIMIT_WINDOW_MS, DEFAULT_LIMIT_CONFIG.rateLimitWindowMs, { min: 1000, max: 24 * 60 * 60 * 1000 }),
    maxRequestsPerIp: parseIntegerEnv(env.FLYREQ_RATE_LIMIT_MAX_REQUESTS_PER_IP, DEFAULT_LIMIT_CONFIG.maxRequestsPerIp, { min: 0, max: 100000 }),
    maxRequestsPerApiKey: parseIntegerEnv(env.FLYREQ_RATE_LIMIT_MAX_REQUESTS_PER_API_KEY, DEFAULT_LIMIT_CONFIG.maxRequestsPerApiKey, { min: 0, max: 100000 }),
    maxPendingTasksPerIp: parseIntegerEnv(env.FLYREQ_MAX_PENDING_TASKS_PER_IP, DEFAULT_LIMIT_CONFIG.maxPendingTasksPerIp, { min: 0, max: 100000 }),
    maxPendingTasksPerApiKey: parseIntegerEnv(env.FLYREQ_MAX_PENDING_TASKS_PER_API_KEY, DEFAULT_LIMIT_CONFIG.maxPendingTasksPerApiKey, { min: 0, max: 100000 }),
    retryAfterSeconds: parseIntegerEnv(env.FLYREQ_RATE_LIMIT_RETRY_AFTER_SECONDS, DEFAULT_LIMIT_CONFIG.retryAfterSeconds, { min: 1, max: 24 * 60 * 60 }),
  };
}

function createHttpError(statusCode, code, message, retryAfterSeconds) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.retryAfter = retryAfterSeconds;
  return error;
}

function isHttpError(error) {
  return error && typeof error.statusCode === 'number' && typeof error.code === 'string';
}

function getClientIp(req) {
  const forwardedFor = req?.headers?.['x-forwarded-for'];
  const firstForwarded = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  const ip = String(firstForwarded || '').split(',')[0].trim()
    || req?.socket?.remoteAddress
    || 'unknown';
  return ip.replace(/^::ffff:/, '');
}

function hashApiKey(apiKey) {
  return createHash('sha256').update(String(apiKey || '')).digest('hex').slice(0, 24);
}

/**
 * 解析图片模板到实际模型 ID 的运行时环境变量映射。
 * @param {Record<string, string>} env 当前运行时环境变量。
 * @returns {Record<string, string>} 经白名单过滤后的模板模型 ID 映射。
 */
function resolveImagePresetModelIds(env = getRuntimeEnv()) {
  const raw = String(env.FLYREQ_IMAGE_PRESET_MODEL_IDS || '').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result = {};
    for (const [presetId, value] of Object.entries(parsed)) {
      if (BUILTIN_IMAGE_PRESET_IDS.has(presetId) && typeof value === 'string' && value.trim()) result[presetId] = value.trim();
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * 解析布尔型环境变量，仅接受常用的真值和假值字符串。
 * @param value 环境变量原始值。
 * @param fallback 变量缺失或无效时采用的默认值。
 * @returns 归一化后的布尔值。
 */
function parseBooleanEnv(value, fallback) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

/**
 * 读取部署级首次图片模型配置，不包含 API Key，避免将密钥下发给浏览器。
 * @param env 合并后的运行时环境变量对象。
 * @returns 可安全传递到前端并用于首次初始化的图片模型配置。
 */
function resolveDefaultImageModelConfig(env = getRuntimeEnv()) {
  const presetCandidate = String(env.FLYREQ_DEFAULT_IMAGE_MODEL_PRESET || '').trim();
  const builtinPreset = BUILTIN_IMAGE_PRESET_IDS.has(presetCandidate)
    ? presetCandidate
    : DEFAULT_IMAGE_MODEL_DEPLOYMENT_CONFIG.builtinPreset;
  const protocolCandidate = String(env.FLYREQ_DEFAULT_IMAGE_MODEL_PROTOCOL || '').trim();
  const protocol = protocolCandidate === 'google' || protocolCandidate === 'openai'
    ? protocolCandidate
    : DEFAULT_IMAGE_MODEL_DEPLOYMENT_CONFIG.protocol;
  const isXaiImagine = builtinPreset === 'grok-imagine-image' || builtinPreset === 'grok-imagine-image-quality';
  const configuredModelId = String(env.FLYREQ_DEFAULT_IMAGE_MODEL_MODEL_ID || '').trim().slice(0, 200);
  const usesPresetModelId = !configuredModelId;
  const supportsAdvancedParams = protocol === 'openai' && builtinPreset === 'gpt-image-2'
    ? parseBooleanEnv(env.FLYREQ_DEFAULT_IMAGE_MODEL_SUPPORTS_ADVANCED_PARAMS, DEFAULT_IMAGE_MODEL_DEPLOYMENT_CONFIG.supportsAdvancedParams)
    : false;
  const streamImages = protocol === 'openai' && builtinPreset === 'gpt-image-2'
    ? parseBooleanEnv(env.FLYREQ_DEFAULT_IMAGE_MODEL_STREAM_IMAGES, DEFAULT_IMAGE_MODEL_DEPLOYMENT_CONFIG.streamImages)
    : false;
  return {
    id: String(env.FLYREQ_DEFAULT_IMAGE_MODEL_KEY || '').trim().slice(0, 120) || DEFAULT_IMAGE_MODEL_DEPLOYMENT_CONFIG.id,
    protocol: isXaiImagine ? 'openai' : protocol,
    name: String(env.FLYREQ_DEFAULT_IMAGE_MODEL_NAME || '').trim().slice(0, 120) || DEFAULT_IMAGE_MODEL_DEPLOYMENT_CONFIG.name,
    modelId: usesPresetModelId ? '' : configuredModelId,
    usesPresetModelId,
    baseUrl: String(env.FLYREQ_DEFAULT_IMAGE_MODEL_BASE_URL || '').trim().slice(0, 500) || DEFAULT_IMAGE_MODEL_DEPLOYMENT_CONFIG.baseUrl,
    builtinPreset,
    maxRefImages: isXaiImagine
      ? 1
      : parseIntegerEnv(env.FLYREQ_DEFAULT_IMAGE_MODEL_MAX_REF_IMAGES, DEFAULT_IMAGE_MODEL_DEPLOYMENT_CONFIG.maxRefImages, { min: 1, max: 16 }),
    maxOutputSize: isXaiImagine
      ? (String(env.FLYREQ_DEFAULT_IMAGE_MODEL_MAX_OUTPUT_SIZE || '').trim() === '1K' ? '1K' : '2K')
      : (['512', '1K', '2K', '4K'].includes(String(env.FLYREQ_DEFAULT_IMAGE_MODEL_MAX_OUTPUT_SIZE || '').trim())
        ? String(env.FLYREQ_DEFAULT_IMAGE_MODEL_MAX_OUTPUT_SIZE).trim()
        : DEFAULT_IMAGE_MODEL_DEPLOYMENT_CONFIG.maxOutputSize),
    supportsAdvancedParams,
    supportsTemperature: protocol === 'google'
      ? parseBooleanEnv(env.FLYREQ_DEFAULT_IMAGE_MODEL_SUPPORTS_TEMPERATURE, false)
      : false,
    streamImages,
  };
}

/**
 * 解析逗号分隔的正整数环境变量数组。
 * @param value 环境变量原始值。
 * @param fallback 变量缺失或没有有效项时采用的默认数组。
 * @returns 去重后的正整数数组。
 */
function parseIntegerListEnv(value, fallback) {
  const values = String(value || '').split(',')
    .map(item => Number(item.trim()))
    .filter(item => Number.isInteger(item) && item > 0);
  return values.length > 0 ? [...new Set(values)] : [...fallback];
}

/**
 * 解析逗号分隔的视频尺寸环境变量数组。
 * @param value 环境变量原始值。
 * @param fallback 变量缺失或没有有效项时采用的默认数组。
 * @returns 仅包含 auto 或宽x高格式的去重数组。
 */
function parseVideoSizeListEnv(value, fallback) {
  const values = String(value || '').split(',')
    .map(item => item.trim().toLowerCase())
    .filter(item => item === 'auto' || /^\d+x\d+$/.test(item));
  return values.length > 0 ? [...new Set(values)] : [...fallback];
}

/**
 * 读取部署级首次视频模型配置，不包含 API Key。
 * @param env 合并后的运行时环境变量对象。
 * @returns 可安全下发给浏览器的视频模型配置。
 */
function resolveDefaultVideoModelConfig(env = getRuntimeEnv()) {
  const protocolCandidate = String(env.FLYREQ_DEFAULT_VIDEO_MODEL_PROTOCOL || '').trim();
  const protocol = isPublicVideoProtocol(protocolCandidate) ? protocolCandidate : DEFAULT_VIDEO_MODEL_DEPLOYMENT_CONFIG.protocol;
  return {
    id: String(env.FLYREQ_DEFAULT_VIDEO_MODEL_KEY || '').trim().slice(0, 120) || DEFAULT_VIDEO_MODEL_DEPLOYMENT_CONFIG.id,
    protocol,
    name: String(env.FLYREQ_DEFAULT_VIDEO_MODEL_NAME || '').trim().slice(0, 120) || DEFAULT_VIDEO_MODEL_DEPLOYMENT_CONFIG.name,
    modelId: String(env.FLYREQ_DEFAULT_VIDEO_MODEL_MODEL_ID || '').trim().slice(0, 200) || DEFAULT_VIDEO_MODEL_DEPLOYMENT_CONFIG.modelId,
    baseUrl: String(env.FLYREQ_DEFAULT_VIDEO_MODEL_BASE_URL || '').trim().slice(0, 500) || DEFAULT_VIDEO_MODEL_DEPLOYMENT_CONFIG.baseUrl,
  };
}

/**
 * 读取视频工作台附件上限与参数预设。
 * @param env 合并后的运行时环境变量对象。
 * @returns 可安全下发给浏览器并用于后端校验的视频工作台配置。
 */
function resolveVideoWorkspaceConfig(env = getRuntimeEnv()) {
  return {
    maxRefImages: parseIntegerEnv(env.FLYREQ_VIDEO_MAX_REF_IMAGES, DEFAULT_VIDEO_WORKSPACE_CONFIG.maxRefImages, { min: 1, max: 20 }),
    maxRefVideos: parseIntegerEnv(env.FLYREQ_VIDEO_MAX_REF_VIDEOS, DEFAULT_VIDEO_WORKSPACE_CONFIG.maxRefVideos, { min: 1, max: 20 }),
    maxRefAudios: parseIntegerEnv(env.FLYREQ_VIDEO_MAX_REF_AUDIOS, DEFAULT_VIDEO_WORKSPACE_CONFIG.maxRefAudios, { min: 1, max: 20 }),
    resolutions: parseIntegerListEnv(env.FLYREQ_VIDEO_RESOLUTIONS, DEFAULT_VIDEO_WORKSPACE_CONFIG.resolutions),
    sizes: parseVideoSizeListEnv(env.FLYREQ_VIDEO_SIZES, DEFAULT_VIDEO_WORKSPACE_CONFIG.sizes),
    durations: parseIntegerListEnv(env.FLYREQ_VIDEO_DURATIONS, DEFAULT_VIDEO_WORKSPACE_CONFIG.durations),
    maxReferenceVideoBytes: parseIntegerEnv(env.FLYREQ_VIDEO_MAX_REFERENCE_VIDEO_BYTES, DEFAULT_VIDEO_WORKSPACE_CONFIG.maxReferenceVideoBytes, { min: 1, max: 1024 * 1024 * 1024 }),
    maxReferenceAudioBytes: parseIntegerEnv(env.FLYREQ_VIDEO_MAX_REFERENCE_AUDIO_BYTES, DEFAULT_VIDEO_WORKSPACE_CONFIG.maxReferenceAudioBytes, { min: 1, max: 512 * 1024 * 1024 }),
    maxReferenceImageBytes: parseIntegerEnv(env.FLYREQ_VIDEO_MAX_REFERENCE_IMAGE_BYTES, DEFAULT_VIDEO_WORKSPACE_CONFIG.maxReferenceImageBytes, { min: 1, max: 100 * 1024 * 1024 }),
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForXaiImagineRequestSlot(apiKey) {
  const apiKeyHash = hashApiKey(apiKey);
  const now = Date.now();
  const nextRequestAt = xaiImagineNextRequestAtByApiKeyHash.get(apiKeyHash) || now;
  const scheduledAt = Math.max(now, nextRequestAt);
  xaiImagineNextRequestAtByApiKeyHash.set(apiKeyHash, scheduledAt + XAI_IMAGINE_REQUEST_INTERVAL_MS);

  if (scheduledAt > now) {
    await delay(scheduledAt - now);
  }
}

function getRetryAfterDelayMs(response) {
  const retryAfter = response.headers.get('retry-after');
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000);

  const retryAt = retryAfter ? Date.parse(retryAfter) : Number.NaN;
  return Number.isFinite(retryAt)
    ? Math.max(0, retryAt - Date.now())
    : XAI_IMAGINE_DEFAULT_RETRY_DELAY_MS;
}

function cleanupTaskRuntimeState(taskId) {
  const source = taskSources.get(taskId);
  if (source) {
    // 递减 IP 计数
    if (source.ip) {
      const ipCount = pendingCountByIp.get(source.ip) || 0;
      if (ipCount <= 1) {
        pendingCountByIp.delete(source.ip);
      } else {
        pendingCountByIp.set(source.ip, ipCount - 1);
      }
    }
    // 递减 apiKeyHash 计数
    if (source.apiKeyHash) {
      const hashCount = pendingCountByApiKeyHash.get(source.apiKeyHash) || 0;
      if (hashCount <= 1) {
        pendingCountByApiKeyHash.delete(source.apiKeyHash);
      } else {
        pendingCountByApiKeyHash.set(source.apiKeyHash, hashCount - 1);
      }
    }
  }
  apiKeys.delete(taskId);
  taskRefImages.delete(taskId);
  taskVideoFiles.delete(taskId);
  videoTaskAbortControllers.delete(taskId);
  taskSources.delete(taskId);
}

function getPendingCountForSource(fieldName, value) {
  if (!value) return 0;
  // O(1) 查找：使用独立计数器代替遍历 taskSources
  if (fieldName === 'ip') return pendingCountByIp.get(value) || 0;
  if (fieldName === 'apiKeyHash') return pendingCountByApiKeyHash.get(value) || 0;
  // fallback：未知字段仍用遍历（不应发生）
  let count = 0;
  for (const source of taskSources.values()) {
    if (source?.[fieldName] === value) count++;
  }
  return count;
}

function consumeRateLimit(bucketKey, maxRequests, windowMs) {
  if (maxRequests <= 0) {
    return { allowed: false, retryAfterSeconds: Math.ceil(windowMs / 1000) };
  }
  const now = Date.now();
  const existing = rateLimitBuckets.get(bucketKey);
  if (!existing || now - existing.windowStart >= windowMs) {
    rateLimitBuckets.set(bucketKey, { windowStart: now, count: 1 });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  if (existing.count >= maxRequests) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((windowMs - (now - existing.windowStart)) / 1000)) };
  }
  existing.count += 1;
  return { allowed: true, retryAfterSeconds: 0 };
}

function cleanupRateLimitBuckets() {
  const now = Date.now();
  const maxWindowMs = getLimitConfig().rateLimitWindowMs;
  for (const [key, bucket] of rateLimitBuckets) {
    if (!bucket || now - bucket.windowStart > maxWindowMs * 2) {
      rateLimitBuckets.delete(key);
    }
  }
  for (const [apiKeyHash, nextRequestAt] of xaiImagineNextRequestAtByApiKeyHash) {
    if (!Number.isFinite(nextRequestAt) || now - nextRequestAt > maxWindowMs * 2) {
      xaiImagineNextRequestAtByApiKeyHash.delete(apiKeyHash);
    }
  }
}

function enforceRateLimit(req, body, config) {
  const ip = getClientIp(req);
  const apiKeyHash = hashApiKey(body.apiKey);
  const ipLimit = consumeRateLimit(`ip:${ip}`, config.maxRequestsPerIp, config.rateLimitWindowMs);
  if (!ipLimit.allowed) {
    throw createHttpError(429, 'RATE_LIMITED', LIMIT_ERROR_MESSAGES.rateLimited, Math.max(config.retryAfterSeconds, ipLimit.retryAfterSeconds));
  }
  const apiKeyLimit = consumeRateLimit(`api:${apiKeyHash}`, config.maxRequestsPerApiKey, config.rateLimitWindowMs);
  if (!apiKeyLimit.allowed) {
    throw createHttpError(429, 'RATE_LIMITED', LIMIT_ERROR_MESSAGES.rateLimited, Math.max(config.retryAfterSeconds, apiKeyLimit.retryAfterSeconds));
  }
  return { ip, apiKeyHash };
}

/** 返回不同任务类型允许的批量数量上限。
 * @param mode 当前任务模式。
 * @returns 对应模式的最大并发数量。
 */
function getMaxParallelCount(mode) {
  return mode === 'text-to-image' || mode === 'image-to-image' ? MAX_IMAGE_PARALLEL_COUNT : MAX_PARALLEL_COUNT;
}

/**
 * 校验队列和来源维度是否有足够容量接收新任务。
 * @param source 当前请求的 IP 与 API Key 哈希来源。
 * @param config 运行时队列与限额配置。
 * @param requestedSlots 本次请求占用的图片生成槽位数量。
 * @param requestedTasks 本次请求将创建的独立任务数量。
 * @returns 无返回值；容量不足时抛出带 HTTP 状态码的异常。
 */
function enforceQueueCapacity(source, config, requestedSlots = 1, requestedTasks = 1, maxParallelCount = MAX_PARALLEL_COUNT) {
  const stats = getQueueStats();
  const slotsToReserve = Math.max(1, Math.min(maxParallelCount, Math.trunc(Number(requestedSlots)) || 1));
  const tasksToReserve = Math.max(1, Math.min(maxParallelCount, Math.trunc(Number(requestedTasks)) || 1));
  if (stats.pendingCount >= config.maxQueueSize) {
    throw createHttpError(503, 'QUEUE_FULL', LIMIT_ERROR_MESSAGES.queueFull, config.retryAfterSeconds);
  }
  if (stats.pendingCount + tasksToReserve > config.maxQueueSize) {
    throw createHttpError(503, 'QUEUE_FULL', LIMIT_ERROR_MESSAGES.queueFull, config.retryAfterSeconds);
  }
  if (stats.pendingSlots + slotsToReserve > config.maxQueueSize) {
    throw createHttpError(503, 'QUEUE_FULL', LIMIT_ERROR_MESSAGES.queueFull, config.retryAfterSeconds);
  }
  if (getPendingCountForSource('ip', source.ip) + tasksToReserve > config.maxPendingTasksPerIp) {
    throw createHttpError(429, 'TOO_MANY_PENDING_TASKS', LIMIT_ERROR_MESSAGES.tooManyPending, config.retryAfterSeconds);
  }
  if (getPendingCountForSource('apiKeyHash', source.apiKeyHash) + tasksToReserve > config.maxPendingTasksPerApiKey) {
    throw createHttpError(429, 'TOO_MANY_PENDING_TASKS', LIMIT_ERROR_MESSAGES.tooManyPending, config.retryAfterSeconds);
  }
}

function isRejectNewTasksEnabled() {
  const env = getRuntimeEnv();
  const rejectSwitch = String(env.FLYREQ_REJECT_NEW_TASKS || '').trim().toLowerCase();
  const acceptSwitch = String(env.FLYREQ_ACCEPT_NEW_TASKS || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(rejectSwitch) || acceptSwitch === 'false' || acceptSwitch === '0';
}

function getQueueStats() {
  const config = getLimitConfig();
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS count, SUM(slot_count) AS slots
    FROM (
      SELECT
        status,
        CASE
          WHEN CAST(json_extract(request_json, '$.parallelCount') AS INTEGER) BETWEEN 1 AND ? THEN CAST(json_extract(request_json, '$.parallelCount') AS INTEGER)
          ELSE 1
        END AS slot_count
      FROM tasks
      WHERE status IN (?, ?, ?)
    )
    GROUP BY status
  `).all(Math.max(MAX_PARALLEL_COUNT, MAX_IMAGE_PARALLEL_COUNT), TASK_STATUS.QUEUED, TASK_STATUS.LEGACY_QUEUED, TASK_STATUS.PROCESSING);
  const counts = Object.fromEntries(rows.map(row => [row.status, Number(row.count || 0)]));
  const slots = Object.fromEntries(rows.map(row => [row.status, Number(row.slots || 0)]));
  const processingCount = counts[TASK_STATUS.PROCESSING] || 0;
  const queuedCount = (counts[TASK_STATUS.QUEUED] || 0) + (counts[TASK_STATUS.LEGACY_QUEUED] || 0);
  const processingSlots = slots[TASK_STATUS.PROCESSING] || 0;
  const queuedSlots = (slots[TASK_STATUS.QUEUED] || 0) + (slots[TASK_STATUS.LEGACY_QUEUED] || 0);
  const totalActiveTasks = processingCount + queuedCount;
  const totalActiveSlots = processingSlots + queuedSlots;
  const acceptingNewTasks = !isRejectNewTasksEnabled();

  return {
    concurrencyLimit: GLOBAL_TASK_CONCURRENCY,
    configuredConcurrency: getMaxServerConcurrency(),
    processingCount,
    queuedCount,
    pendingCount: totalActiveTasks,
    processingSlots,
    queuedSlots,
    pendingSlots: totalActiveSlots,
    maxQueueSize: config.maxQueueSize,
    remainingQueueSlots: Math.max(0, config.maxQueueSize - totalActiveSlots),
    displayConcurrency: Math.min(GLOBAL_TASK_CONCURRENCY, totalActiveSlots),
    displayQueued: Math.max(0, totalActiveSlots - GLOBAL_TASK_CONCURRENCY),
    acceptingNewTasks,
    rateLimitWindowMs: config.rateLimitWindowMs,
    rateLimitMaxRequestsPerIp: config.maxRequestsPerIp,
    rateLimitMaxRequestsPerApiKey: config.maxRequestsPerApiKey,
    retryAfterSeconds: config.retryAfterSeconds,
    serverMessage: acceptingNewTasks ? undefined : LIMIT_ERROR_MESSAGES.notAcceptingTasks,
  };
}

// ===== Image Storage Service =====

/**
 * 确保图片结果目录可写，失败时记录错误并交由启动流程安全退出。
 * @returns {boolean} 目录可用时返回 true，创建失败时返回 false。
 */
function ensureImageDir() {
  try {
    if (!fs.existsSync(IMAGE_DIR)) {
      fs.mkdirSync(IMAGE_DIR, { recursive: true });
    }
    console.log(`[image-storage] 图片存储目录: ${IMAGE_DIR}`);
    return true;
  } catch (error) {
    console.error(`[image-storage] 无法创建图片存储目录: ${IMAGE_DIR}`, error);
    return false;
  }
}

function getImageExtension(mimeType) {
  if (mimeType?.includes('jpeg') || mimeType?.includes('jpg')) return 'jpg';
  if (mimeType?.includes('webp')) return 'webp';
  return 'png';
}

/**
 * 将生成图片写入磁盘，并返回可唯一定位子图的 HTTP 地址。
 * @param taskId 服务端任务标识。
 * @param itemIndex 任务内图片请求序号。
 * @param subIndex 单次上游响应中的子图序号。
 * @param imageBuffer 待保存的图片二进制数据。
 * @param mimeType 图片 MIME 类型。
 * @returns 保存路径与包含子图序号的图片访问地址。
 */
function saveImageToDisk(taskId, itemIndex, subIndex, imageBuffer, mimeType) {
  const ext = getImageExtension(mimeType);
  const fileName = `${taskId}-${itemIndex}-${subIndex}.${ext}`;
  const filePath = path.join(IMAGE_DIR, fileName);
  fs.writeFileSync(filePath, imageBuffer);
  return { filePath, httpUrl: `/api/flyreq/images/${taskId}/${itemIndex}/${subIndex}` };
}

/**
 * 确保视频结果目录存在，目录不可用时终止启动以避免产生不可取回任务。
 * @returns {boolean} 目录可用时返回 true，创建失败时返回 false。
 */
function ensureVideoDir() {
  try {
    if (!fs.existsSync(VIDEO_DIR)) fs.mkdirSync(VIDEO_DIR, { recursive: true });
    // 服务重启时清理上次异常退出留下的临时文件，最终视频文件不受影响。
    for (const name of fs.readdirSync(VIDEO_DIR)) {
      if (/^[a-f0-9-]+\.(?:mp4|webm|mov)\.part$/i.test(name)) fs.rmSync(path.join(VIDEO_DIR, name), { force: true });
    }
    console.log(`[video-storage] 视频存储目录: ${VIDEO_DIR}`);
    return true;
  } catch (error) {
    console.error(`[video-storage] 无法创建视频存储目录: ${VIDEO_DIR}`, error);
    return false;
  }
}

/**
 * 根据响应类型选择视频扩展名。
 * @param mimeType 上游视频响应的 MIME 类型。
 * @returns 受支持的视频文件扩展名。
 */
function getVideoExtension(mimeType) {
  if (mimeType?.includes('webm')) return 'webm';
  if (mimeType?.includes('quicktime')) return 'mov';
  return 'mp4';
}

/**
 * 查找指定任务已缓存的视频文件。
 * @param taskId 视频任务标识。
 * @returns 视频绝对路径；不存在时返回 null。
 */
function findTaskVideoFile(taskId) {
  if (!/^[a-f0-9-]+$/i.test(taskId) || !fs.existsSync(VIDEO_DIR)) return null;
  for (const ext of ['mp4', 'webm', 'mov']) {
    const candidate = path.join(VIDEO_DIR, `${taskId}.${ext}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * 删除指定任务对应的视频结果文件。
 * @param taskId 视频任务标识。
 * @returns 无返回值。
 */
function deleteTaskVideoFile(taskId) {
  const filePath = findTaskVideoFile(taskId);
  if (filePath) {
    try { fs.unlinkSync(filePath); } catch { /* 文件已被清理时无需重复报错。 */ }
  }
}

/**
 * 通过支持 Range 的响应发送视频文件。
 * @param req 原始 HTTP 请求，用于读取 Range 请求头。
 * @param res 原始 HTTP 响应。
 * @param filePath 待发送的视频绝对路径。
 * @returns 无返回值，响应会在文件流结束后关闭。
 */
function sendVideoFile(req, res, filePath) {
  const stat = fs.statSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = ext === '.webm' ? 'video/webm' : ext === '.mov' ? 'video/quicktime' : 'video/mp4';
  const range = String(req.headers.range || '');
  if (!range) {
    res.writeHead(200, { 'Content-Type': mimeType, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600' });
    fs.createReadStream(filePath).pipe(res);
    return;
  }
  const match = range.match(/^bytes=(\d*)-(\d*)$/);
  let start;
  let end;
  if (match?.[1]) {
    // 普通范围 bytes=start-end；省略 end 时读取到文件末尾。
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
  } else if (match?.[2]) {
    // 后缀范围 bytes=-length 表示读取文件末尾 length 字节。
    const suffixLength = Number(match[2]);
    if (Number.isSafeInteger(suffixLength) && suffixLength > 0) {
      start = Math.max(0, stat.size - suffixLength);
      end = stat.size - 1;
    }
  }
  if (!match || start === undefined || end === undefined || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= stat.size) {
    res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
    res.end();
    return;
  }
  res.writeHead(206, {
    'Content-Type': mimeType,
    'Content-Length': end - start + 1,
    'Content-Range': `bytes ${start}-${end}/${stat.size}`,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
  });
  fs.createReadStream(filePath, { start, end }).pipe(res);
}

function getImageMimeType(format, fallback = 'image/png') {
  if (format === 'jpeg') return 'image/jpeg';
  if (format === 'webp') return 'image/webp';
  if (format === 'png') return 'image/png';
  return fallback;
}

function parseAspectRatio(aspectRatio) {
  const match = String(aspectRatio || '').match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (!match) return undefined;

  const decimalPlaces = Math.max(
    (match[1].split('.')[1] || '').length,
    (match[2].split('.')[1] || '').length,
  );
  const multiplier = 10 ** decimalPlaces;
  const width = Math.round(Number(match[1]) * multiplier);
  const height = Math.round(Number(match[2]) * multiplier);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

function getImageLayoutTargetSize(request) {
  const customSize = normalizeCustomImageSize(request.customSize, 3840, request.customSizeAlignMultiple !== false);
  if (customSize) return parseImageSize(customSize);

  const requestedSize = getGptImageSize(request.outputSize, request.aspectRatio);
  if (request.protocol === 'openai' && request.imageApiFlavor !== 'xai-imagine' && requestedSize) {
    return parseImageSize(requestedSize);
  }

  // Every supported provider uses 1024x1024 for the 1K square preset.
  if (request.outputSize === '1K' && request.aspectRatio === '1:1') {
    return { width: 1024, height: 1024 };
  }

  return undefined;
}

function getCenteredAspectCrop(width, height, aspectRatio) {
  const ratio = parseAspectRatio(aspectRatio);
  if (!ratio || width <= 0 || height <= 0) return undefined;

  const scale = Math.floor(Math.min(width / ratio.width, height / ratio.height));
  if (scale <= 0) return undefined;

  const cropWidth = scale * ratio.width;
  const cropHeight = scale * ratio.height;
  return {
    left: Math.floor((width - cropWidth) / 2),
    top: Math.floor((height - cropHeight) / 2),
    width: cropWidth,
    height: cropHeight,
  };
}

/**
 * 校验品牌图片地址，只允许站内绝对路径或 HTTP(S) 资源地址。
 * @param value 环境变量中读取到的品牌图片地址。
 * @param fallback 配置缺失或地址无效时使用的默认地址。
 * @returns 可安全下发给浏览器加载的图片地址。
 */
function normalizeBrandAssetUrl(value, fallback) {
  const normalized = String(value || '').trim();
  if (!normalized) return fallback;
  if (normalized.startsWith('/') && !normalized.startsWith('//')) return normalized;
  try {
    const parsed = new URL(normalized);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? normalized : fallback;
  } catch {
    return fallback;
  }
}

/**
 * 读取平台名称、Logo、站点图标、PWA 图标与镜像构建版本号的运行时品牌配置。
 * @param env 合并后的运行时环境变量对象。
 * @returns 可直接下发至前端和 PWA Manifest 的品牌配置。
 */
function resolvePlatformBranding(env = getRuntimeEnv()) {
  const configuredName = String(env.FLYREQ_PLATFORM_NAME || '').trim().slice(0, 120);
  return {
    platformName: configuredName || DEFAULT_PLATFORM_BRANDING.platformName,
    logoUrl: normalizeBrandAssetUrl(env.FLYREQ_PLATFORM_LOGO_URL, DEFAULT_PLATFORM_BRANDING.logoUrl),
    iconUrl: normalizeBrandAssetUrl(env.FLYREQ_PLATFORM_ICON_URL, DEFAULT_PLATFORM_BRANDING.iconUrl),
    pwaIcon192Url: normalizeBrandAssetUrl(env.FLYREQ_PWA_ICON_192_URL, DEFAULT_PLATFORM_BRANDING.pwaIcon192Url),
    pwaIcon512Url: normalizeBrandAssetUrl(env.FLYREQ_PWA_ICON_512_URL, DEFAULT_PLATFORM_BRANDING.pwaIcon512Url),
    pwaMaskableIcon512Url: normalizeBrandAssetUrl(env.FLYREQ_PWA_MASKABLE_ICON_512_URL, DEFAULT_PLATFORM_BRANDING.pwaMaskableIcon512Url),
    platformVersion: DEFAULT_PLATFORM_BRANDING.platformVersion,
  };
}

/**
 * 根据当前品牌配置生成 PWA Manifest，确保安装后的名称和图标与页面一致。
 * @param branding 已校验的平台品牌配置。
 * @returns 可作为 Web App Manifest 返回的 JSON 对象。
 */
function buildPlatformManifest(branding) {
  return {
    id: '/',
    name: branding.platformName,
    short_name: branding.platformName,
    description: branding.platformName,
    start_url: '/',
    display: 'standalone',
    background_color: '#f5f5fa',
    theme_color: '#1a1a2e',
    orientation: 'any',
    icons: [
      { src: branding.pwaIcon192Url, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: branding.pwaIcon512Url, sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: branding.pwaMaskableIcon512Url, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}

/**
 * Providers are asked for the requested layout first. This is a final guard for
 * OpenAI-compatible gateways that return an image with a different layout.
 */
async function enforceGeneratedImageLayout(imageBuffer, mimeType, request) {
  const metadata = await sharp(imageBuffer).metadata();
  const sourceWidth = metadata.width;
  const sourceHeight = metadata.height;
  if (!sourceWidth || !sourceHeight) {
    throw new Error('无法读取生成图片尺寸，无法确认输出比例');
  }

  const detectedMimeType = getImageMimeType(metadata.format, mimeType);
  const targetSize = getImageLayoutTargetSize(request);
  if (targetSize && (sourceWidth !== targetSize.width || sourceHeight !== targetSize.height)) {
    const result = await sharp(imageBuffer)
      .rotate()
      .resize(targetSize.width, targetSize.height, { fit: 'cover', position: 'centre' })
      .toBuffer({ resolveWithObject: true });
    console.warn(`[image-layout] 已归一化图片尺寸: ${sourceWidth}x${sourceHeight} -> ${targetSize.width}x${targetSize.height}`);
    return {
      buffer: result.data,
      mimeType: getImageMimeType(result.info.format, detectedMimeType),
    };
  }

  if (!targetSize && request.aspectRatio !== 'auto') {
    const crop = getCenteredAspectCrop(sourceWidth, sourceHeight, request.aspectRatio);
    if (crop && (crop.width !== sourceWidth || crop.height !== sourceHeight)) {
      const result = await sharp(imageBuffer)
        .rotate()
        .extract(crop)
        .toBuffer({ resolveWithObject: true });
      console.warn(`[image-layout] 已归一化图片比例: ${sourceWidth}x${sourceHeight} -> ${crop.width}x${crop.height}`);
      return {
        buffer: result.data,
        mimeType: getImageMimeType(result.info.format, detectedMimeType),
      };
    }
  }

  return { buffer: imageBuffer, mimeType: detectedMimeType };
}

async function downloadUrlToDisk(taskId, itemIndex, subIndex, imageUrl, options = {}) {
  const headers = {};
  if (options.apiKey && shouldAuthorizeRemoteImageDownload(imageUrl, options.request)) {
    headers.Authorization = `Bearer ${options.apiKey}`;
  }
  const response = await fetchWithTimeout(imageUrl, Object.keys(headers).length > 0 ? { headers } : {});
  if (!response.ok) {
    console.warn(`[image-download] 远程图片下载失败: status=${response.status} task=${taskId} item=${itemIndex} sub=${subIndex} url=${getSafeUrlLabel(imageUrl)}`);
    throw new Error(`远程图片下载失败: ${response.status}`);
  }
  const contentType = response.headers.get('content-type') || 'image/png';
  const maxBytes = parseIntegerEnv(getRuntimeEnv().FLYREQ_REMOTE_IMAGE_MAX_BYTES, DEFAULT_REMOTE_IMAGE_MAX_BYTES, {
    min: 1024,
    max: 200 * 1024 * 1024,
  });
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel();
    throw new Error(`远程图片超过大小限制：最大 ${maxBytes} 字节`);
  }
  const buffer = await readResponseBufferWithLimit(response, maxBytes);
  const normalized = await enforceGeneratedImageLayout(buffer, contentType, options.request || {});
  return saveImageToDisk(taskId, itemIndex, subIndex, normalized.buffer, normalized.mimeType);
}

/**
 * 流式读取远程响应，并在超过字节上限时立即取消响应体。
 * @param {Response} response 已成功返回的远程图片响应。
 * @param {number} maxBytes 允许读取的最大字节数。
 * @returns {Promise<Buffer>} 未超过限制的完整响应体。
 */
async function readResponseBufferWithLimit(response, maxBytes) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error(`远程图片超过大小限制：最大 ${maxBytes} 字节`);
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, totalBytes);
  } finally {
    reader.releaseLock();
  }
}

function getTaskImageFiles(taskId) {
  try {
    if (!fs.existsSync(IMAGE_DIR)) return [];
    const prefix = `${taskId}-`;
    return fs.readdirSync(IMAGE_DIR)
      .filter(name => name.startsWith(prefix))
      .map(name => path.join(IMAGE_DIR, name));
  } catch {
    return [];
  }
}

function deleteImageFile(filePath, _taskId) {
  try {
    if (!fs.existsSync(filePath)) {
      return { success: true, reason: 'not_found' };
    }
    fs.unlinkSync(filePath);
    return { success: true };
  } catch (error) {
    console.warn(`[image-lifecycle] 删除文件失败: ${filePath}`, error?.message || error);
    return { success: false, reason: error?.message || String(error) };
  }
}

function deleteTaskImageFiles(taskId) {
  const files = getTaskImageFiles(taskId);
  let successCount = 0;
  let notFoundCount = 0;
  let failedCount = 0;
  for (const filePath of files) {
    const result = deleteImageFile(filePath, taskId);
    if (result.success && result.reason === 'not_found') {
      notFoundCount++;
    } else if (result.success) {
      successCount++;
    } else {
      failedCount++;
    }
  }
  console.log(`[image-lifecycle] 任务图片清理完成: taskId=${taskId}, total=${files.length}, success=${successCount}, notFound=${notFoundCount}, failed=${failedCount}`);
  return { total: files.length, success: successCount, notFound: notFoundCount, failed: failedCount };
}

function initDatabase() {
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      mode TEXT NOT NULL,
      request_json TEXT NOT NULL,
      result_json TEXT,
      error TEXT,
      warning TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      expires_at TEXT
    );
    CREATE TABLE IF NOT EXISTS task_items (
      task_id TEXT NOT NULL,
      item_index INTEGER NOT NULL,
      status TEXT NOT NULL,
      image_data TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      PRIMARY KEY (task_id, item_index)
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_expires_at ON tasks(expires_at);
    CREATE INDEX IF NOT EXISTS idx_task_items_task_id ON task_items(task_id);
  `);

  const now = new Date().toISOString();
  db.prepare('UPDATE tasks SET status = ? WHERE status = ?').run(TASK_STATUS.QUEUED, TASK_STATUS.LEGACY_QUEUED);
  db.prepare('UPDATE task_items SET status = ? WHERE status = ?').run(TASK_STATUS.QUEUED, TASK_STATUS.LEGACY_QUEUED);
  const interruptedIds = db.prepare(`
    SELECT id FROM tasks WHERE status IN (?, ?)
  `).all(TASK_STATUS.QUEUED, TASK_STATUS.PROCESSING).map(r => r.id);
  db.prepare(`
    UPDATE tasks
    SET status = 'failed', error = ?, completed_at = ?, expires_at = ?
    WHERE status IN (?, ?)
  `).run('服务器重启，任务已中断，请重新生成', now, new Date(Date.now() + TASK_TTL_MS).toISOString(), TASK_STATUS.QUEUED, TASK_STATUS.PROCESSING);
  for (const id of interruptedIds) {
    deleteTaskImageFiles(id);
  }
}

function sendJson(res, statusCode, body, extraHeaders = {}) {
  // 客户端中止请求后响应可能已经销毁；错误处理不能再次写入已关闭的响应流。
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function sendHttpError(res, error) {
  const headers = {};
  if (error.retryAfter) {
    headers['Retry-After'] = String(error.retryAfter);
  }
  // 413 时请求体可能仍在上传，保持 keep-alive 会让残留入站数据干扰下个请求；
  // 显式关闭连接，确保客户端能干净收到这条错误响应。
  if (error.statusCode === 413) {
    headers['Connection'] = 'close';
  }
  sendJson(res, error.statusCode, {
    error: normalizeError(error),
    code: error.code,
    retryAfter: error.retryAfter,
  }, headers);
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8',
  }[ext] || 'application/octet-stream';
}

// 统一的文件流响应：必须挂 'error' 监听，否则流中途出错（文件被删 / EACCES /
// 磁盘错）会抛出未捕获异常拖垮整个进程。头已发出时只能断开连接。
function pipeFileToResponse(res, filePath, statusCode, headers) {
  const stream = fs.createReadStream(filePath);
  stream.on('error', error => {
    console.warn(`[static] 文件流读取失败: ${filePath}`, error?.message || error);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Internal Server Error');
    } else {
      res.destroy(error);
    }
  });
  res.writeHead(statusCode, headers);
  stream.pipe(res);
}

function serveStatic(req, res, pathname) {
  if (!fs.existsSync(STATIC_DIR)) return false;
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname || '/');
  } catch {
    decodedPath = (pathname || '/').replace(/%(?![0-9a-fA-F]{2})/g, '');
  }
  // 路径遍历防护：规范化后检测 .. 路径段，提前拒绝
  const normalizedPath = path.normalize(decodedPath);
  if (normalizedPath.includes('..')) return false;

  const candidates = [];
  if (normalizedPath.endsWith('/') || normalizedPath.endsWith(path.sep)) {
    candidates.push(path.join(STATIC_DIR, normalizedPath, 'index.html'));
  } else {
    candidates.push(path.join(STATIC_DIR, normalizedPath));
    candidates.push(path.join(STATIC_DIR, `${normalizedPath}.html`));
    candidates.push(path.join(STATIC_DIR, normalizedPath, 'index.html'));
  }

  const staticDirResolved = path.resolve(STATIC_DIR) + path.sep;
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (!resolved.startsWith(staticDirResolved) && resolved !== staticDirResolved.slice(0, -1)) continue;
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) continue;
    pipeFileToResponse(res, resolved, 200, { 'Content-Type': getContentType(resolved) });
    return true;
  }

  const notFound = path.join(STATIC_DIR, '404.html');
  if (fs.existsSync(notFound)) {
    pipeFileToResponse(res, notFound, 404, { 'Content-Type': 'text/html; charset=utf-8' });
    return true;
  }
  return false;
}

const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024; // 10MB

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let rawBytes = 0;
    let aborted = false;
    req.setEncoding('utf8');
    req.on('data', chunk => {
      if (aborted) return;
      raw += chunk;
      // 限制必须按 UTF-8 实际字节数计算，避免多字节字符绕过内存上限。
      rawBytes += Buffer.byteLength(chunk, 'utf8');
      if (rawBytes > MAX_REQUEST_BODY_BYTES) {
        aborted = true;
        raw = ''; // 释放已缓冲内存
        // 不再 req.destroy()：直接重置连接会让客户端收到 ERR_CONNECTION_RESET，
        // 看不到任何错误信息。改为排空剩余入站数据，并以 413 优雅返回（catch -> sendHttpError）。
        req.resume();
        reject(createHttpError(413, 'PAYLOAD_TOO_LARGE', '请求体过大：参考图过多或分辨率过高，请减少参考图数量或降低分辨率后重试。'));
      }
    });
    req.on('end', () => {
      if (aborted) return;
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('请求 JSON 格式无效'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * 规范化任务执行异常，保留已标识的上游原始响应并限制内部错误详情长度。
 * @param error 任务执行期间捕获的异常对象或错误文本。
 * @returns 可安全写入任务状态并展示给用户的错误文本。
 */
function normalizeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith('上游服务错误')) {
    return message;
  }
  if (/failed to fetch|fetch failed|networkerror|network request failed|load failed|network connection was lost|econnreset|socket hang up|terminated/i.test(message)) {
    return '网络连接失败。请检查服务器网络连接或稍后重试。';
  }
  if (/abort|timeout|timed out/i.test(message)) {
    return `请求超时（${REQUEST_TIMEOUT_MS / 1000}秒）。高分辨率图片生成需要更长时间，请稍后重试。`;
  }
  // 截断非预定义错误消息，避免泄露内部信息（文件路径、堆栈等）
  return message.length > 200 ? message.slice(0, 200) + '…' : message;
}

/**
 * 解析视频任务 multipart 请求，并在内存中保存受限附件。
 * @param req 原始 HTTP 请求。
 * @returns 表单字段以及按媒体类型分类的参考附件。
 */
function readVideoMultipartBody(req) {
  const config = resolveVideoWorkspaceConfig();
  return new Promise((resolve, reject) => {
    const fields = {};
    const files = { videos: [], audios: [], images: [] };
    let failure = null;
    const busboy = Busboy({
      headers: req.headers,
      limits: {
        fields: 20,
        files: config.maxRefVideos + config.maxRefAudios + config.maxRefImages,
        fileSize: Math.max(config.maxReferenceVideoBytes, config.maxReferenceAudioBytes, config.maxReferenceImageBytes),
      },
    });
    busboy.on('field', (name, value) => { fields[name] = value; });
    busboy.on('file', (name, stream, info) => {
      const target = name === 'reference_videos' ? files.videos : name === 'reference_audios' ? files.audios : name === 'reference_images' ? files.images : null;
      const expectedPrefix = name === 'reference_videos' ? 'video/' : name === 'reference_audios' ? 'audio/' : 'image/';
      const maxBytes = name === 'reference_videos' ? config.maxReferenceVideoBytes : name === 'reference_audios' ? config.maxReferenceAudioBytes : config.maxReferenceImageBytes;
      const chunks = [];
      let size = 0;
      let exceededLimit = false;
      if (!target || !String(info.mimeType || '').startsWith(expectedPrefix)) {
        failure ||= new Error('参考附件类型无效');
        stream.resume();
        return;
      }
      // 单个附件流异常时主动终止本次 multipart 解析，避免形成未处理流错误或请求永久挂起。
      stream.on('error', error => {
        failure ||= error;
        reject(error);
      });
      stream.on('data', chunk => {
        size += chunk.length;
        if (size <= maxBytes) {
          chunks.push(chunk);
          return;
        }
        // 单类附件超过自身限制后不再缓存后续数据，避免较小限制的音频或图片按视频上限占满内存。
        exceededLimit = true;
        chunks.length = 0;
        failure ||= createHttpError(413, 'PAYLOAD_TOO_LARGE', '参考附件超过大小限制');
      });
      stream.on('limit', () => {
        exceededLimit = true;
        failure ||= createHttpError(413, 'PAYLOAD_TOO_LARGE', '参考附件超过大小限制');
      });
      stream.on('end', () => {
        if (!exceededLimit && size <= maxBytes) target.push({ filename: info.filename, mimeType: info.mimeType, buffer: Buffer.concat(chunks), size });
        else failure ||= createHttpError(413, 'PAYLOAD_TOO_LARGE', '参考附件超过大小限制');
      });
    });
    busboy.on('filesLimit', () => { failure ||= new Error('参考附件数量超过限制'); });
    busboy.on('error', reject);
    busboy.on('finish', () => failure ? reject(failure) : resolve({ fields, files }));
    req.on('aborted', () => reject(createHttpError(400, 'REQUEST_ABORTED', '客户端在上传完成前断开连接')));
    req.pipe(busboy);
  });
}

/**
 * 解析并规范化逐视频附加提示词。
 * @param rawValue multipart 表单中的 JSON 数组文本。
 * @param parallelCount 本次批量创建的视频任务数量。
 * @returns 与任务数量对应且已去除首尾空白的附加提示词数组。
 */
function parseVideoPromptVariants(rawValue, parallelCount) {
  if (!rawValue) return [];
  let parsed;
  try {
    parsed = JSON.parse(String(rawValue));
  } catch {
    throw new Error('逐视频提示词格式无效');
  }
  if (!Array.isArray(parsed)) throw new Error('逐视频提示词格式无效');
  return parsed.slice(0, parallelCount).map(item => typeof item === 'string' ? item.trim() : '');
}

/**
 * 组合单个视频实际发送给上游的完整提示词。
 * @param prompt 批量任务共享的主提示词。
 * @param promptVariant 当前视频的可选附加提示词。
 * @returns 包含当前视频附加要求的完整提示词。
 */
function composeEffectiveVideoPrompt(prompt, promptVariant) {
  const normalizedPrompt = String(prompt || '').trim();
  const normalizedVariant = String(promptVariant || '').trim();
  if (!normalizedVariant) return normalizedPrompt;
  return normalizedPrompt ? `${normalizedPrompt}\n\n本个视频要求：\n${normalizedVariant}` : normalizedVariant;
}

/**
 * 校验并规范化视频任务字段。
 * @param fields multipart 表单中的文本字段。
 * @param files 已解析的参考附件。
 * @returns 可持久化并发送给上游的任务参数 Promise。
 */
async function normalizeVideoTaskPayload(fields, files) {
  const config = resolveVideoWorkspaceConfig();
  const resolution = Number(fields.resolution);
  const seconds = Number(fields.seconds);
  const size = String(fields.size || '').trim().toLowerCase();
  const aspectRatio = String(fields.aspectRatio || '').trim();
  const parallelCount = Number(fields.parallelCount || 1);
  const rawProtocol = String(fields.protocol || '').trim();
  const protocol = rawProtocol || 'openai';
  if (!String(fields.apiKey || '').trim()) throw new Error('缺少 API 密钥');
  if (!String(fields.baseUrl || '').trim()) throw new Error('缺少 API 基础地址');
  if (!String(fields.model || '').trim()) throw new Error('模型名称不能为空');
  if (!String(fields.prompt || '').trim()) throw new Error('提示词不能为空');
  if (!isVideoProtocol(protocol)) throw new Error('视频协议无效');
  if (!Number.isInteger(resolution) || resolution < 144 || resolution > 4320) throw new Error('清晰度必须为 144 至 4320 的整数');
  if (!Number.isInteger(seconds)) throw new Error('视频时长必须为整数');
  if (!Number.isInteger(parallelCount) || parallelCount < 1 || parallelCount > MAX_PARALLEL_COUNT) throw new Error('并发数量无效');
  const promptVariants = parseVideoPromptVariants(fields.promptVariants, parallelCount);
  if (size !== 'auto') {
    const match = size.match(/^(\d+)x(\d+)$/);
    const width = Number(match?.[1]);
    const height = Number(match?.[2]);
    if (!match || [width, height].some(side => !Number.isInteger(side) || side < 64 || side > 4096)) throw new Error('视频尺寸无效');
  }
  if (files.videos.length > config.maxRefVideos || files.audios.length > config.maxRefAudios || files.images.length > config.maxRefImages) throw new Error('参考附件数量超过限制');
  const payload = {
    mode: 'video-generation',
    source: 'flyreq',
    protocol,
    apiKey: String(fields.apiKey).trim(),
    baseUrl: normalizeProtocolBaseUrl(protocol, fields.baseUrl),
    model: String(fields.model).trim(),
    modelName: String(fields.modelName || fields.model).trim().slice(0, 200),
    prompt: String(fields.prompt).trim(),
    resolution,
    size,
    aspectRatio,
    seconds,
    parallelCount,
    promptVariants,
    references: {
      videos: files.videos.map(file => ({ name: file.filename, mimeType: file.mimeType, size: file.size })),
      audios: files.audios.map(file => ({ name: file.filename, mimeType: file.mimeType, size: file.size })),
      images: files.images.map(file => ({ name: file.filename, mimeType: file.mimeType, size: file.size })),
    },
  };
  const profile = validateVideoProtocolRequest(resolveVideoProtocolConfig(getRuntimeEnv()), protocol, payload.model, payload, files);
  await validateVideoProtocolReferences(profile, payload, files);
  return payload;
}

/**
 * 构建视频任务的统一日志上下文，并计算从任务创建至当前阶段的耗时。
 * @param {{ taskId: string, modelName: string, model: string, resolution: number, startedAtMs: number }} trace 任务追踪基础信息。
 * @param {Record<string, unknown>} [extra] 当前阶段需要补充的诊断字段。
 * @returns {Record<string, unknown>} 可直接交给脱敏日志模块的追踪上下文。
 */
function getVideoTaskLogContext(trace, extra = {}) {
  return {
    taskId: trace.taskId,
    modelName: trace.modelName,
    model: trace.model,
    resolution: formatVideoResolution(trace.resolution),
    elapsedMs: Math.max(0, Date.now() - trace.startedAtMs),
    ...extra,
  };
}

/**
 * 构建上游 HTTP 失败的展示前缀，并为网关超时提供重试指引。
 * @param status 上游响应的 HTTP 状态码。
 * @returns 不包含上游响应体的错误前缀。
 */
function getUpstreamHttpErrorPrefix(status) {
  return status === 504
    ? '上游服务错误（HTTP 504，请再次重试）'
    : `上游服务错误（HTTP ${status}）`;
}

/**
 * 将视频上游错误响应转换为适合任务状态展示的可读文本。
 * @param {unknown} payload 已解析的上游 JSON 响应。
 * @param {string} responseText 上游原始响应文本。
 * @param {string} fallback 响应为空时使用的兜底说明。
 * @returns 优先提取 error.message 的错误文本，无法提取时返回截断后的原始响应。
 */
function getVideoUpstreamErrorDetail(payload, responseText, fallback) {
  const extracted = getMessageFromPayload(payload);
  const detail = extracted || String(responseText || '').trim() || fallback;
  return detail.length > 1000 ? `${detail.slice(0, 1000)}…` : detail;
}

/**
 * 从运行时环境变量读取视频上游日志配置。
 * @returns {{ enabled: boolean, maxChars: number, logDir: string|undefined }} 日志开关、单条响应正文的最大字符数和落盘目录。
 */
function getVideoUpstreamLogOptions() {
  const env = getRuntimeEnv();
  return {
    enabled: isVideoUpstreamLogEnabled(env.FLYREQ_VIDEO_UPSTREAM_LOG_ENABLED),
    maxChars: getVideoUpstreamLogMaxChars(
      env.FLYREQ_VIDEO_UPSTREAM_LOG_MAX_CHARS,
      env.FLYREQ_UPSTREAM_ERROR_LOG_MAX_CHARS,
    ),
    logDir: env.FLYREQ_VIDEO_UPSTREAM_LOG_DIR,
  };
}

/**
 * 从运行时环境变量读取图片上游日志配置。
 * @returns {{ enabled: boolean, maxChars: number, logDir: string|undefined }} 日志开关、单条响应正文最大字符数和落盘目录。
 */
function getImageUpstreamLogOptions() {
  const env = getRuntimeEnv();
  return {
    enabled: isImageUpstreamLogEnabled(env.FLYREQ_IMAGE_UPSTREAM_LOG_ENABLED),
    maxChars: getImageUpstreamLogMaxChars(env.FLYREQ_IMAGE_UPSTREAM_LOG_MAX_CHARS),
    logDir: env.FLYREQ_IMAGE_UPSTREAM_LOG_DIR,
  };
}

function validateEnumValue(value, validValues, fieldName) {
  if (value === undefined || value === null || value === '') return undefined;
  if (!validValues.has(value)) {
    throw new Error(`${fieldName} 参数无效`);
  }
  return value;
}

function normalizeGptImageAdvancedParams(params = {}) {
  const quality = validateEnumValue(params.gptImageQuality, GPT_IMAGE_QUALITIES, 'quality');
  const style = validateEnumValue(params.gptImageStyle, GPT_IMAGE_STYLES, 'style');
  const background = validateEnumValue(params.gptImageBackground, GPT_IMAGE_BACKGROUNDS, 'background');
  const outputFormat = validateEnumValue(params.gptImageOutputFormat, GPT_IMAGE_OUTPUT_FORMATS, 'output_format');

  return {
    quality: quality || DEFAULT_GPT_IMAGE_ADVANCED_PARAMS.quality,
    style: style || DEFAULT_GPT_IMAGE_ADVANCED_PARAMS.style,
    background: background || DEFAULT_GPT_IMAGE_ADVANCED_PARAMS.background,
    outputFormat: outputFormat || DEFAULT_GPT_IMAGE_ADVANCED_PARAMS.outputFormat,
  };
}

/**
 * 将客户端图片档位规范成服务端唯一格式，兼容旧缓存中的小写 k。
 * @param {unknown} value 客户端提交的图片档位。
 * @returns {'auto' | '512' | '1K' | '2K' | '4K'} 规范化后的图片档位。
 */
function normalizeImageOutputSize(value) {
  const raw = String(value || '').trim();
  const normalized = raw.toLowerCase() === 'auto' ? 'auto' : raw.toUpperCase();
  if (!IMAGE_OUTPUT_SIZES.has(normalized)) throw new Error('图片分辨率档位无效');
  return normalized;
}

function validateCreatePayload(body) {
  if (!body || typeof body !== 'object') throw new Error('请求体不能为空');
  if (typeof body.apiKey !== 'string' || body.apiKey.trim().length === 0) throw new Error('缺少 API 密钥');
  if (typeof body.baseUrl !== 'string' || body.baseUrl.trim().length === 0) throw new Error('缺少 API 基础地址');
  if (!VALID_PROTOCOLS.has(body.protocol)) throw new Error('协议类型无效，必须为 google 或 openai');
  if (body.mode !== 'text-to-image' && body.mode !== 'image-to-image') throw new Error('任务模式无效');
  if (typeof body.prompt !== 'string' || body.prompt.trim().length === 0) throw new Error('提示词不能为空');
  if (typeof body.model !== 'string' || body.model.trim().length === 0) throw new Error('模型名称不能为空');
  if (!Number.isInteger(body.parallelCount) || body.parallelCount < 1 || body.parallelCount > getMaxParallelCount(body.mode)) throw new Error('并发数量无效');
  if (body.imageApiFlavor !== undefined && !IMAGE_API_FLAVORS.has(body.imageApiFlavor)) throw new Error('图片 API 类型无效');
  if (body.temperature !== undefined && (!Number.isFinite(body.temperature) || body.temperature < 0 || body.temperature > 2)) throw new Error('温度参数无效');

  body.outputSize = normalizeImageOutputSize(body.outputSize);
  body.aspectRatio = String(body.aspectRatio || '').trim();
  if (!body.aspectRatio) throw new Error('图片比例不能为空');

  if (!Array.isArray(body.images)) body.images = [];
  if (!Array.isArray(body.promptVariants)) {
    body.promptVariants = [];
  } else {
    body.promptVariants = body.promptVariants
      .slice(0, body.parallelCount)
      .map(item => typeof item === 'string' ? item.trim() : '');
  }
  if (!Array.isArray(body.effectivePrompts)) {
    body.effectivePrompts = [];
  } else {
    body.effectivePrompts = body.effectivePrompts
      .slice(0, body.parallelCount)
      .map(item => typeof item === 'string' ? item.trim() : '');
  }
  body.baseUrl = normalizeProtocolBaseUrl(body.protocol, body.baseUrl);
  if (!body.baseUrl) throw new Error('缺少 API 基础地址');
  body.streamImages = body.protocol === 'openai' ? Boolean(body.streamImages) : false;
  if (body.imageApiFlavor === 'xai-imagine') {
    if (body.protocol !== 'openai') throw new Error('xAI Imagine 仅支持 OpenAI 兼容协议');
    if (!XAI_IMAGINE_OUTPUT_SIZES.has(body.outputSize)) throw new Error('xAI Imagine 仅支持 1K 或 2K 分辨率');
    if (!XAI_IMAGINE_ASPECT_RATIOS.has(body.aspectRatio)) throw new Error('xAI Imagine 图片比例无效');
    if (body.customSize) throw new Error('xAI Imagine 不支持自定义像素尺寸');
    if (body.images.length > 1) throw new Error('xAI Imagine 首版仅支持 1 张参考图');
    body.streamImages = false;
  }
  // 开源版：不做模型级参数规范化，前端负责传递正确的参数，后端无条件透传
}

/**
 * 将请求体转换为可持久化的任务请求快照，避免保存 API Key 和参考图 Base64 数据。
 * @param body 已校验的创建任务请求体。
 * @param parallelCount 此服务端任务包含的图片数量。
 * @param promptVariants 此服务端任务使用的提示词变体列表。
 * @returns 可写入 tasks.request_json 的安全任务请求对象。
 */
function buildTaskRequestForDb(body, parallelCount = body.parallelCount, promptVariants = body.promptVariants) {
  return {
    mode: body.mode,
    source: 'flyreq',
    protocol: body.protocol,
    imageApiFlavor: body.imageApiFlavor,
    baseUrl: body.baseUrl,
    prompt: body.prompt,
    outputSize: body.outputSize,
    customSize: body.customSize,
    customSizeAlignMultiple: body.customSizeAlignMultiple !== false,
    aspectRatio: body.aspectRatio,
    temperature: body.temperature,
    model: body.model,
    gptImageQuality: body.gptImageQuality,
    gptImageStyle: body.gptImageStyle,
    gptImageBackground: body.gptImageBackground,
    gptImageOutputFormat: body.gptImageOutputFormat,
    streamImages: body.streamImages,
    parallelCount,
    promptVariants,
    images: body.images.map(img => ({ mimeType: img.mimeType })),
  };
}

/**
 * 为已写入数据库的任务登记内存运行状态与来源待处理计数。
 * @param taskId 服务端任务标识。
 * @param apiKey 本次生成所需的 API Key，仅保存在内存。
 * @param images 原始参考图数据，仅保存在内存。
 * @param source 限流和待处理统计使用的请求来源。
 * @returns 无返回值，任务会进入待调度队列。
 */
function registerTaskRuntimeState(taskId, apiKey, images, source) {
  apiKeys.set(taskId, apiKey);
  taskRefImages.set(taskId, images);
  taskSources.set(taskId, source);
  if (source.ip) pendingCountByIp.set(source.ip, (pendingCountByIp.get(source.ip) || 0) + 1);
  if (source.apiKeyHash) pendingCountByApiKeyHash.set(source.apiKeyHash, (pendingCountByApiKeyHash.get(source.apiKeyHash) || 0) + 1);
  queue.push(taskId);
}

/**
 * 创建一个可包含多张图片的兼容旧接口任务。
 * @param body 客户端提交的单任务请求体。
 * @param req 原始 HTTP 请求，用于限流来源识别。
 * @returns 新建任务的服务端任务标识。
 */
function createTask(body, req) {
  validateCreatePayload(body);
  const limitConfig = getLimitConfig();
  if (isRejectNewTasksEnabled()) {
    throw createHttpError(503, 'SERVER_NOT_ACCEPTING_TASKS', LIMIT_ERROR_MESSAGES.notAcceptingTasks, limitConfig.retryAfterSeconds);
  }
  const source = enforceRateLimit(req, body, limitConfig);
  enforceQueueCapacity(source, limitConfig, body.parallelCount, body.parallelCount, getMaxParallelCount(body.mode));

  const taskId = randomUUID();
  const now = new Date().toISOString();
  const requestForDb = buildTaskRequestForDb(body);
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO tasks (id, status, mode, request_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(taskId, TASK_STATUS.QUEUED, body.mode, JSON.stringify(requestForDb), now);
    const insertItem = db.prepare(`
      INSERT INTO task_items (task_id, item_index, status, created_at)
      VALUES (?, ?, ?, ?)
    `);
    for (let index = 0; index < body.parallelCount; index++) {
      insertItem.run(taskId, index, TASK_STATUS.QUEUED, now);
    }
  });
  tx();

  registerTaskRuntimeState(taskId, body.apiKey, body.images, source);
  broadcastTask(taskId);
  broadcastQueueStatus();
  drainQueue();
  return taskId;
}

/**
 * 原子创建一组独立单图任务，确保多图请求不会出现部分入队。
 * @param body 客户端提交的批量图片请求体，parallelCount 表示独立任务数量。
 * @param req 原始 HTTP 请求，用于限流来源识别。
 * @returns 按图片序号排序的独立服务端任务标识列表。
 */
function createTaskBatch(body, req) {
  validateCreatePayload(body);
  const limitConfig = getLimitConfig();
  if (isRejectNewTasksEnabled()) {
    throw createHttpError(503, 'SERVER_NOT_ACCEPTING_TASKS', LIMIT_ERROR_MESSAGES.notAcceptingTasks, limitConfig.retryAfterSeconds);
  }
  const source = enforceRateLimit(req, body, limitConfig);
  enforceQueueCapacity(source, limitConfig, body.parallelCount, body.parallelCount, getMaxParallelCount(body.mode));

  const now = new Date().toISOString();
  const tasks = Array.from({ length: body.parallelCount }, (_, index) => {
    const promptVariant = body.promptVariants[index];
    const effectivePrompt = body.effectivePrompts[index];
    const requestBody = effectivePrompt
      ? { ...body, prompt: effectivePrompt, promptVariants: [] }
      : body;
    return {
      taskId: randomUUID(),
      requestForDb: buildTaskRequestForDb(requestBody, 1, effectivePrompt ? [] : (promptVariant ? [promptVariant] : [])),
    };
  });
  const tx = db.transaction(() => {
    const insertTask = db.prepare(`
      INSERT INTO tasks (id, status, mode, request_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    const insertItem = db.prepare(`
      INSERT INTO task_items (task_id, item_index, status, created_at)
      VALUES (?, ?, ?, ?)
    `);
    for (const task of tasks) {
      insertTask.run(task.taskId, TASK_STATUS.QUEUED, body.mode, JSON.stringify(task.requestForDb), now);
      insertItem.run(task.taskId, 0, TASK_STATUS.QUEUED, now);
    }
  });
  tx();

  for (const task of tasks) {
    registerTaskRuntimeState(task.taskId, body.apiKey, body.images, source);
    broadcastTask(task.taskId);
  }
  broadcastQueueStatus();
  drainQueue();
  return tasks.map(task => task.taskId);
}

function roundToMultiple(value, multiple) {
  return Math.max(multiple, Math.round(value / multiple) * multiple);
}

function floorToMultiple(value, multiple) {
  return Math.max(multiple, Math.floor(value / multiple) * multiple);
}

function parseImageSize(size) {
  const match = String(size || '').match(/^\s*(\d+)\s*[xX×]\s*(\d+)\s*$/);
  if (!match) return undefined;

  const width = Number(match[1]);
  const height = Number(match[2]);
  return Number.isFinite(width) && Number.isFinite(height) ? { width, height } : undefined;
}

function isImageSizeWithinLimits(width, height, maxSide, requireMultiple = true) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false;

  const limit = typeof maxSide === 'number' && maxSide > 0 ? maxSide : Number.POSITIVE_INFINITY;
  const longSide = Math.max(width, height);
  const shortSide = Math.min(width, height);
  const pixels = width * height;

  return (
    longSide <= limit &&
    (!requireMultiple || (width % CUSTOM_IMAGE_SIZE_LIMITS.multiple === 0 && height % CUSTOM_IMAGE_SIZE_LIMITS.multiple === 0)) &&
    longSide / shortSide <= CUSTOM_IMAGE_SIZE_LIMITS.maxAspectRatio &&
    pixels >= CUSTOM_IMAGE_SIZE_LIMITS.minPixels &&
    pixels <= CUSTOM_IMAGE_SIZE_LIMITS.maxPixels
  );
}

function getGptImageSize(outputSize, aspectRatio) {
  if (outputSize === 'auto' || outputSize === '512' || aspectRatio === 'auto') return undefined;
  const match = String(aspectRatio || '').match(/^(\d+):(\d+)$/);
  if (!match) return undefined;

  const ratioWidth = Number(match[1]);
  const ratioHeight = Number(match[2]);
  if (!ratioWidth || !ratioHeight) return undefined;

  let width;
  let height;
  if (outputSize === '1K') {
    const shortSide = 1024;
    width = ratioWidth > ratioHeight
      ? roundToMultiple(shortSide * ratioWidth / ratioHeight, 16)
      : shortSide;
    height = ratioWidth > ratioHeight
      ? shortSide
      : roundToMultiple(shortSide * ratioHeight / ratioWidth, 16);
  } else {
    if (outputSize !== '2K' && outputSize !== '4K') return undefined;
    const longSide = outputSize === '2K' ? 2048 : 3840;
    width = ratioWidth > ratioHeight
      ? longSide
      : roundToMultiple(longSide * ratioWidth / ratioHeight, 16);
    height = ratioWidth > ratioHeight
      ? roundToMultiple(longSide * ratioHeight / ratioWidth, 16)
      : longSide;
  }

  if (!isImageSizeWithinLimits(width, height, 3840)) {
    const maxLongSideByPixels = ratioWidth >= ratioHeight
      ? Math.sqrt(CUSTOM_IMAGE_SIZE_LIMITS.maxPixels * ratioWidth / ratioHeight)
      : Math.sqrt(CUSTOM_IMAGE_SIZE_LIMITS.maxPixels * ratioHeight / ratioWidth);
    const longSide = floorToMultiple(Math.min(3840, maxLongSideByPixels), 16);
    width = ratioWidth >= ratioHeight
      ? longSide
      : floorToMultiple(longSide * ratioWidth / ratioHeight, 16);
    height = ratioWidth >= ratioHeight
      ? floorToMultiple(longSide * ratioHeight / ratioWidth, 16)
      : longSide;
  }

  if (!isImageSizeWithinLimits(width, height, 3840)) return undefined;
  return `${width}x${height}`;
}

function normalizeCustomImageSize(size, maxSide, alignToMultiple = true) {
  const parsed = parseImageSize(size);
  if (!parsed) return undefined;

  const limit = typeof maxSide === 'number' && maxSide > 0 ? maxSide : Number.POSITIVE_INFINITY;
  const width = Math.min(alignToMultiple ? roundToMultiple(parsed.width, CUSTOM_IMAGE_SIZE_LIMITS.multiple) : Math.trunc(parsed.width), limit);
  const height = Math.min(alignToMultiple ? roundToMultiple(parsed.height, CUSTOM_IMAGE_SIZE_LIMITS.multiple) : Math.trunc(parsed.height), limit);
  if (!isImageSizeWithinLimits(width, height, maxSide, alignToMultiple)) return undefined;

  return `${width}x${height}`;
}

function getSupportedGptImageSize(model, outputSize, aspectRatio) {
  return getGptImageSize(outputSize, aspectRatio);
}

function resolveGptImageRequestSize(request) {
  const customSize = normalizeCustomImageSize(request.customSize, 3840);
  const alignedCustomSize = request.customSizeAlignMultiple === false
    ? normalizeCustomImageSize(request.customSize, 3840, false)
    : customSize;
  if (alignedCustomSize) return alignedCustomSize;
  return getSupportedGptImageSize(request.model, request.outputSize, request.aspectRatio);
}

function getGptImageRequestAdvancedParams(request) {
  return normalizeGptImageAdvancedParams(request);
}

/**
 * 获取上游私有协议使用的显式图片比例。
 * @param {unknown} value FlyReq 请求中的比例值。
 * @returns {string | undefined} 非自动比例；自动比例不发送该扩展字段。
 */
function getExplicitImageAspectRatio(value) {
  const aspectRatio = String(value || '').trim();
  return aspectRatio && aspectRatio !== 'auto' ? aspectRatio : undefined;
}

function createGptImageRequestInit(apiKey, request, resolvedSize, options = {}) {
  const prompt = request.prompt;
  const advancedParams = getGptImageRequestAdvancedParams(request);
  const stream = Boolean(options.stream);
  const aspectRatio = getExplicitImageAspectRatio(request.aspectRatio);

  if (request.mode === 'image-to-image') {
    const formData = new FormData();
    formData.append('model', request.model);
    formData.append('prompt', prompt);
    formData.append('n', '1');
    if (stream) {
      formData.append('stream', 'true');
    }
    if (advancedParams) {
      formData.append('quality', advancedParams.quality);
      formData.append('background', advancedParams.background);
      formData.append('output_format', advancedParams.outputFormat);
      if (advancedParams.style === 'vivid' || advancedParams.style === 'natural') {
        formData.append('style', advancedParams.style);
      }
    }
    if (resolvedSize) {
      formData.append('size', resolvedSize);
    }
    if (aspectRatio) {
      formData.append('aspect_ratio', aspectRatio);
    }

    request.images.forEach((img, index) => {
      const mimeType = img.mimeType || 'image/png';
      const extension = mimeType.split('/')[1] || 'png';
      const bytes = Buffer.from(img.data, 'base64');
      const blob = new Blob([bytes], { type: mimeType });
      formData.append('image', blob, `image-${index}.${extension}`);
    });

    return {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
      body: formData,
    };
  }

  const payload = {
    prompt,
    model: request.model,
    ...(stream ? { stream: true } : {}),
    ...(resolvedSize ? { size: resolvedSize } : {}),
    ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
    ...(advancedParams ? {
      quality: advancedParams.quality,
      background: advancedParams.background,
      output_format: advancedParams.outputFormat,
      ...(advancedParams.style === 'vivid' || advancedParams.style === 'natural' ? { style: advancedParams.style } : {}),
    } : {}),
    ...(request.images.length > 0 ? { image: request.images.map(img => `data:${img.mimeType};base64,${img.data}`) } : {}),
  };

  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  };
}

function parseJsonSafely(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isLikelyHtmlResponse(text) {
  const trimmed = String(text || '').trim().toLowerCase();
  return trimmed.startsWith('<!doctype html') || trimmed.startsWith('<html') || trimmed.startsWith('<head') || trimmed.startsWith('<body');
}

function getMessageFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (typeof payload.message === 'string' && payload.message.trim()) return payload.message.trim();

  const error = payload.error;
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (error && typeof error === 'object') {
    if (typeof error.message === 'string' && error.message.trim()) return error.message.trim();
    if (typeof error.code === 'string' && error.code.trim()) return error.code.trim();
  }

  return '';
}

function getErrorMessageFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (payload.error) return getMessageFromPayload(payload);

  const type = typeof payload.type === 'string' ? payload.type.toLowerCase() : '';
  if (type === 'error' || type === 'upstream_error') return getMessageFromPayload(payload);

  return '';
}

function normalizeImagePayloadValue(imageData) {
  if (!imageData || typeof imageData !== 'string') return undefined;
  if (imageData.startsWith('data:image')) return imageData.split(',')[1] || imageData;
  if (/^https?:\/\//i.test(imageData)) return `URL:${imageData}`;
  return imageData;
}

function getImagePayloadValue(data, depth = 0) {
  if (!data || depth > 3) return undefined;
  if (Array.isArray(data)) {
    for (const item of data) {
      const value = getImagePayloadValue(item, depth + 1);
      if (value) return value;
    }
    return undefined;
  }
  if (typeof data !== 'object') return undefined;

  const firstImage = Array.isArray(data.data)
    ? data.data.find(item => item && typeof item === 'object' && (item.b64_json || item.url || item.image_url))
    : undefined;
  const imageData = firstImage?.b64_json || firstImage?.url || firstImage?.image_url
    || data.b64_json || data.url || data.image_url;
  if (imageData) return imageData;

  return getImagePayloadValue(data.result, depth + 1)
    || getImagePayloadValue(data.response, depth + 1)
    || getImagePayloadValue(data.output, depth + 1);
}

function extractImagePayload(data) {
  const imageData = normalizeImagePayloadValue(getImagePayloadValue(data));
  if (!imageData) throw new Error('响应中无图片数据');
  return imageData;
}

function parseImageEventStream(text) {
  const payloads = [];
  let dataLines = [];

  const flush = () => {
    if (dataLines.length === 0) return;
    const raw = dataLines.join('\n').trim();
    dataLines = [];
    if (!raw || raw === '[DONE]') return;
    const parsed = parseJsonSafely(raw);
    if (parsed) payloads.push(parsed);
  };

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line === '') {
      flush();
      continue;
    }
    if (line.startsWith(':')) continue;
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  flush();

  return payloads;
}

function isPartialImageEvent(payload) {
  const type = typeof payload?.type === 'string' ? payload.type.toLowerCase() : '';
  return type.includes('partial');
}

function extractImagePayloadFromEventStream(text) {
  const payloads = parseImageEventStream(text);
  const errorMessage = payloads.map(getErrorMessageFromPayload).find(Boolean);

  for (const payload of [...payloads].reverse()) {
    if (isPartialImageEvent(payload)) continue;
    try {
      return extractImagePayload(payload);
    } catch {
      // Keep scanning earlier events.
    }
  }

  for (const payload of [...payloads].reverse()) {
    if (!isPartialImageEvent(payload)) continue;
    try {
      return extractImagePayload(payload);
    } catch {
      // Keep scanning earlier partial events.
    }
  }

  if (errorMessage) throw new Error(errorMessage);
  throw new Error('响应中无图片数据');
}

function isImageEventStreamResponse(response) {
  return String(response.headers.get('content-type') || '').toLowerCase().includes('text/event-stream');
}

function notifyImageSseResponse(options) {
  if (typeof options?.onSseConfirmed !== 'function') return;
  try {
    options.onSseConfirmed();
  } catch (error) {
    console.warn('[image-stream] 记录 SSE 状态失败:', error?.message || error);
  }
}

async function parseGptImageResponse(response) {
  const isEventStream = isImageEventStreamResponse(response);
  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(`${getUpstreamHttpErrorPrefix(response.status)}：${responseText}`);
  }

  if (isEventStream) {
    try {
      return extractImagePayloadFromEventStream(responseText);
    } catch {
      throw new Error(`上游服务错误：${responseText}`);
    }
  }

  if (isLikelyHtmlResponse(responseText)) {
    throw new Error(`上游服务错误：${responseText}`);
  }

  const data = parseJsonSafely(responseText);
  if (!data) {
    throw new Error(`上游服务错误：${responseText}`);
  }

  const errorMessage = getErrorMessageFromPayload(data);
  if (errorMessage) throw new Error(`上游服务错误：${responseText}`);

  return extractImagePayload(data);
}

async function requestGptImage(apiKey, request, resolvedSize, options = {}) {
  const baseUrl = options.baseUrl || resolveFlyreqApiBaseUrl();
  const endpoint = request.mode === 'image-to-image'
    ? '/v1/images/edits'
    : '/v1/images/generations';
  const stream = Boolean(options.stream);
  const url = appendProtocolApiPath('openai', baseUrl, endpoint);
  const imageLogOptions = getImageUpstreamLogOptions();
  const requestInit = createGptImageRequestInit(apiKey, request, resolvedSize, { ...options, stream });
  const logContext = {
    taskId: options.taskId,
    imageIndex: options.imageIndex,
    protocol: 'openai',
    model: request.model,
    mode: request.mode,
    outputSize: request.outputSize,
    aspectRatio: request.aspectRatio,
    resolvedSize: resolvedSize || 'auto',
  };
  logImageRequestUrl('openai', request.model, url, { size: resolvedSize || 'auto' });
  logImageUpstreamRequest('generate', url, requestInit, logContext, imageLogOptions);
  const response = await fetchWithTimeout(url, requestInit);
  if (imageLogOptions.enabled) {
    const responseText = await response.clone().text();
    logImageUpstreamResponse('generate', url, response, responseText, logContext, {
      ...imageLogOptions,
      isError: !response.ok,
    });
  }
  const usesSse = isImageEventStreamResponse(response);
  if (usesSse) notifyImageSseResponse(options);
  try {
    return { image: await parseGptImageResponse(response), usesSse };
  } catch (error) {
    if (resolvedSize && error instanceof Error) {
      error.message = `${error.message}（FlyReq 实际发送尺寸：${resolvedSize}）`;
    }
    if (usesSse && error && typeof error === 'object') {
      error.usesSse = true;
    }
    throw error;
  }
}

async function requestXaiImagineImage(apiKey, request, options = {}) {
  const baseUrl = options.baseUrl || 'https://api.x.ai';
  const endpoint = getXaiImagineEndpoint(request.mode);
  const url = appendProtocolApiPath('openai', baseUrl, endpoint);
  const imageLogOptions = getImageUpstreamLogOptions();
  const logContext = {
    taskId: options.taskId,
    imageIndex: options.imageIndex,
    protocol: 'xai-imagine',
    model: request.model,
    mode: request.mode,
    outputSize: request.outputSize,
    aspectRatio: request.aspectRatio,
  };
  logImageRequestUrl('xai-imagine', request.model, url);

  for (let attempt = 0; attempt <= XAI_IMAGINE_MAX_RETRIES; attempt++) {
    await waitForXaiImagineRequestSlot(apiKey);
    const requestInit = createXaiImagineRequestInit(apiKey, request);
    const attemptContext = { ...logContext, attempt: attempt + 1 };
    logImageUpstreamRequest('generate', url, requestInit, attemptContext, imageLogOptions);
    const response = await fetchWithTimeout(url, requestInit);
    if (imageLogOptions.enabled) {
      const responseText = await response.clone().text();
      logImageUpstreamResponse('generate', url, response, responseText, attemptContext, {
        ...imageLogOptions,
        isError: !response.ok,
      });
    }
    if (response.status !== 429 || attempt === XAI_IMAGINE_MAX_RETRIES) {
      const usesSse = isImageEventStreamResponse(response);
      if (usesSse) notifyImageSseResponse(options);
      try {
        return { image: await parseGptImageResponse(response), usesSse };
      } catch (error) {
        if (usesSse && error && typeof error === 'object') {
          error.usesSse = true;
        }
        throw error;
      }
    }

    const retryDelayMs = getRetryAfterDelayMs(response);
    await response.text();
    console.warn(`[xai-imagine] 收到 429，${Math.ceil(retryDelayMs / 1000)} 秒后重试`);
    await delay(retryDelayMs);
  }

  throw new Error('xAI Imagine 请求重试次数已耗尽');
}

// ===== 加强网络连接：启用 TCP keepalive，防止 Docker 回环连接被静默断开 =====
// Node.js 内置 fetch 基于 undici，默认不发送 TCP keepalive，
// 导致长时间等待响应（如 4K 图片生成）时连接被 Docker 网络层丢弃。
// 通过 setGlobalDispatcher 配置 undici Agent 的 keepalive 和超时参数。
try {
  const { Agent, setGlobalDispatcher } = require('undici');
  setGlobalDispatcher(new Agent({
    keepAliveTimeout: 60 * 1000,         // 空闲连接保持 60 秒
    keepAliveMaxTimeout: 10 * 60 * 1000, // 最大保持 10 分钟
    connect: {
      keepAlive: true,
      keepAliveInitialDelay: 15000,      // 15 秒后开始发送 TCP keepalive 探测
    },
    bodyTimeout: REQUEST_TIMEOUT_MS,     // 等待响应体的超时（与 abort 超时一致）
    headersTimeout: REQUEST_TIMEOUT_MS,  // 图片生成可能长时间等待响应头，需与任务超时一致
  }));
  console.log('[network] undici Agent 已配置: TCP keepalive=15s, timeout=30min');
} catch (e) {
  console.warn('[network] undici Agent 配置失败，使用默认设置:', e?.message || e);
}

/**
 * 发起带统一超时和可选外部中止信号的上游请求。
 * @param {string|URL} url 上游请求地址。
 * @param {RequestInit} [init] Fetch 请求参数，可通过 signal 主动取消。
 * @returns {Promise<Response>} 上游 HTTP 响应。
 */
async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const externalSignal = init.signal;
  const abortFromExternal = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) {
    abortFromExternal();
  } else {
    externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
  }
  try {
    return await fetch(url, {
      ...init,
      headers: createOutboundHeaders(init?.headers),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', abortFromExternal);
  }
}

async function generateFlyreqImage(apiKey, request, options = {}) {
  // 开源版：根据前端传入的 protocol 字段路由到对应的 API 协议
  const baseUrlDetails = request.baseUrl
    ? resolveAndLogOutboundBaseUrl('图片生成', request.protocol, request.baseUrl)
    : { baseUrl: resolveFlyreqApiBaseUrl(), originalBaseUrl: '', rewritten: false };
  const baseUrl = baseUrlDetails.baseUrl;
  if (request.imageApiFlavor === 'xai-imagine') {
    return requestXaiImagineImage(apiKey, request, {
      baseUrl,
      onSseConfirmed: options.onSseConfirmed,
      taskId: options.taskId,
      imageIndex: options.imageIndex,
    });
  }
  if (request.protocol === 'openai') {
    return requestGptImage(apiKey, request, resolveGptImageRequestSize(request), {
      baseUrl,
      stream: Boolean(request.streamImages),
      onSseConfirmed: options.onSseConfirmed,
      taskId: options.taskId,
      imageIndex: options.imageIndex,
    });
  }
  // 默认走 Google Gemini 协议
  return {
    image: await generateFlyreqGeminiImage(apiKey, request, {
      baseUrl,
      taskId: options.taskId,
      imageIndex: options.imageIndex,
    }),
    usesSse: false,
  };
}

function extractGeminiImagePayload(data) {
  const imagePart = data?.candidates?.[0]?.content?.parts?.find(part => part?.inlineData?.data || part?.inline_data?.data);
  const inlineData = imagePart?.inlineData || imagePart?.inline_data;
  if (!inlineData?.data) throw new Error('响应中无图片数据');
  return inlineData.data;
}

async function generateFlyreqGeminiImage(apiKey, request, options = {}) {
  const baseUrl = options.baseUrl || resolveFlyreqApiBaseUrl();
  const parts = [
    { text: request.prompt },
    ...request.images.map(img => ({ inlineData: { data: img.data, mimeType: img.mimeType } })),
  ];
  const url = appendProtocolApiPath('google', baseUrl, `/v1beta/models/${encodeURIComponent(request.model)}:generateContent`);
  const imageLogOptions = getImageUpstreamLogOptions();
  const requestInit = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: {
        ...(typeof request.temperature === 'number' ? { temperature: request.temperature } : {}),
        responseModalities: ['IMAGE'],
        imageConfig: { imageSize: request.outputSize, aspectRatio: request.aspectRatio },
      },
    }),
  };
  const logContext = {
    taskId: options.taskId,
    imageIndex: options.imageIndex,
    protocol: 'google',
    model: request.model,
    mode: request.mode,
    outputSize: request.outputSize,
    aspectRatio: request.aspectRatio,
  };
  logImageRequestUrl('google', request.model, url);
  logImageUpstreamRequest('generate', url, requestInit, logContext, imageLogOptions);
  const response = await fetchWithTimeout(url, requestInit);
  if (imageLogOptions.enabled) {
    const responseText = await response.clone().text();
    logImageUpstreamResponse('generate', url, response, responseText, logContext, {
      ...imageLogOptions,
      isError: !response.ok,
    });
  }

  if (!response.ok) {
    const responseText = await response.text();
    throw new Error(`${getUpstreamHttpErrorPrefix(response.status)}：${responseText}`);
  }

  const responseText = await response.text();
  if (isLikelyHtmlResponse(responseText)) {
    throw new Error(`上游服务错误：${responseText}`);
  }
  const data = parseJsonSafely(responseText);
  if (!data) {
    throw new Error(`上游服务错误：${responseText}`);
  }
  const errorMessage = getErrorMessageFromPayload(data);
  if (errorMessage) {
    throw new Error(`上游服务错误：${responseText}`);
  }
  return extractGeminiImagePayload(data);
}

/**
 * 返回视频任务独立并发上限。
 * @returns 1 至 20 范围内的并发数量。
 */
function getMaxVideoConcurrency() {
  return parseIntegerEnv(getRuntimeEnv().FLYREQ_VIDEO_TASK_CONCURRENCY, 2, { min: 1, max: 20 });
}

/**
 * 登记视频任务运行期密钥、附件和来源计数，并进入独立队列。
 * @param taskId 新建的视频任务标识。
 * @param payload 已规范化的视频任务参数。
 * @param files 仅在运行期保留的参考附件。
 * @param source 限流使用的请求来源。
 * @returns 无返回值。
 */
function registerVideoTaskRuntimeState(taskId, payload, files, source) {
  apiKeys.set(taskId, payload.apiKey);
  taskVideoFiles.set(taskId, files);
  videoTaskAbortControllers.set(taskId, new AbortController());
  taskSources.set(taskId, source);
  if (source.ip) pendingCountByIp.set(source.ip, (pendingCountByIp.get(source.ip) || 0) + 1);
  if (source.apiKeyHash) pendingCountByApiKeyHash.set(source.apiKeyHash, (pendingCountByApiKeyHash.get(source.apiKeyHash) || 0) + 1);
  videoQueue.push(taskId);
}

/**
 * 等待下一次视频轮询，并允许取消操作立即结束等待。
 * @param {number} intervalMs 等待毫秒数。
 * @param {AbortSignal} signal 视频任务中止信号。
 * @returns {Promise<void>} 等待结束时完成；取消时以 AbortError 拒绝。
 */
function waitForVideoPoll(intervalMs, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason || new DOMException('视频任务已取消', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', handleAbort);
      resolve();
    }, intervalMs);
    /**
     * 取消当前轮询等待并把中止原因传给任务执行器。
     * @returns {void} 通过拒绝外层 Promise 结束等待。
     */
    function handleAbort() {
      clearTimeout(timer);
      reject(signal.reason || new DOMException('视频任务已取消', 'AbortError'));
    }
    signal.addEventListener('abort', handleAbort, { once: true });
  });
}

/**
 * 原子创建单个视频任务并触发独立调度器。
 * @param payload 已规范化的视频任务参数。
 * @param files 已校验的参考附件。
 * @param req 原始请求，用于限流来源识别。
 * @returns 新建任务标识。
 */
function createVideoTask(payload, files, req) {
  const limitConfig = getLimitConfig();
  if (isRejectNewTasksEnabled()) throw createHttpError(503, 'SERVER_NOT_ACCEPTING_TASKS', LIMIT_ERROR_MESSAGES.notAcceptingTasks, limitConfig.retryAfterSeconds);
  const source = enforceRateLimit(req, payload, limitConfig);
  enforceQueueCapacity(source, limitConfig, 1);
  const taskId = randomUUID();
  const now = new Date().toISOString();
  const requestForDb = { ...payload };
  delete requestForDb.apiKey;
  db.prepare(`INSERT INTO tasks (id, status, mode, request_json, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(taskId, TASK_STATUS.QUEUED, 'video-generation', JSON.stringify(requestForDb), now);
  registerVideoTaskRuntimeState(taskId, payload, files, source);
  broadcastTask(taskId);
  broadcastQueueStatus();
  drainVideoQueue();
  return taskId;
}

/**
 * 原子创建一组独立视频任务，并在全部数据库记录写入成功后统一入队。
 * @param payload 已规范化的视频任务参数，parallelCount 表示任务数量。
 * @param files 已校验且由本批任务共享的只读参考附件。
 * @param req 原始请求，用于限流来源识别。
 * @returns 按批次序号排列的新建视频任务标识列表。
 */
function createVideoTaskBatch(payload, files, req) {
  const limitConfig = getLimitConfig();
  if (isRejectNewTasksEnabled()) throw createHttpError(503, 'SERVER_NOT_ACCEPTING_TASKS', LIMIT_ERROR_MESSAGES.notAcceptingTasks, limitConfig.retryAfterSeconds);
  const source = enforceRateLimit(req, payload, limitConfig);
  enforceQueueCapacity(source, limitConfig, payload.parallelCount, payload.parallelCount);

  const now = new Date().toISOString();
  const tasks = Array.from({ length: payload.parallelCount }, (_, index) => {
    const promptVariant = payload.promptVariants[index] || '';
    const requestForDb = {
      ...payload,
      prompt: composeEffectiveVideoPrompt(payload.prompt, promptVariant),
      parallelCount: 1,
      promptVariants: promptVariant ? [promptVariant] : [],
    };
    delete requestForDb.apiKey;
    return { taskId: randomUUID(), requestForDb };
  });
  const insertTasks = db.transaction(() => {
    const insertTask = db.prepare(`INSERT INTO tasks (id, status, mode, request_json, created_at) VALUES (?, ?, ?, ?, ?)`);
    for (const task of tasks) {
      insertTask.run(task.taskId, TASK_STATUS.QUEUED, 'video-generation', JSON.stringify(task.requestForDb), now);
    }
  });
  insertTasks();

  for (const task of tasks) {
    registerVideoTaskRuntimeState(task.taskId, payload, files, source);
    broadcastTask(task.taskId);
  }
  broadcastQueueStatus();
  drainVideoQueue();
  return tasks.map(task => task.taskId);
}

/**
 * 创建上游异步视频任务。
 * @param apiKey 视频模型 API Key。
 * @param request 视频生成参数。
 * @param files 已校验的参考附件。
 * @param {AbortSignal} signal 视频任务中止信号。
 * @param {{ taskId: string, modelName: string, model: string, resolution: number, startedAtMs: number }} trace 视频任务日志追踪信息。
 * @returns 上游视频任务标识。
 */
async function createUpstreamVideo(apiKey, request, files, signal, trace) {
  const baseUrl = resolveAndLogOutboundBaseUrl('视频生成', request.protocol, request.baseUrl).baseUrl;
  const upstreamRequest = createVideoRequest(request.protocol, apiKey, request, files);
  const url = appendProtocolApiPath(request.protocol, baseUrl, upstreamRequest.path);
  const fetchInit = { ...upstreamRequest.init, signal };
  const logOptions = getVideoUpstreamLogOptions();
  const context = getVideoTaskLogContext(trace, { protocol: request.protocol });
  logVideoUpstreamRequest('create', url, fetchInit, context, logOptions);
  const response = await fetchWithTimeout(url, fetchInit);
  const responseText = await response.text();
  const data = parseJsonSafely(responseText);
  const upstreamTaskId = getCreatedVideoTaskId(request.protocol, data);
  logVideoUpstreamResponse('create', url, response, responseText, context, {
    ...logOptions,
    isError: !response.ok || !upstreamTaskId,
  });
  if (!response.ok) {
    throw new Error(`${getUpstreamHttpErrorPrefix(response.status)}：${getVideoUpstreamErrorDetail(data, responseText, '未返回任务 ID')}`);
  }
  if (!upstreamTaskId) {
    throw new Error(`上游创建响应格式不兼容（HTTP ${response.status}）：${getVideoUpstreamErrorDetail(data, responseText, '未返回可识别的任务 ID')}`);
  }
  return upstreamTaskId;
}

/**
 * 轮询上游视频任务直到完成、失败或超时。
 * @param apiKey 视频模型 API Key。
 * @param request 视频生成参数。
 * @param upstreamTaskId 上游视频任务标识。
 * @param {AbortSignal} signal 视频任务中止信号。
 * @param {{ taskId: string, modelName: string, model: string, resolution: number, startedAtMs: number }} trace 视频任务日志追踪信息。
 * @returns 完成视频的远程 URL 与允许携带认证头的实际上游来源。
 */
async function pollUpstreamVideo(apiKey, request, upstreamTaskId, signal, trace) {
  const env = getRuntimeEnv();
  const intervalMs = parseIntegerEnv(env.FLYREQ_VIDEO_POLL_INTERVAL_MS, 5000, { min: 1000, max: 60000 });
  const timeoutMs = parseIntegerEnv(env.FLYREQ_VIDEO_TIMEOUT_MS, 1800000, { min: 10000, max: 24 * 60 * 60 * 1000 });
  const baseUrl = resolveAndLogOutboundBaseUrl('视频任务轮询', request.protocol, request.baseUrl).baseUrl;
  const url = appendProtocolApiPath(request.protocol, baseUrl, getVideoPollPath(request.protocol, upstreamTaskId));
  const deadline = Date.now() + timeoutMs;
  const logOptions = getVideoUpstreamLogOptions();
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const context = getVideoTaskLogContext(trace, { protocol: request.protocol, upstreamTaskId });
    const fetchInit = { headers: { Authorization: `Bearer ${apiKey}` }, signal };
    logVideoUpstreamRequest('poll', url, fetchInit, context, logOptions);
    const response = await fetchWithTimeout(url, fetchInit);
    const responseText = await response.text();
    const data = parseJsonSafely(responseText);
    const result = data ? normalizeVideoPollResult(request.protocol, data, baseUrl, upstreamTaskId) : null;
    logVideoUpstreamResponse('poll', url, response, responseText, context, {
      ...logOptions,
      isError: !response.ok || !data || result?.state === 'failed' || result?.state === 'invalid',
    });
    if (!response.ok || !data) {
      throw new Error(`${getUpstreamHttpErrorPrefix(response.status)}：${getVideoUpstreamErrorDetail(data, responseText, '轮询响应格式无效')}`);
    }
    if (result.state === 'completed') return { remoteUrl: result.remoteUrl, authenticatedOrigin: new URL(baseUrl).origin };
    if (result.state === 'failed') {
      throw new Error(`上游视频任务失败：${getVideoUpstreamErrorDetail(data, responseText, '上游未返回失败原因')}`);
    }
    if (result.state === 'invalid') {
      throw new Error(`上游轮询响应格式不兼容（HTTP ${response.status}）：${getVideoUpstreamErrorDetail(data, responseText, '任务已完成但未返回可用的视频地址')}`);
    }
    await waitForVideoPoll(intervalMs, signal);
  }
  throw new Error('视频生成超时');
}

/**
 * 将上游视频结果流式缓存到任务目录。
 * @param taskId 本地视频任务标识。
 * @param remoteUrl 上游完成视频 URL。
 * @param apiKey 下载视频时使用的 API Key。
 * @param authenticatedOrigin 允许携带认证头的实际上游来源。
 * @param {AbortSignal} signal 视频任务中止信号。
 * @param {{ taskId: string, modelName: string, model: string, resolution: number, startedAtMs: number }} trace 视频任务日志追踪信息。
 * @returns 站内视频播放地址。
 */
async function cacheVideoResult(taskId, remoteUrl, apiKey, authenticatedOrigin, signal, trace) {
  const resultUrl = new URL(remoteUrl);
  const headers = getVideoDownloadHeaders(resultUrl.toString(), authenticatedOrigin, apiKey);
  const fetchInit = { headers, signal };
  const logOptions = getVideoUpstreamLogOptions();
  const context = getVideoTaskLogContext(trace);
  logVideoUpstreamRequest('download', resultUrl, fetchInit, context, logOptions);
  const response = await fetchWithTimeout(resultUrl.toString(), fetchInit);
  if (!response.ok || !response.body) {
    const responseText = await response.text().catch(() => '');
    logVideoUpstreamResponse('download', resultUrl, response, responseText, context, { ...logOptions, isError: true });
    throw new Error(`${getUpstreamHttpErrorPrefix(response.status)}：${getVideoUpstreamErrorDetail(parseJsonSafely(responseText), responseText, '视频下载失败')}`);
  }
  logVideoUpstreamResponse('download', resultUrl, response, undefined, context, logOptions);
  const ext = getVideoExtension(response.headers.get('content-type'));
  const filePath = path.join(VIDEO_DIR, `${taskId}.${ext}`);
  const temporaryPath = `${filePath}.part`;
  try {
    await fs.promises.rm(temporaryPath, { force: true });
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporaryPath, { flags: 'wx' }));
    await fs.promises.rename(temporaryPath, filePath);
    return `/api/flyreq/videos/${taskId}`;
  } catch (error) {
    // 下载失败或任务取消时删除未写完的文件，避免长期占用视频目录空间。
    try { await fs.promises.rm(temporaryPath, { force: true }); } catch { /* 临时文件可能尚未创建或已被并发清理。 */ }
    throw error;
  }
}

/**
 * 执行单个视频任务的创建、轮询、缓存和终态写入。
 * @param taskId 本地视频任务标识。
 * @returns 无返回值，任务终态写入数据库并广播。
 */
async function runVideoTask(taskId) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  const apiKey = apiKeys.get(taskId);
  const files = taskVideoFiles.get(taskId) || { videos: [], audios: [], images: [] };
  const abortController = videoTaskAbortControllers.get(taskId);
  if (!task || !apiKey || !abortController || ![TASK_STATUS.QUEUED, TASK_STATUS.LEGACY_QUEUED].includes(task.status)) {
    cleanupTaskRuntimeState(taskId);
    return;
  }
  const request = parseJsonSafely(task.request_json);
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    const completedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + TASK_TTL_MS).toISOString();
    db.prepare("UPDATE tasks SET status = 'failed', error = ?, completed_at = ?, expires_at = ? WHERE id = ? AND status IN (?, ?)")
      .run('任务请求数据损坏，无法执行', completedAt, expiresAt, taskId, TASK_STATUS.QUEUED, TASK_STATUS.LEGACY_QUEUED);
    cleanupTaskRuntimeState(taskId);
    broadcastTask(taskId);
    broadcastQueueStatus();
    return;
  }
  const startedAtMs = Number.isFinite(Date.parse(task.created_at)) ? Date.parse(task.created_at) : Date.now();
  const trace = {
    taskId,
    modelName: request.modelName || request.model,
    model: request.model,
    resolution: request.resolution,
    startedAtMs,
  };
  db.prepare("UPDATE tasks SET status = 'processing' WHERE id = ?").run(taskId);
  broadcastTask(taskId);
  broadcastQueueStatus();
  try {
    const upstreamTaskId = await createUpstreamVideo(apiKey, request, files, abortController.signal, trace);
    const { remoteUrl, authenticatedOrigin } = await pollUpstreamVideo(apiKey, request, upstreamTaskId, abortController.signal, trace);
    const videoUrl = await cacheVideoResult(taskId, remoteUrl, apiKey, authenticatedOrigin, abortController.signal, trace);
    abortController.signal.throwIfAborted();
    const completedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + TASK_TTL_MS).toISOString();
    db.prepare("UPDATE tasks SET status = 'completed', result_json = ?, completed_at = ?, expires_at = ? WHERE id = ? AND status = 'processing'")
      .run(JSON.stringify({ videoUrl, upstreamTaskId }), completedAt, expiresAt, taskId);
  } catch (error) {
    const latest = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId);
    if (!abortController.signal.aborted) {
      console.error(`[video-task] 视频任务执行失败 taskId=${taskId} model=${request.model} baseUrl=${getSafeUrlLabel(request.baseUrl)}`, error);
    }
    if (latest?.status === TASK_STATUS.PROCESSING) {
      const completedAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + TASK_TTL_MS).toISOString();
      const status = abortController.signal.aborted ? TASK_STATUS.CANCELLED : TASK_STATUS.FAILED;
      const message = abortController.signal.aborted ? '视频任务已取消' : normalizeError(error);
      db.prepare('UPDATE tasks SET status = ?, error = ?, completed_at = ?, expires_at = ? WHERE id = ? AND status = ?')
        .run(status, message, completedAt, expiresAt, taskId, TASK_STATUS.PROCESSING);
    }
  }
  const finalTask = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId);
  const logOptions = getVideoUpstreamLogOptions();
  logVideoTaskSummary({
    ...getVideoTaskLogContext(trace),
    status: finalTask?.status || 'unknown',
    totalDurationMs: Math.max(0, Date.now() - startedAtMs),
  }, {
    ...logOptions,
    isError: ![TASK_STATUS.COMPLETED, TASK_STATUS.CANCELLED].includes(finalTask?.status),
  });
  if (finalTask?.status === TASK_STATUS.CANCELLED) deleteTaskVideoFile(taskId);
  cleanupTaskRuntimeState(taskId);
  broadcastTask(taskId);
  broadcastQueueStatus();
}

/**
 * 取消排队中或处理中的视频任务，并释放其本地队列与运行期资源。
 * @param {string} taskId 待取消的视频任务标识。
 * @returns {{found: boolean, cancelled: boolean}} 是否找到任务以及是否成功取消。
 */
function cancelVideoTask(taskId) {
  const task = db.prepare('SELECT id, status, request_json, created_at FROM tasks WHERE id = ? AND mode = ?').get(taskId, 'video-generation');
  if (!task) return { found: false, cancelled: false };
  if (![TASK_STATUS.QUEUED, TASK_STATUS.LEGACY_QUEUED, TASK_STATUS.PROCESSING].includes(task.status)) {
    return { found: true, cancelled: false };
  }

  // 第一步先写入终态，防止并发完成路径在取消后覆盖状态。
  const completedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + TASK_TTL_MS).toISOString();
  db.prepare('UPDATE tasks SET status = ?, error = ?, completed_at = ?, expires_at = ? WHERE id = ?')
    .run(TASK_STATUS.CANCELLED, '视频任务已取消', completedAt, expiresAt, taskId);

  // 排队任务不会进入 runVideoTask，因此在这里补写唯一的终态摘要；处理中任务由执行器统一记录，避免重复日志。
  if ([TASK_STATUS.QUEUED, TASK_STATUS.LEGACY_QUEUED].includes(task.status)) {
    const request = parseJsonSafely(task.request_json) || {};
    const startedAtMs = Number.isFinite(Date.parse(task.created_at)) ? Date.parse(task.created_at) : Date.now();
    logVideoTaskSummary({
      taskId,
      modelName: request.modelName || request.model || '',
      model: request.model || '',
      resolution: request.resolution ? formatVideoResolution(request.resolution) : '',
      status: TASK_STATUS.CANCELLED,
      elapsedMs: Math.max(0, Date.now() - startedAtMs),
      totalDurationMs: Math.max(0, Date.now() - startedAtMs),
    }, getVideoUpstreamLogOptions());
  }

  // 第二步从等待队列移除任务，并中止本地正在进行的上游创建、轮询或缓存请求。
  // 当前兼容协议没有定义统一的上游取消端点，因此任务已提交上游后只能停止本地继续处理。
  for (let index = videoQueue.length - 1; index >= 0; index -= 1) {
    if (videoQueue[index] === taskId) videoQueue.splice(index, 1);
  }
  const abortController = videoTaskAbortControllers.get(taskId);
  abortController?.abort(new DOMException('视频任务已取消', 'AbortError'));
  deleteTaskVideoFile(taskId);

  // 第三步释放密钥、附件和限流计数；运行函数稍后重复清理时不会二次递减。
  cleanupTaskRuntimeState(taskId);
  broadcastTask(taskId);
  broadcastQueueStatus();
  drainVideoQueue();
  return { found: true, cancelled: true };
}

/**
 * 在独立并发上限内持续调度视频任务。
 * @returns 无返回值。
 */
function drainVideoQueue() {
  const maxConcurrency = getMaxVideoConcurrency();
  while (videoQueue.length > 0 && activeVideoCount < maxConcurrency) {
    const taskId = videoQueue.shift();
    activeVideoCount += 1;
    runVideoTask(taskId)
      .catch(error => {
        // 执行器的意外异常不能形成未处理 Promise；任务状态由后续清理或下一轮启动恢复流程接管。
        console.error(`[video-queue] 执行任务异常 taskId=${taskId}`, error?.message || error);
      })
      .finally(() => {
        activeVideoCount -= 1;
        drainVideoQueue();
      });
  }
}

function drainQueue() {
  const maxConcurrency = getMaxServerConcurrency();
  while (queue.length > 0) {
    const taskId = queue[0];
    const task = db.prepare('SELECT request_json FROM tasks WHERE id = ?').get(taskId);
    const req = task ? parseJsonSafely(task.request_json) : null;
    const imageSlots = req?.parallelCount || 1;

    // 容量足够 → 放行。容量不足时唯一例外：当前空闲（activeCount===0）且该任务
    // 自身就超过总并发，允许其独占运行（否则永远无法被调度）；其余情况一律等待
    // 在飞任务腾出名额。
    const fitsWithinLimit = activeCount + imageSlots <= maxConcurrency;
    const oversizedTaskCanRunAlone = activeCount === 0 && imageSlots > maxConcurrency;
    if (!fitsWithinLimit && !oversizedTaskCanRunAlone) break;

    queue.shift();
    activeCount += imageSlots;
    runTask(taskId)
      .catch(error => {
        // 执行器的意外异常不能形成未处理 Promise；释放并发槽位后继续处理后续任务。
        console.error(`[queue] 执行任务异常 taskId=${taskId}`, error?.message || error);
      })
      .finally(() => {
        activeCount -= imageSlots;
        drainQueue();
      });
  }
}

function recordTaskSseResponse(taskId, requestCount) {
  const task = db.prepare('SELECT status, result_json FROM tasks WHERE id = ?').get(taskId);
  if (!task || task.status !== 'processing') return;

  const parsedResult = task.result_json ? parseJsonSafely(task.result_json) : null;
  const result = parsedResult && typeof parsedResult === 'object' && !Array.isArray(parsedResult)
    ? parsedResult
    : {};
  const requests = Number.isInteger(requestCount) && requestCount > 0 ? requestCount : 1;
  const previousResponses = Number.isInteger(result.sse?.responses) ? result.sse.responses : 0;
  if (previousResponses >= requests) return;

  result.sse = { responses: previousResponses + 1, requests };
  db.prepare('UPDATE tasks SET result_json = ? WHERE id = ?').run(JSON.stringify(result), taskId);
  broadcastTask(taskId);
}

/**
 * 记录每次图片生成实际发往上游的完整请求地址。
 * @param protocol 图片生成协议或图片 API 类型。
 * @param model 实际发送给上游的模型 ID。
 * @param url 最终请求 URL，不包含 API Key 等敏感信息。
 * @param {{ size?: string }} details 可选的安全请求参数摘要。
 * @returns 无返回值。
 */
function logImageRequestUrl(protocol, model, url, details = {}) {
  const size = details.size ? ` 尺寸=${details.size}` : '';
  console.info(`[image-request] 协议=${protocol} 模型=${model}${size} 最终请求URL=${getSafeUrlLabel(url)}`);
}

async function generateSingleImage(apiKey, request, taskId, index) {
  let usesSse = false;
  try {
    const variantPrompt = typeof request.promptVariants?.[index] === 'string'
      ? request.promptVariants[index].trim()
      : '';
    const requestForImage = variantPrompt
      ? { ...request, prompt: `${request.prompt}\n\n本张图要求：\n${variantPrompt}` }
      : request;
    const generated = await generateFlyreqImage(apiKey, requestForImage, {
      onSseConfirmed: () => recordTaskSseResponse(taskId, request.parallelCount),
      taskId,
      imageIndex: index,
    });
    usesSse = generated.usesSse;
    const image = generated.image;
    const expanded = image.startsWith('MULTI_URL:') ? image.substring(10).split('|||').map(url => `URL:${url}`) : [image];
    const diskRefs = [];
    for (let subIdx = 0; subIdx < expanded.length; subIdx++) {
      const img = expanded[subIdx];
      if (img.startsWith('URL:')) {
        const remoteUrl = img.substring(4);
        const result = await downloadUrlToDisk(taskId, index, subIdx, remoteUrl, { apiKey, request: requestForImage });
        diskRefs.push(`URL:${result.httpUrl}`);
      } else {
        const buffer = Buffer.from(img, 'base64');
        const normalized = await enforceGeneratedImageLayout(buffer, 'image/png', requestForImage);
        const result = saveImageToDisk(taskId, index, subIdx, normalized.buffer, normalized.mimeType);
        diskRefs.push(`URL:${result.httpUrl}`);
      }
    }
    db.prepare("UPDATE task_items SET status = 'completed', image_data = ?, completed_at = ? WHERE task_id = ? AND item_index = ?")
      .run(JSON.stringify(diskRefs), new Date().toISOString(), taskId, index);
    return { success: true, images: diskRefs, usesSse };
  } catch (error) {
    const message = normalizeError(error);
    db.prepare("UPDATE task_items SET status = 'failed', error = ?, completed_at = ? WHERE task_id = ? AND item_index = ?")
      .run(message, new Date().toISOString(), taskId, index);
    return { success: false, error: message, usesSse: usesSse || Boolean(error?.usesSse) };
  }
}

async function runTask(taskId) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  const apiKey = apiKeys.get(taskId);
  if (!task || !apiKey || ![TASK_STATUS.QUEUED, TASK_STATUS.LEGACY_QUEUED].includes(task.status)) {
    cleanupTaskRuntimeState(taskId);
    return;
  }

  const request = parseJsonSafely(task.request_json);
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    const completedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + TASK_TTL_MS).toISOString();
    db.prepare("UPDATE tasks SET status = 'failed', error = ?, completed_at = ?, expires_at = ? WHERE id = ? AND status IN (?, ?)")
      .run('任务请求数据损坏，无法执行', completedAt, expiresAt, taskId, TASK_STATUS.QUEUED, TASK_STATUS.LEGACY_QUEUED);
    cleanupTaskRuntimeState(taskId);
    broadcastTask(taskId);
    broadcastQueueStatus();
    return;
  }
  const refImages = taskRefImages.get(taskId);
  if (refImages && refImages.length > 0) {
    request.images = refImages;
  }
  db.prepare("UPDATE tasks SET status = 'processing' WHERE id = ?").run(taskId);
  broadcastTask(taskId);
  broadcastQueueStatus();

  // 所有图片标记为 processing
  for (let index = 0; index < request.parallelCount; index++) {
    db.prepare("UPDATE task_items SET status = 'processing', created_at = ? WHERE task_id = ? AND item_index = ?")
      .run(new Date().toISOString(), taskId, index);
  }

  // 真正并发生成所有图片
  const itemResults = await Promise.allSettled(
    Array.from({ length: request.parallelCount }, (_, index) =>
      generateSingleImage(apiKey, request, taskId, index)
    )
  );

  // 汇总结果
  const images = [];
  const errors = [];
  let sseResponses = 0;
  for (const result of itemResults) {
    if (result.status === 'fulfilled' && result.value.success) {
      images.push(...result.value.images);
      if (result.value.usesSse) sseResponses++;
    } else {
      const msg = result.status === 'fulfilled'
        ? result.value.error
        : normalizeError(result.reason);
      errors.push(msg);
      if (result.status === 'fulfilled' && result.value.usesSse) sseResponses++;
    }
  }
  const sse = sseResponses > 0 ? { responses: sseResponses, requests: request.parallelCount } : undefined;

  const completedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + TASK_TTL_MS).toISOString();
  if (images.length > 0) {
    const warning = errors.length > 0 ? `${errors.length} 张图片生成失败: ${errors.join('; ')}` : null;
    db.prepare(`
      UPDATE tasks SET status = 'completed', result_json = ?, warning = ?, completed_at = ?, expires_at = ? WHERE id = ?
    `).run(JSON.stringify({ images, ...(sse ? { sse } : {}) }), warning, completedAt, expiresAt, taskId);
  } else {
    db.prepare(`
      UPDATE tasks SET status = 'failed', result_json = ?, error = ?, completed_at = ?, expires_at = ? WHERE id = ?
    `).run(JSON.stringify({ images: [], ...(sse ? { sse } : {}) }), `所有图片生成失败: ${errors.join('; ')}`, completedAt, expiresAt, taskId);
  }
  cleanupTaskRuntimeState(taskId);
  broadcastTask(taskId);
  broadcastQueueStatus();
}

function serializeTask(task) {
  if (!task) return null;
  if (task.expires_at && Date.parse(task.expires_at) <= Date.now()) {
    return { id: task.id, status: 'expired', error: '该任务已超出取回时间' };
  }
  // 旧版本或异常中断可能留下损坏的结果 JSON；任务状态仍应可查询，不能让单条记录导致接口抛错。
  const result = task.result_json ? parseJsonSafely(task.result_json) : undefined;
  const createdAtMs = Date.parse(task.created_at);
  const completedAtMs = task.completed_at ? Date.parse(task.completed_at) : Date.now();
  const durationMs = Number.isFinite(createdAtMs) && Number.isFinite(completedAtMs)
    ? Math.max(0, completedAtMs - createdAtMs)
    : undefined;
  return {
    id: task.id,
    status: task.status,
    mode: task.mode,
    result,
    error: task.error,
    warning: task.warning,
    createdAt: task.created_at,
    completedAt: task.completed_at,
    durationMs,
    expiresAt: task.expires_at,
  };
}

function deleteTask(taskId) {
  deleteTaskImageFiles(taskId);
  deleteTaskVideoFile(taskId);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM task_items WHERE task_id = ?').run(taskId);
    db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
  });
  tx();
  cleanupTaskRuntimeState(taskId);
  broadcastQueueStatus();
}

function cleanupExpiredTasks() {
  const ids = db.prepare('SELECT id FROM tasks WHERE expires_at IS NOT NULL AND expires_at <= ?').all(new Date().toISOString());
  let successCount = 0;
  let failCount = 0;
  for (const row of ids) {
    broadcastTaskExpired(row.id);
    try {
      deleteTask(row.id);
      successCount++;
    } catch (error) {
      failCount++;
      console.warn(`[cleanup] 过期任务删除失败: taskId=${row.id}`, error?.message || error);
    }
  }
  if (ids.length > 0) {
    console.log(`[cleanup] 本轮过期清理: 检查${ids.length}个任务, 成功${successCount}个, 失败${failCount}个`);
  }
}

// ===== WebSocket broadcasting =====

/**
 * 判断任务状态是否已经进入不再变化的终态。
 * @param {string} status 待判断的任务状态。
 * @returns 完成、失败、取消或过期时返回 true。
 */
function isTerminalTaskStatus(status) {
  return status === TASK_STATUS.COMPLETED
    || status === TASK_STATUS.FAILED
    || status === TASK_STATUS.CANCELLED
    || status === 'expired';
}

function safeSendJson(ws, payload) {
  try {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(payload));
  } catch (error) {
    console.warn('[ws] send failed', error?.message || error);
  }
}

function broadcastTask(taskId) {
  if (!taskId) return;
  let cachedPayload;
  for (const [ws, set] of taskSubscriptions) {
    if (!set.has(taskId)) continue;
    if (cachedPayload === undefined) {
      const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
      const task = serializeTask(row) || { id: taskId, status: 'expired', error: '该任务已超出取回时间' };
      cachedPayload = { type: 'task', task };
    }
    safeSendJson(ws, cachedPayload);
    if (isTerminalTaskStatus(cachedPayload.task.status)) {
      set.delete(taskId);
    }
  }
}

function broadcastTaskExpired(taskId) {
  const payload = { type: 'task', task: { id: taskId, status: 'expired', error: '该任务已超出取回时间' } };
  for (const [ws, set] of taskSubscriptions) {
    if (!set.has(taskId)) continue;
    safeSendJson(ws, payload);
    set.delete(taskId);
  }
}

function flushQueueBroadcast() {
  queueBroadcastTimer = null;
  if (!queueBroadcastPending) return;
  queueBroadcastPending = false;
  if (queueSubscribers.size === 0) return;
  const stats = getQueueStats();
  const payload = { type: 'queueStatus', stats };
  for (const ws of queueSubscribers) {
    safeSendJson(ws, payload);
  }
}

function broadcastQueueStatus() {
  queueBroadcastPending = true;
  if (queueBroadcastTimer) return;
  queueBroadcastTimer = setTimeout(flushQueueBroadcast, 200);
}

function handleSubscribeTasks(ws, taskIds) {
  if (!Array.isArray(taskIds)) return;
  let set = taskSubscriptions.get(ws);
  if (!set) {
    set = new Set();
    taskSubscriptions.set(ws, set);
  }
  for (const id of taskIds.slice(0, WS_MAX_TASK_IDS_PER_MESSAGE)) {
    if (typeof id !== 'string' || !id) continue;
    // 已达单连接订阅上限且是新 id 时停止，避免无限增长。
    if (!set.has(id) && set.size >= WS_MAX_SUBSCRIPTIONS_PER_SOCKET) break;
    set.add(id);
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    const task = serializeTask(row) || { id, status: 'expired', error: '该任务已超出取回时间' };
    safeSendJson(ws, { type: 'task', task });
    if (isTerminalTaskStatus(task.status)) {
      set.delete(id);
    }
  }
}

function handleUnsubscribeTasks(ws, taskIds) {
  const set = taskSubscriptions.get(ws);
  if (!set || !Array.isArray(taskIds)) return;
  for (const id of taskIds) {
    set.delete(id);
  }
}

function handleSubscribeQueue(ws) {
  queueSubscribers.add(ws);
  safeSendJson(ws, { type: 'queueStatus', stats: getQueueStats() });
}

function handleClientMessage(ws, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    safeSendJson(ws, { type: 'error', code: 'INVALID_JSON', message: '消息不是合法 JSON' });
    return;
  }
  if (!msg || typeof msg.type !== 'string') {
    safeSendJson(ws, { type: 'error', code: 'INVALID_TYPE', message: '消息缺少 type' });
    return;
  }
  switch (msg.type) {
    case 'subscribeTasks':
      handleSubscribeTasks(ws, msg.taskIds);
      break;
    case 'unsubscribeTasks':
      handleUnsubscribeTasks(ws, msg.taskIds);
      break;
    case 'subscribeQueue':
      handleSubscribeQueue(ws);
      break;
    case 'unsubscribeQueue':
      queueSubscribers.delete(ws);
      break;
    case 'ping':
      safeSendJson(ws, { type: 'pong' });
      break;
    default:
      safeSendJson(ws, { type: 'error', code: 'UNKNOWN_TYPE', message: `未知的 type: ${msg.type}` });
  }
}

function setupWebSocketServer() {
  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD_BYTES });

  wss.on('connection', ws => {
    wsAlive.set(ws, { lastPong: Date.now(), missed: 0 });

    ws.on('message', data => {
      handleClientMessage(ws, data.toString());
    });

    ws.on('pong', () => {
      const state = wsAlive.get(ws);
      if (state) {
        state.lastPong = Date.now();
        state.missed = 0;
      }
    });

    ws.on('close', () => {
      taskSubscriptions.delete(ws);
      queueSubscribers.delete(ws);
      wsAlive.delete(ws);
    });

    ws.on('error', error => {
      console.warn('[ws] connection error', error?.message || error);
    });
  });

  setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.readyState !== ws.OPEN) continue;
      const state = wsAlive.get(ws);
      if (!state) continue;
      if (Date.now() - state.lastPong > WS_HEARTBEAT_INTERVAL_MS + WS_PONG_GRACE_MS) {
        state.missed += 1;
        if (state.missed >= 2) {
          try { ws.terminate(); } catch { /* ignore */ }
          continue;
        }
      }
      try { ws.ping(); } catch { /* ignore */ }
    }
  }, WS_HEARTBEAT_INTERVAL_MS).unref();

  return wss;
}

async function handleApi(req, res, pathname) {
  try {
    const apiPathname = pathname.replace(/\/+$/, '');

    if (req.method === 'GET' && apiPathname === '/api/flyreq/queue-status') {
      sendJson(res, 200, getQueueStats());
      return true;
    }

    if (req.method === 'GET' && apiPathname === '/api/flyreq/prompts') {
      const promptsPath = path.join(__dirname, 'prompts.json');
      try {
        if (!fs.existsSync(promptsPath)) {
          sendJson(res, 200, []);
          return true;
        }
        const raw = fs.readFileSync(promptsPath, 'utf8');
        const data = JSON.parse(raw);
        sendJson(res, 200, Array.isArray(data) ? data : []);
      } catch {
        sendJson(res, 200, []);
      }
      return true;
    }

    if (req.method === 'GET' && apiPathname === '/api/flyreq/blacklist') {
      const blacklistPath = path.join(__dirname, 'blacklist.json');
      try {
        if (!fs.existsSync(blacklistPath)) {
          sendJson(res, 200, { keywords: [] });
          return true;
        }
        const raw = fs.readFileSync(blacklistPath, 'utf8');
        const data = JSON.parse(raw);
        sendJson(res, 200, { keywords: Array.isArray(data.keywords) ? data.keywords : [] });
      } catch {
        sendJson(res, 200, { keywords: [] });
      }
      return true;
    }

    if (req.method === 'GET' && apiPathname === '/api/flyreq/manifest.webmanifest') {
      sendJson(res, 200, buildPlatformManifest(resolvePlatformBranding(getRuntimeEnv())), {
        'Content-Type': 'application/manifest+json; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      });
      return true;
    }

    if (req.method === 'GET' && apiPathname === '/api/flyreq/config') {
      const env = getRuntimeEnv();
      const rawMode = String(env.PROMPT_GALLERY_MODE || '2').trim();
      const mode = ['1', '2', '3'].includes(rawMode) ? rawMode : '2';
      sendJson(
        res,
        200,
        {
          promptGalleryMode: mode,
          promptGalleryPasswordEnabled: String(env.PROMPT_GALLERY_PASSWORD || '').trim().length > 0,
          imageModelKeyGuide: resolveImageModelKeyGuide(env),
          imagePresetModelIds: resolveImagePresetModelIds(env),
          defaultImageModel: resolveDefaultImageModelConfig(env),
          defaultVideoModel: resolveDefaultVideoModelConfig(env),
          videoWorkspace: resolveVideoWorkspaceConfig(env),
          videoProtocols: resolveVideoProtocolConfig(env),
          branding: resolvePlatformBranding(env),
        },
        {
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0',
        },
      );
      return true;
    }

    if (req.method === 'POST' && apiPathname === '/api/flyreq/prompt-gallery/verify') {
      const env = getRuntimeEnv();
      const expected = String(env.PROMPT_GALLERY_PASSWORD || '').trim();
      if (!expected) {
        sendJson(res, 200, { ok: true });
        return true;
      }

      const body = await readJsonBody(req);
      const password = String(body?.password || '');
      const ok = hashPromptGalleryPassword(password) === hashPromptGalleryPassword(expected);
      sendJson(res, 200, { ok });
      return true;
    }

    const imageMatch = apiPathname.match(/^\/api\/flyreq\/images\/([^/]+)\/(\d+)(?:\/(\d+))?$/);
    if (req.method === 'GET' && imageMatch) {
      const taskId = imageMatch[1];
      const index = Number(imageMatch[2]);
      const hasSubIndex = imageMatch[3] !== undefined;
      const subIndex = hasSubIndex ? Number(imageMatch[3]) : 0;
      if (!/^[a-zA-Z0-9-]+$/.test(taskId)) {
        sendJson(res, 400, { error: 'Invalid taskId' });
        return true;
      }
      try {
        if (!fs.existsSync(IMAGE_DIR)) {
          sendJson(res, 404, { error: 'Not Found' });
          return true;
        }
        // 常见情况：扩展名 png/jpg/webp，直接拼路径命中，
        // 避免对整个 IMAGE_DIR 做同步 readdir 全目录扫描（随图片数线性变慢）。
        let filePath = null;
        for (const ext of ['png', 'jpg', 'webp']) {
          const candidate = path.join(IMAGE_DIR, `${taskId}-${index}-${subIndex}.${ext}`);
          if (fs.existsSync(candidate)) { filePath = candidate; break; }
        }
        // 旧任务地址不含 subIndex 时保留首个子图兼容回退；新地址必须精确命中。
        if (!filePath && !hasSubIndex) {
          const prefix = `${taskId}-${index}-`;
          const files = fs.readdirSync(IMAGE_DIR)
            .filter(name => name.startsWith(prefix))
            .sort();
          if (files.length > 0) filePath = path.join(IMAGE_DIR, files[0]);
        }
        if (!filePath) {
          sendJson(res, 404, { error: 'Not Found' });
          return true;
        }
        const stat = fs.statSync(filePath);
        pipeFileToResponse(res, filePath, 200, {
          'Content-Type': getContentType(filePath),
          'Content-Length': stat.size,
          'Cache-Control': 'private, max-age=3600',
        });
      } catch {
        sendJson(res, 404, { error: 'Not Found' });
      }
      return true;
    }

    const videoFileMatch = apiPathname.match(/^\/api\/flyreq\/videos\/([^/]+)$/);
    if (req.method === 'GET' && videoFileMatch) {
      const filePath = findTaskVideoFile(videoFileMatch[1]);
      if (!filePath) {
        sendJson(res, 404, { error: 'Not Found' });
        return true;
      }
      sendVideoFile(req, res, filePath);
      return true;
    }

    // ===== 文本 AI 代理（流式 + 非流式，OpenAI / Google 协议） =====
    if (req.method === 'POST' && apiPathname === '/api/flyreq/proxy/text') {
      try {
        const body = await readJsonBody(req);
        const { protocol, baseUrl, apiKey, model, stream, requestBody } = body;
        if (!baseUrl || !apiKey) {
          sendJson(res, 400, { error: 'Missing baseUrl or apiKey' });
          return true;
        }

        const normalizedBaseUrl = resolveAndLogOutboundBaseUrl('文本代理', protocol, baseUrl).baseUrl;
        let targetUrl;
        const authHeaders = { 'Content-Type': 'application/json' };

        if (protocol === 'google') {
          targetUrl = appendProtocolApiPath(
            'google',
            normalizedBaseUrl,
            stream
              ? `/v1beta/models/${encodeURIComponent(model || '')}:streamGenerateContent?alt=sse`
              : `/v1beta/models/${encodeURIComponent(model || '')}:generateContent`,
          );
          authHeaders['x-goog-api-key'] = apiKey;
          authHeaders['Authorization'] = `Bearer ${apiKey}`;
        } else {
          targetUrl = appendProtocolApiPath('openai', normalizedBaseUrl, '/v1/responses');
          authHeaders['Authorization'] = `Bearer ${apiKey}`;
        }

        if (stream) {
          authHeaders['Accept'] = 'text/event-stream';
        }

        let forwardedBody;
        if (requestBody) {
          forwardedBody = requestBody;
        } else {
          const clean = { ...body };
          delete clean.protocol;
          delete clean.baseUrl;
          delete clean.apiKey;
          delete clean.model;
          delete clean.stream;
          delete clean.requestBody;
          forwardedBody = clean;
        }

        const upstream = await fetchWithTimeout(targetUrl, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify(forwardedBody),
        });

        if (stream && upstream.ok) {
          res.writeHead(upstream.status, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
          const reader = upstream.body.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) { res.end(); return true; }
              res.write(value);
            }
          } catch {
            res.end();
          }
          return true;
        }

        let data = null;
        try { data = await upstream.json(); } catch { /* ignore */ }
        sendJson(res, upstream.status, data || { error: `上游返回 ${upstream.status}` });
      } catch (error) {
        if (error && error.message && /abort|timeout/i.test(error.message)) {
          sendJson(res, 504, { error: '代理请求上游超时' });
        } else {
          sendJson(res, 502, { error: normalizeError(error) });
        }
      }
      return true;
    }

    // ===== 模型检查与目录代理 =====
    if ((req.method === 'GET' || req.method === 'POST') && apiPathname === '/api/flyreq/proxy/models') {
      try {
        const parsed = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        // POST 将密钥放在请求体内，避免 API Key 出现在浏览器地址、代理日志和服务器访问日志中。
        const body = req.method === 'POST' ? await readJsonBody(req) : {};
        const baseUrl = req.method === 'POST' ? body.baseUrl : parsed.searchParams.get('baseUrl');
        const apiKey = req.method === 'POST' ? body.apiKey : parsed.searchParams.get('apiKey');
        const protocol = (req.method === 'POST' ? body.protocol : parsed.searchParams.get('protocol')) || 'openai';
        if (!baseUrl || !apiKey) {
          sendJson(res, 400, { error: 'Missing baseUrl or apiKey' });
          return true;
        }

        const normalizedBaseUrl = resolveAndLogOutboundBaseUrl('模型列表', protocol, baseUrl).baseUrl;
        const isGoogle = protocol === 'google';
        const modelsUrl = `${stripProtocolVersionSuffix(protocol, normalizedBaseUrl)}${isGoogle ? '/v1beta/models' : '/v1/models'}`;
        // Google 原生目录使用 x-goog-api-key；其余兼容协议统一使用 Bearer 认证。
        const headers = isGoogle
          ? { 'x-goog-api-key': String(apiKey) }
          : { Authorization: `Bearer ${apiKey}` };

        const response = await fetchWithTimeout(modelsUrl, { method: 'GET', headers });
        let data = null;
        try { data = await response.json(); } catch { /* ignore */ }
        sendJson(res, response.status, data);
      } catch (error) {
        sendJson(res, 502, { error: normalizeError(error) });
      }
      return true;
    }

    // 批量创建端点：请求体包含公共参数和 parallelCount，响应按图片序号返回独立 taskIds。
    if (req.method === 'POST' && apiPathname === '/api/flyreq/video-tasks') {
      const { fields, files } = await readVideoMultipartBody(req);
      const payload = await normalizeVideoTaskPayload(fields, files);
      if (payload.parallelCount > 1) {
        const taskIds = createVideoTaskBatch(payload, files, req);
        const selectTask = db.prepare('SELECT * FROM tasks WHERE id = ? AND mode = ?');
        const tasks = taskIds.map(taskId => serializeTask(selectTask.get(taskId, 'video-generation')));
        sendJson(res, 202, { taskIds, tasks });
        return true;
      }
      const taskId = createVideoTask(payload, files, req);
      const task = serializeTask(db.prepare('SELECT * FROM tasks WHERE id = ? AND mode = ?').get(taskId, 'video-generation'));
      sendJson(res, 202, { ...task, taskId });
      return true;
    }

    const videoTaskMatch = apiPathname.match(/^\/api\/flyreq\/video-tasks\/([^/]+)(?:\/(ack|cancel))?$/);
    if (videoTaskMatch) {
      const taskId = decodeURIComponent(videoTaskMatch[1]);
      const action = videoTaskMatch[2];
      if (req.method === 'GET' && !action) {
        const task = serializeTask(db.prepare('SELECT * FROM tasks WHERE id = ? AND mode = ?').get(taskId, 'video-generation'));
        sendJson(res, task ? 200 : 404, task || { id: taskId, status: 'expired', error: '该任务已超出取回时间' });
        return true;
      }
      if (req.method === 'POST' && action === 'ack') {
        const existing = db.prepare('SELECT id FROM tasks WHERE id = ? AND mode = ?').get(taskId, 'video-generation');
        if (existing) db.prepare('UPDATE tasks SET expires_at = ? WHERE id = ?').run(new Date(Date.now() + 120000).toISOString(), taskId);
        sendJson(res, 200, { ok: true });
        return true;
      }
      if (req.method === 'POST' && action === 'cancel') {
        // 取消端点只接受排队中或处理中的视频任务，并返回写入后的终态快照。
        const cancellation = cancelVideoTask(taskId);
        if (!cancellation.found) {
          sendJson(res, 404, { error: '视频任务不存在或已过期' });
        } else if (!cancellation.cancelled) {
          sendJson(res, 409, { error: '视频任务已经结束，无法取消' });
        } else {
          const task = serializeTask(db.prepare('SELECT * FROM tasks WHERE id = ? AND mode = ?').get(taskId, 'video-generation'));
          sendJson(res, 200, task);
        }
        return true;
      }
      sendJson(res, 405, { error: 'Method Not Allowed' });
      return true;
    }

    if (req.method === 'POST' && apiPathname === '/api/flyreq/tasks/batch') {
      const body = await readJsonBody(req);
      const taskIds = createTaskBatch(body, req);
      sendJson(res, 202, { taskIds });
      return true;
    }

    if (req.method === 'POST' && apiPathname === '/api/flyreq/tasks') {
      const body = await readJsonBody(req);
      const taskId = createTask(body, req);
      sendJson(res, 202, { taskId });
      return true;
    }

    const match = apiPathname.match(/^\/api\/flyreq\/tasks\/([^/]+)(?:\/(ack))?$/);
    if (!match) return false;
    const taskId = decodeURIComponent(match[1]);
    const action = match[2];

    if (req.method === 'GET' && !action) {
      const task = serializeTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId));
      sendJson(res, task ? 200 : 404, task || { id: taskId, status: 'expired', error: '该任务已超出取回时间' });
      return true;
    }

    if (req.method === 'POST' && action === 'ack') {
      const ACK_GRACE_MS = 120 * 1000;
      const existing = db.prepare('SELECT id FROM tasks WHERE id = ?').get(taskId);
      if (existing) {
        db.prepare('UPDATE tasks SET expires_at = ? WHERE id = ?').run(
          new Date(Date.now() + ACK_GRACE_MS).toISOString(), taskId
        );
      }
      sendJson(res, 200, { ok: true });
      return true;
    }

    sendJson(res, 405, { error: 'Method Not Allowed' });
    return true;
  } catch (error) {
    if (isHttpError(error)) {
      sendHttpError(res, error);
    } else if (error && typeof error.statusCode === 'number') {
      sendJson(res, error.statusCode, { error: normalizeError(error) });
    } else {
      sendJson(res, 400, { error: normalizeError(error) });
    }
    return true;
  }
}

initDatabase();
const storageReady = ensureImageDir() && ensureVideoDir();
if (storageReady) {
  logBaseUrlRewriteConfiguration();
  cleanupExpiredTasks();
  setInterval(cleanupExpiredTasks, CLEANUP_INTERVAL_MS).unref();
  setInterval(cleanupRateLimitBuckets, CLEANUP_INTERVAL_MS).unref();
}

/**
 * 处理 HTTP 服务监听失败，输出可直接执行的故障说明并正常结束进程。
 * @param {NodeJS.ErrnoException} error Node.js HTTP Server 监听错误。
 * @returns 无返回值；设置非零退出码交由进程结束。
 */
function handleServerListenError(error) {
  if (error.code === 'EADDRINUSE') {
    console.error(`[server] 启动失败：端口 ${PORT} 已被其他进程占用。请停止旧的 FlyReq Image 实例，或通过 PORT 环境变量改用其他端口。`);
  } else if (error.code === 'EACCES') {
    console.error(`[server] 启动失败：没有权限监听 ${HOSTNAME}:${PORT}，请检查端口权限或改用其他端口。`);
  } else {
    console.error(`[server] 启动失败：无法监听 ${HOSTNAME}:${PORT}`, error);
  }
  process.exitCode = 1;
}

const startServer = () => {
  const wss = setupWebSocketServer();
  const httpServer = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || `${HOSTNAME}:${PORT}`}`);
    if (parsedUrl.pathname?.startsWith('/api/flyreq/')) {
      const handled = await handleApi(req, res, parsedUrl.pathname);
      if (handled || res.headersSent || res.writableEnded) return;
    }
    if (!IS_DEV) {
      if (serveStatic(req, res, parsedUrl.pathname || '/')) return;
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    return handle(req, res);
  });

  const nextUpgradeHandler = IS_DEV && typeof app.getUpgradeHandler === 'function'
    ? app.getUpgradeHandler()
    : null;

  httpServer.on('upgrade', (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url || '/', `http://${req.headers.host || `${HOSTNAME}:${PORT}`}`).pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname === '/api/flyreq/ws') {
      wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
      return;
    }
    if (nextUpgradeHandler) {
      nextUpgradeHandler(req, socket, head);
      return;
    }
    socket.destroy();
  });

  httpServer.once('error', handleServerListenError);
  httpServer.listen(PORT, HOSTNAME, () => {
    const localUrl = `http://localhost:${PORT}`;
    const listenUrl = `http://${HOSTNAME}:${PORT}`;
    console.log(`FlyReq Image server ready on ${localUrl}`);
    if (HOSTNAME !== 'localhost' && HOSTNAME !== '127.0.0.1') {
      console.log(`Listening on ${listenUrl}`);
    }
  });
};

if (!storageReady) {
  // 文件系统错误已经写入日志队列；等待落盘完成后退出，避免丢失最关键的启动诊断。
  void flushDailyFileLogs().finally(() => process.exit(1));
} else if (IS_DEV) {
  app.prepare().then(startServer);
} else {
  startServer();
}
