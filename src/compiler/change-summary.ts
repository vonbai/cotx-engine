import type { GraphNode } from '../core/export/json-exporter.js';
import fs from 'node:fs';
import type {
  ChangeSummary,
  ChangeSummaryNode,
  ChangeSummarySymbol,
  ChangeSummaryStaleAnnotation,
  ChangeSummaryStaleEnrichment,
  ModuleNode,
  ConceptNode,
  ContractNode,
  FlowNode,
} from '../store/schema.js';

type SummaryLayer = ChangeSummaryNode['layer'];

type HashableNode = { id: string; struct_hash: string };

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, val]) => [key, stableValue(val)]),
    );
  }
  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function inferFilePath(node: GraphNode): string | undefined {
  const props = node.properties as Record<string, unknown>;
  const candidate = props.filePath ?? props.file ?? props.path;
  return typeof candidate === 'string' ? candidate : undefined;
}

export function summarizeGraphSymbols(
  previousNodes: GraphNode[],
  currentNodes: GraphNode[],
): ChangeSummary['symbols'] {
  const previous = new Map(previousNodes.map((node) => [node.id, node]));
  const current = new Map(currentNodes.map((node) => [node.id, node]));

  const added: ChangeSummarySymbol[] = [];
  const removed: ChangeSummarySymbol[] = [];
  const changed: ChangeSummarySymbol[] = [];

  for (const [id, node] of current) {
    if (!previous.has(id)) {
      added.push({ id, label: node.label, file: inferFilePath(node) });
      continue;
    }
    const before = previous.get(id)!;
    if (stableStringify(before.properties) !== stableStringify(node.properties)) {
      changed.push({ id, label: node.label, file: inferFilePath(node), reason: 'properties changed' });
    }
  }

  for (const [id, node] of previous) {
    if (!current.has(id)) {
      removed.push({ id, label: node.label, file: inferFilePath(node) });
    }
  }

  const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
  added.sort(byId);
  removed.sort(byId);
  changed.sort(byId);

  return { added, removed, changed };
}

function compareStringArrays(before: string[] | undefined, after: string[] | undefined, label: string): string[] {
  const beforeArr = before ?? [];
  const afterArr = after ?? [];
  const added = afterArr.filter((item) => !beforeArr.includes(item));
  const removed = beforeArr.filter((item) => !afterArr.includes(item));
  const changes: string[] = [];
  if (added.length > 0) changes.push(`+${added.length} ${label}`);
  if (removed.length > 0) changes.push(`-${removed.length} ${label}`);
  return changes;
}

function moduleChanges(before: ModuleNode, after: ModuleNode): string[] {
  const changes = ['structure changed'];
  changes.push(...compareStringArrays(before.files, after.files, 'files'));
  if (before.canonical_entry !== after.canonical_entry) changes.push('entry changed');
  return changes;
}

function contractChanges(before: ContractNode, after: ContractNode): string[] {
  const changes = ['structure changed'];
  changes.push(...compareStringArrays(before.interface, after.interface, 'functions'));
  if (before.provider !== after.provider || before.consumer !== after.consumer) {
    changes.push('boundary changed');
  }
  return changes;
}

function flowChanges(before: FlowNode, after: FlowNode): string[] {
  const changes = ['structure changed'];
  if (before.trigger !== after.trigger) changes.push('trigger changed');
  if ((before.steps?.length ?? 0) !== (after.steps?.length ?? 0)) {
    changes.push(`steps: ${before.steps?.length ?? 0} → ${after.steps?.length ?? 0}`);
  }
  return changes;
}

function summarizeLayerNodes<T extends HashableNode>(
  layer: SummaryLayer,
  previousItems: T[],
  currentItems: T[],
  detailFn?: (before: T, after: T) => string[],
): ChangeSummary['layers'] {
  const previous = new Map(previousItems.map((item) => [item.id, item]));
  const current = new Map(currentItems.map((item) => [item.id, item]));

  const added: ChangeSummaryNode[] = [];
  const removed: ChangeSummaryNode[] = [];
  const changed: ChangeSummaryNode[] = [];

  for (const [id, item] of current) {
    if (!previous.has(id)) {
      added.push({ id, layer });
      continue;
    }
    const before = previous.get(id)!;
    if (before.struct_hash !== item.struct_hash) {
      changed.push({
        id,
        layer,
        changes: detailFn ? detailFn(before, item) : ['structure changed'],
      });
    }
  }

  for (const [id] of previous) {
    if (!current.has(id)) {
      removed.push({ id, layer });
    }
  }

  const byId = (a: ChangeSummaryNode, b: ChangeSummaryNode) => a.id.localeCompare(b.id);
  added.sort(byId);
  removed.sort(byId);
  changed.sort(byId);

  return { added, removed, changed };
}

