import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createLlmClient } from '../../src/llm/client.js';
import type { LlmConfig } from '../../src/config.js';

const CONFIG: LlmConfig = {
  base_url: 'https://api.test.com/v1',
  api_key_env: 'TEST_LLM_KEY',
  chat_model: 'test-model',
  embedding_model: 'test-embed-model',
  max_tokens: 300,
};

describe('LlmClient', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.TEST_LLM_KEY = 'test-key-123';
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    delete process.env.TEST_LLM_KEY;
    vi.restoreAllMocks();
  });

  it('works without API key for local endpoints', async () => {
    delete process.env.TEST_LLM_KEY;
    delete process.env.OPENAI_API_KEY;
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      choices: [{ message: { content: 'OK' } }],
    })));
    const client = createLlmClient({ ...CONFIG, api_key: undefined, api_key_env: undefined });
    const result = await client.chat([{ role: 'user', content: 'Hi' }]);
    expect(result.content).toBe('OK');
    const headers = (fetchSpy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it('uses api_key from config over env var', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      choices: [{ message: { content: 'OK' } }],
    })));
    const client = createLlmClient({ ...CONFIG, api_key: 'config-key-direct' });
    await client.chat([{ role: 'user', content: 'Hi' }]);
    const headers = (fetchSpy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer config-key-direct');
  });

  it('allows keyless compatible endpoints when api_key_env is not configured', async () => {
    delete process.env.OPENAI_API_KEY;
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      choices: [{ message: { content: 'Hello keyless' } }],
    })));

    const client = createLlmClient({
      ...CONFIG,
      api_key_env: undefined,
      base_url: 'http://localhost:11434/v1',
    });
    const result = await client.chat([{ role: 'user', content: 'Hi' }]);

    expect(result.content).toBe('Hello keyless');
    const headers = (fetchSpy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it('sends correct chat completions request', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      choices: [{ message: { content: 'Hello world' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    })));

    const client = createLlmClient(CONFIG);
    const result = await client.chat([{ role: 'user', content: 'Hi' }]);

    expect(result.content).toBe('Hello world');
    expect(result.usage?.prompt_tokens).toBe(10);

    const call = fetchSpy.mock.calls[0];
    expect(call[0]).toBe('https://api.test.com/v1/chat/completions');
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.model).toBe('test-model');
    expect(body.messages).toEqual([{ role: 'user', content: 'Hi' }]);
    expect(body.temperature).toBe(0.3);
  });

  it('throws on non-OK chat response', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('Rate limited', { status: 429 }));
    const client = createLlmClient(CONFIG);
    await expect(client.chat([{ role: 'user', content: 'Hi' }])).rejects.toThrow('429');
  });

  it('throws on null content', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      choices: [{ message: { content: null } }],
    })));
    const client = createLlmClient(CONFIG);
    await expect(client.chat([{ role: 'user', content: 'Hi' }])).rejects.toThrow('empty content');
  });

  it('sends correct embeddings request', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      data: [
        { index: 0, embedding: [0.1, 0.2, 0.3] },
        { index: 1, embedding: [0.4, 0.5, 0.6] },
      ],
    })));

    const client = createLlmClient(CONFIG);
    const result = await client.embed(['hello', 'world']);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual([0.1, 0.2, 0.3]);

    const call = fetchSpy.mock.calls[0];
    expect(call[0]).toBe('https://api.test.com/v1/embeddings');
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.model).toBe('test-embed-model');
    expect(body.input).toEqual(['hello', 'world']);
  });

  it('throws when embedding_model is not configured', async () => {
    const configNoEmbed = { ...CONFIG, embedding_model: undefined };
    const client = createLlmClient(configNoEmbed);
    await expect(client.embed(['hello'])).rejects.toThrow('embedding_model');
  });

  it('strips trailing slashes from base_url', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      choices: [{ message: { content: 'OK' } }],
    })));

    const configSlash = { ...CONFIG, base_url: 'https://api.test.com/v1/' };
    const client = createLlmClient(configSlash);
    await client.chat([{ role: 'user', content: 'Hi' }]);

    expect(fetchSpy.mock.calls[0][0]).toBe('https://api.test.com/v1/chat/completions');
  });
});
