import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type } from '@mariozechner/pi-ai';
import { createReadOnlyTools } from '@mariozechner/pi-coding-agent';
import type { OnboardingContext } from '../compiler/onboarding-context.js';
import { scanWorkspaceLayout } from '../compiler/workspace-scan.js';
import {
  appendTruthCorrectionProposal,
  normalizeTruthCorrectionProposal,
  readTruthCorrectionRecords,
  truthCorrectionProposalKey,
  validateTruthCorrectionProposalCandidate,
} from '../compiler/truth-correction-proposals.js';
import type {
  CotxAgenticEnrichmentLayer,
  CotxTruthCorrectionProposal,
  CotxTruthCorrectionProposalEvent,
} from './agentic-types.js';

export interface CotxRepositoryToolsOptions {
  projectRoot: string;
  onboarding: OnboardingContext;
  layer: CotxAgenticEnrichmentLayer;
  onToolCall: (name: string) => void;
  onTruthCorrection?: (proposal: CotxTruthCorrectionProposal) => void;
  onTruthCorrectionEvent?: (event: CotxTruthCorrectionProposalEvent) => void;
}

export function createCotxRepositoryTools(options: CotxRepositoryToolsOptions): AgentTool<any>[] {
  const recordedProposalKeys = new Set<string>(
    readTruthCorrectionRecords(options.projectRoot)
      .map((record) => truthCorrectionProposalKey(record)),
  );
  return [
    ...createReadOnlyTools(options.projectRoot).map((tool) => trackToolCall(tool, options.onToolCall)),
    createJsonAgentTool(
      'workspace_scan',
      'Workspace Scan',
      'Return a bounded structural map of the working directory: repo/package/doc/.cotx boundaries and candidate input files. This is a navigation index only; it does not read large file contents and does not validate graph truth.',
      Type.Object({}),
      options.onToolCall,
      () => summarizeWorkspaceScan(scanWorkspaceLayout(options.projectRoot, { maxCandidates: 200 })),
    ),
    createJsonAgentTool(
      'onboarding_context',
      'Onboarding Context',
      'Return deterministic onboarding context from README/agent docs/manifests/.cotx sidecars plus doc-vs-graph consistency categories. Check summary.graph_file_index_status: only complete indexes can support real graph-gap claims; partial or missing indexes should be treated as unknown and verified with tools.',
      Type.Object({}),
      options.onToolCall,
      () => ({
        summary: options.onboarding.summary,
        hypotheses: options.onboarding.hypotheses.slice(0, 30),
        consistency: {
          sampling_note: 'These consistency arrays are bounded samples. Use counts plus targeted tools; absence from a returned sample is not evidence that a path is missing.',
          total_counts: options.onboarding.summary.consistency_counts,
          returned_counts: {
            confirmed: Math.min(options.onboarding.consistency.confirmed.length, 20),
            contradicted: Math.min(options.onboarding.consistency.contradicted.length, 20),
            stale_doc: Math.min(options.onboarding.consistency['stale-doc'].length, 20),
            graph_gap: Math.min(options.onboarding.consistency['graph-gap'].length, 20),
            unknown: Math.min(options.onboarding.consistency.unknown.length, 20),
          },
          confirmed: options.onboarding.consistency.confirmed.slice(0, 20),
          contradicted: options.onboarding.consistency.contradicted.slice(0, 20),
          stale_doc: options.onboarding.consistency['stale-doc'].slice(0, 20),
          graph_gap: options.onboarding.consistency['graph-gap'].slice(0, 20),
          unknown: options.onboarding.consistency.unknown.slice(0, 20),
        },
      }),
    ),
    createJsonAgentTool(
      'propose_truth_correction',
      'Propose Truth Correction',
      'Record a deterministic cotx improvement proposal for parser/compiler/grouping/description/doc staleness issues. This writes an overlay queue item only; it never mutates the truth graph. Use it only after evidence confirms a real deterministic gap, not for unknown or partial-index cases. evidence_file_paths must be real project-relative files or directories; use evidence_refs for tool result refs such as onboarding_context. Use missing-node only when a CodeNode/file is absent from the complete truth graph; if the file exists in the graph but architecture grouping is too coarse or missing, use architecture-grouping-gap instead. Allowed kind values: parser-gap, compiler-gap, architecture-grouping-gap, architecture-description-gap, missing-node, missing-relation, wrong-relation, stale-doc, other.',
      Type.Object({
        kind: Type.Union([
          Type.Literal('parser-gap'),
          Type.Literal('compiler-gap'),
          Type.Literal('architecture-grouping-gap'),
          Type.Literal('architecture-description-gap'),
          Type.Literal('missing-node'),
          Type.Literal('missing-relation'),
          Type.Literal('wrong-relation'),
          Type.Literal('stale-doc'),
          Type.Literal('other'),
        ]),
        title: Type.String({ minLength: 1 }),
        current_fact: Type.Optional(Type.String()),
        proposed_fact: Type.String({ minLength: 1 }),
        evidence_file_paths: Type.Array(Type.String(), { minItems: 1 }),
        evidence_refs: Type.Optional(Type.Array(Type.String())),
        suggested_test: Type.Optional(Type.String()),
        confidence: Type.Union([
          Type.Literal('low'),
          Type.Literal('medium'),
          Type.Literal('high'),
        ]),
      }),
      options.onToolCall,
      async (params: CotxTruthCorrectionProposal) => {
        const normalized = tryNormalizeTruthCorrectionProposal(options.projectRoot, params);
        if (!normalized.ok) {
          const event = {
            status: 'rejected' as const,
            errors: normalized.errors,
          };
          options.onTruthCorrectionEvent?.(event);
          return {
            recorded: false,
            status: event.status,
            errors: event.errors,
            retry_hint: 'Use evidence_file_paths only for real project-relative files or directories. Put tool-result refs such as onboarding_context_response into evidence_refs.',
          };
        }
        const proposal = normalized.proposal;
        const preflightFindings = await validateTruthCorrectionProposalCandidate(options.projectRoot, options.layer, proposal, {
          graphFileIndexStatus: options.onboarding.summary.graph_file_index_status,
          truthGraphPresent: options.onboarding.summary.has_storage_v2_truth,
        });
        const preflightErrors = preflightFindings.filter((finding) => finding.level === 'error');
        if (preflightErrors.length > 0) {
          const graphIndexIncomplete = preflightErrors.some((finding) => finding.code === 'GRAPH_FILE_INDEX_INCOMPLETE');
          const event = {
            status: 'rejected' as const,
            errors: preflightErrors.map((finding) => `${finding.code}: ${finding.message}`),
          };
          options.onTruthCorrectionEvent?.(event);
          return {
            recorded: false,
            status: event.status,
            errors: event.errors,
            validation_findings: preflightFindings,
            retry_hint: graphIndexIncomplete
              ? 'The graph file index is not complete. Treat this as unknown until cotx compile produces a complete file index, and do not record a graph correction proposal yet.'
              : 'The candidate conflicts with current graph facts. Re-check graph/file status and use architecture-grouping-gap for coarse boundaries over existing files instead of missing-node.',
          };
        }
        const proposalKey = truthCorrectionProposalKey(proposal);
        if (recordedProposalKeys.has(proposalKey)) {
          const event = {
            status: 'duplicate' as const,
            proposal,
          };
          options.onTruthCorrectionEvent?.(event);
          return { recorded: false, status: event.status, duplicate: true, proposal };
        }
        recordedProposalKeys.add(proposalKey);
        appendTruthCorrectionProposal(options.projectRoot, options.layer, proposal);
        options.onTruthCorrection?.(proposal);
        const event = {
          status: 'recorded' as const,
          proposal,
        };
        options.onTruthCorrectionEvent?.(event);
        return { recorded: true, status: event.status, proposal, validation_findings: preflightFindings };
      },
    ),
  ];
}

