import { Agent, type AgentEvent } from '@mariozechner/pi-agent-core';
import type { AssistantMessage, ToolCall } from '@mariozechner/pi-ai';
import { collectOnboardingContext } from '../compiler/onboarding-context.js';
import { createCotxRepositoryTools } from './agentic-repo-tools.js';
import {
  modelInfo,
  requirePiAgentModel,
  resolvePiAgentApiKey,
} from './agentic-model.js';
import type {
  CotxAgenticEnrichmentLayer,
  CotxLayerAnalysisAgentOptions,
  CotxLayerAnalysisAgentResult,
  CotxTruthCorrectionProposalEvent,
  CotxTruthCorrectionProposal,
} from './agentic-types.js';

export async function runCotxLayerAnalysisAgent(
  options: CotxLayerAnalysisAgentOptions,
): Promise<CotxLayerAnalysisAgentResult> {
  const onboarding = options.onboarding ?? collectOnboardingContext(options.projectRoot, {
    budget: 'standard',
    includeExcerpts: false,
  });
  const model = options.model ?? requirePiAgentModel(options.llm);
  const toolCalls: string[] = [];
  const truthCorrectionProposals: CotxTruthCorrectionProposal[] = [];
  const truthCorrectionEvents: CotxTruthCorrectionProposalEvent[] = [];
  const diagnostics = createLayerAgentDiagnostics();
  const tools = createCotxRepositoryTools({
    projectRoot: options.projectRoot,
    onboarding,
    layer: options.layer,
    onToolCall: (name) => toolCalls.push(name),
    onTruthCorrection: (proposal) => truthCorrectionProposals.push(proposal),
    onTruthCorrectionEvent: (event) => truthCorrectionEvents.push(event),
  });

  const agent = new Agent({
    initialState: {
      systemPrompt: buildLayerAnalysisSystemPrompt(options.layer),
      model,
      thinkingLevel: model.reasoning ? 'medium' : 'off',
      tools,
    },
    getApiKey: options.getApiKey ?? (options.llm ? () => resolvePiAgentApiKey(options.llm!) : undefined),
    toolExecution: 'sequential',
    beforeToolCall: async ({ toolCall }) => {
      if (!tools.some((tool) => tool.name === toolCall.name)) {
        return { block: true, reason: `Tool not allowed in cotx ${options.layer} enrichment agent: ${toolCall.name}` };
      }
      return undefined;
    },
  });
  agent.subscribe((event) => {
    recordLayerAgentDiagnostic(diagnostics, event);
  });

  options.log?.(`Running pi-agent cotx ${options.layer} analysis with ${model.provider}/${model.id}`);
  await agent.prompt(JSON.stringify({
    task: options.task,
    layer: options.layer,
    instruction: 'Use cotx graph data as reference, then inspect docs/source as needed to validate, enrich, or identify graph gaps.',
    reference_context: options.referenceContext ?? null,
  }, null, 2));

  if ((options.requireToolUse ?? true) && toolCalls.length === 0) {
    options.log?.(`  [retry] ${options.layer} agent returned without tool use; requiring workspace/docs/source inspection`);
    await agent.prompt(JSON.stringify({
      correction: 'You returned without using tools. Before final analysis, inspect repository evidence.',
      available_repository_tools: ['read', 'grep', 'find', 'ls', 'workspace_scan', 'onboarding_context'],
      required_actions: [
        'Call workspace_scan.',
        'Call onboarding_context, grep, find, ls, or read.',
        'Before claiming a graph gap, inspect onboarding_context.summary.graph_file_index_status. If it is partial or missing, classify the issue as unknown instead of proposing a graph correction.',
        'Use missing-node only for absent CodeNode/file facts in a complete truth graph. Use architecture-grouping-gap for missing or too-coarse architecture/module grouping when the underlying files already exist in the graph.',
        'If you confirm a deterministic cotx gap with evidence, call propose_truth_correction.',
        'For propose_truth_correction, evidence_file_paths must be real project-relative files or directories. Put tool-result references such as onboarding_context into evidence_refs, not evidence_file_paths.',
        'Then return a grounded final answer.',
      ],
    }, null, 2));
  }

  let rawOutput = lastAssistantText(agent.state.messages);
  if (rawOutput.length === 0 && toolCalls.length > 0) {
    options.log?.(`  [retry] ${options.layer} agent used tools but returned an empty final answer; requiring synthesis`);
    await agent.prompt(JSON.stringify({
      correction: 'You used tools but returned an empty final answer.',
      required_output: {
        summary: 'Grounded layer analysis based on the tool results.',
        evidence_refs: ['project-relative file paths, cotx refs, or tool result refs'],
        graph_gap_proposals: 'Use propose_truth_correction first if deterministic cotx data appears wrong.',
      },
      instruction: 'Do not call more tools unless absolutely necessary. Synthesize the evidence already collected.',
    }, null, 2));
    rawOutput = lastAssistantText(agent.state.messages);
    if (rawOutput.length === 0) {
      throw new Error(
        `${options.layer} agent used tools but returned an empty final answer after synthesis retry. ${formatLayerAgentDiagnostics(toolCalls, diagnostics)}`,
      );
    }
  }

  if (
    (options.requireTruthCorrectionProposals ?? false) &&
    mentionsTruthCorrectionNeed(rawOutput) &&
    truthCorrectionProposals.length === 0 &&
    !allowsNoProposalDueToIncompleteGraphIndex(
      rawOutput,
      truthCorrectionEvents,
      onboarding.summary.graph_file_index_status,
      toolCalls,
    )
  ) {
    options.log?.(`  [retry] ${options.layer} agent described a cotx gap without recording a truth correction proposal`);
    await agent.prompt(JSON.stringify({
      correction: 'Your final answer mentioned a graph gap, deterministic cotx gap, or correction proposal, but you did not call propose_truth_correction.',
      rejected_proposal_attempts: truthCorrectionEvents
        .filter((event) => event.status === 'rejected')
        .map((event) => ({ errors: event.errors ?? [] })),
      required_actions: [
        'If the gap is real, call propose_truth_correction with file evidence and a suggested deterministic test.',
        'Do not call propose_truth_correction for unknown or partial-index cases; explicitly say no proposal is warranted until graph evidence is complete.',
        'Do not use missing-node for files that onboarding_context marks confirmed or graph validation would already contain; use architecture-grouping-gap for missing module boundaries over existing files.',
        'evidence_file_paths must be real project-relative files or directories; use evidence_refs for tool result refs.',
        'Allowed proposal kinds: parser-gap, compiler-gap, architecture-grouping-gap, architecture-description-gap, missing-node, missing-relation, wrong-relation, stale-doc, other.',
        'If it was not a real deterministic cotx gap, explicitly state that no truth correction proposal is warranted and why.',
      ],
    }, null, 2));
    rawOutput = lastAssistantText(agent.state.messages) || rawOutput;
    if (
      mentionsTruthCorrectionNeed(rawOutput) &&
      truthCorrectionProposals.length === 0 &&
      !allowsNoProposalDueToIncompleteGraphIndex(
        rawOutput,
        truthCorrectionEvents,
        onboarding.summary.graph_file_index_status,
        toolCalls,
      )
    ) {
      throw new Error(`${options.layer} agent claimed a deterministic cotx gap but did not record a truth correction proposal.`);
    }
  }
  if (truthCorrectionProposals.length > 0 && mentionsProposalRecordingFailure(rawOutput)) {
    options.log?.(`  [retry] ${options.layer} agent recorded proposals but final answer claims proposal failure; requesting corrected synthesis`);
    await agent.prompt(JSON.stringify({
      correction: 'Your final answer claimed a proposal/tool failure, but propose_truth_correction was successfully recorded.',
      recorded_proposals: truthCorrectionProposals.map((proposal) => ({
        kind: proposal.kind,
        title: proposal.title,
        evidence_file_paths: proposal.evidence_file_paths,
      })),
      required_output: 'Return a corrected grounded final answer. Do not say the proposal could not be submitted.',
    }, null, 2));
    rawOutput = lastAssistantText(agent.state.messages) || rawOutput;
    if ((options.requireTruthCorrectionProposals ?? false) && mentionsProposalRecordingFailure(rawOutput)) {
      throw new Error(`${options.layer} agent recorded truth correction proposals but final answer still claims proposal recording failed.`);
    }
  }

  return {
    layer: options.layer,
    raw_output: rawOutput,
    tool_calls: toolCalls,
    truth_correction_proposals: truthCorrectionProposals,
    truth_correction_events: truthCorrectionEvents,
    model: modelInfo(model),
  };
}

