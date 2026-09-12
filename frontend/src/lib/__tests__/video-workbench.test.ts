import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyDeploymentDefaultVideoModel,
  getCompleteVideoModels,
  getResolvedVideoModelId,
  loadRegistry,
  saveRegistry,
  updateRegistryDefaults,
} from '@/lib/flyreq-models';
import {
  applyVideoWorkspaceConfig,
  getVideoProtocolConfig,
  getVideoWorkspaceConfig,
  getVideoProtocolDurations,
  isValidVideoDuration,
  isValidVideoProtocolDuration,
  isValidVideoResolution,
  isValidVideoSize,
} from '@/lib/video-config';
import { composeEffectiveVideoPrompt } from '@/lib/video-prompt-variants';
import { saveVideoJobs, type StoredVideoJob } from '@/lib/video-job-store';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverSource = fs.readFileSync(path.resolve(testDir, '../../../../backend/server.js'), 'utf8');
const videoTaskClientSource = fs.readFileSync(path.resolve(testDir, '../video-task-client.ts'), 'utf8');
const videoWorkspaceSource = fs.readFileSync(path.resolve(testDir, '../../components/VideoGenerationWorkspace.tsx'), 'utf8');

describe('逐视频附加提示词', () => {
  it('将共享主提示词与当前视频要求组合成完整提示词', () => {
    expect(composeEffectiveVideoPrompt('共享场景', '俯视镜头')).toBe('共享场景\n\n本个视频要求：\n俯视镜头');
  });
});

