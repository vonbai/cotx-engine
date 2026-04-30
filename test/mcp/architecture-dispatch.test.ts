// test/mcp/architecture-dispatch.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CotxStore } from '../../src/store/store.js';
import { ArchitectureStore } from '../../src/store/architecture-store.js';
import { handleToolCall } from '../../src/mcp/tools.js';

function parseMcpJson(result: Awaited<ReturnType<typeof handleToolCall>>): any {
  return JSON.parse(result.content[0].text);
}

describe('MCP architecture dispatch', () => {
  let tmpDir: string;
  let tmpHome: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-mcp-arch-'));
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-mcp-arch-home-'));
    previousHome = process.env.HOME;
    process.env.HOME = tmpHome;

    // Set up CotxStore
    const store = new CotxStore(tmpDir);
    store.init('test');
    store.updateMeta({ compiled_at: '2026-04-09T00:00:00Z' });

    // Set up ArchitectureStore
    const archStore = new ArchitectureStore(tmpDir);
    archStore.init({
      perspectives: ['overall-architecture', 'data-flow'],
      generated_at: '2026-04-09T00:00:00Z',
      mode: 'auto',
      struct_hash: 'abc',
    });
    archStore.writePerspective({
      id: 'overall-architecture',
      label: 'Overall Architecture',
      components: [{
        id: 'store',
        label: 'Store',
        kind: 'leaf',
        directory: 'src/store',
        files: ['src/store/store.ts'],
        exported_functions: ['writeModule'],
        stats: { file_count: 1, function_count: 5, total_cyclomatic: 10, max_cyclomatic: 3, max_nesting_depth: 1, risk_score: 10 },
      }],
      edges: [],
    });
    archStore.writeElement('overall-architecture', 'store', {
      id: 'store',
      label: 'Store',
      kind: 'leaf',
      directory: 'src/store',
      files: ['src/store/store.ts'],
      exported_functions: ['writeModule'],
      stats: { file_count: 1, function_count: 5, total_cyclomatic: 10, max_cyclomatic: 3, max_nesting_depth: 1, risk_score: 10 },
    });
    archStore.writeDescription('overall-architecture', 'Main architecture');
    archStore.writePerspective({
      id: 'data-flow',
      label: 'Data Flow',
      components: [{
        id: 'store',
        label: 'Store',
        kind: 'leaf',
        directory: 'src/store',
        files: ['src/store/store.ts'],
        related_flows: ['compile-flow'],
        stats: { file_count: 1, function_count: 5, total_cyclomatic: 10, max_cyclomatic: 3, max_nesting_depth: 1, risk_score: 10 },
      }],
      edges: [],
    });
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('cotx_context dispatches architecture/ prefix to ArchitectureStore', async () => {
    const result = parseMcpJson(
      await handleToolCall('cotx_context', {
        project_root: tmpDir,
        node_id: 'architecture/overall-architecture',
      }),
    );
    expect(result.layer).toBe('architecture');
    expect(result.data.id).toBe('overall-architecture');
    expect(result.children).toBeDefined();
  });

  it('cotx_context dispatches architecture/ nested element', async () => {
    const result = parseMcpJson(
      await handleToolCall('cotx_context', {
        project_root: tmpDir,
        node_id: 'architecture/overall-architecture/store',
      }),
    );
    expect(result.layer).toBe('architecture');
    expect(result.data.id).toBe('store');
  });

  it('cotx_context falls back to perspective component for non-overall perspectives', async () => {
    const result = parseMcpJson(
      await handleToolCall('cotx_context', {
        project_root: tmpDir,
        node_id: 'architecture/data-flow/store',
      }),
    );
    expect(result.layer).toBe('architecture');
    expect(result.data.id).toBe('store');
    expect(result.data.related_flows).toContain('compile-flow');
  });

  it('cotx_map with scope=architecture returns perspective list', async () => {
    const result = parseMcpJson(
      await handleToolCall('cotx_map', {
        project_root: tmpDir,
        scope: 'architecture',
      }),
    );
    expect(result.perspectives).toBeDefined();
    expect(result.perspectives.length).toBeGreaterThan(0);
  });

  it('cotx_write dispatches architecture/ to ArchitectureStore', async () => {
    const result = parseMcpJson(
      await handleToolCall('cotx_write', {
        project_root: tmpDir,
        node_id: 'architecture/overall-architecture',
        field: 'description',
        content: 'Updated architecture description',
      }),
    );
    expect(result.success ?? result.status).toBeTruthy();

    // Verify it was written
    const archStore = new ArchitectureStore(tmpDir);
    expect(archStore.readDescription('overall-architecture')).toBe('Updated architecture description');
  });

  it('cotx_write batch mode dispatches architecture paths', async () => {
    const result = parseMcpJson(
      await handleToolCall('cotx_write', {
        project_root: tmpDir,
        writes: [
          {
            node_id: 'architecture/overall-architecture',
            field: 'description',
            content: 'Batch updated architecture description',
          },
          {
            node_id: 'architecture/overall-architecture/store',
            field: 'description',
            content: 'Store batch description',
          },
        ],
      }),
    );
    expect(result.succeeded).toBe(2);

    const archStore = new ArchitectureStore(tmpDir);
    expect(archStore.readDescription('overall-architecture')).toBe('Batch updated architecture description');
    expect(archStore.readDescription('overall-architecture/store')).toBe('Store batch description');
  });

  it('cotx_query with layer=architecture searches architecture index', async () => {
    const result = parseMcpJson(
      await handleToolCall('cotx_query', {
        project_root: tmpDir,
        query: 'store writeModule',
        layer: 'architecture',
      }),
    );
    expect(result.results.length).toBeGreaterThan(0);
  });
});
