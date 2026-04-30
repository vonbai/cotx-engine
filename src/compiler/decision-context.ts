import type { CotxStore } from '../store/store.js';
import { readDecisionInputsFromStore, type DecisionInputs } from './decision-inputs.js';
import { buildConcernFamilies, type ConcernFamilyBuildResult } from './concern-family-builder.js';
import { compileCanonicalPaths, type CanonicalPathCompileResult } from './canonical-path-compiler.js';
import { buildSymmetryEdges } from './symmetry-engine.js';
import { analyzeCochange, type CochangeRule } from './cochange-analyzer.js';
import { buildClosureSets } from './closure-engine.js';
import { detectAbstractionOpportunities } from './abstraction-opportunity.js';
import type { AbstractionOpportunity, ClosureSet, SymmetryEdge } from '../store/schema.js';

export interface DecisionContext {
  inputs: DecisionInputs;
  family_result: ConcernFamilyBuildResult;
  canonical_result: CanonicalPathCompileResult;
  symmetry_edges: SymmetryEdge[];
  cochange_rules: CochangeRule[];
  closure_sets: ClosureSet[];
  abstraction_opportunities: AbstractionOpportunity[];
}

export function buildDecisionContext(projectRoot: string, store: CotxStore): DecisionContext | null {
  try {
    const inputs = readDecisionInputsFromStore(store);
    if (inputs.functions.length === 0) return null;
    const familyResult = buildConcernFamilies(inputs);
    const canonicalResult = compileCanonicalPaths(inputs, familyResult);
    const symmetryEdges = buildSymmetryEdges(familyResult);
    const cochangeRules = analyzeCochange(projectRoot);
    const closureSets = buildClosureSets(familyResult, symmetryEdges, cochangeRules);
    const abstractionOpportunities = detectAbstractionOpportunities(familyResult, canonicalResult);
    return {
      inputs,
      family_result: familyResult,
      canonical_result: canonicalResult,
      symmetry_edges: symmetryEdges,
      cochange_rules: cochangeRules,
      closure_sets: closureSets,
      abstraction_opportunities: abstractionOpportunities,
    };
  } catch {
    return null;
  }
}