export function buildLayerAnalysisSystemPrompt(layer: CotxAgenticEnrichmentLayer): string {
  return [
    `You are cotx's built-in agentic enrichment loop for the ${layer} layer.`,
    'cotx deterministic graph and semantic layers are strong reference data, not absolute truth.',
    'Use pi-coding-agent repository tools (read, grep, find, ls) plus cotx-specific context tools to inspect workspace structure, docs, architecture notes, and selected source files when the reference data is incomplete, suspicious, or too generic.',
    'Before claiming graph gaps, check whether onboarding_context reports a complete graph file index. Partial or missing graph indexes are unknown evidence, not graph gaps.',
    'Do not confuse graph nodes with architecture groupings: if files are confirmed in the truth graph but a module/component boundary is missing or too broad, propose architecture-grouping-gap, not missing-node.',
    'Docs may be stale, but they are still important evidence for design history, migration intent, repeated rewrites, and user-facing architecture concepts.',
    'When useful, you may record parser/compiler graph gaps as correction proposals with file/span evidence and suggested deterministic tests; proposals are optional feedback artifacts and do not mutate truth graph facts.',
    'When enriching, produce grounded output with evidence anchor refs or file/line refs. Avoid generic summaries that only restate directories or counts.',
    'Never edit files from this loop. Use tools only for bounded inspection and return a structured final answer for the caller to validate.',
  ].join('\n');
}