describe('视频模型注册表与工作台配置', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    applyDeploymentDefaultVideoModel();
    applyVideoWorkspaceConfig();
  });

  it('为缺少视频模型的旧注册表补充 OpenAI 默认模型和工作流字段', () => {
    localStorage.setItem('flyreq-model-registry', JSON.stringify({ imageModels: [], textModels: [], defaults: {} }));
    const registry = loadRegistry();
    expect(registry.schemaVersion).toBe(2);
    expect(registry.videoModels[0]).toEqual(expect.objectContaining({ modelId: '', usesPresetModelId: true, presetModelId: 'sora-2', protocol: 'openai' }));
    expect(getResolvedVideoModelId(registry.videoModels[0])).toBe('sora-2');
    expect(registry.defaults).toHaveProperty('videoGeneration');
  });

  it('视频历史持久化失败时保留内存工作流且记录错误', () => {
    const storageError = new DOMException('quota exceeded', 'QuotaExceededError');
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw storageError; });
    const errorLogger = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => saveVideoJobs([])).not.toThrow();
    expect(errorLogger).toHaveBeenCalledWith('保存视频任务历史到 localStorage 失败', storageError);
  });

  it('不会把页面级视频对象 URL 写入任务历史', () => {
    saveVideoJobs([{ id: 'blob-video-job', videoUrl: 'blob:temporary-video', cached: false } as unknown as StoredVideoJob]);

    expect(JSON.parse(localStorage.getItem('flyreq-video-jobs') || '[]')).toEqual([{
      id: 'blob-video-job',
      cached: false,
    }]);
  });

  it('应用部署视频模型且仅在 API Key 完整后对工作台可用', () => {
    applyDeploymentDefaultVideoModel({ id: 'video-one', name: 'Video One', modelId: 'video-model', baseUrl: 'https://video.example.com', protocol: 'openai' });
    const registry = loadRegistry();
    expect(registry.videoModels[0].apiKey).toBe('');
    expect(registry.videoModels[0].modelId).toBe('');
    expect(registry.videoModels[0].presetModelId).toBe('video-model');
    expect(getResolvedVideoModelId(registry.videoModels[0])).toBe('video-model');
    expect(getCompleteVideoModels(registry)).toHaveLength(0);
  });

  it('保留用户填写的视频模型 ID 并覆盖预设值', () => {
    localStorage.setItem('flyreq-model-registry', JSON.stringify({
      imageModels: [],
      textModels: [],
      videoModels: [{
        id: 'video-custom',
        protocol: 'openai',
        name: 'Custom',
        modelId: 'custom-video-model',
        apiKey: 'key',
        baseUrl: 'https://video.example.com',
      }],
      defaults: { videoGeneration: 'video-custom' },
    }));
    const registry = loadRegistry();
    expect(registry.videoModels[0].modelId).toBe('custom-video-model');
    expect(registry.videoModels[0].usesPresetModelId).toBeUndefined();
    expect(getResolvedVideoModelId(registry.videoModels[0])).toBe('custom-video-model');
    expect(getCompleteVideoModels(registry)).toHaveLength(1);
  });

  it('保存空模型数组后不会重新插入部署默认模型', () => {
    const registry = loadRegistry();
    saveRegistry({
      ...registry,
      imageModels: [],
      videoModels: [],
      defaults: { ...registry.defaults, textToImage: '', imageToImage: '', videoGeneration: '' },
    });

    const reloaded = loadRegistry();
    expect(reloaded.imageModels).toEqual([]);
    expect(reloaded.videoModels).toEqual([]);
    expect(reloaded.defaults.textToImage).toBe('');
    expect(reloaded.defaults.videoGeneration).toBe('');
  });

  it('工作台选择模型后同步并广播对应的设置默认模型', () => {
    const registry = loadRegistry();
    registry.imageModels[0].apiKey = 'image-key';
    registry.videoModels[0].apiKey = 'video-key';
    registry.imageModels.push({ ...registry.imageModels[0], id: 'image-second', name: 'Image Second' });
    registry.videoModels.push({ ...registry.videoModels[0], id: 'video-second', name: 'Video Second' });
    registry.textModels = [
      { id: 'text-first', protocol: 'openai', name: 'Text First', modelId: 'gpt-5.4-mini', apiKey: 'text-key', baseUrl: 'https://text.example.com' },
      { id: 'text-second', protocol: 'openai', name: 'Text Second', modelId: 'gpt-5.4-mini', apiKey: 'text-key', baseUrl: 'https://text.example.com' },
    ];
    saveRegistry(registry);
    const listener = vi.fn();
    window.addEventListener('flyreq-model-registry-updated', listener);

    const defaults = updateRegistryDefaults({
      textToImage: 'image-second',
      videoGeneration: 'video-second',
      reversePrompt: 'text-second',
    });

    expect(defaults).toEqual(expect.objectContaining({
      textToImage: 'image-second',
      videoGeneration: 'video-second',
      reversePrompt: 'text-second',
    }));
    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener('flyreq-model-registry-updated', listener);
  });

  it('规范化参数数组并执行精确的自定义值边界校验', () => {
    applyVideoWorkspaceConfig({ maxRefImages: 7, resolutions: [1080, 720], sizes: ['1920x1080', 'bad'], durations: [5, 8] });
    expect(getVideoWorkspaceConfig()).toEqual(expect.objectContaining({ maxRefImages: 7, resolutions: [1080, 720], sizes: ['1920x1080'], durations: [5, 8] }));
    expect(isValidVideoResolution(144)).toBe(true);
    expect(isValidVideoResolution(4321)).toBe(false);
    expect(isValidVideoSize('1280x720')).toBe(true);
    expect(isValidVideoSize('63x720')).toBe(false);
    expect(isValidVideoDuration(60)).toBe(true);
    expect(isValidVideoDuration(61)).toBe(false);
    const protocols = getVideoProtocolConfig().protocols;
    expect(getVideoProtocolDurations(protocols.openai)).toEqual([4, 8, 12, 16, 20]);
    expect(getVideoProtocolDurations(protocols.xai)).toEqual([5, 10, 15]);
    expect(isValidVideoProtocolDuration(protocols.openai, 6)).toBe(true);
    expect(isValidVideoProtocolDuration(protocols.openai, 61)).toBe(false);
    expect(isValidVideoProtocolDuration(protocols.xai, 15)).toBe(true);
  });

  it('提供视频工作台的默认附件上限和 4K 清晰度', () => {
    applyVideoWorkspaceConfig();
    expect(getVideoWorkspaceConfig()).toEqual(expect.objectContaining({
      maxRefImages: 9,
      maxRefVideos: 3,
      maxRefAudios: 3,
      resolutions: [720, 480, 1080, 2160],
    }));
  });
});

