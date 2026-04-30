import type { CotxStore } from '../store/store.js';
import type { ChangePlanData, ChangePlanOption, DoctrineStatement, PlanScoreDimension } from '../store/schema.js';
import { buildDecisionContext, type DecisionContext } from './decision-context.js';
import { splitCompoundName } from '../lib/naming.js';
import { inferScopeHint, roleWeight } from './role-inference.js';

const SCORE_WEIGHTS: Record<string, number> = {
  doctrine_alignment: 0.18,
  canonical_alignment: 0.18,
  closure_completeness: 0.2,
  abstraction_quality: 0.14,
  future_debt: 0.12,
  compatibility_risk: 0.08,
  complexity_delta: 0.05,
  migration_cost: 0.05,
};

const GENERIC_ENTRY_ROOTS = new Set(['get', 'set', 'register', 'init', 'setup', 'check', 'test', 'should']);
const RECOMMENDED_SCOPE_BUDGET = 12;

function relevantDoctrine(doctrine: DoctrineStatement[] | undefined, modules: string[]): DoctrineStatement[] {
  if (!doctrine) return [];
  return doctrine.filter((statement) =>
    statement.scope === 'repo' ||
    (statement.scope === 'module' && statement.module && modules.includes(statement.module)) ||
    statement.evidence.some((evidence) => modules.includes(evidence.ref)),
  );
}

function decisionScope(moduleId: string, filePath?: string): string {
  return inferScopeHint(moduleId, filePath);
}

function normalizedText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function tokenSet(value: string): Set<string> {
  const parts = value
    .replace(/[:/._-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const tokens = parts.flatMap((part) => {
    const split = splitCompoundName(part);
    return split.length > 0 ? split : [part.toLowerCase()];
  });
  return new Set(tokens.map((token) => token.toLowerCase()).filter(Boolean));
}

function isDisplayableEntryPoint(entry: string): boolean {
  const tokens = tokenSet(entry);
  if ([...tokens].some((token) => ['testmain', 'test', 'should'].includes(token))) return false;
  if (tokens.size === 0) return false;
  if (tokens.size === 1) {
    const [only] = [...tokens];
    if (GENERIC_ENTRY_ROOTS.has(only)) return false;
  }
  return ![...tokens].every((token) => GENERIC_ENTRY_ROOTS.has(token));
}

function unitMatchScore(unit: { id: string; module: string; file_path?: string; symbol: string }, target: string): number {
  const scope = decisionScope(unit.module, unit.file_path);
  if (unit.id === target) return 100;
  if (unit.module === target) return 95;
  if (scope === target) return 90;
  if (unit.symbol === target) return 85;

  const targetTokens = tokenSet(target);
  const symbolTokens = tokenSet(unit.symbol);
  const scopeTokens = tokenSet(scope);
  const moduleTokens = tokenSet(unit.module);
  const hasTokenOverlap = [...targetTokens].some((token) => symbolTokens.has(token) || scopeTokens.has(token) || moduleTokens.has(token));
  if (hasTokenOverlap) return 50;

  const targetText = normalizedText(target);
  if (normalizedText(unit.symbol).includes(targetText) || normalizedText(scope).includes(targetText)) return 20;
  return 0;
}

function familyMatchScore(
  family: { id: string; name: string; resource_roots: string[] },
  units: Array<{ family_id: string; role?: string }>,
  target: string,
): number {
  const targetTokens = tokenSet(target);
  const familyTokens = new Set([
    ...tokenSet(family.id),
    ...tokenSet(family.name),
    ...family.resource_roots.map((root) => normalizedText(root)),
  ]);
  const tokenOverlap = [...targetTokens].filter((token) => familyTokens.has(token)).length;
  if (tokenOverlap === 0) return 0;
  const familyUnits = units.filter((unit) => unit.family_id === family.id);
  const rolePurity = familyUnits.length > 0
    ? familyUnits.reduce((sum, unit) => sum + roleWeight((unit.role ?? 'peripheral') as Parameters<typeof roleWeight>[0]), 0) / familyUnits.length
    : 0.4;
  return tokenOverlap * 10 + rolePurity * 5;
}

function entryPointRank(entry: string, target: string): number {
  const targetTokens = tokenSet(target);
  const entryTokens = tokenSet(entry);
  const overlap = [...targetTokens].filter((token) => entryTokens.has(token)).length;
  const genericPenalty = [...entryTokens].filter((token) => GENERIC_ENTRY_ROOTS.has(token)).length;
  return overlap * 10 - genericPenalty;
}

function jaccard(left: Set<string>, right: Set<string>): number {
  const intersection = [...left].filter((item) => right.has(item)).length;
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : intersection / union;
}

function representativeEntryPoints(entries: string[], target: string, limit = 12): string[] {
  const remaining = [...entries];
  const selected: string[] = [];
  while (remaining.length > 0 && selected.length < limit) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < remaining.length; index++) {
      const entry = remaining[index];
      const entryTokens = tokenSet(entry);
      const relevance = entryPointRank(entry, target);
      const redundancy = selected.length === 0
        ? 0
        : Math.max(...selected.map((candidate) => jaccard(entryTokens, tokenSet(candidate))));
      const score = relevance - redundancy * 8 - Math.max(0, entry.length - 48) / 16;
      if (score > bestScore || (score === bestScore && entry.localeCompare(remaining[bestIndex]) < 0)) {
        bestScore = score;
        bestIndex = index;
      }
    }
    selected.push(remaining.splice(bestIndex, 1)[0]);
  }
  return selected;
}

