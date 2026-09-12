import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '@/components/LanguageProvider';
import { patchTextModelProtocol, patchVideoModelProtocol, SettingsModal } from '@/components/SettingsModal';
import { getCompleteTextModels, loadRegistry, saveRegistry } from '@/lib/flyreq-models';
import { applyVideoProtocolConfig, getVideoProtocolConfig } from '@/lib/video-config';

/**
 * 使用英文环境渲染设置弹窗，便于验证新增多语言交互文案。
 * @param onClose 弹窗请求关闭时调用的监听函数。
 * @returns 测试渲染结果。
 */
function renderSettings(onClose = vi.fn()) {
  return render(
    <LanguageProvider initialLocale="en">
      <SettingsModal isOpen onClose={onClose} />
    </LanguageProvider>,
  );
}

describe('SettingsModal unsaved configuration', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('flyreq-locale', 'en');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    }));
  });

  afterEach(() => {
    applyVideoProtocolConfig();
  });

  it('does not show the follow-along save bar before an actual edit', async () => {
    renderSettings();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Save now' })).toBeDisabled());
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
  });

  it('selects the current default image, video, and text models when settings open', async () => {
    localStorage.setItem('flyreq-model-registry', JSON.stringify({
      schemaVersion: 2,
      imageModels: [
        { id: 'image-first', protocol: 'openai', name: 'Image First', modelId: 'image-1', apiKey: 'key', baseUrl: 'https://image-1.example.com', builtinPreset: 'gpt-image-2', maxRefImages: 1, maxOutputSize: '1K' },
        { id: 'image-default', protocol: 'openai', name: 'Image Default', modelId: 'image-2', apiKey: 'key', baseUrl: 'https://image-2.example.com', builtinPreset: 'gpt-image-2', maxRefImages: 1, maxOutputSize: '1K' },
      ],
      videoModels: [
        { id: 'video-first', protocol: 'openai', name: 'Video First', modelId: 'video-1', apiKey: 'key', baseUrl: 'https://video-1.example.com' },
        { id: 'video-default', protocol: 'openai', name: 'Video Default', modelId: 'video-2', apiKey: 'key', baseUrl: 'https://video-2.example.com' },
      ],
      textModels: [
        { id: 'text-first', protocol: 'openai', name: 'Text First', modelId: 'text-1', apiKey: 'key', baseUrl: 'https://text-1.example.com' },
        { id: 'text-default', protocol: 'openai', name: 'Text Default', modelId: 'text-2', apiKey: 'key', baseUrl: 'https://text-2.example.com' },
      ],
      defaults: {
        textToImage: 'image-default',
        imageToImage: 'image-default',
        videoGeneration: 'video-default',
        reversePrompt: 'text-default',
        agent: 'text-default',
        promptOptimize: 'text-default',
        imageDescribe: 'text-default',
      },
    }));

    renderSettings();

    expect(await screen.findByDisplayValue('Image Default')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Video Default')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Text Default')).toBeInTheDocument();
    expect(screen.queryByText('Current default')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument());
  });

  it('preserves user-entered model content when changing video or text protocol', () => {
    const videoModel = {
      id: 'video-custom',
      protocol: 'openai' as const,
      name: 'Custom Video',
      modelId: 'custom-video-id',
      apiKey: 'video-key',
      baseUrl: 'https://custom-video.example.com',
    };
    expect(patchVideoModelProtocol(videoModel, 'new-api')).toEqual(expect.objectContaining({
      protocol: 'new-api',
      name: 'Custom Video',
      modelId: 'custom-video-id',
      apiKey: 'video-key',
      baseUrl: 'https://custom-video.example.com',
    }));

    const textModel = {
      id: 'text-custom',
      protocol: 'openai' as const,
      name: 'Custom Text',
      modelId: 'custom-text-id',
      apiKey: 'text-key',
      baseUrl: 'https://custom-text.example.com',
      note: 'Custom note',
    };
    expect(patchTextModelProtocol(textModel, 'google')).toEqual({ ...textModel, protocol: 'google' });
  });

  it('renders the complete settings navigation and model sections in English', async () => {
    renderSettings();

    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Models' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Backup' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'About' })).toBeInTheDocument();
    expect(screen.getByText('Image models')).toBeInTheDocument();
    expect(screen.getByText('Text models')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Show or hide API Key' }).length).toBeGreaterThan(0);
  });

  it('fetches remote models securely and selects cached models through the filter combobox', async () => {
    localStorage.setItem('flyreq-model-registry', JSON.stringify({
      schemaVersion: 2,
      imageModels: [{ id: 'image-model', protocol: 'openai', name: 'Image', modelId: 'custom-image', apiKey: 'image-key', baseUrl: 'https://image.example.com', builtinPreset: 'gpt-image-2', maxRefImages: 1, maxOutputSize: '1K' }],
      videoModels: [{ id: 'video-model', protocol: 'new-api', name: 'Video', modelId: 'video-id', apiKey: 'video-key', baseUrl: 'https://video.example.com' }],
      textModels: [{ id: 'text-model', protocol: 'openai', name: 'Text', modelId: 'text-id', apiKey: 'text-key', baseUrl: 'https://text.example.com' }],
      defaults: { textToImage: 'image-model', imageToImage: 'image-model', videoGeneration: 'video-model', reversePrompt: 'text-model', agent: 'text-model', promptOptimize: 'text-model', imageDescribe: 'text-model' },
    }));
    const fetchMock = vi.fn().mockImplementation(async (input: string, init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => input === '/api/flyreq/proxy/models'
        ? { data: [{ id: 'image-fetched', name: 'Fetched Image' }] }
        : {},
      requestInit: init,
    }));
    vi.stubGlobal('fetch', fetchMock);

    renderSettings();

    const fetchButtons = await screen.findAllByRole('button', { name: 'Fetch models' });
    expect(fetchButtons).toHaveLength(3);
    const modelIdInputs = screen.getAllByRole('combobox', { name: 'Model ID' });
    expect(modelIdInputs).toHaveLength(3);
    const imageModelIdInput = modelIdInputs[0];
    expect(imageModelIdInput).toHaveValue('custom-image');
    expect(modelIdInputs[1]).toHaveValue('video-id');
    expect(modelIdInputs[2]).toHaveValue('text-id');
    expect(imageModelIdInput.parentElement?.parentElement?.parentElement).toContainElement(fetchButtons[0]);
    fireEvent.click(fetchButtons[0]);

    expect(await screen.findByText('1 models fetched. Filter the list and select a model.')).toBeInTheDocument();
    const modelRequest = fetchMock.mock.calls.find(([input]) => input === '/api/flyreq/proxy/models');
    expect(modelRequest?.[1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(modelRequest?.[1]?.body))).toEqual({
      baseUrl: 'https://image.example.com',
      apiKey: 'image-key',
      protocol: 'openai',
    });

    const selectedInput = screen.getAllByRole('combobox', { name: 'Model ID' })[0];
    fireEvent.click(screen.getAllByRole('button', { name: 'Model ID' })[0]);
    const fetchedOption = await screen.findByText('Fetched Image (image-fetched)');
    fireEvent.click(fetchedOption);
    expect(selectedInput).toHaveValue('Fetched Image (image-fetched)');
    expect(document.querySelector<HTMLInputElement>('#model-catalog-image-model-hidden-input')).toHaveValue('image-fetched');
  });

  it('shows the save bar after editing and commits the configuration', async () => {
    renderSettings();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save now' })).toBeDisabled());

    const apiKeyInput = document.querySelector<HTMLInputElement>('input[type="password"]');
    expect(apiKeyInput).not.toBeNull();
    fireEvent.change(apiKeyInput!, { target: { value: 'saved-image-key' } });

    expect(await screen.findByText('Unsaved changes')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }));

    expect(await screen.findByText('Configuration saved')).toBeInTheDocument();
    expect(loadRegistry().imageModels[0].apiKey).toBe('saved-image-key');
  });

  it('offers all three choices when closing with unsaved changes', async () => {
    const onClose = vi.fn();
    renderSettings(onClose);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save now' })).toBeDisabled());

    const apiKeyInput = document.querySelector<HTMLInputElement>('input[type="password"]');
    fireEvent.change(apiKeyInput!, { target: { value: 'pending-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save and close' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue editing' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Discard changes' })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Continue editing' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('discards the draft without changing persistent configuration', async () => {
    const onClose = vi.fn();
    renderSettings(onClose);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save now' })).toBeDisabled());

    const apiKeyInput = document.querySelector<HTMLInputElement>('input[type="password"]');
    fireEvent.change(apiKeyInput!, { target: { value: 'discarded-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Discard changes' }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(loadRegistry().imageModels[0].apiKey).toBe('');
  });

  it('saves the draft before closing when requested', async () => {
    const onClose = vi.fn();
    renderSettings(onClose);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save now' })).toBeDisabled());

    const apiKeyInput = document.querySelector<HTMLInputElement>('input[type="password"]');
    fireEvent.change(apiKeyInput!, { target: { value: 'save-and-close-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save and close' }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(loadRegistry().imageModels[0].apiKey).toBe('save-and-close-key');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save now' })).toBeDisabled());
  });

  it('marks configuration imported from an external link as unsaved', async () => {
    const onConsumed = vi.fn();
    render(
      <LanguageProvider initialLocale="en">
        <SettingsModal
          isOpen
          onClose={vi.fn()}
          externalModelConfig={{
            type: 'image',
            modelKey: 'external-image-model',
            preset: 'gpt-image-2',
            name: 'External image model',
            apiKey: 'external-key',
          }}
          onExternalModelConfigConsumed={onConsumed}
        />
      </LanguageProvider>,
    );

    expect(await screen.findByText('Unsaved changes')).toBeInTheDocument();
    expect(screen.getByText('Image model configuration was imported from the external link and set as the image defaults. Save the configuration to apply it.')).toBeInTheDocument();
    expect(onConsumed).toHaveBeenCalledOnce();
  });

  it('keeps an incomplete external model selected as the pending default', async () => {
    const registry = loadRegistry();
    registry.imageModels[0].apiKey = 'existing-key';
    registry.defaults.textToImage = registry.imageModels[0].id;
    registry.defaults.imageToImage = registry.imageModels[0].id;
    saveRegistry(registry);

    render(
      <LanguageProvider initialLocale="en">
        <SettingsModal
          isOpen
          onClose={vi.fn()}
          externalModelConfig={{
            type: 'image',
            modelKey: 'pending-external-model',
            preset: 'gpt-image-2',
            name: 'Pending external model',
          }}
          onExternalModelConfigConsumed={vi.fn()}
        />
      </LanguageProvider>,
    );

    expect(await screen.findByText('Unsaved changes')).toBeInTheDocument();
    const imageApiKeyInput = document.querySelectorAll<HTMLInputElement>('input[type="password"]')[0];
    fireEvent.change(imageApiKeyInput, { target: { value: 'external-completed-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }));

    await waitFor(() => {
      const saved = loadRegistry();
      expect(saved.defaults.textToImage).toBe('pending-external-model');
      expect(saved.defaults.imageToImage).toBe('pending-external-model');
    });
  });

  it('imports a complete external text model and assigns all text defaults', async () => {
    render(
      <LanguageProvider initialLocale="en">
        <SettingsModal
          isOpen
          onClose={vi.fn()}
          externalModelConfig={{
            type: 'text',
            protocol: 'openai',
            modelKey: 'external-text-model',
            name: 'External text model',
            modelId: 'gpt-5.4-mini',
            baseUrl: 'https://text.example.com',
            apiKey: 'text-key',
          }}
          onExternalModelConfigConsumed={vi.fn()}
        />
      </LanguageProvider>,
    );

    expect(await screen.findByText('Text model configuration was imported from the external link and set as the text defaults. Save the configuration to apply it.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }));
    await waitFor(() => {
      const saved = loadRegistry();
      expect(saved.textModels.some(model => model.id === 'external-text-model')).toBe(true);
      expect(saved.defaults).toMatchObject({
        reversePrompt: 'external-text-model',
        agent: 'external-text-model',
        promptOptimize: 'external-text-model',
        imageDescribe: 'external-text-model',
      });
    });
  });

  it('imports a complete external video model and assigns the video default', async () => {
    render(
      <LanguageProvider initialLocale="en">
        <SettingsModal
          isOpen
          onClose={vi.fn()}
          externalModelConfig={{
            type: 'video',
            protocol: 'openai',
            modelKey: 'external-video-model',
            name: 'External video model',
            modelId: 'sora-2',
            baseUrl: 'https://video.example.com',
            apiKey: 'video-key',
          }}
          onExternalModelConfigConsumed={vi.fn()}
        />
      </LanguageProvider>,
    );

    expect(await screen.findByText('Video model configuration was imported from the external link and set as the video default. Save the configuration to apply it.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }));
    await waitFor(() => {
      const saved = loadRegistry();
      expect(saved.videoModels.some(model => model.id === 'external-video-model')).toBe(true);
      expect(saved.defaults.videoGeneration).toBe('external-video-model');
    });
  });

  it('persists incomplete text models as inactive drafts', async () => {
    renderSettings();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save now' })).toBeDisabled());

    fireEvent.click(screen.getByRole('button', { name: 'Add text model' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save configuration' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Save now' })).toBeDisabled());

    const registry = loadRegistry();
    expect(registry.textModels).toHaveLength(1);
    expect(getCompleteTextModels(registry)).toHaveLength(0);
    expect(registry.defaults.promptOptimize).toBe('');
  });

  it('creates OpenAI video drafts with the Sora protocol template', async () => {
    renderSettings();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save now' })).toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Add video model' }));

    expect(await screen.findByPlaceholderText('sora-2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }));
    await waitFor(() => expect(loadRegistry().videoModels).toEqual(expect.arrayContaining([
      expect.objectContaining({ protocol: 'openai', presetModelId: 'sora-2', baseUrl: 'https://api.openai.com' }),
    ])));
  });

  it('shows the exact create endpoint and New API resolution behavior for the selected video protocol', async () => {
    const registry = loadRegistry();
    registry.videoModels[0] = {
      ...registry.videoModels[0],
      protocol: 'new-api',
      presetModelId: '',
      baseUrl: 'https://video.example.com',
    };
    saveRegistry(registry);
    renderSettings();

    expect(await screen.findByText('POST /v1/video/generations')).toBeInTheDocument();
    expect(screen.getByText('New API sends clarity through metadata.resolution and output dimensions through size.')).toBeInTheDocument();
  });

  it('opens settings with a deterministic endpoint fallback for old runtime protocol config', async () => {
    const oldConfig = structuredClone(getVideoProtocolConfig());
    delete oldConfig.protocols.openai.createEndpoint;
    applyVideoProtocolConfig(oldConfig);

    renderSettings();

    expect(await screen.findByText('POST /v1/videos')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
  });


});
