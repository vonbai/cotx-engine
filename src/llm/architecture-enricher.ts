/**
 * Canonical architecture enricher.
 *
 * This path requires the C4/Structurizr-style workspace and recursion plan
 * produced by `cotx compile`. Legacy perspective-only enrichment was removed
 * because it hid missing canonical architecture data and encouraged old sidecar
 * semantics to linger.
 */

import { readConfig, type LlmConfig } from '../config.js';
import { createLlmClient } from './client.js';
import { ArchitectureStore } from '../store/architecture-store.js';
import {
  buildArchitectureLeafPrompt,
  buildArchitectureOverviewPrompt,
  buildArchitectureParentPrompt,
  planArchitecturePromptJobs,
  type ArchitecturePrompt,
} from './architecture-prompts.js';
import { hashArchitectureEnrichmentOutput } from '../compiler/architecture-enrichment-job.js';
import type { ArchitectureBoundaryReview, ArchitectureEvidenceAnchor, ArchitectureWorkspaceData, ArchitectureWorkspaceElement } from '../store/schema.js';
import type { LlmClient } from './client.js';
import { runArchitectureBoundaryAgent } from './agentic-architecture-enricher.js';

export interface ArchitectureEnrichResult {
  perspectives_enriched: number;
  descriptions_written: number;
  diagrams_written: number;
  recursive_jobs_planned?: number;
  recursive_jobs_run?: number;
}

interface ArchitectureDocOutput {
  summary: string;
  responsibilities?: string[];
  key_relationships?: Array<{ target_id: string; description: string; evidence_anchor_refs: string[] }>;
  risks_or_constraints?: Array<{ description: string; evidence_anchor_refs: string[] }>;
  evidence_anchor_refs?: string[];
}

// ── Public API ─────────────────────────────────────────────────────────────────

export async function enrichArchitecture(
  projectRoot: string,
  options?: {
    dryRun?: boolean;
    log?: (...args: unknown[]) => void;
  },
): Promise<ArchitectureEnrichResult> {
  const log = options?.log ?? (() => {});
  const config = readConfig();

  if (!config.llm?.chat_model && !options?.dryRun) {
    throw new Error(
      'No LLM configured. Run `cotx setup` or set llm.chat_model in ~/.cotx/config.json',
    );
  }

  const archStore = new ArchitectureStore(projectRoot);

  if (!archStore.exists()) {
    throw new Error('No architecture data. Run `cotx compile` first.');
  }

  const meta = archStore.readMeta();
  const diagramsWritten = 0;
  const workspace = archStore.readWorkspace();
  const recursionPlan = archStore.readRecursionPlan();

  if (options?.dryRun) {
    if (!workspace || !recursionPlan) {
      throw new Error('No canonical architecture workspace. Run `cotx compile` to generate workspace.json and recursion-plan.json.');
    }
    const promptPlan = planArchitecturePromptJobs(workspace, recursionPlan);
    log(`[dry-run] Would run canonical recursive architecture prompt plan: ${promptPlan.jobs.length} job(s)`);
    for (const job of promptPlan.jobs) {
      log(`[dry-run] ${job.kind} ${job.target_id} depends_on=${job.depends_on.join(',') || 'none'}`);
    }
    return {
      perspectives_enriched: meta.perspectives.length,
      descriptions_written: 0,
      diagrams_written: 0,
      recursive_jobs_planned: promptPlan.jobs.length,
    };
  }

  if (!config.llm?.chat_model) {
    throw new Error(
      'No LLM configured. Run `cotx setup` or set llm.chat_model in ~/.cotx/config.json',
    );
  }
  const llm = config.llm;
  const client = createLlmClient(llm);
  const maxTokens = llm.max_tokens !== undefined && llm.max_tokens > 4000
    ? llm.max_tokens
    : 4000;

  if (!workspace || !recursionPlan) {
    throw new Error('No canonical architecture workspace. Run `cotx compile` to generate workspace.json and recursion-plan.json.');
  }

  const recursive = await enrichCanonicalWorkspace(projectRoot, archStore, client, llm, workspace, recursionPlan, {
    maxTokens,
    log,
  });
  if (recursive.descriptionsWritten > 0) {
    archStore.writeMeta({ ...meta, mode: 'llm' });
  }
  return {
    perspectives_enriched: meta.perspectives.length,
    descriptions_written: recursive.descriptionsWritten,
    diagrams_written: diagramsWritten,
    recursive_jobs_planned: recursive.jobsPlanned,
    recursive_jobs_run: recursive.jobsRun,
  };
}

