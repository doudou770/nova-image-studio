const { isVideoProtocol } = require('./video-protocol-config');

/**
 * 将媒体附件转换为可放入 JSON 请求的数据地址。
 * @param {{ mimeType: string, buffer: Buffer } | undefined} file 参考媒体文件。
 * @returns {string | undefined} Base64 数据地址；没有附件时返回 undefined。
 */
function toMediaDataUrl(file) {
  if (!file) return undefined;
  return `data:${file.mimeType};base64,${file.buffer.toString('base64')}`;
}

/**
 * 向 multipart 请求追加同类型参考附件。
 * @param {FormData} body 待写入的上游表单。
 * @param {string} fieldName 上游附件字段名。
 * @param {Array<{ filename: string, mimeType: string, buffer: Buffer }>} files 同类型附件集合。
 * @returns {void} 直接修改传入的表单。
 */
function appendMediaFiles(body, fieldName, files) {
  for (const file of files) body.append(fieldName, new Blob([file.buffer], { type: file.mimeType }), file.filename);
}

/**
 * 将带版本或不带版本的基础地址与视频 API 路径安全拼接。
 * @param {string} baseUrl 上游基础地址。
 * @param {string} apiPath 以 /v1 开头的视频 API 路径。
 * @returns {string} 不会重复追加 /v1 的完整地址。
 */
function appendVideoApiPath(baseUrl, apiPath) {
  const normalizedBaseUrl = String(baseUrl || '').replace(/\/+$/, '');
  const normalizedPath = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
  return normalizedBaseUrl.toLowerCase().endsWith('/v1') && normalizedPath.toLowerCase().startsWith('/v1/')
    ? `${normalizedBaseUrl}${normalizedPath.slice(3)}`
    : `${normalizedBaseUrl}${normalizedPath}`;
}

/**
 * 仅为实际上游同源的视频下载请求附加认证头。
 * @param {string} remoteUrl 视频下载地址。
 * @param {string} authenticatedOrigin 允许携带认证信息的实际上游来源。
 * @param {string} apiKey 上游 API Key。
 * @returns {Record<string, string>} 安全的视频下载请求头。
 */
function getVideoDownloadHeaders(remoteUrl, authenticatedOrigin, apiKey) {
  return new URL(remoteUrl).origin === authenticatedOrigin ? { Authorization: `Bearer ${apiKey}` } : {};
}

/**
 * 将内部清晰度数值转换为上游视频协议使用的字符串。
 * @param {number} resolution 视频垂直清晰度数值，2160 代表 4K。
 * @returns {string} 4K 返回 4k，其余清晰度返回带 p 后缀的字符串。
 */
function formatVideoResolution(resolution) {
  return resolution === 2160 ? '4k' : `${resolution}p`;
}

/**
 * 根据协议构造视频创建请求。
 * @param {'new-api' | 'openai' | 'xai' | 'legacy-openai-video'} protocol 视频协议。
 * @param {string} apiKey 上游 API Key。
 * @param {{ model: string, prompt: string, resolution: number, size: string, aspectRatio: string, seconds: number }} request 工作台生成参数。
 * @param {{ images: Array<{ filename: string, mimeType: string, buffer: Buffer }>, videos: Array<{ filename: string, mimeType: string, buffer: Buffer }>, audios: Array<{ filename: string, mimeType: string, buffer: Buffer }> }} files 参考附件集合。
 * @returns {{ path: string, init: { method: string, headers: Record<string, string>, body: string | FormData } }} 上游路径和 fetch 参数。
 */
function createVideoRequest(protocol, apiKey, request, files) {
  const authorization = { Authorization: `Bearer ${apiKey}` };
  const images = files.images || [];
  const videos = files.videos || [];
  const audios = files.audios || [];
  const image = images[0];
  if (protocol === 'openai') {
    const body = new FormData();
    body.append('model', request.model);
    body.append('prompt', request.prompt);
    body.append('seconds', String(request.seconds));
    if (request.size !== 'auto') body.append('size', request.size);
    body.append('resolution', formatVideoResolution(request.resolution));
    if (image) body.append('input_reference', new Blob([image.buffer], { type: image.mimeType }), image.filename);
    appendMediaFiles(body, 'reference_images', images.slice(1));
    appendMediaFiles(body, 'reference_videos', videos);
    appendMediaFiles(body, 'reference_audios', audios);
    return { path: '/v1/videos', init: { method: 'POST', headers: authorization, body } };
  }

  if (protocol === 'legacy-openai-video') {
    const common = { model: request.model, prompt: request.prompt, resolution: request.resolution, size: request.size, seconds: request.seconds };
    if (images.length > 0 || videos.length > 0 || audios.length > 0) {
      const body = new FormData();
      for (const [key, value] of Object.entries(common)) body.append(key, String(value));
      appendMediaFiles(body, 'reference_images', images);
      appendMediaFiles(body, 'reference_videos', videos);
      appendMediaFiles(body, 'reference_audios', audios);
      return { path: '/v1/videos/generations', init: { method: 'POST', headers: authorization, body } };
    }
    return { path: '/v1/videos/generations', init: { method: 'POST', headers: { ...authorization, 'Content-Type': 'application/json' }, body: JSON.stringify(common) } };
  }

  if (protocol === 'new-api') {
    const imageDataUrls = images.map(toMediaDataUrl);
    const referenceVideos = videos.map(toMediaDataUrl);
    const referenceAudios = audios.map(toMediaDataUrl);
    const metadata = {
      resolution: formatVideoResolution(request.resolution),
    };
    if (referenceVideos.length > 0) metadata.reference_videos = referenceVideos;
    if (referenceAudios.length > 0) metadata.reference_audios = referenceAudios;
    const payload = {
      model: request.model,
      prompt: request.prompt,
      duration: request.seconds,
      seconds: String(request.seconds),
      metadata,
    };
    if (request.size !== 'auto') payload.size = request.size;
    if (imageDataUrls.length > 0) {
      payload.image = imageDataUrls[0];
      payload.images = imageDataUrls;
    }
    return {
      path: '/v1/video/generations',
      init: { method: 'POST', headers: { ...authorization, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) },
    };
  }

  const payload = { model: request.model, prompt: request.prompt, duration: request.seconds, resolution: formatVideoResolution(request.resolution), aspect_ratio: request.aspectRatio };
  const imageDataUrl = toMediaDataUrl(image);
  if (imageDataUrl) payload.image = imageDataUrl;
  return {
    path: '/v1/videos/generations',
    init: { method: 'POST', headers: { ...authorization, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) },
  };
}

