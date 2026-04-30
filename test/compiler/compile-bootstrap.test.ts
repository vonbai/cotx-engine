import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ArchitectureStore } from '../../src/store/architecture-store.js';
import type { ArchitectureMeta, ModuleNode } from '../../src/store/schema.js';
import { CotxStore } from '../../src/store/store.js';
import {
  BOOTSTRAP_ENRICHMENT_VERSION,
  runCompileBootstrapEnrichment,
  runIncrementalSemanticEnrichment,
} from '../../src/compiler/compile-bootstrap.js';

function writeModule(store: CotxStore, mod: Partial<ModuleNode> & { id: string; struct_hash: string }): void {
  store.writeModule({
    canonical_entry: '',
    files: [],
    depends_on: [],
    depended_by: [],
    ...mod,
  });
}

function initArchitectureMeta(store: ArchitectureStore, mode: ArchitectureMeta['mode'] = 'auto'): void {
  store.init({
    perspectives: ['overall-architecture'],
    generated_at: '2026-04-15T00:00:00.000Z',
    mode,
    struct_hash: 'arch-hash',
  });
}

describe('runCompileBootstrapEnrichment', () => {
  it('skips bootstrap when llm is not configured and policy is bootstrap-if-available', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-bootstrap-skip-'));
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-bootstrap-home-'));
    const previousHome = process.env.HOME;
    process.env.HOME = tmpHome;

    try {
      const store = new CotxStore(tmpDir);
      store.init('bootstrap-skip');
      initArchitectureMeta(new ArchitectureStore(tmpDir));
      const result = await runCompileBootstrapEnrichment(
        tmpDir,
        store,
        new ArchitectureStore(tmpDir),
        'bootstrap-if-available',
        {
          autoEnrich: async () => {
            throw new Error('should not run');
          },
          enrichArchitecture: async () => {
            throw new Error('should not run');
          },
        },
        () => {},
      );
      expect(result.ran).toBe(false);
      expect(result.skipped_reason).toBe('no-llm-configured');
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('runs module and architecture bootstrap when no baseline exists', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-bootstrap-run-'));
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-bootstrap-home-'));
    const previousHome = process.env.HOME;
    process.env.HOME = tmpHome;
    fs.mkdirSync(path.join(tmpHome, '.cotx'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.cotx', 'config.json'),
      JSON.stringify({
        port: 3000,
        host: '127.0.0.1',
        llm: {
          base_url: 'http://127.0.0.1:4000/v1',
          chat_model: 'vertex/gemini-2.5-flash',
        },
      }),
      'utf-8',
    );

    try {
      const store = new CotxStore(tmpDir);
      store.init('bootstrap-run');
      writeModule(store, { id: 'api', struct_hash: 'hash-a' });
      initArchitectureMeta(new ArchitectureStore(tmpDir));

      const result = await runCompileBootstrapEnrichment(
        tmpDir,
        store,
        new ArchitectureStore(tmpDir),
        'bootstrap-if-available',
        {
          autoEnrich: async () => ({ total: 1, succeeded: 1, failed: 0, results: [] }),
          enrichArchitecture: async () => ({
            perspectives_enriched: 1,
            descriptions_written: 2,
            diagrams_written: 0,
          }),
        },
        () => {},
      );

      expect(result.ran).toBe(true);
      expect(result.layers).toEqual(['module', 'architecture']);
      expect(store.readMeta().bootstrap_enrichment?.baseline_version).toBe(BOOTSTRAP_ENRICHMENT_VERSION);
      // Enrichment is detached to a background worker; summaries land in
      // .cotx/enrichment-status.json, not synchronously in meta.
      expect(result.module_summary).toBeUndefined();
      expect(result.architecture_summary).toBeUndefined();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('skips bootstrap-if-available when baseline metadata already exists', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-bootstrap-baseline-'));
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-bootstrap-home-'));
    const previousHome = process.env.HOME;
    process.env.HOME = tmpHome;
    fs.mkdirSync(path.join(tmpHome, '.cotx'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.cotx', 'config.json'),
      JSON.stringify({
        port: 3000,
        host: '127.0.0.1',
        llm: {
          base_url: 'http://127.0.0.1:4000/v1',
          chat_model: 'vertex/gemini-2.5-flash',
        },
      }),
      'utf-8',
    );

    try {
      const store = new CotxStore(tmpDir);
      store.init('bootstrap-baseline');
      writeModule(store, {
        id: 'api',
        struct_hash: 'hash-a',
        enriched: {
          responsibility: 'API layer',
          source_hash: 'hash-a',
          enriched_at: '2026-04-15T00:00:00.000Z',
        },
      });
      const archStore = new ArchitectureStore(tmpDir);
      initArchitectureMeta(archStore, 'llm');
      archStore.writeDescription('overall-architecture', 'Human-quality architecture summary');
      store.updateMeta({
        bootstrap_enrichment: {
          schema_version: 'cotx.bootstrap_enrichment.v1',
          baseline_version: BOOTSTRAP_ENRICHMENT_VERSION,
          policy: 'bootstrap-if-available',
          created_at: '2026-04-15T00:00:00.000Z',
          layers: ['module', 'architecture'],
        },
      });

      const result = await runCompileBootstrapEnrichment(
        tmpDir,
        store,
        archStore,
        'bootstrap-if-available',
        {
          autoEnrich: async () => {
            throw new Error('should not run');
          },
          enrichArchitecture: async () => {
            throw new Error('should not run');
          },
        },
        () => {},
      );

      expect(result.ran).toBe(false);
      expect(result.skipped_reason).toBe('bootstrap-baseline-already-present');
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('incremental enrichment targets only affected stale nodes by default', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-incremental-run-'));
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-bootstrap-home-'));
    const previousHome = process.env.HOME;
    process.env.HOME = tmpHome;
    fs.mkdirSync(path.join(tmpHome, '.cotx'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.cotx', 'config.json'),
      JSON.stringify({
        port: 3000,
        host: '127.0.0.1',
        llm: {
          base_url: 'http://127.0.0.1:4000/v1',
          chat_model: 'vertex/gemini-2.5-flash',
        },
      }),
      'utf-8',
    );

    try {
      const store = new CotxStore(tmpDir);
      store.init('incremental-run');
      let capturedNodeIds: string[] = [];

      const result = await runIncrementalSemanticEnrichment(
        tmpDir,
        store,
        'affected-if-available',
        [
          { nodeId: 'module:a', layer: 'module' },
          { nodeId: 'module:b', layer: 'module' },
        ],
        ['module:b'],
        {
          autoEnrich: async (_projectRoot, options) => {
            capturedNodeIds = options?.nodeIds ?? [];
            return {
              total: capturedNodeIds.length,
              succeeded: capturedNodeIds.length,
              failed: 0,
              results: [],
            };
          },
        },
        () => {},
      );

      expect(result.ran).toBe(true);
      expect(result.target_node_ids).toEqual(['module:b']);
      expect(capturedNodeIds).toEqual(['module:b']);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
