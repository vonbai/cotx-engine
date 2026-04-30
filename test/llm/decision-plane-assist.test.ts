import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { LlmClient } from '../../src/llm/client.js';
import { assistDecisionAmbiguity } from '../../src/llm/decision-plane-assist.js';

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
        selected_candidate_id: 'candidate-2',
        explanation: 'Candidate 2 best matches the existing naming and evidence.',
        suggested_abstraction_level: 'extract_helper',
      }),
    })),
    embed: vi.fn(() => Promise.reject(new Error('unused'))),
  };
}

describe('assistDecisionAmbiguity', () => {
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

  it('returns a structured ambiguous-zone suggestion without inventing a new zone', async () => {
    mockCreateLlmClient.mockReturnValue(makeLlmClient());

    const result = await assistDecisionAmbiguity({
      ambiguous_zone: 'canonical_rerank',
      target: 'persistence/save',
      candidates: [
        { id: 'candidate-1', summary: 'legacy wrapper path' },
        { id: 'candidate-2', summary: 'shared repository path' },
      ],
      evidence: [{ ref: 'canonical:persistence/save', detail: 'score tie' }],
    });

    expect(result.ambiguous_zone).toBe('canonical_rerank');
    expect(result.selected_candidate_id).toBe('candidate-2');
    expect(result.suggested_abstraction_level).toBe('extract_helper');
  });
});
