import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ArchitectureStore } from '../../src/store/architecture-store.js';
import {
  hashArchitectureEnrichmentOutput,
  validateArchitectureEnrichmentJob,
  validateArchitectureEnrichmentJobWithGraph,
  validateArchitectureTarget,
} from '../../src/compiler/architecture-enrichment-job.js';
import type { ArchitectureEnrichmentJob, ArchitectureWorkspaceData } from '../../src/store/schema.js';
import { GraphTruthStore } from '../../src/store-v2/graph-truth-store.js';

describe('architecture enrichment job validation', () => {
  let tmpDir: string;
  let archStore: ArchitectureStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-arch-job-'));
    archStore = new ArchitectureStore(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Project\n', 'utf-8');
    const workspace: ArchitectureWorkspaceData = {
      schema_version: 'cotx.architecture.workspace.v1',
      generated_at: '2026-04-13T00:00:00Z',
      elements: [
        {
          id: 'container:compiler',
          name: 'Compiler',
          level: 'container',
          evidence: [{ kind: 'file', id: 'README.md', filePath: 'README.md' }],
          review_status: 'draft',
        },
      ],
      relationships: [],
      views: [],
    };
    archStore.writeWorkspace(workspace);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeJob(overrides: Partial<ArchitectureEnrichmentJob> = {}): ArchitectureEnrichmentJob {
    const content = 'Compiler owns deterministic analysis.';
    return {
      schema_version: 'cotx.architecture.enrichment_job.v1',
      id: 'job:compiler',
      mode: 'caller-agent',
      target: { kind: 'architecture-element', id: 'container:compiler', field: 'description' },
      prompt_version: 'architecture-v1',
      input_graph_compiled_at: '2026-04-13T00:00:00Z',
      created_at: '2026-04-13T00:01:00Z',
      evidence: [{ kind: 'file', id: 'README.md', filePath: 'README.md' }],
      output: {
        format: 'markdown',
        content,
        hash: hashArchitectureEnrichmentOutput(content),
      },
      review_status: 'draft',
      ...overrides,
    };
  }

  it('accepts jobs with file evidence, a valid architecture target, and matching output hash', () => {
    const result = validateArchitectureTarget(tmpDir, makeJob(), archStore);
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it('rejects jobs without evidence', () => {
    const result = validateArchitectureEnrichmentJob(tmpDir, makeJob({ evidence: [] }), archStore);
    expect(result.ok).toBe(false);
    expect(result.findings.some((finding) => finding.code === 'MISSING_EVIDENCE')).toBe(true);
  });

  it('rejects missing file evidence and mismatched output hashes', () => {
    const result = validateArchitectureEnrichmentJob(tmpDir, makeJob({
      evidence: [{ kind: 'file', id: 'docs/missing.md', filePath: 'docs/missing.md' }],
      output: { format: 'markdown', content: 'changed', hash: 'wrong' },
    }), archStore);
    expect(result.ok).toBe(false);
    expect(result.findings.some((finding) => finding.code === 'MISSING_FILE')).toBe(true);
    expect(result.findings.some((finding) => finding.code === 'OUTPUT_HASH_MISMATCH')).toBe(true);
  });

  it('rejects missing architecture workspace targets', () => {
    const result = validateArchitectureTarget(tmpDir, makeJob({
      target: { kind: 'architecture-element', id: 'container:missing' },
    }), archStore);
    expect(result.ok).toBe(false);
    expect(result.findings.some((finding) => finding.code === 'MISSING_ARCHITECTURE_ELEMENT')).toBe(true);
  });

  it('keeps storage-v2 node anchors as explicit warnings until graph-backed validation is wired', () => {
    const result = validateArchitectureEnrichmentJob(tmpDir, makeJob({
      evidence: [{ kind: 'node', id: 'Function:src/index.ts:run', filePath: 'src/index.ts' }],
    }), archStore);
    expect(result.ok).toBe(true);
    expect(result.findings.some((finding) => finding.code === 'UNSUPPORTED_ANCHOR_VALIDATION')).toBe(true);
  });

  it('validates storage-v2 node, route, tool, process, relation, and module anchors when graph data exists', async () => {
    const graph = new GraphTruthStore({ dbPath: path.join(tmpDir, '.cotx', 'v2', 'truth.lbug') });
    await graph.open();
    try {
      await graph.writeFacts({
        codeNodes: [
          { id: 'Function:src/index.ts:run', label: 'Function', name: 'run', filePath: 'src/index.ts', startLine: 1, endLine: 3, isExported: true, properties: '{}' },
          { id: 'Function:src/store.ts:save', label: 'Function', name: 'save', filePath: 'src/store.ts', startLine: 1, endLine: 3, isExported: true, properties: '{}' },
          { id: 'route:GET /users', label: 'Route', name: '/users', filePath: 'src/index.ts', startLine: 1, endLine: 1, isExported: false, properties: '{}' },
          { id: 'tool:create_user', label: 'Tool', name: 'create_user', filePath: 'src/tools.ts', startLine: 1, endLine: 1, isExported: false, properties: '{}' },
          { id: 'process:create_user', label: 'Process', name: 'create_user', filePath: '', startLine: 0, endLine: 0, isExported: false, properties: '{}' },
        ],
        codeRelations: [
          { from: 'Function:src/index.ts:run', to: 'Function:src/store.ts:save', type: 'CALLS', confidence: 1, reason: '', step: 0 },
        ],
      });
      await graph.writeSemanticArtifacts([
        {
          id: 'api',
          layer: 'module',
          structHash: 'api-hash',
          payload: { id: 'api', files: ['src/index.ts'] },
        },
      ]);
    } finally {
      await graph.close();
    }

    const result = await validateArchitectureEnrichmentJobWithGraph(tmpDir, makeJob({
      evidence: [
        { kind: 'node', id: 'Function:src/index.ts:run', filePath: 'src/index.ts' },
        { kind: 'route', id: 'route:GET /users' },
        { kind: 'tool', id: 'tool:create_user' },
        { kind: 'process', id: 'process:create_user' },
        { kind: 'relation', id: 'Function:src/index.ts:run->Function:src/store.ts:save' },
        { kind: 'module', id: 'api' },
      ],
    }), archStore);

    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it('fails graph-backed validation for missing storage-v2 anchors', async () => {
    const graph = new GraphTruthStore({ dbPath: path.join(tmpDir, '.cotx', 'v2', 'truth.lbug') });
    await graph.open();
    await graph.close();

    const result = await validateArchitectureEnrichmentJobWithGraph(tmpDir, makeJob({
      evidence: [{ kind: 'node', id: 'Function:missing' }],
    }), archStore);
    expect(result.ok).toBe(false);
    expect(result.findings.some((finding) => finding.code === 'MISSING_GRAPH_ANCHOR')).toBe(true);
  });
});
