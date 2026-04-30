import type { Model, OpenAICompletionsCompat } from '@mariozechner/pi-ai';
import type { LlmConfig } from '../config.js';
import type { CotxAgentModelInfo } from './agentic-types.js';

export function createPiAgentModel(llm: LlmConfig): Model<'openai-completions'> {
  const provider = inferOpenAiCompatibleProvider(llm.base_url);
  const maxTokens = Math.max(llm.max_tokens ?? 4096, 4096);
  const compat: OpenAICompletionsCompat = {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    supportsUsageInStreaming: false,
    supportsStrictMode: false,
    maxTokensField: 'max_tokens',
  };

  return {
    id: llm.chat_model,
    name: `${llm.chat_model} (${provider})`,
    api: 'openai-completions',
    provider,
    baseUrl: llm.base_url.replace(/\/+$/, ''),
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens,
    compat,
  };
}

export function requirePiAgentModel(llm: LlmConfig | undefined): Model<'openai-completions'> {
  if (!llm?.chat_model) {
    throw new Error('No LLM configured for cotx built-in agent.');
  }
  return createPiAgentModel(llm);
}

export function resolvePiAgentApiKey(config: LlmConfig): string | undefined {
  if (config.api_key !== undefined) return config.api_key;
  if (config.api_key_env && process.env[config.api_key_env]) return process.env[config.api_key_env];
  return process.env.OPENAI_API_KEY;
}

export function modelInfo(model: Model<any>): CotxAgentModelInfo {
  return {
    provider: model.provider,
    id: model.id,
    api: model.api,
    base_url: model.baseUrl,
  };
}

function inferOpenAiCompatibleProvider(baseUrl: string): string {
  const lower = baseUrl.toLowerCase();
  if (lower.includes('litellm') || lower.includes(':4000')) return 'litellm';
  if (lower.includes('ollama') || lower.includes(':11434')) return 'ollama';
  if (lower.includes('openrouter')) return 'openrouter';
  if (lower.includes('localhost') || lower.includes('127.0.0.1')) return 'local-openai-compatible';
  return 'openai-compatible';
}