export function mentionsTruthCorrectionNeed(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) return false;
  const withoutNegatedClauses = normalized
    .replace(/\b(?:no|not any|without)\b.{0,80}\b(?:truth corrections?|correction proposals?|graph gaps?|parser gaps?|compiler gaps?|deterministic (?:cotx )?gaps?|missing-node|architecture-grouping-gap)\b/ig, '')
    .replace(/\b(?:no proposal|no truth correction proposal|no correction proposal)\b.{0,80}\b(?:needed|warranted|required|recorded)\b/ig, '');
  const explicitProposal = /\b(?:correction proposals?|truth correction proposals?|proposed truth corrections?)\b/i.test(withoutNegatedClauses);
  const positiveGap = (
    /\b(?:identified|detected|found|confirmed|recorded|submitted|proposed|requires?|needs?|should record|should propose)\b.{0,120}\b(?:graph gaps?|parser gaps?|compiler gaps?|deterministic (?:cotx )?gaps?|missing-node|architecture-grouping-gap|architecture-description-gap|stale-doc)\b/i.test(withoutNegatedClauses) ||
    /\b(?:graph gaps?|parser gaps?|compiler gaps?|deterministic (?:cotx )?gaps?|missing-node|architecture-grouping-gap|architecture-description-gap|stale-doc)\b.{0,120}\b(?:identified|detected|found|confirmed|recorded|submitted|proposed|requires?|needs?)\b/i.test(withoutNegatedClauses)
  );
  return positiveGap || explicitProposal;
}

