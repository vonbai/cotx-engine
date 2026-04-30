import { CotxStore } from '../store/store.js';
import fs from 'node:fs';
import path from 'node:path';
import type { ChangeSummary, ModuleNode, ConceptNode, ContractNode, FlowNode } from '../store/schema.js';
import { buildChangeSummary, printChangeSummary, readGraphNodesFile } from '../compiler/change-summary.js';
import { readSemanticArtifactsSync } from '../store-v2/graph-truth-store.js';
import type { SemanticArtifactFact } from '../store-v2/types.js';

export interface DiffResult {
  added: Array<{ id: string; layer: string }>;
  removed: Array<{ id: string; layer: string }>;
  modified: Array<{ id: string; layer: string; changes: string[] }>;
  summary?: ChangeSummary;
}

export async function commandDiff(
  projectRoot: string,
  options: { snapshot?: string; silent?: boolean },
): Promise<DiffResult> {
  const store = new CotxStore(projectRoot);
  if (!store.exists()) {
    if (!options.silent) console.log('No .cotx/ found.');
    return { added: [], removed: [], modified: [], summary: undefined };
  }

  if (!options.snapshot) {
    if (!options.silent) console.log('Usage: cotx diff --snapshot <tag>');
    return { added: [], removed: [], modified: [], summary: undefined };
  }

  const snapshotDir = path.join(projectRoot, '.cotx', 'snapshots', options.snapshot);
  if (!fs.existsSync(snapshotDir)) {
    if (!options.silent) console.log(`Snapshot "${options.snapshot}" not found.`);
    return { added: [], removed: [], modified: [], summary: undefined };
  }

  const result: DiffResult = { added: [], removed: [], modified: [], summary: undefined };
  const previousModules: ModuleNode[] = [];
  const currentModules: ModuleNode[] = [];
  const previousConcepts: ConceptNode[] = [];
  const currentConcepts: ConceptNode[] = [];
  const previousContracts: ContractNode[] = [];
  const currentContracts: ContractNode[] = [];
  const previousFlows: FlowNode[] = [];
  const currentFlows: FlowNode[] = [];

  const currentArtifacts = semanticArtifactMap(path.join(projectRoot, '.cotx', 'v2', 'truth.lbug'));
  const previousArtifacts = semanticArtifactMap(path.join(snapshotDir, 'v2', 'truth.lbug'));
  const allArtifactKeys = new Set([...currentArtifacts.keys(), ...previousArtifacts.keys()]);
  for (const key of allArtifactKeys) {
    const current = currentArtifacts.get(key);
    const previous = previousArtifacts.get(key);
    if (current) {
      collectLayerData(current.layer, current.payload as Record<string, unknown>, currentModules, currentConcepts, currentContracts, currentFlows);
    }
    if (previous) {
      collectLayerData(previous.layer, previous.payload as Record<string, unknown>, previousModules, previousConcepts, previousContracts, previousFlows);
    }
    if (current && !previous) {
      result.added.push({ id: current.id, layer: current.layer });
    } else if (!current && previous) {
      result.removed.push({ id: previous.id, layer: previous.layer });
    } else if (current && previous) {
      const changes = artifactChanges(
        current.layer,
        current.payload as Record<string, unknown>,
        previous.payload as Record<string, unknown>,
        current.structHash,
        previous.structHash,
      );
      if (changes.length > 0) result.modified.push({ id: current.id, layer: current.layer, changes });
    }
  }

  result.summary = buildChangeSummary({
    trigger: 'diff',
    changedFiles: [],
    previousGraphNodes: readGraphNodesFile(path.join(snapshotDir, 'graph', 'nodes.json')),
    currentGraphNodes: readGraphNodesFile(path.join(projectRoot, '.cotx', 'graph', 'nodes.json')),
    previousModules,
    currentModules,
    previousConcepts,
    currentConcepts,
    previousContracts,
    currentContracts,
    previousFlows,
    currentFlows,
  });

  if (!options.silent) {
    console.log(`Diff vs snapshot "${options.snapshot}":\n`);

    if (result.added.length > 0) {
      console.log(`Added (${result.added.length}):`);
      for (const n of result.added) console.log(`  + [${n.layer}] ${n.id}`);
      console.log();
    }

    if (result.removed.length > 0) {
      console.log(`Removed (${result.removed.length}):`);
      for (const n of result.removed) console.log(`  - [${n.layer}] ${n.id}`);
      console.log();
    }

    if (result.modified.length > 0) {
      console.log(`Modified (${result.modified.length}):`);
      for (const n of result.modified)
        console.log(`  ~ [${n.layer}] ${n.id}: ${n.changes.join(', ')}`);
      console.log();
    }

    if (
      result.added.length === 0 &&
      result.removed.length === 0 &&
      result.modified.length === 0
    ) {
      console.log('No changes.');
    }

    const total = result.added.length + result.removed.length + result.modified.length;
    console.log(
      `Total: ${total} changes (${result.added.length} added, ${result.removed.length} removed, ${result.modified.length} modified)`,
    );
    if (result.summary) {
      console.log();
      printChangeSummary(result.summary);
    }
  }

  return result;
}

