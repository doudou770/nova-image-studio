import { describe, expect, it } from 'vitest';
import {
  getCleanUrlAfterExternalModelConfig,
  getExternalImageModelMatch,
  getExternalTextModelMatch,
  getExternalVideoModelMatch,
  parseExternalModelConfig,
} from '@/lib/external-model-config';
import type { ImageModelConfig, TextModelConfig, VideoModelConfig } from '@/lib/flyreq-models';

describe('external model config URL parser', () => {
  it('parses image model config from a single provider JSON parameter', () => {
    const provider = encodeURIComponent(JSON.stringify({
      type: 'image',
      preset: 'gpt-image-2',
      provider: 'openai',
      modelKey: 'flyreq-gpt-image-2',
      name: 'FlyReq',
      modelId: 'gpt-image-2',
      baseUrl: 'https://flyreq.com',
      apiKey: 'json-key',
      maxRefImages: 16,
      maxOutputSize: '4K',
    }));
    const url = new URL(`https://example.com/zh/?provider=${provider}`);

    expect(parseExternalModelConfig(url)).toMatchObject({
      type: 'image',
      preset: 'gpt-image-2',
      protocol: 'openai',
      modelKey: 'flyreq-gpt-image-2',
      name: 'FlyReq',
      modelId: 'gpt-image-2',
      baseUrl: 'https://flyreq.com',
      apiKey: 'json-key',
      maxRefImages: 16,
      maxOutputSize: '4K',
    });
  });

  it('also accepts raw JSON in the provider parameter', () => {
    const url = new URL('https://example.com/zh/?provider={"type":"image","preset":"gpt-image-2","provider":"openai","name":"FlyReq","modelId":"gpt-image-2","baseUrl":"https://flyreq.com","apiKey":"raw-key"}');

    expect(parseExternalModelConfig(url)).toMatchObject({
      type: 'image',
      preset: 'gpt-image-2',
      protocol: 'openai',
      name: 'FlyReq',
      modelId: 'gpt-image-2',
      baseUrl: 'https://flyreq.com',
      apiKey: 'raw-key',
    });
  });

  it('parses Gemini temperature capability and the Lite preset from a provider URL', () => {
    const provider = encodeURIComponent(JSON.stringify({
      type: 'image',
      preset: 'gemini-3.1-flash-lite-image',
      provider: 'google',
      modelId: 'gemini-3.1-flash-lite-image',
      supportsTemperature: false,
    }));
    const url = new URL(`https://example.com/zh/?provider=${provider}`);

    expect(parseExternalModelConfig(url)).toMatchObject({
      preset: 'gemini-3.1-flash-lite-image',
      protocol: 'google',
      supportsTemperature: false,
    });
  });

  it('parses text and video model configs from provider JSON', () => {
    const textUrl = new URL(`https://example.com/en/?provider=${encodeURIComponent(JSON.stringify({
      type: 'text', provider: 'google', modelKey: 'text-one', name: 'Gemini', modelId: 'gemini-2.5-flash', baseUrl: 'https://text.example.com', apiKey: 'text-key', note: 'Gemini protocol',
    }))}`);
    const videoUrl = new URL(`https://example.com/en/?provider=${encodeURIComponent(JSON.stringify({
      type: 'video', provider: 'openai', modelKey: 'video-one', name: 'Video', modelId: 'grok-imagine-video', baseUrl: 'https://video.example.com', apiKey: 'video-key',
    }))}`);

    expect(parseExternalModelConfig(textUrl)).toMatchObject({ type: 'text', protocol: 'google', modelKey: 'text-one', note: 'Gemini protocol' });
    expect(parseExternalModelConfig(videoUrl)).toMatchObject({ type: 'video', protocol: 'openai', modelKey: 'video-one', modelId: 'grok-imagine-video' });
  });

  it('accepts New API and xAI video protocols from external links', () => {
    const newApiUrl = new URL('https://example.com/?configureModel=1&type=video&protocol=new-api&name=NewAPI&modelId=video-model&baseUrl=https%3A%2F%2Fnewapi.example.com');
    const xaiUrl = new URL(`https://example.com/?provider=${encodeURIComponent(JSON.stringify({ type: 'video', protocol: 'xai', name: 'xAI', modelId: 'grok-imagine-video' }))}`);

    expect(parseExternalModelConfig(newApiUrl)).toMatchObject({ type: 'video', protocol: 'new-api' });
    expect(parseExternalModelConfig(xaiUrl)).toMatchObject({ type: 'video', protocol: 'xai' });
  });

  it('仅在显式 protocol 字段中启用新的 OpenAI Videos 协议', () => {
    const legacyUrl = new URL(`https://example.com/?provider=${encodeURIComponent(JSON.stringify({
      type: 'video', provider: 'openai', modelId: 'grok-imagine-video',
    }))}`);
    const soraUrl = new URL(`https://example.com/?provider=${encodeURIComponent(JSON.stringify({
      type: 'video', protocol: 'openai', modelId: 'sora-2',
    }))}`);

    expect(parseExternalModelConfig(legacyUrl)).toMatchObject({ type: 'video', protocol: 'openai' });
    expect(parseExternalModelConfig(soraUrl)).toMatchObject({ type: 'video', protocol: 'openai' });
  });

  it('removes external config params and hash from URL', () => {
    const provider = encodeURIComponent(JSON.stringify({ type: 'image', name: 'FlyReq', apiKey: 'secret' }));
    const url = new URL(`https://example.com/zh/?provider=${provider}&keep=1#debug`);

    expect(getCleanUrlAfterExternalModelConfig(url)).toBe('/zh/?keep=1');
  });

  it('keeps legacy multi-param URLs parseable', () => {
    const url = new URL('https://example.com/zh/?configureModel=1&type=image&preset=gpt-image-2&protocol=openai&name=FlyReq&modelId=gpt-image-2&baseUrl=https%3A%2F%2Fflyreq.com&apiKey=query-key&maxRefImages=16&maxOutputSize=4K');

    expect(parseExternalModelConfig(url)).toMatchObject({
      type: 'image',
      protocol: 'openai',
      apiKey: 'query-key',
      maxOutputSize: '4K',
    });
    expect(getCleanUrlAfterExternalModelConfig(url)).toBe('/zh/');
  });

  it('matches existing image model by stable key or signature', () => {
    const models: ImageModelConfig[] = [{
      id: 'flyreq-gpt-image-2',
      protocol: 'openai',
      name: 'FlyReq',
      modelId: 'gpt-image-2',
      apiKey: '',
      baseUrl: 'https://flyreq.com/',
      builtinPreset: 'gpt-image-2',
      maxRefImages: 16,
      maxOutputSize: '4K',
      supportsAdvancedParams: true,
    }];

    expect(getExternalImageModelMatch(models, {
      type: 'image',
      name: 'FlyReq',
      modelId: 'gpt-image-2',
      baseUrl: 'https://flyreq.com',
    })?.id).toBe('flyreq-gpt-image-2');
  });

  it('matches existing text and video models by stable key or signature', () => {
    const textModels: TextModelConfig[] = [{ id: 'text-one', protocol: 'openai', name: 'Text One', modelId: 'gpt-5.4-mini', apiKey: '', baseUrl: 'https://text.example.com' }];
    const videoModels: VideoModelConfig[] = [{ id: 'video-one', protocol: 'openai', name: 'Video One', modelId: '', usesPresetModelId: true, presetModelId: 'grok-imagine-video', apiKey: '', baseUrl: 'https://video.example.com' }];

    expect(getExternalTextModelMatch(textModels, { type: 'text', name: 'Text One', modelId: 'gpt-5.4-mini', baseUrl: 'https://text.example.com/' })?.id).toBe('text-one');
    expect(getExternalVideoModelMatch(videoModels, { type: 'video', name: 'Video One', modelId: 'grok-imagine-video', baseUrl: 'https://video.example.com/' })?.id).toBe('video-one');
  });

  it('requires the video protocol to match when using a model signature', () => {
    const videoModels: VideoModelConfig[] = [{ id: 'video-one', protocol: 'openai', name: 'Video One', modelId: 'grok-imagine-video', apiKey: '', baseUrl: 'https://video.example.com' }];
    const signature = { type: 'video' as const, name: 'Video One', modelId: 'grok-imagine-video', baseUrl: 'https://video.example.com/' };

    expect(getExternalVideoModelMatch(videoModels, { ...signature, protocol: 'openai' })?.id).toBe('video-one');
    expect(getExternalVideoModelMatch(videoModels, { ...signature, protocol: 'xai' })).toBeUndefined();
    expect(getExternalVideoModelMatch(videoModels, { ...signature, modelKey: 'video-one', protocol: 'xai' })?.id).toBe('video-one');
  });
});