/**
 * 从不同协议的创建响应中读取任务标识。
 * @param {'new-api' | 'openai' | 'xai' | 'legacy-openai-video'} protocol 视频协议。
 * @param {Record<string, unknown> | null} data 上游 JSON 响应。
 * @returns {string} 上游任务标识；缺失时返回空字符串。
 */
function getCreatedVideoTaskId(protocol, data) {
  const nativeField = protocol === 'new-api' ? 'task_id' : protocol === 'xai' ? 'request_id' : 'id';
  const candidateFields = [nativeField, ...['id', 'request_id', 'task_id'].filter(field => field !== nativeField)];
  for (const field of candidateFields) {
    const value = data?.[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/**
 * 返回指定协议的任务查询路径。
 * @param {'new-api' | 'openai' | 'xai' | 'legacy-openai-video'} protocol 视频协议。
 * @param {string} taskId 上游任务标识。
 * @returns {string} 已编码任务标识的查询路径。
 */
function getVideoPollPath(protocol, taskId) {
  const encoded = encodeURIComponent(taskId);
  return protocol === 'new-api' ? `/v1/video/generations/${encoded}` : `/v1/videos/${encoded}`;
}

/**
 * 将上游视频结果地址解析为可供服务端下载的绝对 HTTP(S) 地址。
 *
 * 上游兼容服务可能返回完整 URL，也可能只返回以 /v1 开头的站内路径，
 * 甚至返回不带开头斜杠的相对路径。完整 URL 保持原样；路径形式统一基于
 * 配置的 Base URL 解析，避免把相对路径直接传给 Node.js 的 URL 构造器。
 *
 * @param {string} remoteUrl 上游返回的视频地址。
 * @param {string} baseUrl 用户配置并已规范化的上游基础地址。
 * @returns {string} 可供 fetch 使用的绝对视频地址。
 */
function resolveVideoRemoteUrl(remoteUrl, baseUrl) {
  const value = String(remoteUrl || '').trim();
  if (!value) return '';

  try {
    return new URL(value).toString();
  } catch {
    const base = new URL(String(baseUrl || '').trim());
    const path = value.startsWith('/') ? value : `/${value}`;
    return new URL(path, base.origin).toString();
  }
}

/**
 * 规范化三种协议的任务状态与结果下载地址。
 * @param {'new-api' | 'openai' | 'xai' | 'legacy-openai-video'} protocol 视频协议。
 * @param {Record<string, any>} data 上游任务响应。
 * @param {string} baseUrl 已规范化的上游基础地址。
 * @param {string} taskId 上游任务标识。
 * @returns {{ state: 'pending' | 'completed' | 'failed' | 'invalid', remoteUrl?: string }} 统一任务状态。
 */
function normalizeVideoPollResult(protocol, data, baseUrl, taskId) {
  const status = String(data?.status || '').toLowerCase();
  if (['failed', 'cancelled', 'expired'].includes(status)) return { state: 'failed' };

  // 不论请求协议为何，优先识别第三方兼容服务常见的两种直接结果地址。
  const remoteUrl = [data?.video?.url, data?.url].find(value => typeof value === 'string' && value.trim());
  if (remoteUrl) return { state: 'completed', remoteUrl: resolveVideoRemoteUrl(remoteUrl, baseUrl) };

  // OpenAI 官方完成态不返回结果 URL，需要通过同一任务的 content 端点下载。
  if (status === 'completed' && protocol === 'openai') {
    return { state: 'completed', remoteUrl: appendVideoApiPath(baseUrl, `/v1/videos/${encodeURIComponent(taskId)}/content`) };
  }
  if (status === 'completed') return { state: 'invalid' };
  return { state: 'pending' };
}

module.exports = {
  createVideoRequest,
  formatVideoResolution,
  getCreatedVideoTaskId,
  getVideoDownloadHeaders,
  getVideoPollPath,
  isVideoProtocol,
  normalizeVideoPollResult,
  resolveVideoRemoteUrl,
};
