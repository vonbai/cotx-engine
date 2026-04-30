import type { ClosureSet, SymmetryEdge } from '../store/schema.js';
import type { ConcernFamilyBuildResult } from './concern-family-builder.js';
import type { CochangeRule } from './cochange-analyzer.js';

export function buildClosureSets(
  familyResult: ConcernFamilyBuildResult,
  symmetryEdges: SymmetryEdge[],
  cochangeRules: CochangeRule[],
): ClosureSet[] {
  const cochangeByFile = new Map<string, CochangeRule[]>();
  for (const rule of cochangeRules) {
    for (const file of rule.files) {
      const items = cochangeByFile.get(file) ?? [];
      items.push(rule);
      cochangeByFile.set(file, items);
    }
  }

  return familyResult.operation_units
    .map((unit) => {
      const members = new Map<string, ClosureSet['members'][number]>();

      for (const edge of symmetryEdges) {
        const peerId = edge.from_unit === unit.id ? edge.to_unit : edge.to_unit === unit.id ? edge.from_unit : null;
        if (!peerId) continue;
        members.set(peerId, {
          unit_id: peerId,
          level: edge.strength === 'hard' ? 'must_review' : 'should_review',
          reasons: edge.reasons,
          confidence: edge.score,
          evidence: edge.evidence,
        });
      }

      const fileRules = unit.file_path ? cochangeByFile.get(unit.file_path) ?? [] : [];
      for (const rule of fileRules) {
        const peerFiles = rule.files.filter((file) => file !== unit.file_path);
        for (const peerFile of peerFiles) {
          const peerUnits = familyResult.operation_units.filter((candidate) => candidate.file_path === peerFile);
          for (const peer of peerUnits) {
            if (members.has(peer.id)) continue;
            members.set(peer.id, {
              unit_id: peer.id,
              level: 'should_review',
              reasons: ['historical co-change'],
              confidence: rule.confidence,
              evidence: [{ kind: 'change', ref: peerFile, score: rule.confidence }],
            });
          }
        }
      }

      for (const peer of familyResult.operation_units) {
        if (peer.id === unit.id || peer.family_id !== unit.family_id || members.has(peer.id)) continue;
        members.set(peer.id, {
          unit_id: peer.id,
          level: 'must_change_if_strategy_selected',
          reasons: ['same concern family'],
          confidence: 0.5,
          evidence: [{ kind: 'module', ref: peer.module }],
        });
      }

      return {
        id: `closure:${unit.id}`,
        target_unit: unit.id,
        family_id: unit.family_id,
        generated_at: new Date().toISOString(),
        members: [...members.values()].sort((a, b) => a.unit_id.localeCompare(b.unit_id)),
        evidence: [{ kind: 'module', ref: unit.module }],
      } satisfies ClosureSet;
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}
