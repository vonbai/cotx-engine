export interface Annotation {
  author: 'human' | 'agent';
  type: 'constraint' | 'intent' | 'concern' | 'question';
  content: string;
  date: string;
  stale?: boolean;
  stale_reason?: string;
}

export interface ComplexityMetrics {
  total_functions: number;
  max_nesting_depth: number;
  avg_nesting_depth: number;
  max_cyclomatic: number;
  avg_cyclomatic: number;
  max_function_loc: number;
  hotspot_functions: string[];
}

export interface ChurnMetrics {
  change_count: number;
  last_changed: string;
  stability: 'stable' | 'active' | 'volatile';
}

export interface ModuleNode {
  id: string;
  canonical_entry: string;
  files: string[];
  depends_on: string[];
  depended_by: string[];
  struct_hash: string;
  complexity?: ComplexityMetrics;
  churn?: ChurnMetrics;
  enriched?: {
    responsibility?: string;
    key_patterns?: string;
    source_hash: string;
    enriched_at: string;
  };
  annotations?: Annotation[];
}

export interface ConceptNode {
  id: string;
  aliases: string[];
  appears_in: string[];
  layer: string;
  struct_hash: string;
  enriched?: {
    definition?: string;
    distinguished_from?: Array<{ term: string; difference: string }>;
    source_hash: string;
    enriched_at: string;
  };
  annotations?: Annotation[];
}

export interface ContractNode {
  id: string;
  provider: string;
  consumer: string;
  interface: string[];
  struct_hash: string;
  enriched?: {
    guarantees?: string[];
    invariants?: string[];
    source_hash: string;
    enriched_at: string;
  };
  annotations?: Annotation[];
}

export interface FlowStep {
  module: string;
  function: string;
  action?: string;
}

export interface StateDefinition {
  id: string;
  source: string;  // file:line
}

export interface StateTransition {
  from: string;
  to: string;
  trigger: string;   // function name
  source: string;    // file:line
}

export interface FlowNode {
  id: string;
  type: 'flow' | 'state_machine';
  // --- flow fields ---
  trigger?: string;
  steps?: FlowStep[];
  // --- state_machine fields ---
  owner_module?: string;
  state_field?: string;
  states?: StateDefinition[];
  transitions?: StateTransition[];
  // --- shared ---
  struct_hash: string;
  enriched?: {
    // flow enrichment
    error_paths?: Array<{ condition: string; behavior: string }>;
    // state_machine enrichment
    guards?: Array<{ transition: string; condition: string }>;
    invariants?: string[];
    // shared
    source_hash: string;
    enriched_at: string;
  };
  annotations?: Annotation[];
}

export interface ConcernNode {
  id: string;
  type: 'risk' | 'debt' | 'decision' | 'question';
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  affected_modules: string[];
  affected_flows: string[];
  author: 'human' | 'agent';
  created: string;
}

export interface CotxMeta {
  version: string;
  project: string;
  compiled_at: string;
  module_resolution: 'coarse' | 'medium' | 'fine';
  bootstrap_enrichment?: BootstrapEnrichmentState;
  git?: {
    head: string;
    branch: string;
    dirty_fingerprint: string;
    dirty_files_count?: number;
    ignore_fingerprint?: string;
    worktree_path?: string;
  };
  stats: {
    concepts: number;
    modules: number;
    contracts: number;
    flows: number;
    concerns: number;
  };
}

export type CompileEnrichPolicy = 'never' | 'bootstrap-if-available' | 'force-bootstrap';
export type IncrementalEnrichPolicy = 'never' | 'affected-if-available' | 'stale-if-available' | 'force-affected';

export interface BootstrapEnrichmentState {
  schema_version: 'cotx.bootstrap_enrichment.v1';
  baseline_version: string;
  policy: CompileEnrichPolicy;
  created_at: string;
  git_head?: string;
  git_branch?: string;
  worktree_path?: string;
  layers: Array<'module' | 'architecture'>;
  module_summary?: {
    total: number;
    succeeded: number;
    failed: number;
  };
  architecture_summary?: {
    perspectives_enriched: number;
    descriptions_written: number;
    diagrams_written: number;
    recursive_jobs_planned?: number;
    recursive_jobs_run?: number;
  };
}

export interface CotxIndex {
  version: string;
  compiled_at: string;
  project: string;
  stats: CotxMeta['stats'];
  graph: {
    nodes: Array<{ id: string; layer: string; file: string }>;
    edges: Array<{ from: string; to: string; relation: string }>;
  };
}

export interface ChangeSummarySymbol {
  id: string;
  label: string;
  file?: string;
  reason?: string;
}

