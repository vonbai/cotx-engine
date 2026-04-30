import { structHash } from '../lib/hash.js';
import type { CanonicalPath } from '../store/schema.js';
import type { DecisionInputs } from './decision-inputs.js';
import type { ConcernFamilyBuildResult } from './concern-family-builder.js';
import { roleWeight } from './role-inference.js';

export interface CanonicalPathCompileResult {
  canonical_paths: CanonicalPath[];
  candidate_paths: CanonicalPath[];
}

function normalize(value: number, max: number): number {
  if (max <= 0) return 0;
  return Math.max(0, Math.min(1, value / max));
}

export function compileCanonicalPaths(
  inputs: DecisionInputs,
  families: ConcernFamilyBuildResult,
): CanonicalPathCompileResult {
  const functionById = new Map(inputs.functions.map((fn) => [fn.id, fn]));
  const functionByModuleAndName = new Map(inputs.functions.map((fn) => [`${fn.module_id}:${fn.name}`, fn]));
  const fanInBySymbol = new Map<string, number>();
  const maxFanIn = Math.max(1, ...inputs.functions.map((fn) => fn.caller_ids.length));

  for (const fn of inputs.functions) {
    fanInBySymbol.set(fn.name, fn.caller_ids.length);
  }

  const canonicalPaths: CanonicalPath[] = [];
  const candidatePaths: CanonicalPath[] = [];

  for (const family of families.families) {
    const members = families.path_instances.filter((instance) => instance.family_id === family.id);
    if (members.length === 0) continue;

    const grouped = new Map<string, typeof members>();
    for (const member of members) {
      const signature = `${member.module_chain.join('>')}|${member.sink_symbol}|${member.sink_role}|${member.contract_hops.join('>')}`;
      const items = grouped.get(signature) ?? [];
      items.push(member);
      grouped.set(signature, items);
    }

    const candidates = [...grouped.entries()]
      .map(([signature, group]) => {
        const coverage = group.length / members.length;
        const sinkFanIn = normalize(
          Math.max(...group.map((member) => fanInBySymbol.get(member.sink_symbol) ?? 0)),
          maxFanIn,
        );
        const contractReuse = group.some((member) => member.contract_hops.length > 0) ? 1 : 0;
        const entryStrength = group.reduce((sum, member) => {
          const entry = functionByModuleAndName.get(`${member.module_chain[0]}:${member.entry_symbol}`);
          return sum + normalize(entry ? (functionById.get(entry.id)?.entry_point_score ?? 0) : 0, 4);
        }, 0) / group.length;
        const score = coverage * 0.5 + sinkFanIn * 0.2 + contractReuse * 0.15 + entryStrength * 0.15;
        return { signature, group, coverage, sinkFanIn, contractReuse, entryStrength, score };
      })
      .sort((a, b) => b.score - a.score || b.group.length - a.group.length || a.signature.localeCompare(b.signature));

    const best = candidates[0];
    const second = candidates[1];
    const groupFunctions = best.group.flatMap((path) =>
      path.function_symbols.map((symbol, index) => functionByModuleAndName.get(`${path.module_chain[index]}:${symbol}`)).filter(Boolean),
    );
    const rolePurity = groupFunctions.length > 0
      ? groupFunctions.reduce((sum, fn) => sum + roleWeight(fn!.role), 0) / groupFunctions.length
      : 0.4;
    const head = family.id.split(':')[0];
    const genericPenalty = ['process', 'build', 'set', 'run', 'add', 'check', 'misc', 'unknown'].includes(head) ? 0.18 : 0;
    const unknownPenalty = family.sink_role === 'unknown' ? 0.15 : 0;
    const visibility = Number(Math.max(0, Math.min(1, best.score * 0.7 + rolePurity * 0.3 - genericPenalty - unknownPenalty)).toFixed(3));
    const status: CanonicalPath['status'] =
      best.group.length >= 2 &&
      best.score >= 0.55 &&
      visibility >= 0.66 &&
      (!second || best.score - second.score >= 0.05)
        ? 'canonical'
        : 'candidate';

    const path: CanonicalPath = {
      id: `canonical:${family.id}`,
      family_id: family.id,
      name: `${family.name} canonical path`,
      target_concern: family.id,
      owning_module: best.group[0].module_chain[best.group[0].module_chain.length - 1] ?? 'unknown',
      primary_entry_symbols: [...new Set(best.group.map((item) => item.entry_symbol))].sort(),
      path_ids: best.group.map((item) => item.id).sort(),
      score_breakdown: {
        coverage: Number(best.coverage.toFixed(3)),
        fan_in: Number(best.sinkFanIn.toFixed(3)),
        contract_reuse: Number(best.contractReuse.toFixed(3)),
        entry_strength: Number(best.entryStrength.toFixed(3)),
        role_purity: Number(rolePurity.toFixed(3)),
        visibility,
      },
      confidence: Number(best.score.toFixed(3)),
      status,
      evidence: best.group.flatMap((item) => item.evidence),
      deviations: members
        .filter((member) => !best.group.includes(member))
        .map((member) => ({
          module: member.module_chain[member.module_chain.length - 1] ?? 'unknown',
          symbol: member.sink_symbol,
          missing_symbols: best.group[0].function_symbols.filter((symbol) => !member.function_symbols.includes(symbol)),
          reason: `deviates from ${best.group[0].sink_symbol}`,
        })),
    };

    if (status === 'canonical') canonicalPaths.push(path);
    else candidatePaths.push(path);
  }

  return {
    canonical_paths: canonicalPaths.sort((a, b) => a.id.localeCompare(b.id)),
    candidate_paths: candidatePaths.sort((a, b) => a.id.localeCompare(b.id)),
  };
}
