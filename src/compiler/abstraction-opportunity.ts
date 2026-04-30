import type { AbstractionOpportunity } from '../store/schema.js';
import type { CanonicalPathCompileResult } from './canonical-path-compiler.js';
import type { ConcernFamilyBuildResult } from './concern-family-builder.js';

export function detectAbstractionOpportunities(
  familyResult: ConcernFamilyBuildResult,
  canonicalResult: CanonicalPathCompileResult,
): AbstractionOpportunity[] {
  const canonicalFamilies = new Set(canonicalResult.canonical_paths.map((path) => path.family_id));

  return familyResult.families
    .filter((family) => family.member_paths.length >= 3)
    .map((family) => {
      const units = familyResult.operation_units.filter((unit) => unit.family_id === family.id);
      const modules = [...new Set(units.map((unit) => unit.module))];
      const suggestedLevel: AbstractionOpportunity['suggested_abstraction_level'] =
        !canonicalFamilies.has(family.id) && family.sink_role === 'repository_write'
          ? 'lift_to_canonical_path'
          : modules.length > 1
            ? 'extract_service'
            : 'extract_helper';

      return {
        id: `abstraction:${family.id}`,
        title: `Extract shared ${family.name}`,
        family_id: family.id,
        repeated_paths: family.member_paths,
        candidate_units: units.map((unit) => unit.id).sort(),
        suggested_abstraction_level: suggestedLevel,
        candidate_owning_module: modules[0] ?? 'unknown',
        evidence: family.evidence,
        confidence: Number(Math.min(0.95, 0.55 + family.member_paths.length * 0.07).toFixed(3)),
        status: family.member_paths.length >= 4 ? 'recommended' : 'candidate',
      } satisfies AbstractionOpportunity;
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}
