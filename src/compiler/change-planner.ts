import { CotxGraph } from '../query/graph-index.js';
import type { CotxStore } from '../store/store.js';
import type { ChangePlanData, ChangePlanOption, DoctrineStatement } from '../store/schema.js';
import { compareChangePlans } from './plan-comparator.js';

function normalizeTargetToNodes(store: CotxStore, target: string) {
  const graph = CotxGraph.fromStore(store);
  const exact = graph.findNode(target);
  if (exact) return { graph, nodes: [exact] };
  const matches = graph.search(target).slice(0, 5);
  return { graph, nodes: matches };
}

function focusModulesFromNode(node: ReturnType<CotxGraph['findNode']>): string[] {
  if (!node) return [];
  const data = node.data as unknown as Record<string, unknown>;
  if (node.layer === 'module') return [node.id];
  if (node.layer === 'concept' && typeof data.layer === 'string') return [data.layer];
  if (node.layer === 'contract') {
    return [data.consumer, data.provider].filter((value): value is string => typeof value === 'string');
  }
  if (node.layer === 'flow' && Array.isArray(data.steps)) {
    return [...new Set(data.steps.map((step) => (step as { module?: string }).module).filter((value): value is string => typeof value === 'string'))];
  }
  return [];
}

function relatedModules(store: CotxStore, focusModules: string[]): string[] {
  const graph = CotxGraph.fromStore(store);
  const result = new Set<string>(focusModules);
  for (const modId of focusModules) {
    const bfs = graph.bfs(modId, 'out', 2);
    for (const ids of bfs.values()) {
      for (const id of ids) {
        const node = graph.findNode(id);
        if (node?.layer === 'module') result.add(id);
      }
    }
    const reverse = graph.bfs(modId, 'in', 2);
    for (const ids of reverse.values()) {
      for (const id of ids) {
        const node = graph.findNode(id);
        if (node?.layer === 'module') result.add(id);
      }
    }
  }
  return [...result].sort();
}

function entryPoints(store: CotxStore, modules: string[]): string[] {
  return modules
    .map((id) => {
      try {
        return store.readModule(id).canonical_entry;
      } catch {
        return null;
      }
    })
    .filter((value): value is string => Boolean(value))
    .sort();
}

function relevantDoctrine(doctrine: DoctrineStatement[] | undefined, modules: string[]): DoctrineStatement[] {
  if (!doctrine) return [];
  return doctrine.filter((statement) =>
    statement.scope === 'repo' ||
    (statement.scope === 'module' && statement.module && modules.includes(statement.module)) ||
    statement.evidence.some((evidence) => modules.includes(evidence.ref)),
  );
}

export function buildChangePlan(
  projectRoot: string,
  store: CotxStore,
  target: string,
  intent?: string,
): ChangePlanData {
  const compared = compareChangePlans(projectRoot, store, target, intent);
  if (compared && compared.recommended_modules.length > 0) return compared;

  const { graph, nodes } = normalizeTargetToNodes(store, target);
  const focusModules = [...new Set(nodes.flatMap((node) => focusModulesFromNode(node)))].sort();
  const recommendedModules = relatedModules(store, focusModules);
  const entry_points = entryPoints(store, recommendedModules);
  const doctrine = store.readDoctrine();
  const doctrineRefs = relevantDoctrine(doctrine?.statements, recommendedModules).map((statement) => statement.id);

  const recommendedSteps = [
    'Inspect the owning modules before introducing wrappers or adapters.',
    ...(entry_points.length > 0 ? [`Start from canonical entries: ${entry_points.join(', ')}`] : []),
    ...(recommendedModules.length > 1 ? [`Review related modules together: ${recommendedModules.join(', ')}`] : []),
  ];

  const discouraged = [
    'Do not add a compatibility layer before checking the owning module path.',
    ...(recommendedModules.length > 1 ? ['Do not change only one side of a cross-module path without reviewing the counterpart.'] : []),
    ...(intent ? [`Do not optimize for only the immediate "${intent}" symptom if the shared path is broader.`] : []),
  ];

  const focusNodeRefs = nodes.map((node) => ({ id: node.id, layer: node.layer }));
  const rationale = [
    ...(nodes.length > 0 ? [`Target resolved to ${nodes.map((n) => `[${n.layer}] ${n.id}`).join(', ')}.`] : [`No exact semantic node matched "${target}", plan built from search fallback.`]),
    ...(recommendedModules.length > 0 ? [`Recommended scope includes modules: ${recommendedModules.join(', ')}.`] : []),
    ...(doctrineRefs.length > 0 ? [`Doctrine references: ${doctrineRefs.join(', ')}.`] : []),
  ];

  const options: ChangePlanOption[] = [
    {
      id: 'recommended-scope',
      title: 'Recommended project-coherent change path',
      summary: 'Update the owning module path first, then review all related modules and contracts in one pass.',
      module_scope: recommendedModules,
      entry_points,
      doctrine_refs: doctrineRefs,
      evidence: focusNodeRefs.map((node) => ({ kind: 'module', ref: node.id })),
      discouraged: false,
    },
    {
      id: 'local-patch',
      title: 'Local patch only',
      summary: 'Touch only the nearest changed file or caller path.',
      module_scope: focusModules,
      entry_points: entry_points.slice(0, 1),
      doctrine_refs: doctrineRefs,
      evidence: focusNodeRefs.map((node) => ({ kind: 'module', ref: node.id })),
      discouraged: true,
    },
  ];

  return {
    generated_at: new Date().toISOString(),
    target,
    intent,
    focus_nodes: focusNodeRefs,
    recommended_modules: recommendedModules,
    entry_points,
    doctrine_refs: doctrineRefs,
    recommended_steps: recommendedSteps,
    discouraged_approaches: discouraged,
    rationale,
    options,
  };
}
