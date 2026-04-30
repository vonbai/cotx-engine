import { Agent, type AgentTool } from '@mariozechner/pi-agent-core';
import type { Model } from '@mariozechner/pi-ai';
import { collectOnboardingContext, type OnboardingContext } from '../compiler/onboarding-context.js';
import type { LlmConfig } from '../config.js';
import { createCotxRepositoryTools } from './agentic-repo-tools.js';
import { lastAssistantText } from './agentic-runtime.js';
import {
  modelInfo,
  requirePiAgentModel,
  resolvePiAgentApiKey,
} from './agentic-model.js';
import type { CotxTruthCorrectionProposalEvent, CotxTruthCorrectionProposal } from './agentic-types.js';
import type { SourceRootInventory, SourceRootRole } from '../compiler/source-root-inventory.js';

export interface SourceRootAdvisorySuggestion {
  path: string;
  role: SourceRootRole | 'peripheral' | 'unknown';
  include_in_overall_architecture: boolean;
  confidence: 'low' | 'medium' | 'high';
  rationale: string;
}

export interface SourceRootAdvisory {
  verdict: 'accept' | 'adjust' | 'uncertain';
  notes: string[];
  suggested_roots: SourceRootAdvisorySuggestion[];
}

export interface SourceRootAdvisorOptions {
  projectRoot: string;
  inventory: SourceRootInventory;
  llm: LlmConfig;
  onboarding?: OnboardingContext;
  model?: Model<any>;
  log?: (...args: unknown[]) => void;
}

export interface SourceRootAdvisorResult {
  raw_output: string;
  parsed: SourceRootAdvisory | null;
  tool_calls: string[];
  truth_correction_proposals: CotxTruthCorrectionProposal[];
  truth_correction_events: CotxTruthCorrectionProposalEvent[];
  model: ReturnType<typeof modelInfo>;
}

const SOURCE_ROOT_ADVISOR_SYSTEM_PROMPT = [
  'You are cotx\'s non-authoritative source-root advisor.',
  'The deterministic source-root inventory is the canonical baseline.',
  'You may inspect workspace layout, onboarding context, README/docs, and bounded source files to decide whether the baseline likely misses or misclassifies any important source root.',
  'Do not mutate truth graph facts. Your job is advisory only.',
  'If you discover a real deterministic compiler or grouping gap with file evidence, you may record a truth correction proposal, but keep your final answer focused on source-root recommendations.',
  'Return strict JSON only. No markdown fences.',
  'Use this JSON schema:',
  JSON.stringify({
    verdict: 'accept | adjust | uncertain',
    notes: ['short note'],
    suggested_roots: [
      {
        path: 'project-relative root path',
        role: 'repo-core | app | package | peripheral | unknown',
        include_in_overall_architecture: true,
        confidence: 'low | medium | high',
        rationale: 'grounded explanation',
      },
    ],
  }, null, 2),
].join('\n');

