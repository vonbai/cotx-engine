import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CotxStore } from '../../src/store/store.js';
import { autoEnrich } from '../../src/llm/enricher.js';
import type { LlmClient } from '../../src/llm/client.js';

// ── Module-level mocks ────────────────────────────────────────────────────────

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

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeLlmClient(chatImpl?: (messages: unknown[]) => Promise<{ content: string }>): LlmClient {
  return {
    chat: vi.fn(chatImpl ?? (() => Promise.resolve({ content: 'Handles HTTP requests for the API layer.' }))),
    embed: vi.fn(() => Promise.reject(new Error('embed not implemented in test'))),
  };
}

function defaultLlmConfig() {
  return {
    base_url: 'https://api.test.com/v1',
    api_key_env: 'TEST_LLM_KEY',
    chat_model: 'test-model',
    max_tokens: 200,
    concurrent: 2,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('autoEnrich', () => {
  let tmpDir: string;
  let store: CotxStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-enricher-'));
    store = new CotxStore(tmpDir);
    store.init('test-project');

    mockReadConfig.mockReturnValue({
      port: 3456,
      host: '127.0.0.1',
      llm: defaultLlmConfig(),
    });

    process.env.TEST_LLM_KEY = 'test-key';
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.TEST_LLM_KEY;
    vi.clearAllMocks();
  });

  // ── Test 1: stale module → calls LLM → writes result ─────────────────────

  it('enriches a stale module node by calling LLM and writing responsibility', async () => {
    const client = makeLlmClient();
    mockCreateLlmClient.mockReturnValue(client);

    // Write a module with stale enrichment (source_hash ≠ struct_hash)
    store.writeModule({
      id: 'api',
      canonical_entry: 'src/api/index.ts',
      files: ['src/api/index.ts', 'src/api/router.ts'],
      depends_on: ['core'],
      depended_by: [],
      struct_hash: 'new_hash_abc',
      enriched: {
        responsibility: 'old description',
        source_hash: 'old_hash_xyz',
        enriched_at: '2026-01-01T00:00:00.000Z',
      },
    });

    const logs: string[] = [];
    const result = await autoEnrich(tmpDir, { log: msg => logs.push(msg) });

    // Should have processed 1 node
    expect(result.total).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      node_id: 'api',
      layer: 'module',
      field: 'enriched.responsibility',
      status: 'ok',
    });

    // LLM client should have been called
    expect(client.chat).toHaveBeenCalledOnce();
    const chatCall = vi.mocked(client.chat).mock.calls[0];
    const messages = chatCall[0];
    expect(messages[0]).toMatchObject({ role: 'system' });
    expect(messages[1]).toMatchObject({ role: 'user', content: expect.stringContaining('api') });

    // The module should now have updated responsibility
    const mod = store.readModule('api');
    expect(mod.enriched?.responsibility).toBe('Handles HTTP requests for the API layer.');
    expect(mod.enriched?.source_hash).toBe('new_hash_abc');
  });

  // ── Test 2: dryRun → does NOT call LLM ────────────────────────────────────

  it('does not call LLM when dryRun is true', async () => {
    const client = makeLlmClient();
    mockCreateLlmClient.mockReturnValue(client);

    store.writeModule({
      id: 'core',
      canonical_entry: 'src/core/index.ts',
      files: ['src/core/index.ts'],
      depends_on: [],
      depended_by: ['api'],
      struct_hash: 'hash_new',
      enriched: {
        responsibility: 'stale desc',
        source_hash: 'hash_old',
        enriched_at: '2026-01-01T00:00:00.000Z',
      },
    });

    const logs: string[] = [];
    const result = await autoEnrich(tmpDir, { dryRun: true, log: msg => logs.push(msg) });

    // Should report what would be enriched
    expect(result.total).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.results[0].status).toBe('ok');

    // LLM should NOT have been called
    expect(client.chat).not.toHaveBeenCalled();

    // Log should mention dry-run
    expect(logs.some(l => l.includes('dry-run'))).toBe(true);

    // Module enrichment should NOT have been updated
    const mod = store.readModule('core');
    expect(mod.enriched?.responsibility).toBe('stale desc');
  });

  it('does not require an API key during dryRun', async () => {
    mockCreateLlmClient.mockImplementation(() => {
      throw new Error('API key missing');
    });

    store.writeModule({
      id: 'preview',
      canonical_entry: 'src/preview/index.ts',
      files: ['src/preview/index.ts'],
      depends_on: [],
      depended_by: [],
      struct_hash: 'hash_new',
      enriched: {
        responsibility: 'stale desc',
        source_hash: 'hash_old',
        enriched_at: '2026-01-01T00:00:00.000Z',
      },
    });

    const result = await autoEnrich(tmpDir, { dryRun: true });

    expect(result.total).toBe(1);
    expect(result.failed).toBe(0);
    expect(mockCreateLlmClient).not.toHaveBeenCalled();
  });

  // ── Test 3: limit → only processes that many nodes ───────────────────────

  it('respects the limit option and only processes that many nodes', async () => {
    const client = makeLlmClient();
    mockCreateLlmClient.mockReturnValue(client);

    // Write 3 stale modules
    for (const id of ['mod-a', 'mod-b', 'mod-c']) {
      store.writeModule({
        id,
        canonical_entry: `src/${id}/index.ts`,
        files: [`src/${id}/index.ts`],
        depends_on: [],
        depended_by: [],
        struct_hash: `hash_new_${id}`,
        enriched: {
          responsibility: 'old',
          source_hash: `hash_old_${id}`,
          enriched_at: '2026-01-01T00:00:00.000Z',
        },
      });
    }

    const result = await autoEnrich(tmpDir, { limit: 2 });

    expect(result.total).toBe(2);
    expect(result.results).toHaveLength(2);
    expect(vi.mocked(client.chat).mock.calls).toHaveLength(2);
  });

  // ── Test 4: no LLM config → throws clear error ────────────────────────────

  it('throws a clear error when no LLM config is present', async () => {
    // Config without llm field
    mockReadConfig.mockReturnValue({ port: 3456, host: '127.0.0.1' });

    await expect(autoEnrich(tmpDir)).rejects.toThrow(
      'No LLM configuration found',
    );

    // createLlmClient should not have been called
    expect(mockCreateLlmClient).not.toHaveBeenCalled();
  });

  // ── Test 5: missing .cotx/ → throws clear error ──────────────────────────

  it('throws when .cotx/ does not exist', async () => {
    const client = makeLlmClient();
    mockCreateLlmClient.mockReturnValue(client);

    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-empty-'));
    try {
      await expect(autoEnrich(emptyDir)).rejects.toThrow('.cotx/');
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  // ── Test 6: layer filter ──────────────────────────────────────────────────

  it('only processes nodes matching the layer filter', async () => {
    const client = makeLlmClient();
    mockCreateLlmClient.mockReturnValue(client);

    // One stale module, one stale concept
    store.writeModule({
      id: 'api',
      canonical_entry: 'src/api/index.ts',
      files: ['src/api/index.ts'],
      depends_on: [],
      depended_by: [],
      struct_hash: 'new',
      enriched: { responsibility: 'old', source_hash: 'old', enriched_at: '2026-01-01T00:00:00.000Z' },
    });
    store.writeConcept({
      id: 'token',
      aliases: ['Token'],
      appears_in: ['src/api/index.ts'],
      layer: 'api',
      struct_hash: 'new_c',
      enriched: { definition: 'old def', source_hash: 'old_c', enriched_at: '2026-01-01T00:00:00.000Z' },
    });

    const result = await autoEnrich(tmpDir, { layer: 'concept' });

    expect(result.total).toBe(1);
    expect(result.results[0]).toMatchObject({ layer: 'concept', node_id: 'token' });
    expect(vi.mocked(client.chat).mock.calls).toHaveLength(1);
  });

  // ── Test 7: LLM error is captured per-node, not thrown ───────────────────

  it('captures LLM errors per-node without aborting other nodes', async () => {
    let callCount = 0;
    const client = makeLlmClient(async () => {
      callCount++;
      if (callCount === 1) throw new Error('Rate limited (429)');
      return { content: 'Handles data persistence.' };
    });
    mockCreateLlmClient.mockReturnValue(client);

    store.writeModule({
      id: 'mod-fail',
      canonical_entry: 'src/mod-fail/index.ts',
      files: ['src/mod-fail/index.ts'],
      depends_on: [],
      depended_by: [],
      struct_hash: 'new1',
      enriched: { responsibility: 'old', source_hash: 'old1', enriched_at: '2026-01-01T00:00:00.000Z' },
    });
    store.writeModule({
      id: 'mod-ok',
      canonical_entry: 'src/mod-ok/index.ts',
      files: ['src/mod-ok/index.ts'],
      depends_on: [],
      depended_by: [],
      struct_hash: 'new2',
      enriched: { responsibility: 'old', source_hash: 'old2', enriched_at: '2026-01-01T00:00:00.000Z' },
    });

    const result = await autoEnrich(tmpDir);

    expect(result.total).toBe(2);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);

    const failed = result.results.find(r => r.status === 'error');
    expect(failed?.error).toContain('Rate limited');
  });
});