function isExcludedDecisionRole(role: string | undefined): boolean {
  return ['test', 'generated', 'example', 'dev_tool'].includes(role ?? 'peripheral');
}

function isNonProductionPath(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = `/${value.toLowerCase().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')}/`;
  return [
    '/test/',
    '/tests/',
    '/testing/',
    '/integration-tests/',
    '/example/',
    '/examples/',
    '/demo/',
    '/demos/',
    '/fixture/',
    '/fixtures/',
    '/mock/',
    '/mocks/',
    '/benchmark/',
    '/benchmarks/',
  ].some((segment) => normalized.includes(segment));
}

function isExcludedDecisionUnit(unit: { role?: string; module: string; file_path?: string; scope_hint?: string }): boolean {
  return isExcludedDecisionRole(unit.role) ||
    isNonProductionPath(unit.module) ||
    isNonProductionPath(unit.file_path) ||
    isNonProductionPath(unit.scope_hint);
}

function isCoreDecisionRole(role: string | undefined): boolean {
  return ['prod_core', 'prod_entrypoint'].includes(role ?? '');
}

function targetAffinity(value: string, targetTokens: Set<string>): number {
  const valueTokens = tokenSet(value);
  const overlap = [...targetTokens].filter((token) => valueTokens.has(token)).length;
  return overlap / Math.max(1, targetTokens.size);
}

function scoreTotal(dimensions: PlanScoreDimension[]): number {
  return Number(dimensions.reduce((sum, dimension) => sum + dimension.score * dimension.weight, 0).toFixed(3));
}

function option(
  base: Omit<ChangePlanOption, 'discouraged'> & { kind: NonNullable<ChangePlanOption['kind']>; discouraged?: boolean; why_not?: string[] },
  dimensions: PlanScoreDimension[],
): ChangePlanOption {
  return {
    ...base,
    discouraged: base.discouraged ?? false,
    dimension_scores: dimensions,
    total_score: scoreTotal(dimensions),
    confidence: Number((dimensions.reduce((sum, dimension) => sum + dimension.score, 0) / dimensions.length).toFixed(3)),
    why_not: base.why_not,
  };
}

