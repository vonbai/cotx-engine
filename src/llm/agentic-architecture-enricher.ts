import { Agent, type AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from '@mariozechner/pi-ai';
import { collectOnboardingContext } from '../compiler/onboarding-context.js';
import type {
  ArchitectureBoundaryAction,
  ArchitectureBoundaryReview,
  ArchitectureBoundaryReviewDecision,
  ArchitectureEvidenceAnchor,
  ArchitectureWorkspaceData,
  ArchitectureWorkspaceLevel,
} from '../store/schema.js';
import {
  buildArchitectureBoundaryReviewPrompt,
  parseArchitectureBoundaryReview,
} from './architecture-prompts.js';
import {
  modelInfo,
  createPiAgentModel,
  requirePiAgentModel,
  resolvePiAgentApiKey,
} from './agentic-model.js';
import { createCotxRepositoryTools, createJsonAgentTool } from './agentic-repo-tools.js';
import { lastAssistantText, runCotxLayerAnalysisAgent } from './agentic-runtime.js';
import type {
  ArchitectureBoundaryAgentOptions,
  ArchitectureBoundaryAgentResult,
  CotxAgenticEnrichmentLayer,
  CotxLayerAnalysisAgentOptions,
  CotxLayerAnalysisAgentResult,
  CotxTruthCorrectionProposal,
} from './agentic-types.js';

export {
  createPiAgentModel,
  runCotxLayerAnalysisAgent,
  type CotxAgenticEnrichmentLayer,
  type CotxLayerAnalysisAgentOptions,
  type CotxLayerAnalysisAgentResult,
  type CotxTruthCorrectionProposal,
};

interface BoundaryProposal {
  decisions: BoundaryProposalDecision[];
}

interface BoundaryProposalDecision {
  element_id: string;
  action: ArchitectureBoundaryAction;
  reason: string;
  evidence_anchor_refs: string[];
  proposed_name?: string;
  proposed_level?: ArchitectureWorkspaceLevel;
}

export async function runArchitectureBoundaryAgent(
  options: ArchitectureBoundaryAgentOptions,
): Promise<ArchitectureBoundaryAgentResult> {
  const onboarding = options.onboarding ?? collectOnboardingContext(options.projectRoot, {
    budget: 'standard',
    includeExcerpts: false,
  });
  const model = options.model ?? requirePiAgentModel(options.llm);
  const prompt = buildArchitectureBoundaryReviewPrompt(options.workspace, options.recursionPlan, onboarding);
  const toolCalls: string[] = [];
  let proposal: BoundaryProposal | undefined;

  const tools = createBoundaryAgentTools({
    projectRoot: options.projectRoot,
    workspace: options.workspace,
    onboarding,
    onToolCall: (name) => toolCalls.push(name),
    onProposal: (next) => {
      proposal = next;
    },
  });

  const agent = new Agent({
    initialState: {
      systemPrompt: [
        prompt.system,
        '',
        'You are running inside cotx built-in architecture enrichment.',
        'Use pi-coding-agent repository tools (read, grep, find, ls) plus cotx-specific context tools for bounded repository understanding before making architecture-boundary decisions.',
        'You may inspect docs, architecture notes, and selected source files when cotx graph evidence is incomplete, stale, or suspicious.',
        'Call propose_boundary_patch only for documentation-boundary changes to canonical architecture elements. This does not remove files, graph nodes, relations, routes, tools, or processes.',
        'If no boundary change is needed, submit keep decisions for inspected elements or return an empty decisions array.',
        'Never edit files or truth graph facts.',
      ].join('\n'),
      model,
      thinkingLevel: model.reasoning ? 'medium' : 'off',
      tools,
    },
    getApiKey: options.getApiKey ?? (options.llm ? () => resolvePiAgentApiKey(options.llm!) : undefined),
    toolExecution: 'sequential',
    beforeToolCall: async ({ toolCall }) => {
      if (!tools.some((tool) => tool.name === toolCall.name)) {
        return { block: true, reason: `Tool not allowed in cotx architecture boundary agent: ${toolCall.name}` };
      }
      return undefined;
    },
  });

  options.log?.(`Running pi-agent architecture boundary review with ${model.provider}/${model.id}`);
  await agent.prompt(JSON.stringify({
    task: 'Review architecture workspace boundaries and propose documentation-boundary decisions.',
    workspace_generated_at: options.workspace.generated_at,
    prompt_payload: JSON.parse(prompt.user) as unknown,
  }, null, 2));

  if ((options.requireToolUse ?? true) && toolCalls.length === 0) {
    options.log?.('  [retry] Boundary agent returned without tool use; requiring workspace/docs/source inspection');
    await agent.prompt(JSON.stringify({
      correction: 'You returned without using tools. Before boundary review, inspect repository evidence.',
      available_repository_tools: ['read', 'grep', 'find', 'ls', 'workspace_scan', 'onboarding_context'],
      required_actions: [
        'Call workspace_scan.',
        'Call onboarding_context or grep against docs/source.',
        'Call propose_boundary_patch with documentation-boundary decisions or an empty decisions array.',
      ],
    }, null, 2));
  }

  const lastOutput = lastAssistantText(agent.state.messages);
  const review = proposal
    ? boundaryReviewFromProposal(proposal, options.workspace)
    : parseArchitectureBoundaryReview(lastOutput, options.workspace);

  return {
    review,
    raw_output: lastOutput,
    tool_calls: toolCalls,
    model: modelInfo(model),
  };
}

function createBoundaryAgentTools(options: {
  projectRoot: string;
  workspace: ArchitectureWorkspaceData;
  onboarding: NonNullable<ArchitectureBoundaryAgentOptions['onboarding']>;
  onToolCall: (name: string) => void;
  onProposal: (proposal: BoundaryProposal) => void;
}): AgentTool<any>[] {
  return [
    ...createCotxRepositoryTools({
      projectRoot: options.projectRoot,
      onboarding: options.onboarding,
      layer: 'architecture',
      onToolCall: options.onToolCall,
    }),
    createJsonAgentTool(
      'query_architecture',
      'Query Architecture',
      'Search the canonical cotx architecture workspace elements and relationships by text. This is architecture-overlay context, not a raw truth graph query.',
      Type.Object({
        query: Type.String({ minLength: 1 }),
      }),
      options.onToolCall,
      (params: { query: string }) => queryArchitecture(options.workspace, params.query),
    ),
    createJsonAgentTool(
      'validate_evidence',
      'Validate Evidence',
      'Validate evidence anchor refs against the current canonical architecture workspace evidence set. This checks workspace evidence refs only; it does not validate storage-v2 graph nodes or relations.',
      Type.Object({
        evidence_anchor_refs: Type.Array(Type.String()),
      }),
      options.onToolCall,
      (params: { evidence_anchor_refs: string[] }) => validateEvidenceRefs(options.workspace, params.evidence_anchor_refs),
    ),
    createJsonAgentTool(
      'propose_boundary_patch',
      'Propose Boundary Patch',
      'Submit architecture documentation-boundary decisions for canonical workspace elements. This filters decisions to existing element IDs and known workspace evidence refs, and never mutates truth graph facts.',
      Type.Object({
        decisions: Type.Array(Type.Object({
          element_id: Type.String({ minLength: 1 }),
          action: Type.Union([
            Type.Literal('keep'),
            Type.Literal('exclude_from_docs'),
            Type.Literal('rename'),
            Type.Literal('relevel'),
          ]),
          reason: Type.String({ minLength: 1 }),
          evidence_anchor_refs: Type.Array(Type.String(), { minItems: 1 }),
          proposed_name: Type.Optional(Type.String()),
          proposed_level: Type.Optional(Type.Union([
            Type.Literal('software_system'),
            Type.Literal('container'),
            Type.Literal('component'),
            Type.Literal('code_element'),
          ])),
        })),
      }),
      options.onToolCall,
      (params: BoundaryProposal) => {
        const normalized = normalizeBoundaryProposal(options.workspace, params);
        options.onProposal(normalized);
        return {
          accepted_decisions: normalized.decisions.length,
          rejected_decisions: params.decisions.length - normalized.decisions.length,
          decisions: normalized.decisions,
        };
      },
    ),
  ];
}

function queryArchitecture(workspace: ArchitectureWorkspaceData, query: string): Record<string, unknown> {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const includesTerms = (text: string): boolean => terms.every((term) => text.toLowerCase().includes(term));
  const elements = workspace.elements
    .filter((element) => includesTerms([
      element.id,
      element.name,
      element.level,
      ...(element.source_paths ?? []),
      ...element.evidence.map((anchor) => `${anchor.kind}:${anchor.id}:${anchor.filePath ?? ''}`),
    ].join(' ')))
    .slice(0, 25);
  const relationships = workspace.relationships
    .filter((relationship) => includesTerms([
      relationship.id,
      relationship.source_id,
      relationship.target_id,
      relationship.description,
    ].join(' ')))
    .slice(0, 25);
  return { elements, relationships };
}

function validateEvidenceRefs(workspace: ArchitectureWorkspaceData, refs: string[]): Record<string, unknown> {
  const knownRefs = new Set(workspace.elements.flatMap((element) => element.evidence.map(evidenceRef)));
  for (const relationship of workspace.relationships) {
    for (const anchor of relationship.evidence) knownRefs.add(evidenceRef(anchor));
  }
  return {
    valid: refs.filter((ref) => knownRefs.has(ref)),
    invalid: refs.filter((ref) => !knownRefs.has(ref)),
  };
}

function normalizeBoundaryProposal(
  workspace: ArchitectureWorkspaceData,
  proposal: BoundaryProposal,
): BoundaryProposal {
  const elementIds = new Set(workspace.elements.map((element) => element.id));
  const knownEvidence = new Set(workspace.elements.flatMap((element) => element.evidence.map(evidenceRef)));
  for (const relationship of workspace.relationships) {
    for (const anchor of relationship.evidence) knownEvidence.add(evidenceRef(anchor));
  }

  return {
    decisions: proposal.decisions
      .filter((decision) => elementIds.has(decision.element_id))
      .map((decision) => ({
        ...decision,
        evidence_anchor_refs: decision.evidence_anchor_refs.filter((ref) => knownEvidence.has(ref)),
      }))
      .filter((decision) => decision.reason.trim().length > 0 && decision.evidence_anchor_refs.length > 0),
  };
}

function boundaryReviewFromProposal(
  proposal: BoundaryProposal,
  workspace: ArchitectureWorkspaceData,
): ArchitectureBoundaryReview {
  return {
    schema_version: 'cotx.architecture.boundary_review.v1',
    generated_at: new Date().toISOString(),
    source_workspace_generated_at: workspace.generated_at,
    decisions: proposal.decisions.map((decision) => boundaryDecision(decision)),
  };
}

function boundaryDecision(decision: BoundaryProposalDecision): ArchitectureBoundaryReviewDecision {
  return {
    element_id: decision.element_id,
    action: decision.action,
    reason: decision.reason,
    evidence_anchor_refs: decision.evidence_anchor_refs,
    ...(decision.proposed_name ? { proposed_name: decision.proposed_name } : {}),
    ...(decision.proposed_level ? { proposed_level: decision.proposed_level } : {}),
  };
}

function evidenceRef(anchor: ArchitectureEvidenceAnchor): string {
  return `${anchor.kind}:${anchor.id}`;
}
