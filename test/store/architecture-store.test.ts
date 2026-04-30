// test/store/architecture-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import yaml from 'js-yaml';
import { ArchitectureStore } from '../../src/store/architecture-store.js';
import type { ArchitectureBoundaryReview, ArchitectureEnrichmentJob, ArchitectureRecursionPlan, ArchitectureWorkspaceData, PerspectiveData, ArchitectureMeta } from '../../src/store/schema.js';

describe('ArchitectureStore', () => {
  let tmpDir: string;
  let store: ArchitectureStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-arch-store-'));
    store = new ArchitectureStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exists() returns false before init', () => {
    expect(store.exists()).toBe(false);
  });

  it('init creates architecture directory and meta.yaml', () => {
    store.init({
      perspectives: ['overall-architecture'],
      generated_at: '2026-04-09T00:00:00Z',
      mode: 'auto',
      struct_hash: 'abc123',
    });
    expect(store.exists()).toBe(true);
    const meta = store.readMeta();
    expect(meta.perspectives).toEqual(['overall-architecture']);
    expect(meta.mode).toBe('auto');
  });

  it('writes and reads a perspective', () => {
    store.init({
      perspectives: ['overall-architecture'],
      generated_at: '2026-04-09T00:00:00Z',
      mode: 'auto',
      struct_hash: 'abc',
    });
    const perspective: PerspectiveData = {
      id: 'overall-architecture',
      label: 'Overall Architecture',
      components: [
        {
          id: 'store',
          label: 'Store',
          kind: 'leaf',
          directory: 'src/store',
          files: ['src/store/store.ts', 'src/store/schema.ts'],
          stats: { file_count: 2, function_count: 10, total_cyclomatic: 20, max_cyclomatic: 5, max_nesting_depth: 2, risk_score: 15 },
        },
      ],
      edges: [
        { from: 'compiler', to: 'store', label: 'writeModule, writeConcept', type: 'dependency', weight: 5 },
      ],
    };
    store.writePerspective(perspective);
    const loaded = store.readPerspective('overall-architecture');
    expect(loaded.id).toBe('overall-architecture');
    expect(loaded.components).toHaveLength(1);
    expect(loaded.components[0].id).toBe('store');
    expect(loaded.edges).toHaveLength(1);
  });

  it('writeDescription and readDescription for a perspective', () => {
    store.init({
      perspectives: ['overall-architecture'],
      generated_at: '2026-04-09T00:00:00Z',
      mode: 'auto',
      struct_hash: 'abc',
    });
    const perspective: PerspectiveData = {
      id: 'overall-architecture',
      label: 'Overall Architecture',
      components: [],
      edges: [],
    };
    store.writePerspective(perspective);
    store.writeDescription('overall-architecture', 'This is the main architecture.');
    expect(store.readDescription('overall-architecture')).toBe('This is the main architecture.');
  });

  it('writeDiagram and readDiagram for a perspective', () => {
    store.init({
      perspectives: ['overall-architecture'],
      generated_at: '2026-04-09T00:00:00Z',
      mode: 'auto',
      struct_hash: 'abc',
    });
    const perspective: PerspectiveData = {
      id: 'overall-architecture',
      label: 'Overall Architecture',
      components: [],
      edges: [],
    };
    store.writePerspective(perspective);
    store.writeDiagram('overall-architecture', 'graph TD\n  A --> B');
    expect(store.readDiagram('overall-architecture')).toBe('graph TD\n  A --> B');
  });

  it('writes and reads nested element data by path', () => {
    store.init({
      perspectives: ['overall-architecture'],
      generated_at: '2026-04-09T00:00:00Z',
      mode: 'auto',
      struct_hash: 'abc',
    });
    const perspective: PerspectiveData = {
      id: 'overall-architecture',
      label: 'Overall Architecture',
      components: [{
        id: 'compiler',
        label: 'Compiler',
        kind: 'group',
        directory: 'src/compiler',
        children: ['module-compiler'],
        stats: { file_count: 5, function_count: 20, total_cyclomatic: 50, max_cyclomatic: 8, max_nesting_depth: 3, risk_score: 25 },
      }],
      edges: [],
    };
    store.writePerspective(perspective);
    store.writeElement('overall-architecture', 'compiler/module-compiler', {
      id: 'module-compiler',
      label: 'Module Compiler',
      kind: 'leaf',
      directory: 'src/compiler/module-compiler.ts',
      files: ['src/compiler/module-compiler.ts'],
      exported_functions: ['compileModules'],
      stats: { file_count: 1, function_count: 4, total_cyclomatic: 10, max_cyclomatic: 4, max_nesting_depth: 2, risk_score: 12 },
    });
    const loaded = store.readElement('overall-architecture', 'compiler/module-compiler');
    expect(loaded.id).toBe('module-compiler');
    expect(loaded.kind).toBe('leaf');
  });

  it('reads and writes sidecars by full architecture path', () => {
    store.init({
      perspectives: ['overall-architecture'],
      generated_at: '2026-04-09T00:00:00Z',
      mode: 'auto',
      struct_hash: 'abc',
    });
    store.writePerspective({
      id: 'overall-architecture',
      label: 'Overall Architecture',
      components: [],
      edges: [],
    });
    store.writeDescription('overall-architecture/compiler', 'Compiler pipeline');
    expect(store.readDescription('overall-architecture/compiler')).toBe('Compiler pipeline');
  });

  it('lists immediate child element names for a nested path', () => {
    store.init({
      perspectives: ['overall-architecture'],
      generated_at: '2026-04-09T00:00:00Z',
      mode: 'auto',
      struct_hash: 'abc',
    });
    store.writePerspective({
      id: 'overall-architecture',
      label: 'Overall Architecture',
      components: [],
      edges: [],
    });
    store.writeElement('overall-architecture', 'compiler', {
      id: 'compiler',
      label: 'Compiler',
      kind: 'group',
      directory: 'src/compiler',
      children: ['module-compiler'],
      stats: { file_count: 1, function_count: 1, total_cyclomatic: 1, max_cyclomatic: 1, max_nesting_depth: 1, risk_score: 1 },
    });
    store.writeElement('overall-architecture', 'compiler/module-compiler', {
      id: 'module-compiler',
      label: 'Module Compiler',
      kind: 'leaf',
      directory: 'src/compiler/module-compiler.ts',
      files: ['src/compiler/module-compiler.ts'],
      stats: { file_count: 1, function_count: 1, total_cyclomatic: 1, max_cyclomatic: 1, max_nesting_depth: 1, risk_score: 1 },
    });
    expect(store.listChildren('overall-architecture/compiler')).toEqual(['module-compiler']);
  });

  it('listPerspectives returns perspective IDs', () => {
    store.init({
      perspectives: ['overall-architecture', 'data-flow'],
      generated_at: '2026-04-09T00:00:00Z',
      mode: 'auto',
      struct_hash: 'abc',
    });
    expect(store.listPerspectives()).toEqual(['overall-architecture', 'data-flow']);
  });

  it('writes and reads canonical C4 workspace data without requiring legacy perspectives', () => {
    const workspace: ArchitectureWorkspaceData = {
      schema_version: 'cotx.architecture.workspace.v1',
      generated_at: '2026-04-13T00:00:00Z',
      source_graph_compiled_at: '2026-04-13T00:00:00Z',
      elements: [
        {
          id: 'system:cotx-engine',
          name: 'cotx-engine',
          level: 'software_system',
          description: 'Compiles repositories into queryable semantic maps.',
          evidence: [{ kind: 'file', id: 'README.md', filePath: 'README.md' }],
          review_status: 'draft',
        },
        {
          id: 'container:compiler',
          name: 'Compiler',
          level: 'container',
          parent_id: 'system:cotx-engine',
          source_paths: ['src/compiler'],
          evidence: [{ kind: 'module', id: 'compiler' }],
          review_status: 'draft',
        },
      ],
      relationships: [
        {
          id: 'rel:compiler-store',
          source_id: 'container:compiler',
          target_id: 'container:store',
          description: 'writes semantic artifacts',
          evidence: [{ kind: 'relation', id: 'compiler->store', detail: 'dependency' }],
          review_status: 'draft',
        },
      ],
      views: [
        {
          id: 'view:containers',
          name: 'Containers',
          type: 'container',
          element_ids: ['system:cotx-engine', 'container:compiler'],
          relationship_ids: ['rel:compiler-store'],
          review_status: 'draft',
        },
      ],
    };

    expect(store.readWorkspace()).toBeNull();
    store.writeWorkspace(workspace);
    const loaded = store.readWorkspace();
    expect(loaded?.schema_version).toBe('cotx.architecture.workspace.v1');
    expect(loaded?.elements.map((element) => element.id)).toEqual(['system:cotx-engine', 'container:compiler']);
    expect(loaded?.relationships[0].evidence[0].kind).toBe('relation');
    expect(store.exists()).toBe(false);
  });

  it('writes, reads, and lists architecture enrichment jobs', () => {
    const job: ArchitectureEnrichmentJob = {
      schema_version: 'cotx.architecture.enrichment_job.v1',
      id: 'job:architecture-element:compiler',
      mode: 'caller-agent',
      target: { kind: 'architecture-element', id: 'container:compiler', field: 'description' },
      prompt_version: 'architecture-v1',
      input_graph_compiled_at: '2026-04-13T00:00:00Z',
      created_at: '2026-04-13T00:01:00Z',
      evidence: [{ kind: 'file', id: 'README.md', filePath: 'README.md' }],
      output: {
        format: 'markdown',
        content: 'Compiler owns deterministic analysis.',
        hash: 'test-hash',
      },
      review_status: 'draft',
    };

    expect(store.listEnrichmentJobs()).toEqual([]);
    store.writeEnrichmentJob(job);
    expect(store.listEnrichmentJobs()).toEqual(['job:architecture-element:compiler']);
    expect(store.readEnrichmentJob(job.id)?.target.id).toBe('container:compiler');
  });

  it('writes and reads architecture recursion plans', () => {
    const plan: ArchitectureRecursionPlan = {
      schema_version: 'cotx.architecture.recursion_plan.v1',
      generated_at: '2026-04-13T00:02:00Z',
      source_workspace_generated_at: '2026-04-13T00:01:00Z',
      decisions: [
        {
          element_id: 'system:cotx-engine',
          action: 'recurse',
          reason: 'Element has child architecture elements.',
          child_element_ids: ['container:compiler'],
          evidence: [{ kind: 'file', id: 'README.md', filePath: 'README.md' }],
        },
      ],
    };

    expect(store.readRecursionPlan()).toBeNull();
    store.writeRecursionPlan(plan);
    expect(store.readRecursionPlan()?.decisions[0].action).toBe('recurse');
  });

  it('writes and reads architecture boundary reviews', () => {
    const review: ArchitectureBoundaryReview = {
      schema_version: 'cotx.architecture.boundary_review.v1',
      generated_at: '2026-04-13T00:03:00Z',
      source_workspace_generated_at: '2026-04-13T00:01:00Z',
      decisions: [
        {
          element_id: 'container:README',
          action: 'exclude_from_docs',
          reason: 'README is documentation, not a runtime container.',
          evidence_anchor_refs: ['file:README.md'],
        },
      ],
    };

    expect(store.readBoundaryReview()).toBeNull();
    store.writeBoundaryReview(review);
    expect(store.readBoundaryReview()?.decisions[0].action).toBe('exclude_from_docs');
  });

  it('writeField dispatches by full path and field', () => {
    store.init({
      perspectives: ['overall-architecture'],
      generated_at: '2026-04-09T00:00:00Z',
      mode: 'auto',
      struct_hash: 'abc',
    });
    store.writePerspective({
      id: 'overall-architecture',
      label: 'Overall Architecture',
      components: [],
      edges: [],
    });
    store.writeField('overall-architecture', 'description', 'Test desc');
    store.writeField('overall-architecture', 'diagram', 'graph TD\n  X --> Y');
    expect(store.readDescription('overall-architecture')).toBe('Test desc');
    expect(store.readDiagram('overall-architecture')).toBe('graph TD\n  X --> Y');
  });

  it('readPerspective overlays top-level element docs over perspective components', () => {
    store.init({
      perspectives: ['overall-architecture'],
      generated_at: '2026-04-09T00:00:00Z',
      mode: 'auto',
      struct_hash: 'abc',
    });
    store.writePerspective({
      id: 'overall-architecture',
      label: 'Overall Architecture',
      components: [
        {
          id: 'store',
          label: 'Store',
          kind: 'leaf',
          directory: 'src/store',
          files: ['src/store/store.ts'],
          stats: { file_count: 1, function_count: 1, total_cyclomatic: 1, max_cyclomatic: 1, max_nesting_depth: 1, risk_score: 1 },
        },
      ],
      edges: [],
    });
    store.writeField('overall-architecture/store', 'data', yaml.dump({
      id: 'store',
      label: 'Store Updated',
      kind: 'leaf',
      directory: 'src/store',
      files: ['src/store/store.ts', 'src/store/schema.ts'],
      stats: { file_count: 2, function_count: 4, total_cyclomatic: 5, max_cyclomatic: 3, max_nesting_depth: 2, risk_score: 9 },
    }));

    const loaded = store.readPerspective('overall-architecture');
    expect(loaded.components[0].label).toBe('Store Updated');
    expect(loaded.components[0].stats.file_count).toBe(2);
  });
});
