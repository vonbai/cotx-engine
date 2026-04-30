import type { Model } from '@mariozechner/pi-ai';
import type { LlmConfig } from '../config.js';
import type { OnboardingContext } from '../compiler/onboarding-context.js';
import type {
  ArchitectureBoundaryReview,
  ArchitectureWorkspaceData,
  ArchitectureRecursionPlan,
} from '../store/schema.js';
import type {
  CotxTruthCorrectionLayer,
  CotxTruthCorrectionProposal,
} from '../compiler/truth-correction-proposals.js';

export type CotxAgenticEnrichmentLayer = CotxTruthCorrectionLayer;

export type { CotxTruthCorrectionProposal };

export interface CotxAgentModelInfo {
  provider: string;
  id: string;
  api: string;
  base_url?: string;
}

export interface CotxLayerAnalysisAgentOptions {
  projectRoot: string;
  layer: CotxAgenticEnrichmentLayer;
  task: string;
  referenceContext?: unknown;
  onboarding?: OnboardingContext;
  llm?: LlmConfig;
  model?: Model<any>;
  getApiKey?: (provider: string) => string | undefined | Promise<string | undefined>;
  log?: (...args: unknown[]) => void;
  requireToolUse?: boolean;
  requireTruthCorrectionProposals?: boolean;
}

export interface CotxTruthCorrectionProposalEvent {
  status: 'recorded' | 'duplicate' | 'rejected';
  errors?: string[];
  proposal?: CotxTruthCorrectionProposal;
}

export interface CotxLayerAnalysisAgentResult {
  layer: CotxAgenticEnrichmentLayer;
  raw_output: string;
  tool_calls: string[];
  truth_correction_proposals: CotxTruthCorrectionProposal[];
  truth_correction_events: CotxTruthCorrectionProposalEvent[];
  model: CotxAgentModelInfo;
}

export interface ArchitectureBoundaryAgentOptions {
  projectRoot: string;
  workspace: ArchitectureWorkspaceData;
  recursionPlan: ArchitectureRecursionPlan;
  onboarding?: OnboardingContext;
  llm?: LlmConfig;
  model?: Model<any>;
  getApiKey?: (provider: string) => string | undefined | Promise<string | undefined>;
  log?: (...args: unknown[]) => void;
  requireToolUse?: boolean;
}

export interface ArchitectureBoundaryAgentResult {
  review: ArchitectureBoundaryReview;
  raw_output?: string;
  tool_calls: string[];
  model: CotxAgentModelInfo;
}