export interface ChangeSummaryNode {
  id: string;
  layer: 'module' | 'concept' | 'contract' | 'flow' | 'concern';
  changes?: string[];
}

export interface ChangeSummaryStaleEnrichment {
  nodeId: string;
  layer: string;
  source_hash?: string;
  struct_hash?: string;
  reason?: string;
}

export interface ChangeSummaryStaleAnnotation {
  nodeId: string;
  layer: string;
  annotationIndex: number;
  reason: string;
}

export interface ChangeSummary {
  generated_at: string;
  trigger: 'update' | 'diff';
  changed_files: string[];
  affected_modules: string[];
  affected_contracts: string[];
  affected_flows: string[];
  symbols: {
    added: ChangeSummarySymbol[];
    removed: ChangeSummarySymbol[];
    changed: ChangeSummarySymbol[];
  };
  layers: {
    added: ChangeSummaryNode[];
    removed: ChangeSummaryNode[];
    changed: ChangeSummaryNode[];
  };
  stale: {
    enrichments: ChangeSummaryStaleEnrichment[];
    annotations: ChangeSummaryStaleAnnotation[];
  };
}

export interface DoctrineEvidenceRef {
  kind:
    | 'module'
    | 'contract'
    | 'flow'
    | 'architecture'
    | 'annotation'
    | 'doc'
    | 'change'
    | 'function'
    | 'canonical_path'
    | 'symmetry_edge'
    | 'closure_set'
    | 'abstraction_opportunity'
    | 'plan_option'
    | 'override';
  ref: string;
  detail?: string;
  score?: number;
}

export interface DoctrineStatement {
  id: string;
  kind: 'principle' | 'constraint' | 'preferred_pattern' | 'anti_pattern' | 'decision_note';
  title: string;
  statement: string;
  refined_statement?: string;
  strength: 'hard' | 'soft';
  scope: 'repo' | 'module';
  module?: string;
  inferred: boolean;
  evidence: DoctrineEvidenceRef[];
}

export interface DoctrineData {
  generated_at: string;
  struct_hash: string;
  statements: DoctrineStatement[];
}

export type DecisionConfidenceStatus = 'candidate' | 'confirmed' | 'ambiguous' | 'canonical' | 'recommended';

export interface ConcernFamily {
  id: string;
  name: string;
  verb_roots: string[];
  resource_roots: string[];
  sink_role: string;
  entry_kinds: string[];
  member_paths: string[];
  evidence: DoctrineEvidenceRef[];
  confidence: number;
  status: Extract<DecisionConfidenceStatus, 'candidate' | 'confirmed' | 'ambiguous'>;
}

export interface PathInstance {
  id: string;
  family_id: string;
  entry_symbol: string;
  entry_kind: 'flow_trigger' | 'canonical_entry' | 'contract_interface' | 'high_fan_in' | 'unknown';
  function_symbols: string[];
  module_chain: string[];
  contract_hops: string[];
  sink_symbol: string;
  sink_role: string;
  evidence: DoctrineEvidenceRef[];
}

export interface OperationUnit {
  id: string;
  family_id: string;
  module: string;
  symbol: string;
  file_path?: string;
  role?: 'prod_core' | 'prod_entrypoint' | 'test' | 'example' | 'dev_tool' | 'generated' | 'peripheral';
  role_confidence?: number;
  scope_hint?: string;
  kind: 'handler' | 'service' | 'validator' | 'repository' | 'worker' | 'unknown';
  path_ids: string[];
  related_symbols: string[];
  evidence: DoctrineEvidenceRef[];
}

export interface CanonicalPathDeviation {
  module: string;
  symbol: string;
  missing_symbols: string[];
  reason: string;
}

export interface CanonicalPath {
  id: string;
  family_id: string;
  name: string;
  target_concern: string;
  owning_module: string;
  primary_entry_symbols: string[];
  path_ids: string[];
  score_breakdown: Record<string, number>;
  confidence: number;
  status: Extract<DecisionConfidenceStatus, 'candidate' | 'canonical' | 'recommended'>;
  evidence: DoctrineEvidenceRef[];
  deviations: CanonicalPathDeviation[];
}

export interface SymmetryEdge {
  id: string;
  family_id: string;
  from_unit: string;
  to_unit: string;
  strength: 'hard' | 'soft';
  score: number;
  reasons: string[];
  evidence: DoctrineEvidenceRef[];
}

export interface ClosureMember {
  unit_id: string;
  level: 'must_review' | 'should_review' | 'must_change_if_strategy_selected';
  reasons: string[];
  confidence: number;
  evidence: DoctrineEvidenceRef[];
}