function collectLayerData(
  layer: string,
  data: Record<string, unknown>,
  modules: ModuleNode[],
  concepts: ConceptNode[],
  contracts: ContractNode[],
  flows: FlowNode[],
): void {
  if (layer === 'module') modules.push(data as unknown as ModuleNode);
  if (layer === 'concept') concepts.push(data as unknown as ConceptNode);
  if (layer === 'contract') contracts.push(data as unknown as ContractNode);
  if (layer === 'flow') flows.push(data as unknown as FlowNode);
}

function semanticArtifactMap(dbPath: string): Map<string, SemanticArtifactFact> {
  return new Map(
    readSemanticArtifactsSync(dbPath).map((artifact) => [`${artifact.layer}\0${artifact.id}`, artifact]),
  );
}

function artifactChanges(
  layer: string,
  currentData: Record<string, unknown>,
  oldData: Record<string, unknown>,
  currentStructHash?: string,
  oldStructHash?: string,
): string[] {
  const changes: string[] = [];
  if ((currentStructHash ?? currentData['struct_hash']) !== (oldStructHash ?? oldData['struct_hash'])) {
    changes.push('structure changed');
    if (layer === 'module') {
      const currentFiles = (currentData['files'] as string[] | undefined) ?? [];
      const oldFiles = (oldData['files'] as string[] | undefined) ?? [];
      const addedFiles = currentFiles.filter((file) => !oldFiles.includes(file));
      const removedFiles = oldFiles.filter((file) => !currentFiles.includes(file));
      if (addedFiles.length > 0) changes.push(`+${addedFiles.length} files`);
      if (removedFiles.length > 0) changes.push(`-${removedFiles.length} files`);
      if (currentData['canonical_entry'] !== oldData['canonical_entry']) changes.push('entry changed');
    }
    if (layer === 'contract') {
      const currentIface = (currentData['interface'] as string[] | undefined) ?? [];
      const oldIface = (oldData['interface'] as string[] | undefined) ?? [];
      const addedFns = currentIface.filter((fn) => !oldIface.includes(fn));
      const removedFns = oldIface.filter((fn) => !currentIface.includes(fn));
      if (addedFns.length > 0) changes.push(`+${addedFns.length} functions`);
      if (removedFns.length > 0) changes.push(`-${removedFns.length} functions`);
    }
  }

  const currentAnns = (currentData['annotations'] as unknown[] | undefined)?.length ?? 0;
  const oldAnns = (oldData['annotations'] as unknown[] | undefined)?.length ?? 0;
  if (currentAnns !== oldAnns) changes.push(`annotations: ${oldAnns} → ${currentAnns}`);
  return changes;
}