export function summarizeLayerChanges(input: {
  previousModules: ModuleNode[];
  currentModules: ModuleNode[];
  previousConcepts: ConceptNode[];
  currentConcepts: ConceptNode[];
  previousContracts: ContractNode[];
  currentContracts: ContractNode[];
  previousFlows: FlowNode[];
  currentFlows: FlowNode[];
}): ChangeSummary['layers'] {
  const moduleSummary = summarizeLayerNodes('module', input.previousModules, input.currentModules, moduleChanges);
  const conceptSummary = summarizeLayerNodes('concept', input.previousConcepts, input.currentConcepts);
  const contractSummary = summarizeLayerNodes('contract', input.previousContracts, input.currentContracts, contractChanges);
  const flowSummary = summarizeLayerNodes('flow', input.previousFlows, input.currentFlows, flowChanges);

  return {
    added: [...moduleSummary.added, ...conceptSummary.added, ...contractSummary.added, ...flowSummary.added].sort((a, b) => a.id.localeCompare(b.id)),
    removed: [...moduleSummary.removed, ...conceptSummary.removed, ...contractSummary.removed, ...flowSummary.removed].sort((a, b) => a.id.localeCompare(b.id)),
    changed: [...moduleSummary.changed, ...conceptSummary.changed, ...contractSummary.changed, ...flowSummary.changed].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export function buildChangeSummary(input: {
  trigger: ChangeSummary['trigger'];
  changedFiles: string[];
  previousGraphNodes: GraphNode[];
  currentGraphNodes: GraphNode[];
  previousModules: ModuleNode[];
  currentModules: ModuleNode[];
  previousConcepts: ConceptNode[];
  currentConcepts: ConceptNode[];
  previousContracts: ContractNode[];
  currentContracts: ContractNode[];
  previousFlows: FlowNode[];
  currentFlows: FlowNode[];
  affectedModules?: string[];
  affectedContracts?: string[];
  affectedFlows?: string[];
  staleEnrichments?: ChangeSummaryStaleEnrichment[];
  staleAnnotations?: ChangeSummaryStaleAnnotation[];
}): ChangeSummary {
  return {
    generated_at: new Date().toISOString(),
    trigger: input.trigger,
    changed_files: [...input.changedFiles].sort(),
    affected_modules: [...(input.affectedModules ?? [])].sort(),
    affected_contracts: [...(input.affectedContracts ?? [])].sort(),
    affected_flows: [...(input.affectedFlows ?? [])].sort(),
    symbols: summarizeGraphSymbols(input.previousGraphNodes, input.currentGraphNodes),
    layers: summarizeLayerChanges({
      previousModules: input.previousModules,
      currentModules: input.currentModules,
      previousConcepts: input.previousConcepts,
      currentConcepts: input.currentConcepts,
      previousContracts: input.previousContracts,
      currentContracts: input.currentContracts,
      previousFlows: input.previousFlows,
      currentFlows: input.currentFlows,
    }),
    stale: {
      enrichments: (input.staleEnrichments ?? []).slice().sort((a, b) => `${a.layer}:${a.nodeId}`.localeCompare(`${b.layer}:${b.nodeId}`)),
      annotations: (input.staleAnnotations ?? []).slice().sort((a, b) => `${a.layer}:${a.nodeId}:${a.annotationIndex}`.localeCompare(`${b.layer}:${b.nodeId}:${b.annotationIndex}`)),
    },
  };
}

export function readGraphNodesFile(filePath: string): GraphNode[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as GraphNode);
  } catch {
    return [];
  }
}

export function printChangeSummary(
  summary: ChangeSummary,
  log: (line: string) => void = console.log,
): void {
  const lines: string[] = [];
  const pushSection = (title: string, items: string[]): void => {
    if (items.length === 0) return;
    lines.push(title);
    for (const item of items) lines.push(`  ${item}`);
  };

  pushSection('Change summary:', []);

  if (summary.changed_files.length > 0) {
    pushSection('Changed files:', summary.changed_files.map((file) => `- ${file}`));
  }

  pushSection(
    'Added symbols:',
    summary.symbols.added.slice(0, 10).map((symbol) => `+ [${symbol.label}] ${symbol.id}`),
  );
  if (summary.symbols.added.length > 10) {
    lines.push(`  ... and ${summary.symbols.added.length - 10} more`);
  }

  pushSection(
    'Removed symbols:',
    summary.symbols.removed.slice(0, 10).map((symbol) => `- [${symbol.label}] ${symbol.id}`),
  );
  if (summary.symbols.removed.length > 10) {
    lines.push(`  ... and ${summary.symbols.removed.length - 10} more`);
  }

  pushSection(
    'Changed layers:',
    summary.layers.changed.slice(0, 10).map((item) => `~ [${item.layer}] ${item.id}${item.changes?.length ? `: ${item.changes.join(', ')}` : ''}`),
  );

  if (summary.stale.enrichments.length > 0) {
    pushSection(
      'Stale enrichments:',
      summary.stale.enrichments.slice(0, 10).map((item) => `! [${item.layer}] ${item.nodeId}: ${item.reason ?? 'stale'}`),
    );
  }

  if (lines.length === 0) return;
  for (const line of lines) log(line);
}
