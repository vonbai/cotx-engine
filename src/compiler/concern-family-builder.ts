import { structHash } from '../lib/hash.js';
import { splitCompoundName } from '../lib/naming.js';
import type {
  ConcernFamily,
  DoctrineEvidenceRef,
  OperationUnit,
  PathInstance,
} from '../store/schema.js';
import type { DecisionInputs } from './decision-inputs.js';
import { roleWeight } from './role-inference.js';
import type { DecisionFunctionInput } from './decision-inputs.js';

export interface ConcernFamilyBuildResult {
  families: ConcernFamily[];
  path_instances: PathInstance[];
  operation_units: OperationUnit[];
}

const ACTION_ROOTS = new Set([
  'add', 'auth', 'authorize', 'build', 'check', 'commit', 'create', 'delete', 'dispatch',
  'execute', 'fetch', 'get', 'handle', 'init', 'list', 'load', 'log', 'persist', 'post',
  'prepare', 'process', 'put', 'query', 'read', 'run', 'save', 'send', 'set', 'start',
  'store', 'sync', 'trigger', 'update', 'validate', 'write',
]);

const GENERIC_ACTION_ROOTS = new Set([
  'run', 'handle', 'process', 'execute', 'init', 'setup', 'register', 'check',
  'add', 'list', 'load',
]);

const ROOT_ALIASES: Record<string, string> = {
  creation: 'create',
  created: 'create',
  creates: 'create',
  update: 'update',
  updated: 'update',
  updating: 'update',
  updates: 'update',
  finding: 'find',
  finds: 'find',
  loading: 'load',
  loaded: 'load',
  listing: 'list',
  saving: 'save',
  saved: 'save',
  usagef: 'usage',
  usaget: 'usage',
};

const NOISE_ROOTS = new Set([
  'as', 'can', 'does', 'do', 'be', 'is', 'are', 'to', 'from', 'with', 'without',
  'for', 'of', 'in', 'on', 'off', 'by', 'new', 'main', 'misc',
]);

function normalizeRoot(root: string): string {
  if (ROOT_ALIASES[root]) return ROOT_ALIASES[root];
  if (root.endsWith('ing') && ACTION_ROOTS.has(root.slice(0, -3))) return root.slice(0, -3);
  if (root.endsWith('ed') && ACTION_ROOTS.has(root.slice(0, -2))) return root.slice(0, -2);
  return root;
}

function chooseFamilyHead(
  functionSymbols: string[],
  globalRootCount: Map<string, number>,
): string {
  const entrySpecificActions = splitCompoundName(functionSymbols[0] ?? '')
    .map(normalizeRoot)
    .filter((root) => ACTION_ROOTS.has(root) && !GENERIC_ACTION_ROOTS.has(root) && !NOISE_ROOTS.has(root));
  if (entrySpecificActions.length > 0) {
    return entrySpecificActions[0];
  }

  const familyRootCount = new Map<string, number>();
  for (const root of functionSymbols.flatMap((name) => splitCompoundName(name).map(normalizeRoot))) {
    if (NOISE_ROOTS.has(root) || root.length < 3) continue;
    familyRootCount.set(root, (familyRootCount.get(root) ?? 0) + 1);
  }

  const candidates = [...familyRootCount.keys()];
  if (candidates.length === 0) return 'misc';

  const specificActions = candidates.filter((root) => ACTION_ROOTS.has(root) && !GENERIC_ACTION_ROOTS.has(root));
  const pool = specificActions.length > 0 ? specificActions : candidates;

  pool.sort((left, right) => {
    const leftFamily = familyRootCount.get(left) ?? 0;
    const rightFamily = familyRootCount.get(right) ?? 0;
    const leftGlobal = globalRootCount.get(left) ?? 1;
    const rightGlobal = globalRootCount.get(right) ?? 1;
    const leftScore = leftFamily / leftGlobal + (ACTION_ROOTS.has(left) && !GENERIC_ACTION_ROOTS.has(left) ? 0.4 : 0);
    const rightScore = rightFamily / rightGlobal + (ACTION_ROOTS.has(right) && !GENERIC_ACTION_ROOTS.has(right) ? 0.4 : 0);
    return rightScore - leftScore || rightFamily - leftFamily || right.length - left.length || left.localeCompare(right);
  });

  return pool[0];
}

function signalNames(
  functions: Array<DecisionFunctionInput | undefined>,
  fallbackSymbols: string[],
): string[] {
  const publicNames = functions
    .filter((fn): fn is DecisionFunctionInput => Boolean(fn))
    .filter((fn) => fn.is_public_signal && ['prod_core', 'prod_entrypoint'].includes(fn.role))
    .map((fn) => fn.name);
  const boundaryNames = [fallbackSymbols[0], fallbackSymbols[fallbackSymbols.length - 1]].filter((value): value is string => Boolean(value));
  const candidates = [...new Set([...boundaryNames, ...publicNames])];
  return candidates.length > 0 ? candidates : fallbackSymbols;
}

