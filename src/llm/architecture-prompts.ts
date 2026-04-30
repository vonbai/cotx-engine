import type {
  ArchitectureBoundaryReview,
  ArchitectureBoundaryReviewDecision,
  ArchitectureEvidenceAnchor,
  ArchitectureRecursionDecision,
  ArchitectureRecursionPlan,
  ArchitectureWorkspaceData,
  ArchitectureWorkspaceElement,
} from '../store/schema.js';
import type { OnboardingContext } from '../compiler/onboarding-context.js';

export type ArchitecturePromptKind = 'boundary-review' | 'leaf' | 'parent' | 'overview';

export interface ArchitecturePrompt {
  kind: ArchitecturePromptKind;
  prompt_version: 'cotx-architecture-docs-v1';
  target_id: string;
  system: string;
  user: string;
  required_evidence: ArchitectureEvidenceAnchor[];
}

export interface ArchitecturePromptJob {
  id: string;
  kind: ArchitecturePromptKind;
  target_id: string;
  depends_on: string[];
  child_element_ids: string[];
  required_evidence: ArchitectureEvidenceAnchor[];
}

export interface ArchitecturePromptJobPlan {
  prompt_version: 'cotx-architecture-docs-v1';
  workspace_generated_at: string;
  recursion_plan_generated_at: string;
  jobs: ArchitecturePromptJob[];
}

export function buildArchitectureLeafPrompt(
  workspace: ArchitectureWorkspaceData,
  targetId: string,
): ArchitecturePrompt {
  const target = requiredElement(workspace, targetId);
  const packet = evidencePacket(workspace, target, []);
  return prompt('leaf', target.id, target.evidence, {
    instruction: 'Write a concise architecture leaf document for one canonical element.',
    output_contract: docOutputContract(),
    target: packet,
  });
}

export function buildArchitectureBoundaryReviewPrompt(
  workspace: ArchitectureWorkspaceData,
  recursionPlan: ArchitectureRecursionPlan,
  onboarding?: OnboardingContext,
): ArchitecturePrompt {
  const evidence = dedupeEvidence(workspace.elements.flatMap((element) => element.evidence));
  return prompt('boundary-review', 'workspace', evidence, {
    instruction: [
      'Review the canonical architecture workspace before documentation generation.',
      'Find elements that are not meaningful architecture documentation targets, such as README-only docs, Makefiles, Dockerfiles, pyproject files, tests, generated fixtures, or duplicate grouping wrappers.',
      'Do not remove truth graph facts. Propose documentation-boundary decisions only.',
    ].join(' '),
    output_contract: {
      decisions: [{
        element_id: 'string',
        action: 'keep | exclude_from_docs | rename | relevel',
        reason: 'string',
        evidence_anchor_refs: ['kind:id'],
        proposed_name: 'optional string',
        proposed_level: 'optional software_system | container | component | code_element',
      }],
    },
    workspace: {
      generated_at: workspace.generated_at,
      onboarding: onboarding
        ? {
            workspace_scan_summary: onboarding.workspace_scan.summary,
            candidate_inputs: onboarding.workspace_scan.candidates.slice(0, 80),
            hypotheses: onboarding.hypotheses.slice(0, 20),
            consistency_counts: onboarding.summary.consistency_counts,
            graph_gap_sample: onboarding.consistency['graph-gap'].slice(0, 20),
            contradicted_sample: onboarding.consistency.contradicted.slice(0, 20),
          }
        : null,
      elements: workspace.elements.map((element) => ({
        id: element.id,
        name: element.name,
        level: element.level,
        parent_id: element.parent_id ?? null,
        source_paths: element.source_paths ?? [],
        metadata: element.metadata ?? {},
        evidence: element.evidence,
      })),
      relationships: workspace.relationships.map((relationship) => ({
        id: relationship.id,
        source_id: relationship.source_id,
        target_id: relationship.target_id,
        description: relationship.description,
        evidence: relationship.evidence,
      })),
      recursion_decisions: recursionPlan.decisions.map((decision) => ({
        element_id: decision.element_id,
        action: decision.action,
        child_element_ids: decision.child_element_ids,
        reason: decision.reason,
      })),
    },
  });
}