export function compareChangePlans(
  projectRoot: string,
  store: CotxStore,
  target: string,
  intent?: string,
  contextArg?: DecisionContext | null,
): ChangePlanData | null {
  const context = contextArg ?? buildDecisionContext(projectRoot, store);
  if (!context) return null;

  const scoredUnits = context.family_result.operation_units
    .map((unit) => {
      const base = unitMatchScore(unit, target);
      const weighted = base * roleWeight(unit.role ?? 'peripheral');
      return { unit, score: weighted };
    })
    .filter((item) => item.score > 0);
  const bestScore = Math.max(0, ...scoredUnits.map((item) => item.score));
  const matchingUnits = scoredUnits
    .filter((item) => item.score === bestScore)
    .map((item) => item.unit);
  const targetTokens = tokenSet(target);
  const scopeMatchedUnits = matchingUnits.filter((unit) => {
    const scopeTokens = tokenSet(decisionScope(unit.module, unit.file_path));
    return [...targetTokens].some((token) => scopeTokens.has(token));
  });
  const scopeCounts = new Map<string, number>();
  for (const unit of scopeMatchedUnits) {
    const scope = decisionScope(unit.module, unit.file_path);
    scopeCounts.set(scope, (scopeCounts.get(scope) ?? 0) + roleWeight(unit.role ?? 'peripheral'));
  }
  const topScopes = [...scopeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([scope]) => scope);
  const effectiveMatchingUnits = topScopes.length > 0
    ? scopeMatchedUnits.filter((unit) => topScopes.includes(decisionScope(unit.module, unit.file_path)))
    : matchingUnits;

  const matchingFamilies = effectiveMatchingUnits.length > 0
    ? context.family_result.families.filter((family) =>
        effectiveMatchingUnits.some((unit) => unit.family_id === family.id),
      )
    : context.family_result.families
      .map((family) => ({
        family,
        score: familyMatchScore(family, context.family_result.operation_units, target),
      }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.family.id.localeCompare(right.family.id))
      .slice(0, 4)
      .map((item) => item.family);
  const relevantFamilies = matchingFamilies.length > 0
    ? matchingFamilies
    : context.family_result.families.filter((family) => normalizedText(family.id).includes(normalizedText(target)));

  const focusUnits = matchingUnits.length > 0
    ? effectiveMatchingUnits
    : context.family_result.operation_units.filter((unit) => relevantFamilies.some((family) => family.id === unit.family_id));

  const eligibleScoredUnits = scoredUnits.filter((item) => !isExcludedDecisionUnit(item.unit));
  const preferredScoredUnits = eligibleScoredUnits.some((item) => isCoreDecisionRole(item.unit.role))
    ? eligibleScoredUnits.filter((item) => isCoreDecisionRole(item.unit.role))
    : eligibleScoredUnits;
  const directSupportUnits = preferredScoredUnits
    .sort((left, right) => right.score - left.score || left.unit.id.localeCompare(right.unit.id))
    .map((item) => item.unit);
  const eligibleFamilyFallbackUnits = context.family_result.operation_units
    .filter((unit) => relevantFamilies.some((family) => family.id === unit.family_id))
    .filter((unit) => !isExcludedDecisionUnit(unit));
  const familyFallbackUnits = (eligibleFamilyFallbackUnits.some((unit) => isCoreDecisionRole(unit.role))
    ? eligibleFamilyFallbackUnits.filter((unit) => isCoreDecisionRole(unit.role))
    : eligibleFamilyFallbackUnits)
    .sort((left, right) =>
      roleWeight((right.role ?? 'peripheral') as Parameters<typeof roleWeight>[0]) -
      roleWeight((left.role ?? 'peripheral') as Parameters<typeof roleWeight>[0]) ||
      left.id.localeCompare(right.id),
    );
  const unitsForScope = directSupportUnits.length > 0 ? directSupportUnits : familyFallbackUnits;

  const unitScoreById = new Map(scoredUnits.map((item) => [item.unit.id, item.score]));
  const rankedScopes = new Map<string, { module: string; scope: string; score: number }>();
  for (const unit of unitsForScope) {
    const scope = decisionScope(unit.module, unit.file_path);
    const affinity = Math.max(
      targetAffinity(unit.module, targetTokens),
      targetAffinity(scope, targetTokens),
      targetAffinity(unit.symbol, targetTokens) * 0.55,
    );
    const roleScore = roleWeight((unit.role ?? 'peripheral') as Parameters<typeof roleWeight>[0]);
    const score = (unitScoreById.get(unit.id) ?? roleScore * 10) + affinity * 60 + (isCoreDecisionRole(unit.role) ? 10 : 0);
    const key = `${unit.module}\0${scope}`;
    const existing = rankedScopes.get(key);
    if (!existing || score > existing.score) {
      rankedScopes.set(key, { module: unit.module, scope, score });
    }
  }
  const rankedScopeList = [...rankedScopes.values()]
    .sort((left, right) => right.score - left.score || left.module.localeCompare(right.module) || left.scope.localeCompare(right.scope));
  const visibleScopeList = rankedScopeList.slice(0, RECOMMENDED_SCOPE_BUDGET);

  const recommendedModules = [...new Set(visibleScopeList.map((item) => item.module))];
  const scopeHints = [...new Set(visibleScopeList.map((item) => item.scope))];
  const trimmedRecommendationCount = Math.max(0, rankedScopeList.length - visibleScopeList.length);

  const relevantCanonicalPaths = [
    ...context.canonical_result.canonical_paths,
    ...context.canonical_result.candidate_paths,
  ].filter((canonicalPath) =>
    relevantFamilies.some((family) => family.id === canonicalPath.family_id) ||
    canonicalPath.owning_module === target,
  );
  const relevantClosureSets = context.closure_sets.filter((closureSet) =>
    focusUnits.some((unit) => unit.id === closureSet.target_unit) ||
    relevantFamilies.some((family) => family.id === closureSet.family_id),
  );
  const relevantAbstractions = context.abstraction_opportunities.filter((opportunity) =>
    relevantFamilies.some((family) => family.id === opportunity.family_id),
  );
  const doctrineRefs = relevantDoctrine(store.readDoctrine()?.statements, recommendedModules).map((statement) => statement.id);
  const rawEntryPoints = [...new Set([
    ...relevantCanonicalPaths.flatMap((canonicalPath) => canonicalPath.primary_entry_symbols),
    ...focusUnits
      .filter((unit) => isCoreDecisionRole(unit.role))
      .map((unit) => unit.symbol),
    ...recommendedModules
      .map((moduleId) => {
        try {
          return store.readModule(moduleId).canonical_entry;
        } catch {
          return null;
        }
      })
      .filter((value): value is string => Boolean(value)),
  ])]
    .filter(isDisplayableEntryPoint)
    .sort((left, right) => entryPointRank(right, target) - entryPointRank(left, target) || left.localeCompare(right));
  const entryPoints = rawEntryPoints.filter(isDisplayableEntryPoint);
  const visibleEntryPoints = entryPoints.length > 0
    ? representativeEntryPoints(entryPoints, target)
    : rawEntryPoints.slice(0, 5);

  const hasCanonical = relevantCanonicalPaths.length > 0;
  const closureSize = relevantClosureSets.reduce((sum, closureSet) => sum + closureSet.members.length, 0);
  const hasAbstraction = relevantAbstractions.length > 0;

  const options: ChangePlanOption[] = [];

  options.push(option({
    id: 'local_patch',
    kind: 'local_patch',
      title: 'Local patch only',
      summary: 'Touch only the immediate target path.',
      module_scope: [...new Set(focusUnits.map((unit) => unit.module))].sort(),
      scope_hints: [...new Set(focusUnits.map((unit) => decisionScope(unit.module, unit.file_path)))].sort(),
      entry_points: visibleEntryPoints.slice(0, 1),
    doctrine_refs: doctrineRefs,
    evidence: focusUnits.map((unit) => ({ kind: 'module' as const, ref: unit.module, detail: unit.symbol })),
    discouraged: hasCanonical || closureSize > 0 || hasAbstraction,
    why_not: hasCanonical || closureSize > 0 || hasAbstraction
      ? ['Leaves stronger global options unexplored.']
      : undefined,
  }, [
    { name: 'doctrine_alignment', score: 0.45, weight: SCORE_WEIGHTS.doctrine_alignment },
    { name: 'canonical_alignment', score: hasCanonical ? 0.2 : 0.55, weight: SCORE_WEIGHTS.canonical_alignment },
    { name: 'closure_completeness', score: closureSize > 0 ? 0.25 : 0.7, weight: SCORE_WEIGHTS.closure_completeness },
    { name: 'abstraction_quality', score: hasAbstraction ? 0.25 : 0.6, weight: SCORE_WEIGHTS.abstraction_quality },
    { name: 'future_debt', score: 0.3, weight: SCORE_WEIGHTS.future_debt },
    { name: 'compatibility_risk', score: 0.65, weight: SCORE_WEIGHTS.compatibility_risk },
    { name: 'complexity_delta', score: 0.95, weight: SCORE_WEIGHTS.complexity_delta },
    { name: 'migration_cost', score: 0.9, weight: SCORE_WEIGHTS.migration_cost },
  ]));

  if (hasAbstraction) {
    options.push(option({
      id: 'extract_helper',
      kind: 'extract_helper',
      title: 'Extract shared helper',
      summary: 'Introduce a shared helper to consolidate repeated logic.',
      module_scope: recommendedModules,
      scope_hints: scopeHints,
      entry_points: visibleEntryPoints,
      doctrine_refs: doctrineRefs,
      evidence: relevantAbstractions.flatMap((opportunity) => opportunity.evidence),
      related_canonical_paths: relevantCanonicalPaths.map((canonicalPath) => canonicalPath.id),
      related_closure_sets: relevantClosureSets.map((closureSet) => closureSet.id),
    }, [
      { name: 'doctrine_alignment', score: 0.76, weight: SCORE_WEIGHTS.doctrine_alignment },
      { name: 'canonical_alignment', score: hasCanonical ? 0.62 : 0.55, weight: SCORE_WEIGHTS.canonical_alignment },
      { name: 'closure_completeness', score: closureSize > 0 ? 0.65 : 0.45, weight: SCORE_WEIGHTS.closure_completeness },
      { name: 'abstraction_quality', score: 0.9, weight: SCORE_WEIGHTS.abstraction_quality },
      { name: 'future_debt', score: 0.78, weight: SCORE_WEIGHTS.future_debt },
      { name: 'compatibility_risk', score: 0.82, weight: SCORE_WEIGHTS.compatibility_risk },
      { name: 'complexity_delta', score: 0.62, weight: SCORE_WEIGHTS.complexity_delta },
      { name: 'migration_cost', score: 0.56, weight: SCORE_WEIGHTS.migration_cost },
    ]));
  }

  if (hasCanonical) {
    options.push(option({
      id: 'canonicalize_path',
      kind: 'canonicalize_path',
      title: 'Canonicalize the change path',
      summary: 'Route the change through the strongest canonical path.',
      module_scope: recommendedModules,
      scope_hints: scopeHints,
      entry_points: visibleEntryPoints,
      doctrine_refs: doctrineRefs,
      evidence: relevantCanonicalPaths.flatMap((canonicalPath) => canonicalPath.evidence),
      related_canonical_paths: relevantCanonicalPaths.map((canonicalPath) => canonicalPath.id),
      related_closure_sets: relevantClosureSets.map((closureSet) => closureSet.id),
    }, [
      { name: 'doctrine_alignment', score: 0.83, weight: SCORE_WEIGHTS.doctrine_alignment },
      { name: 'canonical_alignment', score: 0.95, weight: SCORE_WEIGHTS.canonical_alignment },
      { name: 'closure_completeness', score: closureSize > 0 ? 0.8 : 0.62, weight: SCORE_WEIGHTS.closure_completeness },
      { name: 'abstraction_quality', score: hasAbstraction ? 0.72 : 0.58, weight: SCORE_WEIGHTS.abstraction_quality },
      { name: 'future_debt', score: 0.84, weight: SCORE_WEIGHTS.future_debt },
      { name: 'compatibility_risk', score: 0.9, weight: SCORE_WEIGHTS.compatibility_risk },
      { name: 'complexity_delta', score: 0.58, weight: SCORE_WEIGHTS.complexity_delta },
      { name: 'migration_cost', score: 0.46, weight: SCORE_WEIGHTS.migration_cost },
    ]));
  }

  if (closureSize > 0) {
    options.push(option({
      id: 'cluster_wide_closure',
      kind: 'cluster_wide_closure',
      title: 'Cover the closure set',
      summary: 'Review and update all required siblings and adjacent paths together.',
      module_scope: recommendedModules,
      scope_hints: scopeHints,
      entry_points: visibleEntryPoints,
      doctrine_refs: doctrineRefs,
      evidence: relevantClosureSets.flatMap((closureSet) => closureSet.evidence),
      related_canonical_paths: relevantCanonicalPaths.map((canonicalPath) => canonicalPath.id),
      related_closure_sets: relevantClosureSets.map((closureSet) => closureSet.id),
    }, [
      { name: 'doctrine_alignment', score: 0.81, weight: SCORE_WEIGHTS.doctrine_alignment },
      { name: 'canonical_alignment', score: hasCanonical ? 0.77 : 0.55, weight: SCORE_WEIGHTS.canonical_alignment },
      { name: 'closure_completeness', score: 0.97, weight: SCORE_WEIGHTS.closure_completeness },
      { name: 'abstraction_quality', score: hasAbstraction ? 0.68 : 0.5, weight: SCORE_WEIGHTS.abstraction_quality },
      { name: 'future_debt', score: 0.8, weight: SCORE_WEIGHTS.future_debt },
      { name: 'compatibility_risk', score: 0.88, weight: SCORE_WEIGHTS.compatibility_risk },
      { name: 'complexity_delta', score: 0.44, weight: SCORE_WEIGHTS.complexity_delta },
      { name: 'migration_cost', score: 0.36, weight: SCORE_WEIGHTS.migration_cost },
    ]));
  }

  options.push(option({
    id: 'compatibility_bridge',
    kind: 'compatibility_bridge',
    title: 'Compatibility bridge',
    summary: 'Add a wrapper, adapter, or legacy bridge around the current path.',
    module_scope: recommendedModules,
    scope_hints: scopeHints,
    entry_points: visibleEntryPoints,
    doctrine_refs: doctrineRefs,
    evidence: focusUnits.map((unit) => ({ kind: 'module' as const, ref: unit.module, detail: unit.symbol })),
    discouraged: true,
    why_not: ['Adds debt and tends to preserve the wrong path.'],
  }, [
    { name: 'doctrine_alignment', score: 0.22, weight: SCORE_WEIGHTS.doctrine_alignment },
    { name: 'canonical_alignment', score: 0.1, weight: SCORE_WEIGHTS.canonical_alignment },
    { name: 'closure_completeness', score: 0.2, weight: SCORE_WEIGHTS.closure_completeness },
    { name: 'abstraction_quality', score: 0.18, weight: SCORE_WEIGHTS.abstraction_quality },
    { name: 'future_debt', score: 0.12, weight: SCORE_WEIGHTS.future_debt },
    { name: 'compatibility_risk', score: 0.15, weight: SCORE_WEIGHTS.compatibility_risk },
    { name: 'complexity_delta', score: 0.55, weight: SCORE_WEIGHTS.complexity_delta },
    { name: 'migration_cost', score: 0.72, weight: SCORE_WEIGHTS.migration_cost },
  ]));

  options.sort((a, b) => (b.total_score ?? 0) - (a.total_score ?? 0));
  const recommended = options.find((item) => !item.discouraged) ?? options[0];
  recommended.recommended = true;

  const focusNodes = matchingUnits.length > 0
    ? matchingUnits.map((unit) => ({ id: unit.id, layer: 'operation_unit' }))
    : recommendedModules.map((moduleId) => ({ id: moduleId, layer: 'module' }));

  const recommendedSteps = [
    `Start from: ${
      (recommended.entry_points ?? []).length > 6
        ? `${(recommended.entry_points ?? []).slice(0, 6).join(', ')} ... and ${(recommended.entry_points ?? []).length - 6} more`
        : ((recommended.entry_points ?? []).join(', ') || 'the matched target path')
    }`,
    ...(trimmedRecommendationCount > 0 ? [`Target matched ${rankedScopeList.length} scopes; start with the top ${visibleScopeList.length} target-scored scopes, then widen only when closure evidence requires it.`] : []),
    ...(recommended.kind === 'cluster_wide_closure' ? ['Review all must-review siblings before editing.'] : []),
    ...(recommended.kind === 'canonicalize_path' ? ['Align edits to the canonical path before introducing adapters.'] : []),
    ...(recommended.kind === 'extract_helper' ? ['Extract only the repeated shared slice, not a speculative framework.'] : []),
  ];

  const discouragedApproaches = options
    .filter((item) => item.discouraged)
    .map((item) => `${item.title}: ${(item.why_not ?? ['discouraged']).join(' ')}`);

  const rationale = [
    ...(focusNodes.length > 0 ? [`Target resolved to ${focusNodes.map((node) => `[${node.layer}] ${node.id}`).join(', ')}.`] : [`No exact target match for "${target}".`]),
    ...(relevantCanonicalPaths.length > 0 ? [`Canonical paths in scope: ${relevantCanonicalPaths.map((item) => item.id).join(', ')}.`] : ['No strong canonical path found in scope.']),
    ...(relevantClosureSets.length > 0 ? [`Closure obligations in scope: ${relevantClosureSets.length}.`] : ['No closure obligations found in scope.']),
    ...(relevantAbstractions.length > 0 ? [`Abstraction opportunities in scope: ${relevantAbstractions.map((item) => item.id).join(', ')}.`] : []),
  ];

  return {
    generated_at: new Date().toISOString(),
    target,
    intent,
    focus_nodes: focusNodes,
    recommended_modules: recommendedModules,
    scope_hints: scopeHints,
    entry_points: visibleEntryPoints,
    doctrine_refs: doctrineRefs,
    recommended_steps: recommendedSteps,
    discouraged_approaches: discouragedApproaches,
    rationale,
    options,
    canonical_paths: relevantCanonicalPaths.map((item) => item.id),
    closure_sets: relevantClosureSets.map((item) => item.id),
    abstraction_opportunities: relevantAbstractions.map((item) => item.id),
    recommended_option_id: recommended.id,
    unresolved_ambiguities: [
      ...(matchingUnits.length === 0 ? [`Target "${target}" did not map to a specific operation unit.`] : []),
      ...(relevantCanonicalPaths.length === 0 ? ['No canonical path with high confidence was found.'] : []),
    ],
  };
}