describe('后端视频任务契约', () => {
  it('包含独立队列、multipart 上传、上游创建轮询和 Range 播放', () => {
    expect(serverSource).toContain("Busboy({");
    expect(serverSource).toContain("require('./video-protocols')");
    expect(serverSource).toContain('function drainVideoQueue()');
    expect(serverSource).toContain("apiPathname === '/api/flyreq/video-tasks'");
    expect(serverSource).toContain('function createVideoTaskBatch(payload, files, req)');
    expect(serverSource).toContain('function parseVideoPromptVariants(rawValue, parallelCount)');
    expect(serverSource).toContain('prompt: composeEffectiveVideoPrompt(payload.prompt, promptVariant)');
    expect(serverSource).toContain('enforceQueueCapacity(source, limitConfig, payload.parallelCount, payload.parallelCount)');
    expect(serverSource).toContain('sendJson(res, 202, { taskIds, tasks })');
    expect(serverSource).toContain('cancelVideoTask(taskId)');
    expect(serverSource).toContain('(ack|cancel)');
    expect(serverSource).toContain('videoTaskAbortControllers');
    expect(serverSource).toContain("'Accept-Ranges': 'bytes'");
  });

  it('通过环境变量下发附件限制和视频参数数组', () => {
    expect(serverSource).toContain('FLYREQ_VIDEO_MAX_REF_VIDEOS');
    expect(serverSource).toContain('FLYREQ_VIDEO_MAX_REF_AUDIOS');
    expect(serverSource).toContain('FLYREQ_VIDEO_MAX_REF_IMAGES');
    expect(serverSource).toContain('FLYREQ_VIDEO_RESOLUTIONS');
    expect(serverSource).toContain('defaultVideoModel: resolveDefaultVideoModelConfig(env)');
    expect(serverSource).toContain("protocol: 'openai'");
    expect(serverSource).toContain("modelId: 'sora-2'");
    expect(serverSource).toContain('videoWorkspace: resolveVideoWorkspaceConfig(env)');
    expect(serverSource).toContain('videoProtocols: resolveVideoProtocolConfig(env)');
    expect(serverSource).toContain('createVideoRequest(request.protocol');
    expect(serverSource).toContain('validateVideoProtocolRequest(resolveVideoProtocolConfig(getRuntimeEnv())');
  });

  it('按附件类型限制流式缓存，且全局文件限制包含参考图片', () => {
    expect(serverSource).toContain('Math.max(config.maxReferenceVideoBytes, config.maxReferenceAudioBytes, config.maxReferenceImageBytes)');
    expect(serverSource).toContain('if (size <= maxBytes)');
    expect(serverSource).toContain('if (!exceededLimit && size <= maxBytes)');
    expect(serverSource).toContain('chunks.length = 0');
  });

  it('把已取消视频任务作为 WebSocket 订阅终态清理', () => {
    expect(serverSource).toContain('function isTerminalTaskStatus(status)');
    expect(serverSource).toContain('status === TASK_STATUS.CANCELLED');
    expect(serverSource).toContain('if (isTerminalTaskStatus(cachedPayload.task.status))');
  });

  it('视频 Range 下载正确支持文件末尾后缀范围', () => {
    expect(serverSource).toContain('const suffixLength = Number(match[2])');
    expect(serverSource).toContain('start = Math.max(0, stat.size - suffixLength)');
    expect(serverSource).toContain('start === undefined || end === undefined');
  });

  it('视频先写入临时文件并在完整下载后原子改名', () => {
    expect(serverSource).toContain('const temporaryPath = `${filePath}.part`');
    expect(serverSource).toContain("fs.createWriteStream(temporaryPath, { flags: 'wx' })");
    expect(serverSource).toContain('await fs.promises.rename(temporaryPath, filePath)');
    expect(serverSource).toContain('/^[a-f0-9-]+\\.(?:mp4|webm|mov)\\.part$/i.test(name)');
    expect(serverSource).toContain("for (const ext of ['mp4', 'webm', 'mov'])");
    expect(serverSource).not.toContain('await fs.promises.rm(filePath, { force: true })');
  });

  it('记录视频上游请求与响应并提取结构化错误消息', () => {
    expect(serverSource).toContain("require('./video-upstream-logger')");
    expect(serverSource).toContain("logVideoUpstreamRequest('create'");
    expect(serverSource).toContain("logVideoUpstreamRequest('poll'");
    expect(serverSource).toContain("logVideoUpstreamRequest('download'");
    expect(serverSource).toContain("logVideoUpstreamResponse('create'");
    expect(serverSource).toContain("logVideoUpstreamResponse('poll'");
    expect(serverSource).toContain("logVideoUpstreamResponse('download'");
    expect(serverSource).toContain('taskId: trace.taskId');
    expect(serverSource).toContain('modelName: trace.modelName');
    expect(serverSource).toContain('resolution: formatVideoResolution(trace.resolution)');
    expect(serverSource).toContain('totalDurationMs: Math.max(0, Date.now() - startedAtMs)');
    expect(serverSource).toContain('logVideoTaskSummary({');
    expect(serverSource).toContain('durationMs,');
    expect(serverSource).toContain("sendJson(res, 202, { ...task, taskId })");
    expect(videoTaskClientSource).toContain("formData.set('modelName', input.model.name)");
    expect(videoWorkspaceSource).toContain('apiModelId: getResolvedVideoModelId(requestModel || selectedModel)');
    expect(serverSource).toContain('FLYREQ_VIDEO_UPSTREAM_LOG_ENABLED');
    expect(serverSource).toContain('FLYREQ_VIDEO_UPSTREAM_LOG_MAX_CHARS');
    expect(serverSource).not.toContain('logVideoUpstreamFailure');
    expect(serverSource).toContain('const extracted = getMessageFromPayload(payload)');
    expect(serverSource).not.toContain("${data?.error || responseText || '未返回任务 ID'}");
  });
});
