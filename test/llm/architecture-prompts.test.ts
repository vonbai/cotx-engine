import { describe, it, expect } from 'vitest';
import {
  buildArchitectureLeafPrompt,
  buildArchitectureOverviewPrompt,
  buildArchitectureParentPrompt,
  buildArchitectureBoundaryReviewPrompt,
  planArchitecturePromptJobs,
  parseArchitectureBoundaryReview,
} from '../../src/llm/architecture-prompts.js';
import type { ArchitectureRecursionPlan, ArchitectureWorkspaceData } from '../../src/store/schema.js';

const workspace: ArchitectureWorkspaceData = {
  schema_version: 'cotx.architecture.workspace.v1',
  generated_at: '2026-04-13T00:00:00Z',
  elements: [
    {
      id: 'system:cotx-engine',
      name: 'cotx-engine',
      level: 'software_system',
      evidence: [{ kind: 'file', id: 'README.md', filePath: 'README.md' }],
      review_status: 'draft',
    },
    {
      id: 'container:compiler',
      name: 'Compiler',
      level: 'container',
      parent_id: 'system:cotx-engine',
      source_paths: ['src/compiler'],
      metadata: { exported_functions: ['compileArchitecture'] },
      evidence: [{ kind: 'module', id: 'compiler' }],
      review_status: 'draft',
    },
    {
      id: 'container:store',
      name: 'Store',
      level: 'container',
      parent_id: 'system:cotx-engine',
      source_paths: ['src/store'],
      evidence: [{ kind: 'module', id: 'store' }],
      review_status: 'draft',
    },
  ],
  relationships: [
    {
      id: 'rel:compiler-store',
      source_id: 'container:compiler',
      target_id: 'container:store',
      description: 'writes artifacts',
      evidence: [{ kind: 'relation', id: 'compiler->store' }],
      review_status: 'draft',
    },
  ],
  views: [],
};

const recursionPlan: ArchitectureRecursionPlan = {
  schema_version: 'cotx.architecture.recursion_plan.v1',
  generated_at: '2026-04-13T00:01:00Z',
  source_workspace_generated_at: workspace.generated_at,
  decisions: [
    {
      element_id: 'system:cotx-engine',
      action: 'recurse',
      reason: 'Element has children.',
      child_element_ids: ['container:compiler', 'container:store'],
      evidence: [{ kind: 'file', id: 'README.md', filePath: 'README.md' }],
    },
  ],
};