export interface ClosureSet {
  id: string;
  target_unit: string;
  family_id?: string;
  generated_at: string;
  members: ClosureMember[];
  evidence: DoctrineEvidenceRef[];
}

export interface AbstractionOpportunity {
  id: string;
  title: string;
  family_id?: string;
  repeated_paths: string[];
  candidate_units: string[];
  suggested_abstraction_level: 'extract_helper' | 'extract_service' | 'lift_to_canonical_path';
  candidate_owning_module: string;
  expected_closure_set?: string;
  evidence: DoctrineEvidenceRef[];
  confidence: number;
  status: Extract<DecisionConfidenceStatus, 'candidate' | 'recommended' | 'ambiguous'>;
}

export interface DecisionOverride {
  id: string;
  created_at: string;
  target_type: 'canonical_path' | 'plan_option' | 'review_finding';
  target_id: string;
  reason: string;
  evidence: DoctrineEvidenceRef[];
}

export interface PlanScoreDimension {
  name: string;
  score: number;
  weight: number;
  detail?: string;
}

export interface ChangePlanOption {
  id: string;
  kind?: 'local_patch' | 'extract_helper' | 'canonicalize_path' | 'cluster_wide_closure' | 'compatibility_bridge';
  title: string;
  summary: string;
  module_scope: string[];
  scope_hints?: string[];
  entry_points: string[];
  doctrine_refs: string[];
  evidence: DoctrineEvidenceRef[];
  dimension_scores?: PlanScoreDimension[];
  total_score?: number;
  confidence?: number;
  why_not?: string[];
  related_canonical_paths?: string[];
  related_closure_sets?: string[];
  discouraged: boolean;
  recommended?: boolean;
}

export interface ChangePlanData {
  generated_at: string;
  target: string;
  intent?: string;
  focus_nodes: Array<{ id: string; layer: string }>;
  recommended_modules: string[];
  scope_hints?: string[];
  entry_points: string[];
  doctrine_refs: string[];
  recommended_steps: string[];
  discouraged_approaches: string[];
  rationale: string[];
  options: ChangePlanOption[];
  canonical_paths?: string[];
  closure_sets?: string[];
  abstraction_opportunities?: string[];
  recommended_option_id?: string;
  unresolved_ambiguities?: string[];
}

export interface ChangeReviewFinding {
  id: string;
  severity: 'info' | 'warning' | 'error';
  kind: 'local_patch' | 'compatibility_layer' | 'half_refactor' | 'doctrine_violation' | 'boundary_bypass';
  title: string;
  message: string;
  doctrine_refs: string[];
  evidence: DoctrineEvidenceRef[];
  recommendation?: string;
  canonical_path_refs?: string[];
  closure_refs?: string[];
  abstraction_refs?: string[];
  related_option_id?: string;
}

export interface ChangeReviewData {
  generated_at: string;
  changed_files: string[];
  findings: ChangeReviewFinding[];
  matched_option_id?: string;
  summary: {
    warnings: number;
    errors: number;
  };
}

// ── Architecture Layer ──────────────────────────────────────────────────────

export interface ArchitectureStats {
  file_count: number;
  function_count: number;
  total_cyclomatic: number;
  max_cyclomatic: number;
  max_nesting_depth: number;
  risk_score: number;
}

export interface ArchitectureElement {
  id: string;
  label: string;
  kind: 'group' | 'leaf';
  directory: string;
  // Group-only (kind === 'group')
  children?: string[];
  // Leaf-only (kind === 'leaf')
  files?: string[];
  exported_functions?: string[];
  contracts_provided?: string[];
  contracts_consumed?: string[];
  related_flows?: string[];
  // Shared
  stats: ArchitectureStats;
}

export interface ArchitectureEdge {
  from: string;
  to: string;
  label: string;
  type: 'data_flow' | 'dependency' | 'event';
  weight: number;
}

export interface PerspectiveData {
  id: string;
  label: string;
  components: ArchitectureElement[];
  edges: ArchitectureEdge[];
}

export interface ArchitectureMeta {
  perspectives: string[];
  generated_at: string;
  mode: 'auto' | 'llm' | 'agent';
  struct_hash: string;
}

export type ArchitectureWorkspaceLevel = 'software_system' | 'container' | 'component' | 'code_element';

export type ArchitectureWorkspaceViewType = 'system_context' | 'container' | 'component' | 'dynamic' | 'custom';

export type ArchitectureReviewStatus = 'draft' | 'accepted' | 'rejected' | 'stale';

