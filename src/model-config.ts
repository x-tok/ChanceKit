export const modelApis = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'] as const;
export type ModelApi = typeof modelApis[number];
// Keep legacy IDs readable so existing encrypted settings remain valid.
export const modelProviders = ['deepseek', 'qwen', 'moonshotai-cn', 'zhipu', 'minimax-cn', 'custom', 'openai', 'anthropic', 'google', 'openrouter'] as const;
export type ModelProvider = typeof modelProviders[number];
export type ReasoningLevel = 'off' | 'low' | 'medium' | 'high';

export interface ModelConfig {
  provider: ModelProvider;
  api: ModelApi;
  baseUrl: string;
  modelId: string;
  contextWindow: number;
  maxTokens: number;
  temperature: number;
  reasoning: boolean;
  reasoningLevel: ReasoningLevel;
  imageInput: boolean;
}
export interface ModelConfigInput {
  config: ModelConfig;
  // Omitted means retain the key only when the provider, API and endpoint are unchanged.
  apiKey?: string;
}
export interface ModelSettings {
  config: ModelConfig | null;
  hasApiKey: boolean;
  updatedAt: string | null;
  encryptionAvailable: boolean;
}
export interface ModelCatalogEntry {
  id: string;
  name: string;
  api: ModelApi;
  baseUrl: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  imageInput: boolean;
  reasoningLevels?: ReasoningLevel[];
}
export interface ModelProviderEntry {
  id: ModelProvider;
  name: string;
  api: ModelApi;
  baseUrl: string;
  models: ModelCatalogEntry[];
}
export interface ModelTestResult {
  modelId: string;
  latencyMs: number;
  reply: string;
  inputTokens: number;
  outputTokens: number;
}

export const recommendedMaxOutputTokens = 32_768;

function preset(
  id: ModelProvider, name: string, api: ModelApi, baseUrl: string,
  models: Omit<ModelCatalogEntry, 'api' | 'baseUrl'>[],
): ModelProviderEntry {
  return { id, name, api, baseUrl, models: models.map(model => ({ ...model, api, baseUrl })) };
}

export const modelProviderPresets: ModelProviderEntry[] = [
  preset('deepseek', 'DeepSeek', 'openai-completions', 'https://api.deepseek.com', [
    { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', contextWindow: 1000000, maxTokens: 384000, reasoning: true, imageInput: true, reasoningLevels: ['off', 'low', 'high'] },
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 1000000, maxTokens: 384000, reasoning: true, imageInput: false, reasoningLevels: ['off', 'low', 'high'] },
  ]),
  preset('qwen', '通义千问', 'openai-completions', 'https://dashscope.aliyuncs.com/compatible-mode/v1', [
    { id: 'qwen3.7-plus', name: 'Qwen3.7 Plus', contextWindow: 1000000, maxTokens: 65536, reasoning: true, imageInput: true, reasoningLevels: ['off', 'high'] },
    { id: 'qwen3.6-plus', name: 'Qwen3.6 Plus', contextWindow: 1000000, maxTokens: 65536, reasoning: true, imageInput: true, reasoningLevels: ['off', 'high'] },
  ]),
  preset('moonshotai-cn', 'Kimi · 月之暗面', 'openai-completions', 'https://api.moonshot.cn/v1', [
    { id: 'kimi-k2.6', name: 'Kimi K2.6', contextWindow: 262144, maxTokens: 262144, reasoning: true, imageInput: true, reasoningLevels: ['off', 'high'] },
    { id: 'kimi-k2.5', name: 'Kimi K2.5', contextWindow: 262144, maxTokens: 262144, reasoning: true, imageInput: true, reasoningLevels: ['off', 'high'] },
  ]),
  preset('zhipu', '智谱 GLM', 'openai-completions', 'https://open.bigmodel.cn/api/paas/v4', [
    { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1000000, maxTokens: 131072, reasoning: true, imageInput: false, reasoningLevels: ['off', 'high'] },
    { id: 'glm-4.7', name: 'GLM-4.7', contextWindow: 204800, maxTokens: 131072, reasoning: true, imageInput: false, reasoningLevels: ['off', 'high'] },
  ]),
  preset('minimax-cn', 'MiniMax', 'anthropic-messages', 'https://api.minimaxi.com/anthropic', [
    { id: 'MiniMax-M2.7', name: 'MiniMax M2.7', contextWindow: 204800, maxTokens: 131072, reasoning: true, imageInput: false, reasoningLevels: ['high'] },
    { id: 'MiniMax-M2.7-highspeed', name: 'MiniMax M2.7 Highspeed', contextWindow: 204800, maxTokens: 131072, reasoning: true, imageInput: false, reasoningLevels: ['high'] },
  ]),
  preset('custom', '自定义服务', 'openai-completions', '', []),
];

export function configForProvider(provider: ModelProviderEntry, model = provider.models[0]): ModelConfig {
  return {
    provider: provider.id, api: model?.api ?? provider.api, baseUrl: model?.baseUrl ?? provider.baseUrl,
    modelId: model?.id ?? '', contextWindow: model?.contextWindow ?? 128000,
    maxTokens: Math.min(recommendedMaxOutputTokens, model?.maxTokens ?? 4096, model?.contextWindow ?? 128000), temperature: 1,
    reasoning: model?.reasoning ?? false, reasoningLevel: model?.reasoningLevels?.[0] ?? 'off',
    imageInput: model?.imageInput ?? false,
  };
}

export const defaultModelConfig = configForProvider(modelProviderPresets[0]);

export function sameCredentialScope(a: ModelConfig | null, b: ModelConfig): boolean {
  return Boolean(a && a.provider === b.provider && a.api === b.api && a.baseUrl.replace(/\/+$/, '') === b.baseUrl.trim().replace(/\/+$/, ''));
}

export function isLocalModelEndpoint(value: string): boolean {
  try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname); }
  catch { return false; }
}
