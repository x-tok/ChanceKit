import { Agent } from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { googleProvider } from '@earendil-works/pi-ai/providers/google';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { moonshotaiCnProvider } from '@earendil-works/pi-ai/providers/moonshotai-cn';
import { minimaxCnProvider } from '@earendil-works/pi-ai/providers/minimax-cn';
import { qwenTokenPlanCnProvider } from '@earendil-works/pi-ai/providers/qwen-token-plan-cn';
import { zaiCodingCnProvider } from '@earendil-works/pi-ai/providers/zai-coding-cn';
import { isLocalModelEndpoint, modelProviderPresets, type ModelApi, type ModelProvider, type ModelProviderEntry, type ModelTestResult } from '../../../src/model-config';
import { modelConfigInputSchema, type ModelSettingsStore, type StoredModelSettings } from './model-settings';

const catalogs = {
  openai: openaiProvider(), anthropic: anthropicProvider(), google: googleProvider(),
  deepseek: deepseekProvider(), openrouter: openrouterProvider(),
  'moonshotai-cn': moonshotaiCnProvider(), 'minimax-cn': minimaxCnProvider(),
  // Reuse pi's wire compatibility metadata, never its subscription-plan endpoints.
  qwen: qwenTokenPlanCnProvider(), zhipu: zaiCodingCnProvider(),
};
const apis = {
  'openai-completions': openAICompletionsApi,
  'openai-responses': openAIResponsesApi,
  'anthropic-messages': anthropicMessagesApi,
  'google-generative-ai': googleGenerativeAIApi,
};
export const MODEL_TEST_PROMPT = 'Reply with only OK.';

export function getModelCatalog(): ModelProviderEntry[] {
  return structuredClone(modelProviderPresets);
}

function knownModel(provider: ModelProvider, modelId: string, api: ModelApi) {
  if (provider === 'custom') return undefined;
  const id = provider === 'deepseek' && modelId === 'deepseek-flash' ? 'deepseek-v4-flash' : modelId;
  return catalogs[provider].getModels().find(model => model.id === id && model.api === api);
}

interface PiAgentOptions {
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  systemPrompt?: string;
  timeoutMs?: number;
  requireToolCall?: boolean;
}

export function createConfiguredPiAgent(settings: StoredModelSettings, options: PiAgentOptions = {}): Agent {
  const { config, apiKey } = modelConfigInputSchema.parse({ config: settings.config, apiKey: settings.apiKey });
  if (!apiKey && !isLocalModelEndpoint(config.baseUrl)) throw new Error('请填写 API Key；更换服务商、协议或 API 地址后需要重新填写。');
  const known = knownModel(config.provider, config.modelId, config.api);
  const preset = modelProviderPresets.find(provider => provider.id === config.provider)?.models
    .find(model => model.id === config.modelId && model.api === config.api);
  const model: Model<ModelApi> = {
    id: config.modelId, name: preset?.name ?? known?.name ?? config.modelId, api: config.api,
    provider: config.provider, baseUrl: config.baseUrl,
    contextWindow: config.contextWindow, maxTokens: config.maxTokens,
    reasoning: config.reasoning, input: config.imageInput ? ['text', 'image'] : ['text'],
    cost: known?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...(known ? { compat: known.compat, thinkingLevelMap: known.thinkingLevelMap } : {}),
    // V4.1 uses the existing DeepSeek adapter with the current documented effort mapping.
    ...(config.provider === 'deepseek' && config.api === 'openai-completions' && preset ? {
      thinkingLevelMap: { low: 'low', medium: 'high', high: 'high' },
    } : {}),
  };
  const api = apis[config.api]();
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const origin = new URL(config.baseUrl).origin;
  const guardedFetch: typeof globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== origin) return Promise.reject(new Error('模型请求不能跳转到其他服务地址。'));
    return fetchImpl(input, { ...init, redirect: 'error', credentials: 'omit' });
  };
  return new Agent({
    initialState: {
      model, systemPrompt: options.systemPrompt ?? 'You are the ChanceKit assistant.',
      thinkingLevel: config.reasoningLevel, tools: [],
    },
    streamFn: (selectedModel, context, streamOptions) => api.streamSimple(selectedModel, context, {
      ...streamOptions,
      apiKey: apiKey || 'local',
      fetch: guardedFetch,
      signal: options.signal && streamOptions?.signal
        ? AbortSignal.any([options.signal, streamOptions.signal]) : options.signal ?? streamOptions?.signal,
      maxTokens: config.maxTokens,
      temperature: config.reasoning ? undefined : config.temperature,
      ...(options.requireToolCall && context.tools?.length ? {
        // Provider adapters use different names for the same "call one of these tools" constraint.
        toolChoice: config.api === 'anthropic-messages' || config.api === 'google-generative-ai' ? 'any' : 'required',
      } : {}),
      maxRetries: 0, timeoutMs: options.timeoutMs ?? 30_000, transport: 'sse', cacheRetention: 'none',
    } as Parameters<typeof api.streamSimple>[2]),
  });
}

export async function createSavedPiAgent(store: ModelSettingsStore, options: PiAgentOptions = {}): Promise<Agent> {
  const settings = await store.saved();
  if (!settings) throw new Error('请先在模型配置中保存 LLM 设置。');
  return createConfiguredPiAgent(settings, options);
}

function redactModelText(text: string, apiKey: string): string {
  if (apiKey) text = text.replaceAll(apiKey, '[已隐藏密钥]').replaceAll(encodeURIComponent(apiKey), '[已隐藏密钥]');
  return text.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [已隐藏密钥]').slice(0, 500);
}

export async function testPiModel(settings: StoredModelSettings, options: PiAgentOptions & { timeout?: number } = {}): Promise<ModelTestResult> {
  const deadline = AbortSignal.timeout(options.timeout ?? 30_000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const agent = createConfiguredPiAgent(settings, { ...options, signal });
  const cancel = () => agent.abort();
  signal.addEventListener('abort', cancel, { once: true });
  const start = performance.now();
  try {
    signal.throwIfAborted();
    await agent.prompt(MODEL_TEST_PROMPT);
    signal.throwIfAborted();
    const message = agent.state.messages.findLast(message => message.role === 'assistant');
    if (!message || message.role !== 'assistant') throw new Error('服务未返回模型响应。');
    if (message.stopReason === 'error' || message.stopReason === 'aborted') throw new Error(message.errorMessage || '模型请求失败。');
    const reply = message.content.filter(block => block.type === 'text').map(block => block.text).join('').trim();
    if (!reply) throw new Error('模型未返回文本，请检查模型 ID、协议或输出上限。');
    return {
      modelId: settings.config.modelId, latencyMs: Math.round(performance.now() - start), reply: redactModelText(reply, settings.apiKey),
      inputTokens: message.usage.input, outputTokens: message.usage.output,
    };
  } catch (error) {
    if (options.signal?.aborted) throw new Error('连接测试已取消。');
    if (deadline.aborted) throw new Error('连接测试超时（30 秒），请检查服务地址与网络代理。');
    throw new Error(redactModelText(error instanceof Error ? error.message : '模型请求失败。', settings.apiKey));
  } finally {
    signal.removeEventListener('abort', cancel);
    agent.abort();
  }
}