export async function runSourceRootDiscoveryAdvisor(
  options: SourceRootAdvisorOptions,
): Promise<SourceRootAdvisorResult> {
  const onboarding = options.onboarding ?? collectOnboardingContext(options.projectRoot, {
    budget: 'standard',
    includeExcerpts: false,
  });
  const model = options.model ?? requirePiAgentModel(options.llm);
  const toolCalls: string[] = [];
  const truthCorrectionProposals: CotxTruthCorrectionProposal[] = [];
  const truthCorrectionEvents: CotxTruthCorrectionProposalEvent[] = [];
  const tools = createCotxRepositoryTools({
    projectRoot: options.projectRoot,
    onboarding,
    layer: 'architecture',
    onToolCall: (name) => toolCalls.push(name),
    onTruthCorrection: (proposal) => truthCorrectionProposals.push(proposal),
    onTruthCorrectionEvent: (event) => truthCorrectionEvents.push(event),
  });
  const allowedNames = new Set(tools.map((tool) => tool.name));
  const agent = new Agent({
    initialState: {
      systemPrompt: SOURCE_ROOT_ADVISOR_SYSTEM_PROMPT,
      model,
      thinkingLevel: model.reasoning ? 'medium' : 'off',
      tools: tools as AgentTool<any>[],
    },
    getApiKey: () => resolvePiAgentApiKey(options.llm),
    toolExecution: 'sequential',
    beforeToolCall: async ({ toolCall }) => {
      if (!allowedNames.has(toolCall.name)) {
        return {
          block: true,
          reason: `Tool not allowed in source-root advisor: ${toolCall.name}`,
        };
      }
      return undefined;
    },
  });

  options.log?.(`Running source-root advisor with ${model.provider}/${model.id}`);
  await agent.prompt(JSON.stringify({
    task: 'Review the deterministic source root inventory and propose advisory adjustments only if the evidence supports them.',
    deterministic_inventory: {
      selected: options.inventory.selected,
      excluded: options.inventory.excluded,
      summary: options.inventory.summary,
    },
    required_actions: [
      'Call workspace_scan.',
      'Call onboarding_context.',
      'Use read/grep/find/ls if README, docs, manifests, or selected source files are needed.',
      'Return strict JSON only.',
    ],
  }, null, 2));

  if (toolCalls.length === 0) {
    options.log?.('  [retry] source-root advisor returned without tool use; requiring bounded inspection');
    await agent.prompt(JSON.stringify({
      correction: 'You returned without using tools. Inspect workspace_scan and onboarding_context at minimum, then return strict JSON.',
    }, null, 2));
  }

  const raw = lastAssistantText(agent.state.messages);
  return {
    raw_output: raw,
    parsed: parseSourceRootAdvisory(raw),
    tool_calls: toolCalls,
    truth_correction_proposals: truthCorrectionProposals,
    truth_correction_events: truthCorrectionEvents,
    model: modelInfo(model),
  };
}

export function parseSourceRootAdvisory(raw: string): SourceRootAdvisory | null {
  const json = extractJsonObject(raw);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Partial<SourceRootAdvisory>;
    if (
      parsed.verdict !== 'accept' &&
      parsed.verdict !== 'adjust' &&
      parsed.verdict !== 'uncertain'
    ) {
      return null;
    }
    const notes = Array.isArray(parsed.notes)
      ? parsed.notes.filter((item): item is string => typeof item === 'string')
      : [];
    const suggested_roots = Array.isArray(parsed.suggested_roots)
      ? parsed.suggested_roots.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const record = item as {
          path?: unknown;
          role?: unknown;
          include_in_overall_architecture?: unknown;
          confidence?: unknown;
          rationale?: unknown;
        };
        if (typeof record.path !== 'string' || typeof record.rationale !== 'string') return [];
        const role = normalizeRole(record.role);
        const confidence = normalizeConfidence(record.confidence);
        if (!role || !confidence) return [];
        return [{
          path: record.path,
          role,
          include_in_overall_architecture: record.include_in_overall_architecture === true,
          confidence,
          rationale: record.rationale,
        } satisfies SourceRootAdvisorySuggestion];
      })
      : [];
    return {
      verdict: parsed.verdict,
      notes,
      suggested_roots,
    };
  } catch {
    return null;
  }
}

function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index++) {
    const ch = raw[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return raw.slice(start, index + 1);
    }
  }
  return null;
}

function normalizeRole(value: unknown): SourceRootAdvisorySuggestion['role'] | null {
  return value === 'repo-core' ||
    value === 'app' ||
    value === 'package' ||
    value === 'peripheral' ||
    value === 'unknown'
    ? value
    : null;
}

function normalizeConfidence(value: unknown): SourceRootAdvisorySuggestion['confidence'] | null {
  return value === 'low' || value === 'medium' || value === 'high' ? value : null;
}