function classifySinkRole(functionSymbols: string[], moduleChain: string[]): string {
  const text = `${functionSymbols.join(' ')} ${moduleChain.join(' ')}`;
  const roots = splitCompoundName(text).map(normalizeRoot);
  if (roots.some((root) => ['save', 'persist', 'store', 'write', 'commit', 'update', 'create', 'delete'].includes(root))) {
    return 'repository_write';
  }
  if (roots.some((root) => ['read', 'query', 'list', 'load', 'fetch', 'get'].includes(root))) {
    return 'repository_read';
  }
  if (roots.some((root) => ['validate', 'check', 'auth', 'authorize'].includes(root))) {
    return 'validation';
  }
  if (roots.some((root) => ['usage', 'format', 'template', 'render', 'print'].includes(root))) {
    return 'formatting';
  }
  return 'unknown';
}

function classifyOperationKind(symbol: string, moduleId: string): OperationUnit['kind'] {
  const roots = splitCompoundName(`${symbol} ${moduleId}`);
  if (roots.includes('handle')) return 'handler';
  if (roots.includes('validate') || roots.includes('check') || roots.includes('auth')) return 'validator';
  if (roots.some((root) => ['save', 'persist', 'store', 'query', 'read', 'write'].includes(root))) return 'repository';
  if (roots.includes('service') || moduleId.includes('service')) return 'service';
  if (roots.includes('worker')) return 'worker';
  return 'unknown';
}

function resourceRootsFromPath(functionSymbols: string[]): string[] {
  return [...new Set(
    functionSymbols
      .flatMap((name) => splitCompoundName(name))
      .filter((root) => !ACTION_ROOTS.has(root)),
  )].sort();
}

function buildPathInstance(
  familyKey: string,
  flowOrSourceId: string,
  entryKind: PathInstance['entry_kind'],
  functionSymbols: string[],
  moduleChain: string[],
  contractHops: string[],
  evidence: DoctrineEvidenceRef[],
): PathInstance {
  const entrySymbol = functionSymbols[0] ?? flowOrSourceId;
  const sinkSymbol = functionSymbols[functionSymbols.length - 1] ?? entrySymbol;
  const sinkRole = classifySinkRole(functionSymbols, moduleChain);

  return {
    id: structHash({
      source: flowOrSourceId,
      familyKey,
      functions: functionSymbols.join('>'),
      modules: moduleChain.join('>'),
    }),
    family_id: familyKey,
    entry_symbol: entrySymbol,
    entry_kind: entryKind,
    function_symbols: functionSymbols,
    module_chain: moduleChain,
    contract_hops: [...new Set(contractHops)],
    sink_symbol: sinkSymbol,
    sink_role: sinkRole,
    evidence,
  } satisfies PathInstance;
}

