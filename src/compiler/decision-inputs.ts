import fs from 'node:fs';
import path from 'node:path';
import type { GraphNode, GraphEdge, ProcessData } from '../core/export/json-exporter.js';
import { calculateEntryPointScore } from '../core/parser/entry-point-scoring.js';
import { isTestFile } from '../core/parser/entry-point-scoring.js';
import { SupportedLanguages } from '../core/shared/index.js';
import type { CotxStore } from '../store/store.js';
import type { ContractNode, FlowNode, ModuleNode } from '../store/schema.js';
import { splitCompoundName } from '../lib/naming.js';
import { inferRole, inferScopeHint, type DecisionRole } from './role-inference.js';
import { readSemanticArtifactsSync } from '../store-v2/graph-truth-store.js';

export interface DecisionFunctionInput {
  id: string;
  name: string;
  label: string;
  file_path: string;
  module_id: string;
  scope_hint: string;
  language: SupportedLanguages;
  is_exported: boolean;
  is_public_signal: boolean;
  role: DecisionRole;
  role_confidence: number;
  caller_ids: string[];
  callee_ids: string[];
  process_ids: string[];
  contract_ids: string[];
  entry_point_score: number;
  verb_roots: string[];
  resource_roots: string[];
}

export interface DecisionInputs {
  modules: ModuleNode[];
  contracts: ContractNode[];
  flows: FlowNode[];
  processes: ProcessData[];
  functions: DecisionFunctionInput[];
  function_calls: Array<{ from: string; to: string }>;
  functions_by_module: Record<string, string[]>;
  entry_points: string[];
}

interface BuildDecisionInputsArgs {
  nodes: GraphNode[];
  edges: GraphEdge[];
  processes: ProcessData[];
  modules: ModuleNode[];
  contracts: ContractNode[];
  flows: FlowNode[];
}

const FUNCTION_LABELS = new Set(['Function', 'Method']);
const ACTION_ROOTS = new Set([
  'add', 'auth', 'authorize', 'build', 'check', 'commit', 'create', 'delete', 'dispatch',
  'execute', 'fetch', 'get', 'handle', 'init', 'list', 'load', 'log', 'persist', 'post',
  'prepare', 'process', 'put', 'query', 'read', 'run', 'save', 'send', 'set', 'start',
  'store', 'sync', 'trigger', 'update', 'validate', 'write',
]);

function toSupportedLanguage(value: unknown): SupportedLanguages {
  const language = typeof value === 'string' ? value : '';
  return (Object.values(SupportedLanguages) as string[]).includes(language)
    ? language as SupportedLanguages
    : SupportedLanguages.TypeScript;
}

function readJsonLines<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function extractResourceRoots(name: string): string[] {
  return splitCompoundName(name).filter((root) => !ACTION_ROOTS.has(root));
}

function isNoisyDecisionName(name: string): boolean {
  return /^(should|test|given|when|then)[A-Z_]/.test(name) ||
    ['setUp', 'setup', 'tearDown', 'teardown'].includes(name);
}

