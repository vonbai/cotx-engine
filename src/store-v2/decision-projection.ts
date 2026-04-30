import type {
  AbstractionOpportunity,
  CanonicalPath,
  ClosureSet,
  SymmetryEdge,
} from '../store/schema.js';
import type { DecisionRuleFacts } from './types.js';

export interface DecisionProjectionInput {
  canonicalPaths: CanonicalPath[];
  symmetryEdges: SymmetryEdge[];
  closureSets: ClosureSet[];
  abstractionOpportunities: AbstractionOpportunity[];
}

export function projectDecisionFacts(input: DecisionProjectionInput): DecisionRuleFacts {
  return {
    canonical: input.canonicalPaths.map((item) => ({
      id: item.id,
      familyId: item.family_id,
      targetConcern: item.target_concern,
      owningModule: item.owning_module,
      confidence: item.confidence,
      status: item.status,
    })),
    symmetry: input.symmetryEdges.map((item) => ({
      id: item.id,
      familyId: item.family_id,
      fromUnit: item.from_unit,
      toUnit: item.to_unit,
      strength: item.strength,
      score: item.score,
    })),
    closures: input.closureSets.map((item) => ({
      id: item.id,
      targetUnit: item.target_unit,
      familyId: item.family_id ?? '',
    })),
    closureMembers: input.closureSets.flatMap((item) =>
      item.members.map((member) => ({
        closureId: item.id,
        unitId: member.unit_id,
        level: member.level,
        confidence: member.confidence,
        reasons: member.reasons.join('; '),
      })),
    ),
    abstractions: input.abstractionOpportunities.map((item) => ({
      id: item.id,
      familyId: item.family_id ?? '',
      title: item.title,
      owningModule: item.candidate_owning_module,
      level: item.suggested_abstraction_level,
      confidence: item.confidence,
      status: item.status,
    })),
    abstractionUnits: input.abstractionOpportunities.flatMap((item) =>
      item.candidate_units.map((unitId) => ({ abstractionId: item.id, unitId })),
    ),
    plans: [],
    reviews: [],
    planCoversClosure: [],
    reviewFlagsPlan: [],
  };
}
