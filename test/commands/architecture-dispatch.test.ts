import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandContext } from '../../src/commands/context.js';
import { commandQuery, QUERY_LAYER_HELP } from '../../src/commands/query.js';
import { ArchitectureStore } from '../../src/store/architecture-store.js';
import { CotxStore } from '../../src/store/store.js';

describe('CLI architecture dispatch', () => {
  let tmpDir: string;
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-cli-arch-'));
    const store = new CotxStore(tmpDir);
    store.init('cli-arch-test');

    const archStore = new ArchitectureStore(tmpDir);
    archStore.init({
      perspectives: ['overall-architecture'],
      generated_at: '2026-04-14T00:00:00Z',
      mode: 'auto',
      struct_hash: 'abc',
    });
    archStore.writePerspective({
      id: 'overall-architecture',
      label: 'Overall Architecture',
      components: [{
        id: 'store',
        label: 'Store Layer',
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
      label: 'Store Layer',
      kind: 'leaf',
      directory: 'src/store',
      files: ['src/store/store.ts'],
      exported_functions: ['writeModule'],
      stats: { file_count: 1, function_count: 5, total_cyclomatic: 10, max_cyclomatic: 3, max_nesting_depth: 1, risk_score: 10 },
    });
    archStore.writeDescription('overall-architecture', 'Main architecture');
    archStore.writeDescription('overall-architecture/store', 'Stores canonical map data.');

    spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    spy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('queries canonical architecture data when layer is architecture', async () => {
    await commandQuery(tmpDir, 'writeModule', { layer: 'architecture' });

    const output = spy.mock.calls.flat().join('\n');
    expect(output).toContain('Found');
    expect(output).toContain('[architecture:element] architecture/overall-architecture/store');
  });

  it('advertises architecture as a query layer', () => {
    expect(QUERY_LAYER_HELP).toContain('architecture');
  });

  it('prints canonical architecture context for architecture-prefixed ids', async () => {
    await commandContext(tmpDir, 'architecture/overall-architecture/store');

    const output = spy.mock.calls.flat().join('\n');
    const parsed = JSON.parse(output);
    expect(parsed.layer).toBe('architecture');
    expect(parsed.data.id).toBe('store');
    expect(parsed.data.description).toBe('Stores canonical map data.');
  });

  it('prints not found for unknown architecture perspectives', async () => {
    await commandContext(tmpDir, 'architecture/missing-perspective/store');

    const output = spy.mock.calls.flat().join('\n');
    expect(output).toBe('Architecture node "architecture/missing-perspective/store" not found.');
  });
});