function tryNormalizeTruthCorrectionProposal(
  projectRoot: string,
  params: CotxTruthCorrectionProposal,
): { ok: true; proposal: CotxTruthCorrectionProposal } | { ok: false; errors: string[] } {
  try {
    const proposal = normalizeTruthCorrectionProposal(projectRoot, params);
    return { ok: true, proposal };
  } catch (error) {
    return {
      ok: false,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

export function createJsonAgentTool<T>(
  name: string,
  label: string,
  description: string,
  parameters: AgentTool<any>['parameters'],
  onToolCall: (name: string) => void,
  execute: (params: T) => unknown | Promise<unknown>,
): AgentTool<any> {
  return {
    name,
    label,
    description,
    parameters,
    async execute(_toolCallId, params) {
      onToolCall(name);
      const details = await execute(params as T);
      return {
        content: [{ type: 'text', text: JSON.stringify(details, null, 2) }],
        details,
      };
    },
  };
}

function trackToolCall(tool: AgentTool<any>, onToolCall: (name: string) => void): AgentTool<any> {
  return {
    ...tool,
    async execute(toolCallId, params, signal, onUpdate) {
      onToolCall(tool.name);
      return tool.execute(toolCallId, params, signal, onUpdate);
    },
  };
}

function summarizeWorkspaceScan(scan: ReturnType<typeof scanWorkspaceLayout>): Record<string, unknown> {
  return {
    summary: scan.summary,
    directories: scan.directories.slice(0, 120),
    candidates: scan.candidates.slice(0, 120),
    packages: scan.directories.filter((entry) => entry.kind === 'package').slice(0, 80),
    asset_dirs: scan.directories.filter((entry) => entry.kind === 'asset').slice(0, 80),
    nested_repos: scan.directories.filter((entry) => entry.kind === 'nested-repo').slice(0, 30),
    local_inputs: scan.directories.filter((entry) => entry.kind === 'example' || entry.kind === 'docs' || entry.kind === 'architecture-store').slice(0, 80),
  };
}
