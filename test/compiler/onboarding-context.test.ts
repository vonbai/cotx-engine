import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { collectOnboardingContext } from '../../src/compiler/onboarding-context.js';

describe('collectOnboardingContext', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-onboarding-'));
    fs.mkdirSync(path.join(tmpDir, 'src', 'store'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'docs', 'architecture'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'packages', 'core'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'example', 'reference'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'assets', 'icons'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.cotx', 'graph'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.cotx', 'architecture', 'overall-architecture', 'store'), { recursive: true });

    fs.writeFileSync(
      path.join(tmpDir, 'README.md'),
      '# Fixture Engine\n\nSee src/store/store.ts and src/missing.ts.\n',
      'utf-8',
    );
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# Agent Notes\n\nStart with README.md.\n', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# Claude Notes\n\nUse docs/architecture/overview.md.\n', 'utf-8');
    fs.writeFileSync(
      path.join(tmpDir, 'docs', 'architecture', 'overview.md'),
      '# Architecture\n\nStore path: src/store/store.ts. Exists but not indexed: src/store/unindexed.ts.\n',
      'utf-8',
    );
    fs.writeFileSync(path.join(tmpDir, 'src', 'store', 'store.ts'), 'export const store = true;\n', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'src', 'store', 'jsonl.ts'), 'export const jsonl = true;\n', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'src', 'store', 'unindexed.ts'), 'export const gap = true;\n', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'assets', 'icons', 'logo.png'), 'png', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'example', 'reference', 'README.md'), '# Reference Repo\n', 'utf-8');

    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({
        name: 'fixture-engine',
        description: 'Fixture project',
        type: 'module',
        workspaces: ['packages/*'],
        bin: { fixture: 'dist/index.js' },
        scripts: { build: 'tsc', test: 'vitest', lint: 'tsc --noEmit' },
      }, null, 2),
      'utf-8',
    );
    fs.writeFileSync(path.join(tmpDir, 'packages', 'core', 'package.json'), '{"name":"core"}\n', 'utf-8');

    fs.writeFileSync(
      path.join(tmpDir, '.cotx', 'meta.yaml'),
      yaml.dump({
        version: '0.1',
        project: 'fixture-engine',
        compiled_at: '2026-04-13T00:00:00.000Z',
        stats: { modules: 1, concepts: 0, contracts: 0, flows: 0, concerns: 0 },
      }),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(tmpDir, '.cotx', 'index.json'),
      JSON.stringify({
        version: '0.1',
        compiled_at: '2026-04-13T00:00:00.000Z',
        project: 'fixture-engine',
        stats: {},
        graph: {
          nodes: [{ id: 'store', layer: 'module', file: 'src/store/store.ts' }],
          edges: [],
        },
      }),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(tmpDir, '.cotx', 'graph', 'nodes.json'),
      [
        JSON.stringify({ id: 'File:src/store/store.ts', label: 'File', properties: { filePath: 'src/store/store.ts' } }),
        JSON.stringify({ id: 'File:src/store/jsonl.ts', label: 'File', properties: { filePath: 'src/store/jsonl.ts' } }),
      ].join('\n') + '\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(tmpDir, '.cotx', 'architecture', 'meta.yaml'),
      yaml.dump({
        perspectives: ['overall-architecture'],
        generated_at: '2026-04-12T00:00:00.000Z',
        mode: 'auto',
        struct_hash: 'abc',
      }),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(tmpDir, '.cotx', 'architecture', 'overall-architecture', 'data.yaml'),
      yaml.dump({
        id: 'overall-architecture',
        label: 'Overall Architecture',
        components: [{
          id: 'store',
          label: 'Store',
          kind: 'leaf',
          directory: 'src/store',
          files: ['src/store/store.ts', 'src/store/jsonl.ts'],
          stats: { file_count: 1, function_count: 1, total_cyclomatic: 1, max_cyclomatic: 1, max_nesting_depth: 1, risk_score: 1 },
        }],
        edges: [],
      }),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(tmpDir, '.cotx', 'architecture', 'overall-architecture', 'store', 'data.yaml'),
      yaml.dump({
        id: 'store',
        label: 'Store',
        kind: 'leaf',
        directory: 'src/store',
        files: ['src/store/store.ts', 'src/store/jsonl.ts'],
        stats: { file_count: 1, function_count: 1, total_cyclomatic: 1, max_cyclomatic: 1, max_nesting_depth: 1, risk_score: 1 },
      }),
      'utf-8',
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('collects repo onboarding sources from docs, manifests, and examples while keeping .cotx out of the source set', () => {
    const context = collectOnboardingContext(tmpDir, { budget: 'standard' });
    const kinds = new Set(context.sources.map((source) => source.kind));

    expect(kinds).toContain('readme');
    expect(kinds).toContain('agent-instructions');
    expect(kinds).toContain('architecture-doc');
    expect(kinds).toContain('manifest');
    expect(kinds).toContain('example');
    expect(kinds).not.toContain('cotx');
    expect(context.summary.sources_by_kind.cotx).toBe(0);
    expect(context.summary.has_cotx).toBe(true);
    expect(context.summary.has_architecture_store).toBe(true);
    expect(context.summary.graph_file_count).toBe(2);
    expect(context.summary.graph_file_index_status).toBe('complete');
    expect(context.workspace_scan.summary.packages).toBeGreaterThanOrEqual(2);
    expect(context.summary.workspace_candidates).toBe(context.workspace_scan.summary.candidates);
    expect(context.summary.asset_directories).toBeGreaterThanOrEqual(1);
  });

  it('emits deterministic architecture hypotheses from sampled onboarding sources', () => {
    const context = collectOnboardingContext(tmpDir, { budget: 'standard' });
    const hypothesisKinds = new Set(context.hypotheses.map((hypothesis) => hypothesis.kind));

    expect(hypothesisKinds).toContain('project-purpose');
    expect(hypothesisKinds).toContain('runtime');
    expect(hypothesisKinds).toContain('workspace-layout');
    expect(hypothesisKinds).toContain('command-surface');
    expect(hypothesisKinds).toContain('semantic-map');
    expect(hypothesisKinds).toContain('architecture-store');
  });

  it('classifies doc and architecture anchors by graph consistency status', () => {
    const context = collectOnboardingContext(tmpDir, { budget: 'standard' });

    expect(context.consistency.confirmed.some((finding) => finding.subject === 'src/store/store.ts')).toBe(true);
    expect(context.consistency.confirmed.some((finding) => finding.subject === 'src/store/jsonl.ts')).toBe(true);
    expect(context.consistency.contradicted.some((finding) => finding.subject === 'src/missing.ts')).toBe(true);
    expect(context.consistency['graph-gap'].some((finding) => finding.subject === 'src/store/unindexed.ts')).toBe(true);
    expect(context.consistency['graph-gap'].some((finding) => finding.subject === '.cotx/v2/truth.lbug')).toBe(true);
    expect(context.consistency['stale-doc'].some((finding) => finding.subject === '.cotx/architecture')).toBe(true);
    expect(context.summary.consistency_counts.confirmed).toBeGreaterThan(0);
  });

  it('keeps tiny budget output compact by omitting excerpts', () => {
    const context = collectOnboardingContext(tmpDir, { budget: 'tiny' });
    expect(context.sources.every((source) => source.excerpt === undefined)).toBe(true);
    expect(context.budget).toBe('tiny');
  });

  it('keeps root repo docs visible even when many example files compete for candidate budget', () => {
    for (let i = 0; i < 120; i += 1) {
      const dir = path.join(tmpDir, 'example', 'reference', `case-${i}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'README.md'), `# Example ${i}\n`, 'utf-8');
    }

    const context = collectOnboardingContext(tmpDir, { budget: 'tiny' });
    const paths = new Set(context.sources.map((source) => source.path));

    expect(paths).toContain('README.md');
    expect(paths).toContain('AGENTS.md');
    expect(paths).toContain('package.json');
    expect(context.summary.sources_by_kind.example).toBeLessThanOrEqual(8);
    expect(context.hypotheses.some((hypothesis) => hypothesis.kind === 'semantic-map')).toBe(true);
    expect(context.hypotheses.some((hypothesis) => hypothesis.kind === 'architecture-store')).toBe(true);
  });
});