async function enrichCanonicalWorkspace(
  projectRoot: string,
  archStore: ArchitectureStore,
  client: LlmClient,
  llm: LlmConfig,
  workspace: ArchitectureWorkspaceData,
  recursionPlan: NonNullable<ReturnType<ArchitectureStore['readRecursionPlan']>>,
  options: {
    maxTokens: number;
    log: (...args: unknown[]) => void;
  },
): Promise<{ descriptionsWritten: number; jobsPlanned: number; jobsRun: number }> {
  options.log('Reviewing canonical architecture boundaries');
  let boundaryReview;
  try {
    const agentResult = await runArchitectureBoundaryAgent({
      projectRoot,
      workspace,
      recursionPlan,
      llm,
      log: options.log,
    });
    boundaryReview = agentResult.review;
    options.log(`  [ok] Boundary agent completed with ${agentResult.tool_calls.length} tool call(s)`);
  } catch (error) {
    options.log(`  [warn] Boundary agent did not return a valid review; continuing without boundary exclusions: ${error instanceof Error ? error.message : String(error)}`);
    boundaryReview = {
      schema_version: 'cotx.architecture.boundary_review.v1' as const,
      generated_at: new Date().toISOString(),
      source_workspace_generated_at: workspace.generated_at,
      decisions: [],
    };
  }
  archStore.writeBoundaryReview(boundaryReview);
  const excludedElementIds = safeExcludedElementIds(workspace, boundaryReview);
  const promptPlan = planArchitecturePromptJobs(workspace, recursionPlan, { excludedElementIds });
  const summaries = new Map<string, { element_id: string; summary: string; evidence: ArchitectureEvidenceAnchor[] }>();
  let descriptionsWritten = 0;
  let jobsRun = 1;

  for (const job of promptPlan.jobs) {
    let prompt: ArchitecturePrompt;
    if (job.kind === 'leaf') {
      prompt = buildArchitectureLeafPrompt(workspace, job.target_id);
    } else if (job.kind === 'parent') {
      prompt = buildArchitectureParentPrompt(
        workspace,
        recursionPlan,
        job.target_id,
        job.child_element_ids.flatMap((childId) => summaries.get(childId) ? [summaries.get(childId)!] : []),
      );
    } else {
      prompt = buildArchitectureOverviewPrompt(workspace, recursionPlan);
    }

    options.log(`Enriching canonical architecture ${job.kind}: ${job.target_id}`);
    const response = await client.chat(
      [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      { max_tokens: options.maxTokens },
    );
    const raw = stripJsonFence(response.content);
    const parsed = JSON.parse(raw) as ArchitectureDocOutput;
    if (typeof parsed.summary !== 'string' || parsed.summary.trim().length === 0) {
      throw new Error(`Architecture LLM response for ${job.id} did not include a non-empty summary.`);
    }

    const element = workspace.elements.find((item) => item.id === job.target_id);
    if (element && job.kind !== 'overview') {
      element.description = parsed.summary;
      descriptionsWritten++;
    }
    summaries.set(job.target_id, {
      element_id: job.target_id,
      summary: parsed.summary,
      evidence: prompt.required_evidence,
    });
    archStore.writeEnrichmentJob({
      schema_version: 'cotx.architecture.enrichment_job.v1',
      id: `architecture-doc:${job.id}`,
      mode: 'builtin-llm',
      target: { kind: 'architecture-element', id: job.target_id, field: 'description' },
      prompt_version: prompt.prompt_version,
      provider: llm.base_url,
      model: llm.chat_model,
      input_graph_compiled_at: workspace.source_graph_compiled_at,
      created_at: new Date().toISOString(),
      evidence: prompt.required_evidence,
      output: {
        format: 'json',
        content: raw,
        hash: hashArchitectureEnrichmentOutput(raw),
      },
      review_status: 'draft',
    });
    jobsRun++;
  }

  archStore.writeWorkspace(workspace);
  return { descriptionsWritten, jobsPlanned: promptPlan.jobs.length + 1, jobsRun };
}

function stripJsonFence(content: string): string {
  return content.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
}

function safeExcludedElementIds(workspace: ArchitectureWorkspaceData, review: ArchitectureBoundaryReview): string[] {
  const byId = new Map(workspace.elements.map((element) => [element.id, element]));
  return review.decisions
    .filter((decision) => decision.action === 'exclude_from_docs')
    .filter((decision) => {
      const element = byId.get(decision.element_id);
      return element ? isSafeDocumentationExclusion(element) : false;
    })
    .map((decision) => decision.element_id);
}

function isSafeDocumentationExclusion(element: ArchitectureWorkspaceElement): boolean {
  const paths = element.source_paths ?? [];
  if (paths.length === 0) return false;
  return paths.every((sourcePath) => {
    const lower = sourcePath.toLowerCase();
    return lower === 'readme.md' ||
      lower.endsWith('.md') ||
      lower === 'makefile' ||
      lower === 'dockerfile' ||
      lower.endsWith('.toml') ||
      lower.endsWith('.json') ||
      lower.startsWith('tests/') ||
      lower === 'tests' ||
      lower.startsWith('docs/') ||
      lower === 'docs';
  });
}