export interface ArchitectureEvidenceAnchor {
  kind: 'node' | 'relation' | 'file' | 'process' | 'route' | 'tool' | 'decision' | 'module';
  id: string;
  filePath?: string;
  line?: number;
  detail?: string;
}

export interface ArchitectureWorkspaceElement {
  id: string;
  name: string;
  level: ArchitectureWorkspaceLevel;
  parent_id?: string;
  description?: string;
  tags?: string[];
  source_paths?: string[];
  metadata?: {
    stats?: Partial<ArchitectureStats>;
    exported_functions?: string[];
    contracts_provided?: string[];
    contracts_consumed?: string[];
    related_flows?: string[];
  };
  evidence: ArchitectureEvidenceAnchor[];
  review_status: ArchitectureReviewStatus;
  stale?: boolean;
  stale_reason?: string;
}

export interface ArchitectureWorkspaceRelationship {
  id: string;
  source_id: string;
  target_id: string;
  description: string;
  technology?: string;
  tags?: string[];
  evidence: ArchitectureEvidenceAnchor[];
  review_status: ArchitectureReviewStatus;
  stale?: boolean;
  stale_reason?: string;
}

export interface ArchitectureWorkspaceView {
  id: string;
  name: string;
  type: ArchitectureWorkspaceViewType;
  element_ids: string[];
  relationship_ids: string[];
  description?: string;
  review_status: ArchitectureReviewStatus;
}

export interface ArchitectureWorkspaceData {
  schema_version: 'cotx.architecture.workspace.v1';
  generated_at: string;
  source_graph_compiled_at?: string;
  elements: ArchitectureWorkspaceElement[];
  relationships: ArchitectureWorkspaceRelationship[];
  views: ArchitectureWorkspaceView[];
}

export type ArchitectureEnrichmentMode = 'builtin-llm' | 'caller-agent';

export type ArchitectureEnrichmentTarget =
  | 'code-node'
  | 'module'
  | 'flow'
  | 'route'
  | 'tool'
  | 'architecture-element'
  | 'architecture-perspective';

export interface ArchitectureEnrichmentJob {
  schema_version: 'cotx.architecture.enrichment_job.v1';
  id: string;
  mode: ArchitectureEnrichmentMode;
  target: {
    kind: ArchitectureEnrichmentTarget;
    id: string;
    field?: string;
  };
  prompt_version?: string;
  provider?: string;
  model?: string;
  input_graph_compiled_at?: string;
  created_at: string;
  updated_at?: string;
  evidence: ArchitectureEvidenceAnchor[];
  output?: {
    format: 'markdown' | 'json' | 'text';
    content: string;
    hash: string;
  };
  review_status: ArchitectureReviewStatus;
  stale?: boolean;
  stale_reason?: string;
}

export interface ArchitectureEnrichmentValidationFinding {
  level: 'error' | 'warning';
  code:
    | 'MISSING_EVIDENCE'
    | 'MISSING_TARGET'
    | 'MISSING_FILE'
    | 'MISSING_GRAPH_ANCHOR'
    | 'MISSING_ARCHITECTURE_ELEMENT'
    | 'MISSING_ARCHITECTURE_PERSPECTIVE'
    | 'UNSUPPORTED_ANCHOR_VALIDATION'
    | 'OUTPUT_HASH_MISMATCH';
  message: string;
  anchor?: ArchitectureEvidenceAnchor;
}

export interface ArchitectureEnrichmentValidationResult {
  ok: boolean;
  findings: ArchitectureEnrichmentValidationFinding[];
}

export interface ArchitectureRecursionDecision {
  element_id: string;
  action: 'leaf' | 'recurse' | 'unsupported';
  reason: string;
  child_element_ids: string[];
  evidence: ArchitectureEvidenceAnchor[];
}

export interface ArchitectureRecursionPlan {
  schema_version: 'cotx.architecture.recursion_plan.v1';
  generated_at: string;
  source_workspace_generated_at?: string;
  decisions: ArchitectureRecursionDecision[];
}

export type ArchitectureBoundaryAction = 'keep' | 'exclude_from_docs' | 'rename' | 'relevel';

export interface ArchitectureBoundaryReviewDecision {
  element_id: string;
  action: ArchitectureBoundaryAction;
  reason: string;
  evidence_anchor_refs: string[];
  proposed_name?: string;
  proposed_level?: ArchitectureWorkspaceLevel;
}

export interface ArchitectureBoundaryReview {
  schema_version: 'cotx.architecture.boundary_review.v1';
  generated_at: string;
  source_workspace_generated_at?: string;
  decisions: ArchitectureBoundaryReviewDecision[];
}
