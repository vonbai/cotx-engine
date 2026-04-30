import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { CotxStore } from '../../src/store/store.js';
import { ArchitectureStore } from '../../src/store/architecture-store.js';
import { COTX_TOOLS, handleToolCall } from '../../src/mcp/tools.js';

function parseMcpJson(result: Awaited<ReturnType<typeof handleToolCall>>): any {
  return JSON.parse(result.content[0].text);
}

describe('handleToolCall', () => {
  let tmpDir: string;
  let store: CotxStore;
  let tmpHome: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-mcp-test-'));
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-mcp-home-'));
    previousHome = process.env.HOME;
    process.env.HOME = tmpHome;
    store = new CotxStore(tmpDir);
    store.init('mcp-test');
    fs.writeFileSync(path.join(tmpDir, 'api.ts'), 'export function Handle() { return 1; }\n', 'utf-8');
    store.writeModule({
      id: 'api',
      canonical_entry: 'Handle',
      files: ['api.ts'],
      depends_on: [],
      depended_by: [],
      struct_hash: 'aaaa1111',
    });
    store.updateMeta({ compiled_at: '2026-04-08T00:00:00Z' });
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    delete process.env.TEST_LLM_KEY;
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('writes enrichment data through cotx_write', async () => {
    const write = parseMcpJson(
      await handleToolCall('cotx_write', {
        project_root: tmpDir,
        node_id: 'api',
        field: 'enriched.responsibility',
        content: 'API layer',
      }),
    );
    expect(write.success).toBe(true);
    expect(store.readModule('api').enriched?.responsibility).toBe('API layer');
  });

  it('cotx_write handles batch writes via writes array', async () => {
    const result = parseMcpJson(
      await handleToolCall('cotx_write', {
        project_root: tmpDir,
        writes: [
          { node_id: 'api', field: 'enriched.responsibility', content: 'API handler' },
        ],
      }),
    );
    expect(result.total).toBe(1);
    expect(result.succeeded).toBe(1);
  });

  it('cotx_query with mode=focus returns typed graph results', async () => {
    await handleToolCall('cotx_compile', { project_root: tmpDir });
    const result = parseMcpJson(
      await handleToolCall('cotx_query', {
        project_root: tmpDir,
        mode: 'focus',
        focus_node: 'api.ts',
      }),
    );
    expect(result.mode).toBe('focus');
    expect(result.results[0].id).toContain('api.ts');
  });

  it('catches unexpected tool exceptions and returns structured errors', async () => {
    vi.spyOn(CotxStore.prototype, 'readDoctrine').mockImplementation(() => {
      throw new Error('boom-doctrine');
    });

    const result = await handleToolCall('cotx_doctrine', {
      project_root: tmpDir,
    });

    expect(result.isError).toBe(true);
    expect(parseMcpJson(result).error).toContain('boom-doctrine');
  });

  it('cotx_query with filter=stale includes exported API from provided contracts', async () => {
    store.writeModule({
      id: 'db',
      canonical_entry: 'query',
      files: ['db.ts'],
      depends_on: [],
      depended_by: ['api'],
      struct_hash: 'bbbb2222',
    });
    store.writeContract({
      id: 'api-db',
      consumer: 'api',
      provider: 'db',
      interface: ['query()', 'exec()'],
      struct_hash: 'cccc3333',
    });
    store.updateMeta({ compiled_at: new Date().toISOString() });

    const result = parseMcpJson(
      await handleToolCall('cotx_query', {
        project_root: tmpDir,
        filter: 'stale',
        layer: 'module',
      }),
    );

    const dbTask = result.tasks.find((task: { node_id: string }) => task.node_id === 'db');
    expect(dbTask.context.exported_api).toContain('query()');
    expect(dbTask.context.exported_api).toContain('exec()');
  });

  it('cotx_query with architecture layer requires an explicit query', async () => {
    new ArchitectureStore(tmpDir).init({
      perspectives: [],
      generated_at: '2026-04-14T00:00:00.000Z',
      mode: 'auto',
      struct_hash: 'arch-empty',
    });

    const result = await handleToolCall('cotx_query', {
      project_root: tmpDir,
      layer: 'architecture',
    });
    const parsed = parseMcpJson(result);

    expect(result.isError).toBe(true);
    expect(parsed.error).toContain('Missing query');
  });

  it('cotx_context reports typed graph misses instead of semantic fallback', async () => {
    const result = parseMcpJson(
      await handleToolCall('cotx_context', {
        project_root: tmpDir,
        node_id: 'api',
      }),
    );
    expect(result.error).toContain('storage-v2 typed graph');
  });

  it('cotx_batch_write returns migration error', async () => {
    const result = await handleToolCall('cotx_batch_write', { project_root: tmpDir, writes: [] });
    expect(result.isError).toBe(true);
    const parsed = parseMcpJson(result);
    expect(parsed.error).toContain('merged into cotx_write');
  });

  it('cotx_enrich returns migration error', async () => {
    const result = await handleToolCall('cotx_enrich', { project_root: tmpDir });
    expect(result.isError).toBe(true);
    const parsed = parseMcpJson(result);
    expect(parsed.error).toContain('merged into cotx_query');
  });

  it('cotx_onboarding_context returns deterministic read-only repo context', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'README.md'),
      '# MCP Fixture\n\nThe API entry is api.ts.\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({
        name: 'mcp-fixture',
        scripts: { test: 'vitest' },
      }),
      'utf-8',
    );

    const result = parseMcpJson(
      await handleToolCall('cotx_onboarding_context', {
        project_root: tmpDir,
        budget: 'tiny',
      }),
    );

    expect(result.budget).toBe('tiny');
    expect(result.sources.some((source: { path: string; kind: string }) => source.path === 'README.md' && source.kind === 'readme')).toBe(true);
    expect(result.sources.some((source: { path: string; kind: string }) => source.path === 'package.json' && source.kind === 'manifest')).toBe(true);
    expect(result.hypotheses.some((hypothesis: { kind: string }) => hypothesis.kind === 'runtime')).toBe(true);
    expect(result.summary.has_cotx).toBe(true);
    expect(result.summary.has_storage_v2_truth).toBe(true);
  });

  it('declares cotx_onboarding_context in the MCP tool list', () => {
    expect(COTX_TOOLS.some((tool) => tool.name === 'cotx_onboarding_context')).toBe(true);
  });

  it('cotx_onboarding_context rejects invalid budget values', async () => {
    const result = await handleToolCall('cotx_onboarding_context', {
      project_root: tmpDir,
      budget: 'wide-open',
    });
    expect(result.isError).toBe(true);
    expect(parseMcpJson(result).error).toContain('Invalid budget');
  });

  it('cotx_minimal_context returns workspace-first context before compile', async () => {
    const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-minimal-context-'));
    try {
      fs.writeFileSync(path.join(freshDir, 'README.md'), '# Minimal Fixture\n', 'utf-8');
      fs.writeFileSync(path.join(freshDir, 'package.json'), '{"name":"minimal-fixture"}\n', 'utf-8');
      fs.mkdirSync(path.join(freshDir, 'assets', 'icons'), { recursive: true });
      fs.writeFileSync(path.join(freshDir, 'assets', 'icons', 'logo.png'), 'png', 'utf-8');

      const result = parseMcpJson(
        await handleToolCall('cotx_minimal_context', {
          project_root: freshDir,
          task: 'map architecture before changing an API route',
          changed_files: ['README.md'],
          budget: 'tiny',
        }),
      );

      expect(result.budget).toBe('tiny');
      expect(result.task_classification.intent).toBe('api');
      expect(result.workspace.summary.repo_boundaries).toBe(1);
      expect(result.workspace.summary.asset_dirs).toBe(1);
      expect(result.workspace.asset_directories).toEqual([
        expect.objectContaining({ path: 'assets/icons', kind: 'asset' }),
      ]);
      expect(result.workspace.candidate_inputs.some((candidate: { path: string }) => candidate.path === 'README.md')).toBe(true);
      expect(result.changed_files[0]).toEqual({ file: 'README.md', exists: true });
      expect(result.risk_flags).toContain('cotx-map-missing');
      expect(result.recommended_next_tools.some((tool: { tool: string }) => tool.tool === 'cotx_compile')).toBe(true);
    } finally {
      fs.rmSync(freshDir, { recursive: true, force: true });
    }
  });

  it('cotx_minimal_context reconciles stale cached workspace layout with a live architecture store', async () => {
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# MCP Fixture\n', 'utf-8');
    const architectureDir = path.join(tmpDir, '.cotx', 'architecture');
    fs.mkdirSync(architectureDir, { recursive: true });
    fs.writeFileSync(
      path.join(architectureDir, 'meta.yaml'),
      yaml.dump({ perspectives: ['overall-architecture'], generated_at: '2026-04-14T07:35:15.081Z', mode: 'auto' }),
      'utf-8',
    );
    store.writeWorkspaceLayout({
      project_root: tmpDir,
      generated_at: '2026-04-14T07:35:12.502Z',
      directories: [
        { path: '.', kind: 'repo-root', depth: 0 },
        { path: '.cotx', kind: 'cotx', depth: 1 },
      ],
      candidates: [
        { path: '.cotx/meta.yaml', kind: 'cotx', reason: 'cotx sidecar metadata', boundary: '.' },
        { path: 'README.md', kind: 'readme', reason: 'README-like file', boundary: '.' },
      ],
      summary: {
        directories: 2,
        candidates: 2,
        asset_dirs: 0,
        repo_boundaries: 1,
        packages: 0,
        docs_dirs: 0,
        example_dirs: 0,
        cotx_present: true,
        architecture_store_present: false,
      },
    });

    const result = parseMcpJson(
      await handleToolCall('cotx_minimal_context', {
        project_root: tmpDir,
        task: 'inspect architecture',
        budget: 'tiny',
      }),
    );

    expect(result.workspace.summary.architecture_store_present).toBe(true);
    expect(result.risk_flags).toContain('workspace-layout-stale');
    expect(result.risk_flags).not.toContain('architecture-store-missing');
    expect(result.workspace.candidate_inputs.some((candidate: { path: string }) => candidate.path.startsWith('.cotx/'))).toBe(false);
  });

  it('declares cotx_minimal_context in the MCP tool list', () => {
    expect(COTX_TOOLS.some((tool) => tool.name === 'cotx_minimal_context')).toBe(true);
  });

  it('cotx_source_roots returns deterministic mixed-repo roots', async () => {
    const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-source-roots-'));
    try {
      fs.mkdirSync(path.join(freshDir, 'src', 'compiler'), { recursive: true });
      fs.mkdirSync(path.join(freshDir, 'packages', 'core', 'src', 'types'), { recursive: true });
      fs.mkdirSync(path.join(freshDir, 'apps', 'workbench', 'src', 'routes'), { recursive: true });
      fs.mkdirSync(path.join(freshDir, 'example', 'demo', 'src'), { recursive: true });
      fs.mkdirSync(path.join(freshDir, 'example', 'demo', '.git'), { recursive: true });
      fs.writeFileSync(path.join(freshDir, 'src', 'compiler', 'index.ts'), 'export const x = 1;\n', 'utf-8');
      fs.writeFileSync(path.join(freshDir, 'packages', 'core', 'src', 'types', 'layers.ts'), 'export const y = 2;\n', 'utf-8');
      fs.writeFileSync(path.join(freshDir, 'apps', 'workbench', 'src', 'routes', 'main.tsx'), 'export const z = 3;\n', 'utf-8');
      fs.writeFileSync(path.join(freshDir, 'example', 'demo', 'src', 'main.ts'), 'export const ignored = 0;\n', 'utf-8');

      const result = parseMcpJson(
        await handleToolCall('cotx_source_roots', {
          project_root: freshDir,
          budget: 'tiny',
        }),
      );

      expect(result.inventory.selected_paths).toContain('src');
      expect(result.inventory.selected_paths).toContain('packages/core/src');
      expect(result.inventory.selected_paths).toContain('apps/workbench/src');
      expect(result.inventory.selected_paths).not.toContain('example/demo/src');
      expect(result.inventory.excluded.some((root: { path: string; role: string }) => root.path === 'example/demo/src' && root.role === 'example')).toBe(true);
    } finally {
      fs.rmSync(freshDir, { recursive: true, force: true });
    }
  });

  it('declares cotx_source_roots in the MCP tool list', () => {
    expect(COTX_TOOLS.some((tool) => tool.name === 'cotx_source_roots')).toBe(true);
  });

  it('cotx_prepare_task returns phase, graph health, and enrichment recommendation', async () => {
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# MCP Fixture\n\nThe API entry is api.ts.\n', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"mcp-fixture"}\n', 'utf-8');

    const result = parseMcpJson(
      await handleToolCall('cotx_prepare_task', {
        project_root: tmpDir,
        task: 'understand architecture before changing API routing',
        focus: 'api',
        budget: 'tiny',
      }),
    );

    expect(['bootstrap', 'enrich', 'develop', 'review']).toContain(result.phase);
    expect(result.task_classification.intent).toBe('api');
    expect(result.workspace.summary.repo_boundaries).toBeGreaterThanOrEqual(1);
    expect(result.workspace.source_root_inventory).toBeDefined();
    expect(result.onboarding.summary.has_cotx).toBe(true);
    expect(result.graph_health.has_storage_v2_truth).toBe(true);
    expect(typeof result.enrichment_decision.recommended).toBe('boolean');
    expect(Array.isArray(result.enrichment_decision.triggers)).toBe(true);
    expect(result.recommended_next_tools.length).toBeGreaterThan(0);
  });

  it('declares cotx_prepare_task in the MCP tool list', () => {
    expect(COTX_TOOLS.some((tool) => tool.name === 'cotx_prepare_task')).toBe(true);
  });

  it('cotx_prepare_task falls back to bootstrap when cotx truth is missing', async () => {
    const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-prepare-bootstrap-'));
    try {
      fs.writeFileSync(path.join(freshDir, 'README.md'), '# Fresh Fixture\n', 'utf-8');
      fs.writeFileSync(path.join(freshDir, 'package.json'), '{"name":"fresh-fixture"}\n', 'utf-8');

      const result = parseMcpJson(
        await handleToolCall('cotx_prepare_task', {
          project_root: freshDir,
          task: 'understand the repository',
          budget: 'tiny',
        }),
      );

      expect(result.phase).toBe('bootstrap');
      expect(result.enrichment_decision.recommended).toBe(false);
      expect(result.enrichment_decision.triggers).toContain('missing-cotx-or-truth');
      expect(result.recommended_next_tools.some((tool: { tool: string }) => tool.tool === 'cotx_compile')).toBe(true);
    } finally {
      fs.rmSync(freshDir, { recursive: true, force: true });
    }
  });

  it('cotx_prepare_task prefers review phase when changed files are present and deterministic truth is ready', async () => {
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Change Fixture\n', 'utf-8');

    const result = parseMcpJson(
      await handleToolCall('cotx_prepare_task', {
        project_root: tmpDir,
        task: 'review the current change',
        changed_files: ['api.ts'],
        budget: 'tiny',
      }),
    );

    expect(result.phase).toBe('review');
    expect(result.enrichment_decision.recommended).toBe(false);
    expect(result.recommended_next_tools.some((tool: { tool: string }) => tool.tool === 'cotx_review_change')).toBe(true);
  });

  it('cotx_lint with rules returns rules in response', async () => {
    const result = parseMcpJson(
      await handleToolCall('cotx_lint', {
        project_root: tmpDir,
        rules: ['consistency', 'dead_code'],
      }),
    );
    expect(result.rules).toEqual(['consistency', 'dead_code']);
    expect(Array.isArray(result.issues)).toBe(true);
  });

  it('cotx_lint with rules=architecture enforces forbidden dependency rules without consistency noise', async () => {
    store.writeModule({
      id: 'db',
      canonical_entry: 'Query',
      files: ['db.ts'],
      depends_on: [],
      depended_by: ['api'],
      struct_hash: 'bbbb2222',
    });
    store.writeModule({
      id: 'api',
      canonical_entry: 'Handle',
      files: ['api.ts'],
      depends_on: ['db'],
      depended_by: [],
      struct_hash: 'aaaa1111',
    });
    fs.writeFileSync(path.join(tmpDir, 'api.ts'), 'export const api = true;\n');
    fs.writeFileSync(path.join(tmpDir, 'db.ts'), 'export const db = true;\n');
    fs.writeFileSync(
      path.join(tmpDir, '.cotx', 'rules.yaml'),
      yaml.dump({
        forbidden_dependencies: [
          { from: 'api', to: 'db', message: 'API must not depend on DB directly' },
        ],
      }),
      'utf-8',
    );

    const result = parseMcpJson(
      await handleToolCall('cotx_lint', {
        project_root: tmpDir,
        rules: ['architecture'],
      }),
    );

    expect(result.rules).toEqual(['architecture']);
    expect(result.issues.some((issue: { type: string }) => issue.type === 'ARCHITECTURE_VIOLATION')).toBe(true);
    expect(result.issues.some((issue: { type: string }) => issue.type === 'ORPHAN_MODULE')).toBe(false);
  });

  it('cotx_query semantic mode respects layer filtering', async () => {
    process.env.TEST_LLM_KEY = 'test-key';
    fs.mkdirSync(path.join(tmpHome, '.cotx'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.cotx', 'config.json'),
      JSON.stringify({
        port: 3456,
        host: '127.0.0.1',
        llm: {
          base_url: 'https://api.test.com/v1',
          api_key_env: 'TEST_LLM_KEY',
          chat_model: 'chat-model',
          embedding_model: 'embed-model',
        },
      }, null, 2),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(tmpDir, '.cotx', 'embeddings.json'),
      JSON.stringify({
        model: 'embed-model',
        built_at: '2026-04-09T00:00:00.000Z',
        entries: [
          { id: 'api', layer: 'module', vector: [1, 0] },
          { id: 'token', layer: 'concept', vector: [0.9, 0.1] },
        ],
      }),
      'utf-8',
    );
    store.writeConcept({
      id: 'token',
      aliases: ['tok'],
      appears_in: ['api.ts'],
      layer: 'api',
      struct_hash: 'cccc3333',
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        data: [{ embedding: [1, 0], index: 0 }],
      })),
    );

    const result = parseMcpJson(
      await handleToolCall('cotx_query', {
        project_root: tmpDir,
        query: 'api token',
        mode: 'semantic',
        layer: 'module',
        limit: 10,
      }),
    );

    expect(result.results).toEqual([
      expect.objectContaining({ id: 'api', layer: 'module' }),
    ]);
  });

  it('cotx_query semantic mode filters out stale embedding entries', async () => {
    process.env.TEST_LLM_KEY = 'test-key';
    fs.mkdirSync(path.join(tmpHome, '.cotx'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.cotx', 'config.json'),
      JSON.stringify({
        port: 3456,
        host: '127.0.0.1',
        llm: {
          base_url: 'https://api.test.com/v1',
          api_key_env: 'TEST_LLM_KEY',
          chat_model: 'chat-model',
          embedding_model: 'embed-model',
        },
      }, null, 2),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(tmpDir, '.cotx', 'embeddings.json'),
      JSON.stringify({
        model: 'embed-model',
        built_at: '2026-04-09T00:00:00.000Z',
        entries: [
          { id: 'deleted-node', layer: 'module', vector: [1, 0] },
        ],
      }),
      'utf-8',
    );

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        data: [{ embedding: [1, 0], index: 0 }],
      })),
    );

    const result = parseMcpJson(
      await handleToolCall('cotx_query', {
        project_root: tmpDir,
        query: 'whatever',
        mode: 'semantic',
        limit: 10,
      }),
    );

    expect(result.results).toEqual([]);
  });
});
