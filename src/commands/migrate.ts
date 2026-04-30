import { CotxStore } from '../store/store.js';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { Annotation, ModuleNode } from '../store/schema.js';
import { readSemanticArtifactsSync } from '../store-v2/graph-truth-store.js';
import type { SemanticArtifactFact } from '../store-v2/types.js';
import { extendArray } from '../core/shared/array-utils.js';

interface MigrationResult {
  migrated: number;
  orphaned: number;
  details: Array<{ oldNode: string; layer: string; action: 'migrated' | 'orphaned'; target?: string; annotations: number }>;
}

export async function commandMigrate(
  projectRoot: string,
  options: { from?: string; status?: boolean },
): Promise<MigrationResult> {
  const store = new CotxStore(projectRoot);
  if (!store.exists()) {
    console.log('No .cotx/ found.');
    return { migrated: 0, orphaned: 0, details: [] };
  }

  if (options.status) {
    return showMigrationStatus(projectRoot);
  }

  const tag = options.from;
  if (!tag) {
    console.log('Usage: cotx migrate --from <tag>');
    return { migrated: 0, orphaned: 0, details: [] };
  }

  const snapshotDir = path.join(projectRoot, '.cotx', 'snapshots', tag);
  if (!fs.existsSync(snapshotDir)) {
    console.log(`Snapshot "${tag}" not found.`);
    return { migrated: 0, orphaned: 0, details: [] };
  }

  const result: MigrationResult = { migrated: 0, orphaned: 0, details: [] };
  const orphanedAnnotations: Array<{ oldNode: string; layer: string; annotations: Annotation[] }> = [];

  // Load old snapshot's annotated semantic artifacts
  const layers = ['module', 'concept', 'contract', 'flow'] as const;
  const oldArtifactsByLayer = groupSnapshotArtifacts(path.join(snapshotDir, 'v2', 'truth.lbug'));

  for (const layer of layers) {
    const oldArtifacts = oldArtifactsByLayer.get(layer) ?? [];
    if (oldArtifacts.length === 0) continue;

    const newIds = new Set(
      layer === 'module' ? store.listModules() :
      layer === 'concept' ? store.listConcepts() :
      layer === 'contract' ? store.listContracts() :
      store.listFlows()
    );

    for (const artifact of oldArtifacts) {
      const oldData = artifact.payload as any;
      if (!oldData?.annotations || oldData.annotations.length === 0) continue;

      const oldId = oldData.id ?? artifact.id;
      const annotations = oldData.annotations as Annotation[];

      // Strategy 1: Same ID exists in new map
      if (newIds.has(oldId)) {
        migrateAnnotations(store, layer, oldId, annotations);
        result.migrated += annotations.length;
        result.details.push({ oldNode: oldId, layer, action: 'migrated', target: oldId, annotations: annotations.length });
        continue;
      }

      // Strategy 2: File overlap (modules only)
      if (layer === 'module' && oldData.files) {
        const matchedModule = findModuleByFileOverlap(store, oldData.files);
        if (matchedModule) {
          migrateAnnotations(store, 'module', matchedModule, annotations);
          result.migrated += annotations.length;
          result.details.push({ oldNode: oldId, layer, action: 'migrated', target: matchedModule, annotations: annotations.length });
          continue;
        }
      }

      // No match → orphan
      orphanedAnnotations.push({ oldNode: oldId, layer, annotations });
      result.orphaned += annotations.length;
      result.details.push({ oldNode: oldId, layer, action: 'orphaned', annotations: annotations.length });
    }
  }

  // Write orphaned annotations
  if (orphanedAnnotations.length > 0) {
    const orphanPath = path.join(projectRoot, '.cotx', 'orphaned-annotations.yaml');
    fs.writeFileSync(orphanPath, yaml.dump(orphanedAnnotations, { lineWidth: 120 }));
  }

  // Print summary
  console.log(`Migration from "${tag}":`);
  console.log(`  ${result.migrated} annotations migrated`);
  console.log(`  ${result.orphaned} annotations orphaned`);
  for (const d of result.details) {
    if (d.action === 'migrated') {
      console.log(`  ✓ ${d.layer}/${d.oldNode} → ${d.target} (${d.annotations} annotations)`);
    } else {
      console.log(`  ✗ ${d.layer}/${d.oldNode} → orphaned (${d.annotations} annotations)`);
    }
  }

  return result;
}

function findModuleByFileOverlap(store: CotxStore, oldFiles: string[]): string | null {
  const oldSet = new Set(oldFiles);
  let bestMatch: string | null = null;
  let bestOverlap = 0;

  for (const id of store.listModules()) {
    const mod = store.readModule(id);
    const overlap = mod.files.filter(f => oldSet.has(f)).length;
    const ratio = oldFiles.length > 0 ? overlap / oldFiles.length : 0;
    if (ratio > 0.6 && ratio > bestOverlap) {
      bestOverlap = ratio;
      bestMatch = id;
    }
  }

  return bestMatch;
}

function migrateAnnotations(store: CotxStore, layer: string, nodeId: string, annotations: Annotation[]): void {
  let data: any;
  switch (layer) {
    case 'module': data = store.readModule(nodeId); break;
    case 'concept': data = store.readConcept(nodeId); break;
    case 'contract': data = store.readContract(nodeId); break;
    case 'flow': data = store.readFlow(nodeId); break;
    default: return;
  }

  if (!data.annotations) data.annotations = [];
  extendArray(data.annotations, annotations);

  switch (layer) {
    case 'module': store.writeModule(data); break;
    case 'concept': store.writeConcept(data); break;
    case 'contract': store.writeContract(data); break;
    case 'flow': store.writeFlow(data); break;
  }
}

function groupSnapshotArtifacts(dbPath: string): Map<SemanticArtifactFact['layer'], SemanticArtifactFact[]> {
  const grouped = new Map<SemanticArtifactFact['layer'], SemanticArtifactFact[]>();
  for (const artifact of readSemanticArtifactsSync(dbPath)) {
    const existing = grouped.get(artifact.layer) ?? [];
    existing.push(artifact);
    grouped.set(artifact.layer, existing);
  }
  return grouped;
}

function showMigrationStatus(projectRoot: string): MigrationResult {
  const orphanPath = path.join(projectRoot, '.cotx', 'orphaned-annotations.yaml');
  if (fs.existsSync(orphanPath)) {
    const orphans = yaml.load(fs.readFileSync(orphanPath, 'utf-8')) as any[];
    const count = orphans.reduce((sum, o) => sum + (o.annotations?.length ?? 0), 0);
    console.log(`Orphaned annotations: ${count} across ${orphans.length} nodes`);
    for (const o of orphans) {
      console.log(`  ${o.layer}/${o.oldNode}: ${o.annotations?.length ?? 0} annotations`);
    }
  } else {
    console.log('No orphaned annotations.');
  }
  return { migrated: 0, orphaned: 0, details: [] };
}
