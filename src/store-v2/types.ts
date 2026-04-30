export interface CodeNodeFact {
  id: string;
  label: string;
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  isExported: boolean;
  properties: string;
}

export interface CodeRelationFact {
  from: string;
  to: string;
  type: string;
  confidence: number;
  reason: string;
  step: number;
}

export interface GraphFacts {
  codeNodes: CodeNodeFact[];
  codeRelations: CodeRelationFact[];
}

export interface SemanticArtifactFact {
  id: string;
  layer:
    | 'module'
    | 'concept'
    | 'contract'
    | 'flow'
    | 'concern'
    | 'concern_family'
    | 'canonical_path'
    | 'symmetry_edge'
    | 'closure_set'
    | 'abstraction_opportunity'
    | 'decision_override';
  structHash: string;
  payload: unknown;
}

export interface CanonicalFact {
  id: string;
  familyId: string;
  targetConcern: string;
  owningModule: string;
  confidence: number;
  status: string;
}

export interface SymmetryFact {
  id: string;
  familyId: string;
  fromUnit: string;
  toUnit: string;
  strength: string;
  score: number;
}

export interface ClosureFact {
  id: string;
  targetUnit: string;
  familyId: string;
}

export interface ClosureMemberFact {
  closureId: string;
  unitId: string;
  level: string;
  confidence: number;
  reasons: string;
}

export interface AbstractionFact {
  id: string;
  familyId: string;
  title: string;
  owningModule: string;
  level: string;
  confidence: number;
  status: string;
}

export interface PlanFact {
  id: string;
  kind: string;
  totalScore: number;
}

export interface ReviewFact {
  id: string;
  severity: string;
  finding: string;
}

export interface DecisionRuleFacts {
  canonical: CanonicalFact[];
  symmetry: SymmetryFact[];
  closures: ClosureFact[];
  closureMembers: ClosureMemberFact[];
  abstractions: AbstractionFact[];
  abstractionUnits: Array<{ abstractionId: string; unitId: string }>;
  plans: PlanFact[];
  reviews: ReviewFact[];
  planCoversClosure: Array<{ from: string; to: string }>;
  reviewFlagsPlan: Array<{ from: string; to: string }>;
}
