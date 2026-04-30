import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { LlmClient } from '../../src/llm/client.js';
import { refineDoctrine } from '../../src/llm/doctrine-enricher.js';

vi.mock('../../src/config.js', () => ({
  readConfig: vi.fn(),
}));

vi.mock('../../src/llm/client.js', () => ({
  createLlmClient: vi.fn(),
}));

import { readConfig } from '../../src/config.js';
import { createLlmClient } from '../../src/llm/client.js';

const mockReadConfig = vi.mocked(readConfig);
const mockCreateLlmClient = vi.mocked(createLlmClient);

function makeLlmClient(): LlmClient {
  return {
    chat: vi.fn(() => Promise.resolve({
      content: JSON.stringify({
        refinements: {
          'doctrine-1': 'Refined deterministic doctrine statement.',
        },
      }),
    })),
    embed: vi.fn(() => Promise.reject(new Error('unused'))),
  };
}

describe('refineDoctrine', () => {
  beforeEach(() => {
    mockReadConfig.mockReturnValue({
      port: 3456,
      host: '127.0.0.1',
      llm: {
        base_url: 'https://api.test.com/v1',
        api_key_env: 'TEST_LLM_KEY',
        chat_model: 'test-chat',
      },
    });
    process.env.TEST_LLM_KEY = 'test';
  });

  afterEach(() => {
    delete process.env.TEST_LLM_KEY;
    vi.clearAllMocks();
  });

  it('refines doctrine statements without changing deterministic IDs or evidence', async () => {
    const client = makeLlmClient();
    mockCreateLlmClient.mockReturnValue(client);

    const input = {
      generated_at: '2026-04-11T00:00:00Z',
      struct_hash: 'abc123',
      statements: [
        {
          id: 'doctrine-1',
          kind: 'principle' as const,
          title: 'Prefer module-local fixes',
          statement: 'Prefer changing the owning module first.',
          strength: 'soft' as const,
          scope: 'repo' as const,
          inferred: true,
          evidence: [{ kind: 'module' as const, ref: 'api' }],
        },
      ],
    };

    const { doctrine, result } = await refineDoctrine(input);

    expect(result.refined).toBe(1);
    expect(doctrine.statements[0].id).toBe('doctrine-1');
    expect(doctrine.statements[0].refined_statement).toBe('Refined deterministic doctrine statement.');
    expect(doctrine.statements[0].evidence).toEqual([{ kind: 'module', ref: 'api' }]);
  });
});