export function parseArchitectureBoundaryReview(
  content: string,
  workspace: ArchitectureWorkspaceData,
): ArchitectureBoundaryReview {
  const parsed = JSON.parse(stripJsonFence(content)) as { decisions?: unknown[] };
  const validElementIds = new Set(workspace.elements.map((element) => element.id));
  const decisions: ArchitectureBoundaryReviewDecision[] = [];
  for (const item of parsed.decisions ?? []) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const elementId = typeof record.element_id === 'string' ? record.element_id : '';
    const action = typeof record.action === 'string' ? record.action : '';
    const reason = typeof record.reason === 'string' ? record.reason : '';
    const evidenceRefs = Array.isArray(record.evidence_anchor_refs)
      ? record.evidence_anchor_refs.filter((ref): ref is string => typeof ref === 'string')
      : [];
    if (!validElementIds.has(elementId)) continue;
    if (action !== 'keep' && action !== 'exclude_from_docs' && action !== 'rename' && action !== 'relevel') continue;
    if (reason.length === 0 || evidenceRefs.length === 0) continue;
    decisions.push({
      element_id: elementId,
      action,
      reason,
      evidence_anchor_refs: evidenceRefs,
      ...(typeof record.proposed_name === 'string' ? { proposed_name: record.proposed_name } : {}),
      ...(isWorkspaceLevel(record.proposed_level) ? { proposed_level: record.proposed_level } : {}),
    });
  }
  return {
    schema_version: 'cotx.architecture.boundary_review.v1',
    generated_at: new Date().toISOString(),
    source_workspace_generated_at: workspace.generated_at,
    decisions,
  };
}

export function buildArchitectureParentPrompt(
  workspace: ArchitectureWorkspaceData,
  recursionPlan: ArchitectureRecursionPlan,
  targetId: string,
  childSummaries: Array<{ element_id: string; summary: string; evidence: ArchitectureEvidenceAnchor[] }>,
): ArchitecturePrompt {
  const target = requiredElement(workspace, targetId);
  const decision = recursionPlan.decisions.find((item) => item.element_id === targetId);
  const children = workspace.elements.filter((element) => decision?.child_element_ids.includes(element.id));
  const evidence = [...target.evidence, ...childSummaries.flatMap((child) => child.evidence)];
  return prompt('parent', target.id, evidence, {
    instruction: 'Write a parent architecture document by synthesizing child summaries. Do not reread or invent source beyond the evidence packet.',
    output_contract: docOutputContract(),
    target: evidencePacket(workspace, target, children),
    recursion_decision: decision ?? null,
    child_summaries: childSummaries,
  });
}

export function buildArchitectureOverviewPrompt(
  workspace: ArchitectureWorkspaceData,
  recursionPlan: ArchitectureRecursionPlan,
): ArchitecturePrompt {
  const system = workspace.elements.find((element) => element.level === 'software_system') ?? workspace.elements[0];
  if (!system) throw new Error('Architecture workspace has no elements.');
  const evidence = [...new Map(workspace.elements.flatMap((element) => element.evidence).map((anchor) => [`${anchor.kind}:${anchor.id}`, anchor])).values()];
  return prompt('overview', system.id, evidence, {
    instruction: 'Write a repository architecture overview from the canonical workspace model and recursion plan.',
    output_contract: docOutputContract(),
    workspace: {
      schema_version: workspace.schema_version,
      generated_at: workspace.generated_at,
      elements: workspace.elements.map((element) => ({
        id: element.id,
        name: element.name,
        level: element.level,
        parent_id: element.parent_id ?? null,
        source_paths: element.source_paths ?? [],
        metadata: element.metadata ?? {},
        evidence: element.evidence,
      })),
      relationships: workspace.relationships.map((relationship) => ({
        id: relationship.id,
        source_id: relationship.source_id,
        target_id: relationship.target_id,
        description: relationship.description,
        evidence: relationship.evidence,
      })),
      views: workspace.views.map((view) => ({
        id: view.id,
        type: view.type,
        element_ids: view.element_ids,
        relationship_ids: view.relationship_ids,
      })),
    },
    recursion_plan: recursionPlan,
  });
}

