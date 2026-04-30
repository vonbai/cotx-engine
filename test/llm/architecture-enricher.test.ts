import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ArchitectureStore } from '../../src/store/architecture-store.js';
import { enrichArchitecture } from '../../src/llm/architecture-enricher.js';
import type { LlmClient } from '../../src/llm/client.js';
import type { ArchitectureRecursionPlan, ArchitectureWorkspaceData } from '../../src/store/schema.js';

vi.mock('../../src/config.js', () => ({
  readConfig: vi.fn(),
}));

vi.mock('../../src/llm/client.js', () => ({
  createLlmClient: vi.fn(),
}));

vi.mock('../../src/llm/agentic-architecture-enricher.js', () => ({
  runArchitectureBoundaryAgent: vi.fn((args: { workspace: { generated_at: string } }) => Promise.resolve({
    review: {
      schema_version: 'cotx.architecture.boundary_review.v1',
      generated_at: '2026-04-13T00:02:00.000Z',
      source_workspace_generated_at: args.workspace.generated_at,
      decisions: [],
    },
    tool_calls: [],
    model: { provider: 'test', id: 'test-model', api: 'test' },
  })),
}));

import { readConfig } from '../../src/config.js';
import { createLlmClient } from '../../src/llm/client.js';

const mockReadConfig = vi.mocked(readConfig);
const mockCreateLlmClient = vi.mocked(createLlmClient);

function defaultLlmConfig() {
  return {
    base_url: 'https://api.test.com/v1',
    api_key_env: 'TEST_LLM_KEY',
    chat_model: 'test-model',
    max_tokens: 200,
    concurrent: 2,
  };
}

function makeLlmClient(chatImpl?: (messages: unknown[]) => Promise<{ content: string }>): LlmClient {
  return {
    chat: vi.fn(chatImpl ?? (() => Promise.resolve({
      content: JSON.stringify({
        summary: 'Evidence-backed architecture summary.',
        responsibilities: ['Owns one architecture responsibility.'],
        key_relationships: [],
        risks_or_constraints: [],
        evidence_anchor_refs: ['module:parser'],
      }),
    }))),
    embed: vi.fn(() => Promise.reject(new Error('embed not implemented in test'))),
  };
}

function writeCanonicalArchitecture(archStore: ArchitectureStore): void {
  archStore.init({
    perspectives: ['overall-architecture'],
    generated_at: '2026-04-09T00:00:00.000Z',
    mode: 'auto',
    struct_hash: 'abc123',
  });
  const workspace: ArchitectureWorkspaceData = {
    schema_version: 'cotx.architecture.workspace.v1',
    generated_at: '2026-04-13T00:00:00Z',
    elements: [
      { id: 'system:test', name: 'test', level: 'software_system', evidence: [{ kind: 'file', id: 'README.md', filePath: 'README.md' }], review_status: 'draft' },
      { id: 'container:parser', name: 'Parser', level: 'container', parent_id: 'system:test', evidence: [{ kind: 'module', id: 'parser' }], review_status: 'draft' },
      { id: 'container:store', name: 'Store', level: 'container', parent_id: 'system:test', evidence: [{ kind: 'module', id: 'store' }], review_status: 'draft' },
    ],
    relationships: [],
    views: [],
  };
  const recursionPlan: ArchitectureRecursionPlan = {
    schema_version: 'cotx.architecture.recursion_plan.v1',
    generated_at: '2026-04-13T00:01:00Z',
    source_workspace_generated_at: workspace.generated_at,
    decisions: [
      { element_id: 'container:parser', action: 'leaf', reason: 'leaf', child_element_ids: [], evidence: [{ kind: 'module', id: 'parser' }] },
      { element_id: 'container:store', action: 'leaf', reason: 'leaf', child_element_ids: [], evidence: [{ kind: 'module', id: 'store' }] },
      { element_id: 'system:test', action: 'recurse', reason: 'children', child_element_ids: ['container:parser', 'container:store'], evidence: [{ kind: 'file', id: 'README.md', filePath: 'README.md' }] },
    ],
  };
  archStore.writeWorkspace(workspace);
  archStore.writeRecursionPlan(recursionPlan);
}

