import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const loadCommonJs = createRequire(import.meta.url);
const {
  createVideoRequest,
  getCreatedVideoTaskId,
  getVideoDownloadHeaders,
  getVideoPollPath,
  normalizeVideoPollResult,
  resolveVideoRemoteUrl,
} = loadCommonJs(path.resolve(testDir, '../../../../backend/video-protocols.js'));

const request = {
  model: 'video-model',
  prompt: 'A camera move',
  resolution: 720,
  size: '1280x720',
  aspectRatio: '16:9',
  seconds: 8,
};
const files = {
  images: [{ filename: 'reference.png', mimeType: 'image/png', buffer: Buffer.from('image') }],
  videos: [{ filename: 'reference.mp4', mimeType: 'video/mp4', buffer: Buffer.from('video') }],
  audios: [{ filename: 'reference.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('audio') }],
};

describe('视频协议适配器', () => {
  it('构造 New API JSON 请求并识别 task_id', () => {
    const upstream = createVideoRequest('new-api', 'key', request, files);
    expect(upstream.path).toBe('/v1/video/generations');
    expect(upstream.init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(upstream.init.body)).toEqual(expect.objectContaining({
      model: 'video-model',
      prompt: 'A camera move',
      duration: 8,
      seconds: '8',
      size: '1280x720',
      image: expect.stringMatching(/^data:image\/png;base64,/),
      images: [expect.stringMatching(/^data:image\/png;base64,/)],
      metadata: expect.objectContaining({
        resolution: '720p',
        reference_videos: [expect.stringMatching(/^data:video\/mp4;base64,/)],
        reference_audios: [expect.stringMatching(/^data:audio\/mpeg;base64,/)],
      }),
    }));
    expect(getCreatedVideoTaskId('new-api', { task_id: 'task-new' })).toBe('task-new');
    expect(getVideoPollPath('new-api', 'task/new')).toBe('/v1/video/generations/task%2Fnew');
    expect(normalizeVideoPollResult('new-api', { status: 'completed', url: 'https://cdn.example/video.mp4' }, 'https://api.example', 'task-new')).toEqual({ state: 'completed', remoteUrl: 'https://cdn.example/video.mp4' });
  });

  it('构造 OpenAI Videos multipart 请求并使用 content 端点下载', () => {
    const upstream = createVideoRequest('openai', 'key', request, files);
    expect(upstream.path).toBe('/v1/videos');
    expect(upstream.init.body).toBeInstanceOf(FormData);
    expect(upstream.init.body.get('model')).toBe('video-model');
    expect(upstream.init.body.get('input_reference')).toBeInstanceOf(Blob);
    expect(upstream.init.body.get('resolution')).toBe('720p');
    expect(upstream.init.body.has('reference_images')).toBe(false);
    expect(upstream.init.body.getAll('reference_videos')).toHaveLength(1);
    expect(upstream.init.body.getAll('reference_audios')).toHaveLength(1);
    expect(getCreatedVideoTaskId('openai', { id: 'video-openai' })).toBe('video-openai');
    expect(normalizeVideoPollResult('openai', { status: 'completed' }, 'https://api.openai.com', 'video-openai')).toEqual({
      state: 'completed',
      remoteUrl: 'https://api.openai.com/v1/videos/video-openai/content',
    });
    expect(normalizeVideoPollResult('openai', { status: 'completed' }, 'https://api.openai.com/v1', 'video-openai')).toEqual({
      state: 'completed',
      remoteUrl: 'https://api.openai.com/v1/videos/video-openai/content',
    });
    expect(getVideoDownloadHeaders('http://internal-api:3000/v1/videos/video-openai/content', 'http://internal-api:3000', 'secret')).toEqual({ Authorization: 'Bearer secret' });
    expect(getVideoDownloadHeaders('https://cdn.example/video.mp4', 'http://internal-api:3000', 'secret')).toEqual({});
  });

  it('构造 OpenAI 多参考图请求时不会重复发送首张图片', () => {
    const multipleImages = [
      files.images[0],
      { filename: 'reference-2.png', mimeType: 'image/png', buffer: Buffer.from('image-2') },
      { filename: 'reference-3.png', mimeType: 'image/png', buffer: Buffer.from('image-3') },
    ];
    const upstream = createVideoRequest('openai', 'key', request, { ...files, images: multipleImages });

    expect(upstream.init.body.getAll('input_reference')).toHaveLength(1);
    expect(upstream.init.body.getAll('reference_images')).toHaveLength(2);
  });

  it('创建响应按协议原生字段优先并兼容三种任务标识', () => {
    expect(getCreatedVideoTaskId('openai', { request_id: 'request-openai' })).toBe('request-openai');
    expect(getCreatedVideoTaskId('xai', { id: 'video-xai' })).toBe('video-xai');
    expect(getCreatedVideoTaskId('new-api', { id: 'video-new-api' })).toBe('video-new-api');
    expect(getCreatedVideoTaskId('legacy-openai-video', { task_id: 'task-legacy' })).toBe('task-legacy');
    expect(getCreatedVideoTaskId('openai', { id: 'native-id', request_id: 'compatible-id' })).toBe('native-id');
    expect(getCreatedVideoTaskId('xai', { request_id: 'native-id', id: 'compatible-id' })).toBe('native-id');
    expect(getCreatedVideoTaskId('new-api', { task_id: 'native-id', id: 'compatible-id' })).toBe('native-id');
    expect(getCreatedVideoTaskId('openai', { id: '   ' })).toBe('');
  });

  it('将上游返回的绝对、根相对和普通相对视频地址统一解析为绝对地址', () => {
    expect(resolveVideoRemoteUrl('https://cdn.example/video.mp4', 'https://api.example/v1')).toBe('https://cdn.example/video.mp4');
    expect(resolveVideoRemoteUrl('/v1/videos/task/content', 'https://api.example/v1')).toBe('https://api.example/v1/videos/task/content');
    expect(normalizeVideoPollResult('xai', { status: 'done', video: { url: '/v1/videos/task/content' } }, 'https://api.example', 'task')).toEqual({
      state: 'completed',
      remoteUrl: 'https://api.example/v1/videos/task/content',
    });
  });

  it('轮询响应跨协议兼容直接视频地址并统一识别失败状态', () => {
    expect(normalizeVideoPollResult('openai', { video: { url: ' https://cdn.example/nested.mp4 ' } }, 'https://api.example', 'video-openai')).toEqual({
      state: 'completed',
      remoteUrl: 'https://cdn.example/nested.mp4',
    });
    expect(normalizeVideoPollResult('xai', { url: 'https://cdn.example/root.mp4' }, 'https://api.example', 'request-xai')).toEqual({
      state: 'completed',
      remoteUrl: 'https://cdn.example/root.mp4',
    });
    expect(normalizeVideoPollResult('new-api', { status: 'cancelled', url: 'https://cdn.example/stale.mp4' }, 'https://api.example', 'task-new')).toEqual({ state: 'failed' });
    expect(normalizeVideoPollResult('openai', { status: 'expired' }, 'https://api.example', 'video-openai')).toEqual({ state: 'failed' });
  });

  it('非 OpenAI 完成态缺少视频地址时立即标记为格式无效', () => {
    expect(normalizeVideoPollResult('xai', { status: 'completed' }, 'https://api.example', 'request-xai')).toEqual({ state: 'invalid' });
    expect(normalizeVideoPollResult('new-api', { status: 'completed' }, 'https://api.example', 'task-new')).toEqual({ state: 'invalid' });
  });

  it('将 2160 清晰度作为 4k 发送给 New API 和 OpenAI', () => {
    const request4k = { ...request, resolution: 2160 };
    const newApi = createVideoRequest('new-api', 'key', request4k, files);
    expect(JSON.parse(newApi.init.body).metadata.resolution).toBe('4k');

    const openai = createVideoRequest('openai', 'key', request4k, files);
    expect(openai.init.body.get('resolution')).toBe('4k');
  });

  it('构造 xAI JSON 请求并识别 request_id 与 video.url', () => {
    const upstream = createVideoRequest('xai', 'key', request, files);
    expect(upstream.path).toBe('/v1/videos/generations');
    expect(JSON.parse(upstream.init.body)).toEqual(expect.objectContaining({
      model: 'video-model',
      duration: 8,
      resolution: '720p',
      aspect_ratio: '16:9',
      image: expect.stringMatching(/^data:image\/png;base64,/),
    }));
    expect(getCreatedVideoTaskId('xai', { request_id: 'request-xai' })).toBe('request-xai');
    expect(getVideoPollPath('xai', 'request-xai')).toBe('/v1/videos/request-xai');
    expect(normalizeVideoPollResult('xai', { video: { url: 'https://cdn.x.ai/video.mp4' } }, 'https://api.x.ai', 'request-xai')).toEqual({ state: 'completed', remoteUrl: 'https://cdn.x.ai/video.mp4' });
  });

  it('保留旧注册表模型使用的 OpenAI 兼容生成端点', () => {
    const upstream = createVideoRequest('legacy-openai-video', 'key', request, { images: [] });
    expect(upstream.path).toBe('/v1/videos/generations');
    expect(JSON.parse(upstream.init.body)).toEqual(expect.objectContaining({
      model: 'video-model',
      resolution: 720,
      size: '1280x720',
      seconds: 8,
    }));
  });

  it('旧兼容协议不会丢弃声明支持的参考媒体', () => {
    const upstream = createVideoRequest('legacy-openai-video', 'key', request, files);
    expect(upstream.init.body).toBeInstanceOf(FormData);
    expect(upstream.init.body.getAll('reference_images')).toHaveLength(1);
    expect(upstream.init.body.getAll('reference_videos')).toHaveLength(1);
    expect(upstream.init.body.getAll('reference_audios')).toHaveLength(1);
  });
});