export function planArchitecturePromptJobs(
  workspace: ArchitectureWorkspaceData,
  recursionPlan: ArchitectureRecursionPlan,
  options: { excludedElementIds?: string[] } = {},
): ArchitecturePromptJobPlan {
  const jobs = new Map<string, ArchitecturePromptJob>();
  const excluded = new Set(options.excludedElementIds ?? []);

  const depthById = elementDepths(workspace);
  const decisions = [...recursionPlan.decisions]
    .filter((decision) => workspace.elements.some((element) => element.id === decision.element_id) && !excluded.has(decision.element_id))
    .sort((left, right) => (depthById.get(right.element_id) ?? 0) - (depthById.get(left.element_id) ?? 0) || left.element_id.localeCompare(right.element_id));

  for (const decision of decisions) {
    const element = requiredElement(workspace, decision.element_id);
    if (decision.action === 'recurse') {
      const dependsOn = decision.child_element_ids
        .filter((childId) => workspace.elements.some((item) => item.id === childId) && !excluded.has(childId))
        .map((childId) => [...jobs.values()].find((job) => job.target_id === childId)?.id ?? jobId('leaf', childId));
      jobs.set(jobId('parent', element.id), {
        id: jobId('parent', element.id),
        kind: 'parent',
        target_id: element.id,
        depends_on: dependsOn,
        child_element_ids: decision.child_element_ids,
        required_evidence: dedupeEvidence([...element.evidence, ...decision.evidence]),
      });
    } else {
      jobs.set(jobId('leaf', element.id), {
        id: jobId('leaf', element.id),
        kind: 'leaf',
        target_id: element.id,
        depends_on: [],
        child_element_ids: [],
        required_evidence: element.evidence,
      });
    }
  }

  for (const element of workspace.elements) {
    if (excluded.has(element.id)) continue;
    if (![...jobs.values()].some((job) => job.target_id === element.id)) {
      jobs.set(jobId('leaf', element.id), {
        id: jobId('leaf', element.id),
        kind: 'leaf',
        target_id: element.id,
        depends_on: [],
        child_element_ids: [],
        required_evidence: element.evidence,
      });
    }
  }

  const terminalJobs = [...jobs.values()]
    .filter((job) => ![...jobs.values()].some((candidate) => candidate.depends_on.includes(job.id)))
    .map((job) => job.id)
    .sort();
  const system = workspace.elements.find((element) => element.level === 'software_system') ?? workspace.elements[0];
  if (system) {
    jobs.set(jobId('overview', system.id), {
      id: jobId('overview', system.id),
      kind: 'overview',
      target_id: system.id,
      depends_on: terminalJobs,
      child_element_ids: workspace.elements.filter((element) => element.parent_id === system.id).map((element) => element.id).sort(),
      required_evidence: dedupeEvidence(workspace.elements.flatMap((element) => element.evidence)),
    });
  }

  return {
    prompt_version: 'cotx-architecture-docs-v1',
    workspace_generated_at: workspace.generated_at,
    recursion_plan_generated_at: recursionPlan.generated_at,
    jobs: [...jobs.values()].sort((left, right) => jobRank(left.kind) - jobRank(right.kind) || left.id.localeCompare(right.id)),
  };
}

