import { splitCompoundName } from '../lib/naming.js';
import type { SymmetryEdge } from '../store/schema.js';
import type { ConcernFamilyBuildResult } from './concern-family-builder.js';

function jaccard(a: string[], b: string[]): number {
  const left = new Set(a);
  const right = new Set(b);
  const intersection = [...left].filter((item) => right.has(item)).length;
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : intersection / union;
}

export function buildSymmetryEdges(result: ConcernFamilyBuildResult): SymmetryEdge[] {
  const edges: SymmetryEdge[] = [];

  for (const family of result.families) {
    const units = result.operation_units
      .filter((unit) => unit.family_id === family.id)
      .sort((a, b) => a.id.localeCompare(b.id));

    for (let i = 0; i < units.length; i++) {
      for (let j = i + 1; j < units.length; j++) {
        const from = units[i];
        const to = units[j];
        const rootSimilarity = jaccard(splitCompoundName(from.symbol), splitCompoundName(to.symbol));
        const sameKind = from.kind === to.kind ? 1 : 0;
        const sameModule = from.module === to.module ? 1 : 0;
        const score = sameKind * 0.45 + sameModule * 0.3 + rootSimilarity * 0.25;

        let strength: SymmetryEdge['strength'] | null = null;
        const reasons: string[] = [];
        if (sameKind && sameModule && from.kind !== 'unknown') {
          strength = 'hard';
          reasons.push('same family', 'same module', 'same operation kind');
        } else if (score >= 0.55) {
          strength = 'soft';
          reasons.push('same family', 'similar naming or shape');
        }

        if (!strength) continue;
        edges.push({
          id: `symmetry:${family.id}:${from.id}~${to.id}`,
          family_id: family.id,
          from_unit: from.id,
          to_unit: to.id,
          strength,
          score: Number(score.toFixed(3)),
          reasons,
          evidence: [
            { kind: 'module', ref: from.module },
            { kind: 'module', ref: to.module },
          ],
        });
      }
    }
  }

  return edges.sort((a, b) => a.id.localeCompare(b.id));
}