describe('enrichArchitecture', () => {
  let tmpDir: string;
  let archStore: ArchitectureStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-arch-enricher-'));
    archStore = new ArchitectureStore(tmpDir);
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

  it('uses the canonical recursive workspace enrichment path', async () => {
    const client = makeLlmClient();
    mockCreateLlmClient.mockReturnValue(client);
    writeCanonicalArchitecture(archStore);

    const result = await enrichArchitecture(tmpDir, { log: () => {} });

    expect(client.chat).toHaveBeenCalledTimes(4);
    expect(result.recursive_jobs_run).toBe(5);
    expect(result.recursive_jobs_planned).toBe(5);
    expect(archStore.readWorkspace()?.elements.every((element) => element.description === 'Evidence-backed architecture summary.')).toBe(true);
    expect(archStore.listEnrichmentJobs()).toHaveLength(4);
    expect(archStore.readMeta().mode).toBe('llm');
  });

  it('does not let overview jobs overwrite the system element description', async () => {
    let callCount = 0;
    const client = makeLlmClient(() => {
      callCount++;
      return Promise.resolve({
        content: JSON.stringify({
          summary: callCount === 4 ? 'Overview summary.' : 'Element summary.',
          responsibilities: [],
          key_relationships: [],
          risks_or_constraints: [],
          evidence_anchor_refs: ['module:parser'],
        }),
      });
    });
    mockCreateLlmClient.mockReturnValue(client);
    writeCanonicalArchitecture(archStore);

    await enrichArchitecture(tmpDir, { log: () => {} });

    expect(archStore.readWorkspace()?.elements.find((element) => element.id === 'system:test')?.description).toBe('Element summary.');
    expect(archStore.readEnrichmentJob('architecture-doc:overview:system:test')?.output?.content).toContain('Overview summary');
  });

  it('dryRun reports the canonical recursive prompt plan without calling the LLM', async () => {
    const client = makeLlmClient();
    mockCreateLlmClient.mockReturnValue(client);
    writeCanonicalArchitecture(archStore);
    const logs: unknown[] = [];

    const result = await enrichArchitecture(tmpDir, {
      dryRun: true,
      log: (...args) => logs.push(...args),
    });

    expect(client.chat).not.toHaveBeenCalled();
    expect(mockCreateLlmClient).not.toHaveBeenCalled();
    expect(result.recursive_jobs_planned).toBe(4);
    expect(logs.some((entry) => typeof entry === 'string' && entry.includes('canonical recursive architecture prompt plan'))).toBe(true);
  });

  it('allows dryRun without LLM config when canonical workspace exists', async () => {
    mockReadConfig.mockReturnValue({ port: 3456, host: '127.0.0.1' });
    writeCanonicalArchitecture(archStore);

    const result = await enrichArchitecture(tmpDir, { dryRun: true, log: () => {} });

    expect(result.perspectives_enriched).toBe(1);
    expect(mockCreateLlmClient).not.toHaveBeenCalled();
  });

  it('throws when architecture data is missing', async () => {
    await expect(enrichArchitecture(tmpDir)).rejects.toThrow('No architecture data');
  });

  it('throws when canonical workspace data is missing instead of falling back to legacy perspective enrichment', async () => {
    archStore.init({
      perspectives: ['overall-architecture'],
      generated_at: '2026-04-09T00:00:00.000Z',
      mode: 'auto',
      struct_hash: 'abc123',
    });

    await expect(enrichArchitecture(tmpDir)).rejects.toThrow('No canonical architecture workspace');
    expect(mockCreateLlmClient).toHaveBeenCalledOnce();
  });

  it('throws a clear error when no LLM config is present', async () => {
    mockReadConfig.mockReturnValue({ port: 3456, host: '127.0.0.1' });
    writeCanonicalArchitecture(archStore);

    await expect(enrichArchitecture(tmpDir)).rejects.toThrow('No LLM configured');
    expect(mockCreateLlmClient).not.toHaveBeenCalled();
  });

  it('uses max_tokens of at least 4000 for architecture output', async () => {
    const client = makeLlmClient();
    mockCreateLlmClient.mockReturnValue(client);
    mockReadConfig.mockReturnValue({
      port: 3456,
      host: '127.0.0.1',
      llm: { ...defaultLlmConfig(), max_tokens: 200 },
    });
    writeCanonicalArchitecture(archStore);

    await enrichArchitecture(tmpDir, { log: () => {} });

    const chatCall = vi.mocked(client.chat).mock.calls[0];
    const callOptions = chatCall[1] as { max_tokens?: number } | undefined;
    expect(callOptions?.max_tokens).toBeGreaterThanOrEqual(4000);
  });

  it('handles JSON responses wrapped in markdown code fences', async () => {
    const wrappedResponse = `\`\`\`json
${JSON.stringify({
  summary: 'Wrapped in code fences.',
  responsibilities: [],
  key_relationships: [],
  risks_or_constraints: [],
  evidence_anchor_refs: ['module:parser'],
})}
\`\`\``;
    const client = makeLlmClient(() => Promise.resolve({ content: wrappedResponse }));
    mockCreateLlmClient.mockReturnValue(client);
    writeCanonicalArchitecture(archStore);

    const result = await enrichArchitecture(tmpDir, { log: () => {} });

    expect(result.descriptions_written).toBe(3);
    expect(archStore.readWorkspace()?.elements.find((element) => element.id === 'container:parser')?.description).toBe('Wrapped in code fences.');
  });
});
