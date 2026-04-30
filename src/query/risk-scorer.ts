/**
 * Risk Scorer
 *
 * Computes a composite risk score (0-100) for a module based on:
 *   - complexity (0-25): max_nesting_depth * max_cyclomatic, normalized
 *   - churn (0-25): change_count / total_snapshots, normalized
 *   - coupling (0-25): in-degree (how many modules depend on this)
 *   - coverage (0-25): inverse of test_density (low coverage = high risk)
 */

import type { ModuleNode } from '../store/schema.js';
import type { CotxGraphNode, CotxGraphEdge } from './graph-index.js';

export interface RiskFactors {
  complexity: number;  // 0-25
  churn: number;       // 0-25
  coupling: number;    // 0-25
  coverage: number;    // 0-25
}

export interface RiskScore {
  score: number;       // 0-100
  label: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  factors: RiskFactors;
}

/**
 * Compute risk score for a single module.
 *
 * @param mod - the module node data
 * @param inDegree - number of modules that depend on this module
 * @param testDensity - test coverage ratio (0.0-1.0), undefined = unknown
 * @param totalModules - total number of modules (for normalization)
 */
export function computeRiskScore(
  mod: ModuleNode,
  inDegree: number,
  testDensity: number | undefined,
  totalModules: number,
): RiskScore {
  // Factor 1: Complexity (0-25)
  let complexityScore = 0;
  if (mod.complexity) {
    // Raw score = max_nesting * max_cyclomatic
    // Normalize: 1-10 = low, 10-30 = medium, 30+ = high
    const raw = mod.complexity.max_nesting_depth * mod.complexity.max_cyclomatic;
    complexityScore = Math.min(25, Math.round((raw / 30) * 25));
  }

  // Factor 2: Churn (0-25)
  let churnScore = 0;
  if (mod.churn) {
    switch (mod.churn.stability) {
      case 'stable': churnScore = 5; break;
      case 'active': churnScore = 15; break;
      case 'volatile': churnScore = 25; break;
    }
  }

  // Factor 3: Coupling (0-25)
  // More dependents = higher risk when changing
  const maxReasonableDeps = Math.max(totalModules * 0.5, 5);
  const couplingScore = Math.min(25, Math.round((inDegree / maxReasonableDeps) * 25));

  // Factor 4: Coverage (0-25, inverse — low coverage = high risk)
  let coverageScore = 12;  // Default: unknown = medium risk
  if (testDensity !== undefined) {
    coverageScore = Math.round((1 - testDensity) * 25);
  }

  const totalScore = complexityScore + churnScore + couplingScore + coverageScore;

  let label: RiskScore['label'];
  if (totalScore <= 25) label = 'LOW';
  else if (totalScore <= 50) label = 'MEDIUM';
  else if (totalScore <= 75) label = 'HIGH';
  else label = 'CRITICAL';

  return {
    score: totalScore,
    label,
    factors: {
      complexity: complexityScore,
      churn: churnScore,
      coupling: couplingScore,
      coverage: coverageScore,
    },
  };
}

/**
 * Compute risk scores for all modules in the graph.
 */
export function computeAllRiskScores(
  modules: CotxGraphNode[],
  inEdges: Map<string, CotxGraphEdge[]>,
  testDensities: Map<string, number>,
): Map<string, RiskScore> {
  const totalModules = modules.length;
  const result = new Map<string, RiskScore>();

  for (const node of modules) {
    const mod = node.data as ModuleNode;
    const inDegree = (inEdges.get(node.id) ?? [])
      .filter((e) => e.relation === 'depends_on')
      .length;
    const density = testDensities.get(node.id);

    result.set(node.id, computeRiskScore(mod, inDegree, density, totalModules));
  }

  return result;
}