function prompt(
  kind: ArchitecturePromptKind,
  targetId: string,
  requiredEvidence: ArchitectureEvidenceAnchor[],
  payload: Record<string, unknown>,
): ArchitecturePrompt {
  return {
    kind,
    prompt_version: 'cotx-architecture-docs-v1',
    target_id: targetId,
    required_evidence: requiredEvidence,
    system: [
      'You are writing architecture documentation for cotx.',
      'Use only the provided canonical workspace model and evidence anchors.',
      'Do not invent files, symbols, routes, tools, relationships, components, or decisions.',
      'Do not use generic directory summaries such as "owns code under X" or "exposes N functions" as the main point unless that is the only supported fact.',
      'Do not put exported-function counts in the summary. Use function names, relationships, and runtime responsibilities instead; counts are only supporting evidence.',
      'Prefer architectural responsibility, runtime role, integration boundary, orchestration role, or data/control-flow responsibility when evidence supports it.',
      'Use concrete file and module names in evidence to infer responsibilities, such as integration adapters, middleware hooks, prompt construction, server/API entry points, web app handlers, repository utilities, sandbox utilities, or external-service tools.',
      'If evidence only supports a directory/count statement, explicitly keep the summary short and avoid adding unsupported behavior.',
      'Every claim must be supported by evidence_anchor_refs copied from the input evidence anchors.',
      'Respond only with valid JSON matching the requested output contract.',
    ].join('\n'),
    user: JSON.stringify(payload, null, 2),
  };
}

function evidencePacket(
  workspace: ArchitectureWorkspaceData,
  target: ArchitectureWorkspaceElement,
  children: ArchitectureWorkspaceElement[],
): Record<string, unknown> {
  return {
    workspace_generated_at: workspace.generated_at,
    target: {
      id: target.id,
      name: target.name,
      level: target.level,
      parent_id: target.parent_id ?? null,
      description: target.description ?? null,
      source_paths: target.source_paths ?? [],
      metadata: target.metadata ?? {},
      evidence: target.evidence,
    },
    children: children.map((child) => ({
      id: child.id,
      name: child.name,
      level: child.level,
      source_paths: child.source_paths ?? [],
      metadata: child.metadata ?? {},
      evidence: child.evidence,
    })),
    relationships: workspace.relationships
      .filter((relationship) => relationship.source_id === target.id || relationship.target_id === target.id || children.some((child) => relationship.source_id === child.id || relationship.target_id === child.id))
      .map((relationship) => ({
        id: relationship.id,
        source_id: relationship.source_id,
        target_id: relationship.target_id,
        description: relationship.description,
        evidence: relationship.evidence,
      })),
  };
}

function requiredElement(workspace: ArchitectureWorkspaceData, targetId: string): ArchitectureWorkspaceElement {
  const target = workspace.elements.find((element) => element.id === targetId);
  if (!target) throw new Error(`Architecture workspace element not found: ${targetId}`);
  return target;
}

function docOutputContract(): Record<string, unknown> {
  return {
    summary: 'string',
    responsibilities: ['string'],
    key_relationships: [{ target_id: 'string', description: 'string', evidence_anchor_refs: ['kind:id'] }],
    risks_or_constraints: [{ description: 'string', evidence_anchor_refs: ['kind:id'] }],
    evidence_anchor_refs: ['kind:id'],
  };
}

function stripJsonFence(content: string): string {
  return content.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
}

function isWorkspaceLevel(value: unknown): value is ArchitectureWorkspaceElement['level'] {
  return value === 'software_system' || value === 'container' || value === 'component' || value === 'code_element';
}

function jobId(kind: ArchitecturePromptKind, targetId: string): string {
  return `${kind}:${targetId}`;
}

function jobRank(kind: ArchitecturePromptKind): number {
  return kind === 'leaf' ? 0 : kind === 'parent' ? 1 : 2;
}

function elementDepths(workspace: ArchitectureWorkspaceData): Map<string, number> {
  const byId = new Map(workspace.elements.map((element) => [element.id, element]));
  const depths = new Map<string, number>();
  const depth = (id: string): number => {
    if (depths.has(id)) return depths.get(id)!;
    const parent = byId.get(id)?.parent_id;
    const value = parent ? depth(parent) + 1 : 0;
    depths.set(id, value);
    return value;
  };
  for (const element of workspace.elements) depth(element.id);
  return depths;
}

function dedupeEvidence(evidence: ArchitectureEvidenceAnchor[]): ArchitectureEvidenceAnchor[] {
  return [...new Map(evidence.map((anchor) => [`${anchor.kind}:${anchor.id}:${anchor.filePath ?? ''}:${anchor.line ?? ''}`, anchor])).values()];
}