function derivePathInstancesFromCalls(inputs: DecisionInputs): PathInstance[] {
  const functionById = new Map(inputs.functions.map((fn) => [fn.id, fn]));
  const entryPointIds = inputs.entry_points.filter((id) => functionById.has(id));
  const globalRootCount = new Map<string, number>();
  for (const fn of inputs.functions) {
    for (const root of splitCompoundName(fn.name).map(normalizeRoot)) {
      globalRootCount.set(root, (globalRootCount.get(root) ?? 0) + 1);
    }
  }
  const derived: PathInstance[] = [];

  function walk(currentId: string, visited: Set<string>, path: string[]): string[][] {
    if (visited.has(currentId) || path.length >= 6) return [path];
    const current = functionById.get(currentId);
    if (!current || current.callee_ids.length === 0) return [path];

    const nextIds = current.callee_ids.filter((id) => functionById.has(id)).sort();
    if (nextIds.length === 0) return [path];

    const nextVisited = new Set(visited);
    nextVisited.add(currentId);

    return nextIds.slice(0, 3).flatMap((nextId) => walk(nextId, nextVisited, [...path, nextId]));
  }

  for (const entryId of entryPointIds) {
    const paths = walk(entryId, new Set(), [entryId])
      .filter((path) => path.length >= 2)
      .filter((path) => new Set(path.map((id) => functionById.get(id)?.module_id ?? 'unknown')).size >= 2);

    for (const path of paths) {
      const functions = path.map((id) => functionById.get(id)!).filter(Boolean);
      const roleScore = functions.reduce((sum, fn) => sum + roleWeight(fn.role), 0) / functions.length;
      if (roleScore < 0.28) continue;
      const entrySymbol = functions[0]?.name ?? entryId;
      const sinkRole = classifySinkRole(functions.map((fn) => fn.name), functions.map((fn) => fn.module_id));
      const familyKey = `${chooseFamilyHead(signalNames(functions, functions.map((fn) => fn.name)), globalRootCount)}:${sinkRole}`;
      const contractHops = functions.flatMap((fn) => fn.contract_ids).sort();
      derived.push(buildPathInstance(
        familyKey,
        entryId,
        'canonical_entry',
        functions.map((fn) => fn.name),
        functions.map((fn) => fn.module_id),
        contractHops,
        [{ kind: 'function', ref: entryId }],
      ));
    }
  }

  const deduped = new Map<string, PathInstance>();
  for (const item of derived) deduped.set(item.id, item);
  return [...deduped.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function buildConcernFamilies(inputs: DecisionInputs): ConcernFamilyBuildResult {
  const globalRootCount = new Map<string, number>();
  for (const fn of inputs.functions) {
    for (const root of splitCompoundName(fn.name).map(normalizeRoot)) {
      globalRootCount.set(root, (globalRootCount.get(root) ?? 0) + 1);
    }
  }

  const contractByPair = new Map(
    inputs.contracts.map((contract) => [`${contract.consumer}::${contract.provider}`, contract.id]),
  );
  const functionByModuleAndName = new Map(
    inputs.functions.map((fn) => [`${fn.module_id}:${fn.name}`, fn]),
  );

  const flowPathInstances: PathInstance[] = inputs.flows
    .filter((flow) => flow.type === 'flow' && flow.steps && flow.steps.length > 0)
    .map((flow) => {
      const steps = flow.steps ?? [];
      const functionSymbols = steps.map((step) => step.function);
      const moduleChain = steps.map((step) => step.module);
      const functions = functionSymbols
        .map((name, index) => functionByModuleAndName.get(`${moduleChain[index]}:${name}`))
        .filter(Boolean);
      const roleScore = functions.length > 0
        ? functions.reduce((sum, fn) => sum + roleWeight(fn!.role), 0) / functions.length
        : 0.5;
      if (roleScore < 0.2) return null;
      const sinkRole = classifySinkRole(functionSymbols, moduleChain);
      const familyKey = `${chooseFamilyHead(signalNames(functions, functionSymbols), globalRootCount)}:${sinkRole}`;
      const contractHops = steps
        .slice(0, -1)
        .map((step, index) => contractByPair.get(`${step.module}::${steps[index + 1]?.module}`))
        .filter((value): value is string => Boolean(value));

      return buildPathInstance(
        familyKey,
        flow.id,
        'flow_trigger',
        functionSymbols,
        moduleChain,
        contractHops,
        [{ kind: 'flow', ref: flow.id }],
      );
    })
    .filter((item): item is PathInstance => Boolean(item))
    .sort((a, b) => a.id.localeCompare(b.id));

  const coveredEntrySymbols = new Set(flowPathInstances.map((item) => item.entry_symbol));
  const derivedCallPaths = derivePathInstancesFromCalls(inputs).filter((item) => !coveredEntrySymbols.has(item.entry_symbol));
  const pathInstances = [...flowPathInstances, ...derivedCallPaths].sort((a, b) => a.id.localeCompare(b.id));

  const familyMap = new Map<string, PathInstance[]>();
  for (const instance of pathInstances) {
    const items = familyMap.get(instance.family_id) ?? [];
    items.push(instance);
    familyMap.set(instance.family_id, items);
  }

  const families: ConcernFamily[] = [...familyMap.entries()]
    .map(([familyId, members]) => {
      const [verb, sinkRole] = familyId.split(':');
      return {
        id: familyId,
        name: `${verb.replace(/-/g, ' ')} ${sinkRole.replace(/_/g, ' ')}`.trim(),
        verb_roots: [verb],
        resource_roots: resourceRootsFromPath(members.flatMap((member) => member.function_symbols)),
        sink_role: sinkRole,
        entry_kinds: [...new Set(members.map((member) => member.entry_kind))].sort(),
        member_paths: members.map((member) => member.id).sort(),
        evidence: members.flatMap((member) => member.evidence),
        confidence: Math.min(0.95, 0.55 + (members.length - 1) * 0.15),
        status: members.length >= 2 ? 'confirmed' : 'candidate',
      } satisfies ConcernFamily;
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  const operationUnitMap = new Map<string, OperationUnit>();
  for (const pathInstance of pathInstances) {
    pathInstance.function_symbols.forEach((symbol, index) => {
      const moduleId = pathInstance.module_chain[index] ?? 'unknown';
      const unitId = `${moduleId}:${symbol}`;
      const existing = operationUnitMap.get(unitId);
      if (existing) {
        if (!existing.path_ids.includes(pathInstance.id)) existing.path_ids.push(pathInstance.id);
        return;
      }
      operationUnitMap.set(unitId, {
        id: unitId,
        family_id: pathInstance.family_id,
        module: moduleId,
        symbol,
        file_path: functionByModuleAndName.get(`${moduleId}:${symbol}`)?.file_path,
        role: functionByModuleAndName.get(`${moduleId}:${symbol}`)?.role,
        role_confidence: functionByModuleAndName.get(`${moduleId}:${symbol}`)?.role_confidence,
        scope_hint: functionByModuleAndName.get(`${moduleId}:${symbol}`)?.scope_hint,
        kind: classifyOperationKind(symbol, moduleId),
        path_ids: [pathInstance.id],
        related_symbols: [symbol],
        evidence: pathInstance.evidence,
      });
    });
  }

  const operationUnits = [...operationUnitMap.values()]
    .map((unit) => ({ ...unit, path_ids: unit.path_ids.sort(), related_symbols: unit.related_symbols.sort() }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    families,
    path_instances: pathInstances,
    operation_units: operationUnits,
  };
}