export function buildDecisionInputs(input: BuildDecisionInputsArgs): DecisionInputs {
  const nodeById = new Map(input.nodes.map((node) => [node.id, node]));
  const fileToModule = new Map<string, string>();
  for (const mod of input.modules) {
    for (const file of mod.files) fileToModule.set(file, mod.id);
  }

  const callerIds = new Map<string, Set<string>>();
  const calleeIds = new Map<string, Set<string>>();
  const functionCalls: Array<{ from: string; to: string }> = [];

  for (const edge of input.edges) {
    if (edge.type !== 'CALLS') continue;
    functionCalls.push({ from: edge.sourceId, to: edge.targetId });
    if (!calleeIds.has(edge.sourceId)) calleeIds.set(edge.sourceId, new Set());
    if (!callerIds.has(edge.targetId)) callerIds.set(edge.targetId, new Set());
    calleeIds.get(edge.sourceId)!.add(edge.targetId);
    callerIds.get(edge.targetId)!.add(edge.sourceId);
  }

  const processIdsByFunction = new Map<string, Set<string>>();
  for (const process of input.processes) {
    for (const step of process.steps) {
      if (!processIdsByFunction.has(step.nodeId)) processIdsByFunction.set(step.nodeId, new Set());
      processIdsByFunction.get(step.nodeId)!.add(process.id);
    }
  }

  const contractCountByModule = new Map<string, number>();
  const providerContractsByModuleAndInterface = new Map<string, string[]>();
  const consumerContractsByModuleAndInterface = new Map<string, string[]>();
  for (const contract of input.contracts) {
    contractCountByModule.set(contract.provider, (contractCountByModule.get(contract.provider) ?? 0) + 1);
    contractCountByModule.set(contract.consumer, (contractCountByModule.get(contract.consumer) ?? 0) + 1);
    for (const interfaceSymbol of contract.interface) {
      const providerKey = `${contract.provider}\0${interfaceSymbol}`;
      const providerItems = providerContractsByModuleAndInterface.get(providerKey) ?? [];
      providerItems.push(contract.id);
      providerContractsByModuleAndInterface.set(providerKey, providerItems);

      const consumerKey = `${contract.consumer}\0${interfaceSymbol}`;
      const consumerItems = consumerContractsByModuleAndInterface.get(consumerKey) ?? [];
      consumerItems.push(contract.id);
      consumerContractsByModuleAndInterface.set(consumerKey, consumerItems);
    }
  }

  const functions: DecisionFunctionInput[] = input.nodes
    .filter((node) => FUNCTION_LABELS.has(node.label))
    .map((node) => {
      const name = typeof node.properties.name === 'string' ? node.properties.name : node.id;
      const filePath = typeof node.properties.filePath === 'string' ? node.properties.filePath : '';
      const moduleId = fileToModule.get(filePath) ?? 'unknown';
      const language = toSupportedLanguage(node.properties.language);
      const isExported = Boolean(node.properties.isExported);
      const callers = [...(callerIds.get(node.id) ?? new Set())].sort();
      const callees = [...(calleeIds.get(node.id) ?? new Set())].sort();
      const externalRefs = callers.filter((callerId) => {
        const callerNode = nodeById.get(callerId);
        const callerFile = typeof callerNode?.properties.filePath === 'string' ? callerNode.properties.filePath : '';
        return callerFile && fileToModule.get(callerFile) !== moduleId;
      }).length;
      const { score } = calculateEntryPointScore(
        name,
        language,
        isExported,
        callers.length,
        callees.length,
        filePath,
      );

      const roots = splitCompoundName(name);
      const { role, confidence } = inferRole({
        filePath,
        moduleId,
        entryPointScore: score,
        externalRefs,
        processRefs: (processIdsByFunction.get(node.id) ?? new Set()).size,
        contractRefs: contractCountByModule.get(moduleId) ?? 0,
      });
      const contractIds = new Set<string>(providerContractsByModuleAndInterface.get(`${moduleId}\0${name}`) ?? []);
      for (const calleeId of callees) {
        const callee = nodeById.get(calleeId);
        if (typeof callee?.properties.name !== 'string') continue;
        for (const contractId of consumerContractsByModuleAndInterface.get(`${moduleId}\0${callee.properties.name}`) ?? []) {
          contractIds.add(contractId);
        }
      }
      return {
        id: node.id,
        name,
        label: node.label,
        file_path: filePath,
        module_id: moduleId,
        scope_hint: inferScopeHint(moduleId, filePath),
        language,
        is_exported: isExported,
        is_public_signal: isExported || !name.startsWith('_'),
        role,
        role_confidence: confidence,
        caller_ids: callers,
        callee_ids: callees,
        process_ids: [...(processIdsByFunction.get(node.id) ?? new Set())].sort(),
        contract_ids: [...contractIds].sort(),
        entry_point_score: score,
        verb_roots: roots.filter((root) => ACTION_ROOTS.has(root)),
        resource_roots: extractResourceRoots(name),
      };
    })
    .filter((fn) => fn.role !== 'test')
    .sort((a, b) => a.id.localeCompare(b.id));

  const functionsByModule = Object.fromEntries(
    [...new Set(functions.map((fn) => fn.module_id))]
      .sort()
      .map((moduleId) => [
        moduleId,
        functions
          .filter((fn) => fn.module_id === moduleId)
          .map((fn) => fn.id)
          .sort(),
      ]),
  ) as Record<string, string[]>;

  const entryPoints = [...new Set([
    ...input.processes.map((process) => process.entryPointId),
    ...functions
      .filter((fn) => fn.entry_point_score > 1 && !isNoisyDecisionName(fn.name))
      .filter((fn) => fn.role === 'prod_core' || fn.role === 'prod_entrypoint')
      .map((fn) => fn.id),
  ])].sort();

  return {
    modules: input.modules,
    contracts: input.contracts,
    flows: input.flows,
    processes: input.processes,
    functions,
    function_calls: functionCalls.sort((a, b) => `${a.from}:${a.to}`.localeCompare(`${b.from}:${b.to}`)),
    functions_by_module: functionsByModule,
    entry_points: entryPoints,
  };
}

export function readDecisionInputsFromStore(store: CotxStore): DecisionInputs {
  const cotxDir = path.join(store.projectRoot, '.cotx', 'graph');
  const nodes = readJsonLines<GraphNode>(path.join(cotxDir, 'nodes.json'));
  const edges = readJsonLines<GraphEdge>(path.join(cotxDir, 'edges.json'));
  const processes = readJsonLines<ProcessData>(path.join(cotxDir, 'processes.json'));
  const semanticDb = path.join(store.projectRoot, '.cotx', 'v2', 'truth.lbug');
  const modules = readSemanticArtifactsSync(semanticDb, 'module').map((artifact) => artifact.payload as ModuleNode);
  const contracts = readSemanticArtifactsSync(semanticDb, 'contract').map((artifact) => artifact.payload as ContractNode);
  const flows = readSemanticArtifactsSync(semanticDb, 'flow').map((artifact) => artifact.payload as FlowNode);
  return buildDecisionInputs({ nodes, edges, processes, modules, contracts, flows });
}
