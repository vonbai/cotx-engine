import { detectDelta } from './delta-detector.js';
import type { ChangeReviewData, ChangeReviewFinding, DoctrineStatement } from '../store/schema.js';
import type { CotxStore } from '../store/store.js';
import { buildDecisionContext } from './decision-context.js';
import { compareChangePlans } from './plan-comparator.js';

function relevantDoctrineIds(doctrine: DoctrineStatement[] | undefined, changedModules: string[]): string[] {
  if (!doctrine) return [];
  return doctrine
    .filter((statement) =>
      statement.scope === 'repo' ||
      (statement.scope === 'module' && statement.module && changedModules.includes(statement.module)) ||
      statement.evidence.some((evidence) => changedModules.includes(evidence.ref)),
    )
    .map((statement) => statement.id);
}

function finding(input: Omit<ChangeReviewFinding, 'id'> & { id?: string }): ChangeReviewFinding {
  const id = input.id ?? `${input.kind}:${input.title}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return { ...input, id };
}

export function buildDecisionReview(
  projectRoot: string,
  store: CotxStore,
  input: { changedFiles: string[]; addedLines: string[] },
): ChangeReviewData {
  const delta = detectDelta(store, input.changedFiles);
  const changedModules = delta.affectedModules;
  const doctrineIds = relevantDoctrineIds(store.readDoctrine()?.statements, changedModules);
  const findings: ChangeReviewFinding[] = [];
  const compatibilityRegex = /(compat|compatibility|legacy|fallback|shim|adapter|wrapper)/i;

  const context = buildDecisionContext(projectRoot, store);
  const planTargets = changedModules.length > 0
    ? [...new Set(changedModules)]
    : [...new Set(input.changedFiles)];
  const plans = planTargets
    .map((target) => compareChangePlans(projectRoot, store, target, 'review current patch', context))
    .filter((plan): plan is NonNullable<typeof plan> => Boolean(plan));
  const plan = plans
    .slice()
    .sort((left, right) => {
      const leftScore = left.options.find((option) => option.id === left.recommended_option_id)?.total_score ?? 0;
      const rightScore = right.options.find((option) => option.id === right.recommended_option_id)?.total_score ?? 0;
      return rightScore - leftScore;
    })[0];

  if (
    input.changedFiles.some((file) => compatibilityRegex.test(file)) ||
    input.addedLines.some((line) => compatibilityRegex.test(line))
  ) {
    findings.push(finding({
      kind: 'compatibility_layer',
      severity: 'warning',
      title: 'Compatibility layer detected',
      message: 'The change introduces compatibility-style code. Confirm this is better than fixing the canonical or owning path directly.',
      doctrine_refs: doctrineIds,
      evidence: [
        ...input.changedFiles.filter((file) => compatibilityRegex.test(file)).map((file) => ({ kind: 'doc' as const, ref: file })),
        ...input.addedLines.filter((line) => compatibilityRegex.test(line)).slice(0, 3).map((line) => ({ kind: 'change' as const, ref: line })),
      ],
      recommendation: 'Prefer changing the owning module or canonical path before adding wrappers or legacy shims.',
      canonical_path_refs: plan?.canonical_paths,
      related_option_id: 'compatibility_bridge',
    }));
  }

  if (context) {
    const unitById = new Map(context.family_result.operation_units.map((unit) => [unit.id, unit]));
    const fileMatchedUnits = context.family_result.operation_units
      .filter((unit) => unit.file_path && input.changedFiles.includes(unit.file_path))
      .map((unit) => unit.id);
    const changedUnitIds = new Set(
      (fileMatchedUnits.length > 0
        ? fileMatchedUnits
        : context.family_result.operation_units
          .filter((unit) => changedModules.includes(unit.module))
          .map((unit) => unit.id)),
    );
    const relevantClosures = context.closure_sets.filter((closureSet) =>
      changedUnitIds.has(closureSet.target_unit),
    );

    const missingMustReview = relevantClosures.flatMap((closureSet) =>
      closureSet.members
        .filter((member) => member.level === 'must_review')
        .map((member) => unitById.get(member.unit_id))
        .filter((unit): unit is NonNullable<typeof unit> => Boolean(unit))
        .filter((unit) => !unit.file_path || !input.changedFiles.includes(unit.file_path)),
    );

    if (missingMustReview.length > 0) {
      findings.push(finding({
        kind: 'local_patch',
        severity: 'warning',
        title: 'Patch appears under-closed',
        message: 'The changed scope is smaller than the relevant closure set.',
        doctrine_refs: doctrineIds,
        evidence: missingMustReview.map((unit) => ({ kind: 'change' as const, ref: unit.file_path ?? unit.id, detail: unit.id })),
        recommendation: 'Review all must-review siblings before finalizing the patch.',
        closure_refs: relevantClosures.map((closureSet) => closureSet.id),
        related_option_id: plan?.recommended_option_id,
      }));
    }

    const canonicalBypass = context.canonical_result.canonical_paths.filter((canonicalPath) =>
      plan?.canonical_paths?.includes(canonicalPath.id) &&
      !changedModules.includes(canonicalPath.owning_module),
    );
    if (canonicalBypass.length > 0) {
      findings.push(finding({
        kind: 'boundary_bypass',
        severity: 'warning',
        title: 'Canonical path bypass',
        message: 'The patch does not touch the owning module of the strongest canonical path in scope.',
        doctrine_refs: doctrineIds,
        evidence: canonicalBypass.map((canonicalPath) => ({ kind: 'canonical_path' as const, ref: canonicalPath.id, detail: canonicalPath.owning_module })),
        recommendation: 'Compare the patch against the canonical path before merging.',
        canonical_path_refs: canonicalBypass.map((canonicalPath) => canonicalPath.id),
        related_option_id: 'canonicalize_path',
      }));
    }
  }

  const { contracts: allContracts } = store.loadAllSemanticArtifacts();
  const contractById = new Map(allContracts.map((c) => [c.id, c]));
  for (const contractId of delta.affectedContracts) {
    const contract = contractById.get(contractId);
    if (!contract) continue;
    const consumerTouched = changedModules.includes(contract.consumer);
    const providerTouched = changedModules.includes(contract.provider);
    if (consumerTouched !== providerTouched) {
      findings.push(finding({
        kind: 'half_refactor',
        severity: 'warning',
        title: 'Asymmetric contract-side change',
        message: `Only one side of contract ${contract.id} changed directly (${contract.consumer} -> ${contract.provider}).`,
        doctrine_refs: doctrineIds,
        evidence: [{ kind: 'contract', ref: contract.id, detail: `${contract.consumer}->${contract.provider}` }],
        recommendation: 'Review both consumer and provider modules before completing the refactor.',
      }));
    }
  }

  if (plan && plan.recommended_option_id && plan.recommended_option_id !== 'local_patch' && input.changedFiles.length <= 2) {
    findings.push(finding({
      kind: 'doctrine_violation',
      severity: 'info',
      title: 'A stronger plan option exists',
      message: `The current patch most closely resembles a local patch, but the decision plane prefers ${plan.recommended_option_id}.`,
      doctrine_refs: plan.doctrine_refs,
      evidence: plan.options.filter((item) => item.id === plan.recommended_option_id).flatMap((item) => item.evidence),
      recommendation: 'Compare the current patch against the recommended option before merging.',
      related_option_id: plan.recommended_option_id,
    }));
  }

  const warnings = findings.filter((item) => item.severity === 'warning').length;
  const errors = findings.filter((item) => item.severity === 'error').length;

  return {
    generated_at: new Date().toISOString(),
    changed_files: input.changedFiles,
    findings,
    matched_option_id: findings.some((item) => item.kind === 'compatibility_layer')
      ? 'compatibility_bridge'
      : plans.some((item) => item.recommended_option_id === 'cluster_wide_closure')
        ? 'cluster_wide_closure'
        : 'local_patch',
    summary: { warnings, errors },
  };
}