export function mentionsProposalRecordingFailure(text: string): boolean {
  return /\b(unable to (?:call|submit|record)|could not (?:call|submit|record)|was unable to successfully call|tool limitation|validation error)\b/i.test(text);
}

function allowsNoProposalDueToIncompleteGraphIndex(
  text: string,
  events: CotxTruthCorrectionProposalEvent[],
  graphFileIndexStatus: 'complete' | 'partial' | 'missing',
  toolCalls: string[],
): boolean {
  const graphIndexRejected = events.some((event) => (
    event.status === 'rejected' &&
    event.errors?.some((error) => error.includes('GRAPH_FILE_INDEX_INCOMPLETE'))
  ));
  if (!graphIndexRejected && graphFileIndexStatus === 'complete') return false;
  const inspectedOnboardingContext = toolCalls.includes('onboarding_context');
  const hasEvidence = graphIndexRejected || inspectedOnboardingContext;
  if (!hasEvidence) return false;
  const noProposalWarranted = /\bno (?:truth correction )?proposal\b.{0,80}\b(?:warranted|needed|required)\b/i.test(text);
  const incompleteGraphContext = /\bgraph file index\b.{0,80}\b(?:partial|missing|incomplete)\b/i.test(text) ||
    /\b(?:unknown evidence|until graph evidence is complete)\b/i.test(text);
  return noProposalWarranted && incompleteGraphContext;
}

export function lastAssistantText(messages: Array<{ role: string }>): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== 'assistant') continue;
    const assistant = message as AssistantMessage;
    return assistant.content
      .map((block) => {
        if (block.type === 'text') return block.text;
        if (block.type === 'toolCall') return toolCallText(block);
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  return '{"decisions":[]}';
}

function toolCallText(block: ToolCall): string {
  return `${block.name} ${JSON.stringify(block.arguments)}`;
}

interface LayerAgentDiagnostics {
  assistantTurns: LayerAgentAssistantTurn[];
  toolResults: LayerAgentToolResult[];
}

interface LayerAgentAssistantTurn {
  stopReason: string;
  blockTypes: string[];
  textChars: number;
}

interface LayerAgentToolResult {
  name: string;
  isError: boolean;
}

function createLayerAgentDiagnostics(): LayerAgentDiagnostics {
  return {
    assistantTurns: [],
    toolResults: [],
  };
}

function recordLayerAgentDiagnostic(diagnostics: LayerAgentDiagnostics, event: AgentEvent): void {
  if (event.type === 'message_end' && isAssistantMessage(event.message)) {
    diagnostics.assistantTurns.push({
      stopReason: event.message.stopReason,
      blockTypes: event.message.content.map((block) => (
        block.type === 'toolCall' ? `toolCall:${block.name}` : block.type
      )),
      textChars: event.message.content
        .filter((block) => block.type === 'text')
        .reduce((count, block) => count + block.text.trim().length, 0),
    });
  }
  if (event.type === 'tool_execution_end') {
    diagnostics.toolResults.push({
      name: event.toolName,
      isError: event.isError,
    });
  }
}

function formatLayerAgentDiagnostics(toolCalls: string[], diagnostics: LayerAgentDiagnostics): string {
  const assistantTurns = diagnostics.assistantTurns.slice(-6).map((turn, index) => (
    `#${index + 1} stop=${turn.stopReason} blocks=${turn.blockTypes.join('+') || 'none'} text_chars=${turn.textChars}`
  ));
  const toolResults = diagnostics.toolResults.slice(-12).map((result) => (
    result.isError ? `${result.name}:error` : `${result.name}:ok`
  ));
  return [
    `tools=${toolCalls.join(',') || 'none'}`,
    `assistant_turns=${assistantTurns.join('; ') || 'none'}`,
    `tool_results=${toolResults.join(',') || 'none'}`,
  ].join('; ');
}

function isAssistantMessage(message: { role?: unknown }): message is AssistantMessage {
  return message.role === 'assistant';
}
