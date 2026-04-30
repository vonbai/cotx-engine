/**
 * LLM Client — zero-dependency, fetch-based OpenAI-compatible API client.
 *
 * Supports chat completions and text embeddings via any OpenAI-compatible endpoint
 * (OpenAI, LiteLLM, Ollama, Groq, Together, etc.)
 */

import type { LlmConfig } from '../config.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatResponse {
  content: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export interface LlmClient {
  chat(messages: ChatMessage[], options?: { max_tokens?: number }): Promise<ChatResponse>;
  embed(texts: string[]): Promise<number[][]>;
}

export function createLlmClient(config: LlmConfig): LlmClient {
  // Resolve API key: config.api_key → env var → empty (keyless for local endpoints)
  let apiKey: string;
  if (config.api_key !== undefined) {
    apiKey = config.api_key;
  } else if (config.api_key_env && process.env[config.api_key_env]) {
    apiKey = process.env[config.api_key_env]!;
  } else if (process.env.OPENAI_API_KEY) {
    apiKey = process.env.OPENAI_API_KEY;
  } else {
    apiKey = '';
  }

  const baseUrl = config.base_url.replace(/\/+$/, '');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  return {
    async chat(messages, options) {
      const maxTokens = options?.max_tokens ?? config.max_tokens ?? 300;

      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: config.chat_model,
          messages,
          max_tokens: maxTokens,
          temperature: 0.3,
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`LLM chat failed (${res.status}): ${body.slice(0, 200)}`);
      }

      const data = await res.json() as {
        choices: Array<{ message: { content: string | null } }>;
        usage?: { prompt_tokens: number; completion_tokens: number };
      };

      const content = data.choices?.[0]?.message?.content;
      if (content === null || content === undefined) {
        throw new Error('LLM returned empty content (try increasing max_tokens)');
      }

      return {
        content,
        usage: data.usage,
      };
    },

    async embed(texts) {
      if (!config.embedding_model) {
        throw new Error('No embedding_model configured in LLM config');
      }

      const res = await fetch(`${baseUrl}/embeddings`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: config.embedding_model,
          input: texts,
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`LLM embed failed (${res.status}): ${body.slice(0, 200)}`);
      }

      const data = await res.json() as {
        data: Array<{ embedding: number[]; index: number }>;
      };

      // Sort by index to match input order
      return data.data
        .sort((a, b) => a.index - b.index)
        .map((d) => d.embedding);
    },
  };
}