describe('architecture prompt builders', () => {
  it('builds leaf prompts with strict JSON and evidence instructions', () => {
    const prompt = buildArchitectureLeafPrompt(workspace, 'container:compiler');
    const payload = JSON.parse(prompt.user);
    expect(prompt.kind).toBe('leaf');
    expect(prompt.prompt_version).toBe('cotx-architecture-docs-v1');
    expect(prompt.system).toContain('Do not invent files');
    expect(prompt.system).toContain('Do not use generic directory summaries');
    expect(prompt.system).toContain('Do not put exported-function counts in the summary');
    expect(prompt.system).toContain('Use concrete file and module names');
    expect(payload.target.target.id).toBe('container:compiler');
    expect(payload.target.target.metadata.exported_functions).toContain('compileArchitecture');
    expect(payload.output_contract.evidence_anchor_refs).toEqual(['kind:id']);
    expect(prompt.required_evidence).toEqual([{ kind: 'module', id: 'compiler' }]);
  });

  it('builds parent prompts from child summaries and recursion plan', () => {
    const prompt = buildArchitectureParentPrompt(workspace, recursionPlan, 'system:cotx-engine', [
      { element_id: 'container:compiler', summary: 'Compiler summary.', evidence: [{ kind: 'module', id: 'compiler' }] },
    ]);
    const payload = JSON.parse(prompt.user);
    expect(prompt.kind).toBe('parent');
    expect(payload.recursion_decision.action).toBe('recurse');
    expect(payload.child_summaries[0].element_id).toBe('container:compiler');
    expect(prompt.required_evidence.some((anchor) => anchor.id === 'compiler')).toBe(true);
  });

  it('builds overview prompts from the canonical workspace and recursion plan', () => {
    const prompt = buildArchitectureOverviewPrompt(workspace, recursionPlan);
    const payload = JSON.parse(prompt.user);
    expect(prompt.kind).toBe('overview');
    expect(payload.workspace.schema_version).toBe('cotx.architecture.workspace.v1');
    expect(payload.workspace.relationships[0].id).toBe('rel:compiler-store');
    expect(payload.recursion_plan.schema_version).toBe('cotx.architecture.recursion_plan.v1');
    expect(prompt.required_evidence.some((anchor) => anchor.id === 'README.md')).toBe(true);
  });

  it('plans whole-workspace prompt jobs in recursive dependency order', () => {
    const plan = planArchitecturePromptJobs(workspace, recursionPlan);
    expect(plan.prompt_version).toBe('cotx-architecture-docs-v1');
    expect(plan.jobs.map((job) => job.id)).toEqual([
      'leaf:container:compiler',
      'leaf:container:store',
      'parent:system:cotx-engine',
      'overview:system:cotx-engine',
    ]);
    expect(plan.jobs.find((job) => job.id === 'parent:system:cotx-engine')?.depends_on).toEqual([
      'leaf:container:compiler',
      'leaf:container:store',
    ]);
    expect(plan.jobs.find((job) => job.kind === 'overview')?.depends_on).toEqual(['parent:system:cotx-engine']);
  });

  it('builds boundary review prompts with onboarding and workspace scan context', () => {
    const prompt = buildArchitectureBoundaryReviewPrompt(workspace, recursionPlan, {
      project_root: '/repo',
      generated_at: '2026-04-13T00:00:00Z',
      budget: 'standard',
      workspace_scan: {
        project_root: '/repo',
        generated_at: '2026-04-13T00:00:00Z',
        directories: [],
        candidates: [{ path: 'README.md', kind: 'readme', reason: 'README-like file', boundary: '.' }],
        summary: { directories: 1, candidates: 1, asset_dirs: 0, repo_boundaries: 1, packages: 0, docs_dirs: 0, example_dirs: 0, cotx_present: false, architecture_store_present: false },
      },
      sources: [],
      hypotheses: [],
      consistency: { confirmed: [], contradicted: [], 'stale-doc': [], 'graph-gap': [], unknown: [] },
      summary: {
        source_count: 0,
        sources_by_kind: { readme: 0, 'agent-instructions': 0, docs: 0, 'architecture-doc': 0, manifest: 0, example: 0, cotx: 0 },
        hypothesis_count: 0,
        consistency_counts: { confirmed: 0, contradicted: 0, 'stale-doc': 0, 'graph-gap': 0, unknown: 0 },
        has_cotx: false,
        has_storage_v2_truth: false,
        has_architecture_store: false,
        graph_file_count: null,
        graph_file_index_status: 'missing',
        workspace_directories: 1,
        workspace_candidates: 1,
        asset_directories: 0,
        repo_boundaries: 1,
        package_boundaries: 0,
        warnings: [],
      },
    });
    const payload = JSON.parse(prompt.user);
    expect(prompt.kind).toBe('boundary-review');
    expect(payload.workspace.onboarding.candidate_inputs[0].kind).toBe('readme');
    expect(payload.output_contract.decisions[0].action).toContain('exclude_from_docs');
  });

  it('parses valid boundary review decisions and drops invalid element ids', () => {
    const review = parseArchitectureBoundaryReview(JSON.stringify({
      decisions: [
        { element_id: 'container:compiler', action: 'keep', reason: 'runtime container', evidence_anchor_refs: ['module:compiler'] },
        { element_id: 'missing', action: 'exclude_from_docs', reason: 'missing', evidence_anchor_refs: ['file:README.md'] },
      ],
    }), workspace);
    expect(review.decisions).toHaveLength(1);
    expect(review.decisions[0].element_id).toBe('container:compiler');
  });
});
