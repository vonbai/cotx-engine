import { CotxStore } from '../store/store.js';
import fs from 'node:fs';
import path from 'node:path';
import { GraphTruthStore, type CodeNodeContextResult } from '../store-v2/graph-truth-store.js';
import { ArchitectureStore } from '../store/architecture-store.js';

export async function commandContext(projectRoot: string, nodeId: string): Promise<void> {
  const store = new CotxStore(projectRoot);
  if (!store.exists()) {
    console.log('No .cotx/ found. Run: cotx compile');
    return;
  }

  if (nodeId.startsWith('architecture/')) {
    printArchitectureContext(projectRoot, nodeId);
    return;
  }

  if (await printV2CodeNodeContext(projectRoot, nodeId)) return;
  console.log(`Code node "${nodeId}" not found in storage-v2 typed graph.`);
}

function printArchitectureContext(projectRoot: string, nodeId: string): void {
  const archStore = new ArchitectureStore(projectRoot);
  if (!archStore.exists()) {
    console.log('No architecture data. Run: cotx compile');
    return;
  }

  const archPath = nodeId.slice('architecture/'.length);
  const [perspectiveId, ...rest] = archPath.split('/');
  if (!perspectiveId) {
    console.log(`Architecture node "${nodeId}" not found.`);
    return;
  }

  if (rest.length === 0) {
    let data;
    try {
      data = archStore.readPerspective(perspectiveId);
    } catch {
      console.log(`Architecture node "${nodeId}" not found.`);
      return;
    }
    console.log(JSON.stringify({
      id: nodeId,
      layer: 'architecture',
      data: {
        ...data,
        description: archStore.readDescription(perspectiveId),
        diagram: archStore.readDiagram(perspectiveId),
      },
      children: archStore.listChildren(perspectiveId),
    }, null, 2));
    return;
  }

  const elementPath = rest.join('/');
  const fullPath = `${perspectiveId}/${elementPath}`;
  let data;
  try {
    data = archStore.readElement(perspectiveId, elementPath);
  } catch {
    let perspective;
    try {
      perspective = archStore.readPerspective(perspectiveId);
    } catch {
      console.log(`Architecture node "${nodeId}" not found.`);
      return;
    }
    const fallbackId = elementPath.split('/').pop() ?? elementPath;
    data = perspective.components.find((component) => component.id === fallbackId);
    if (!data) {
      console.log(`Architecture node "${nodeId}" not found.`);
      return;
    }
  }

  console.log(JSON.stringify({
    id: nodeId,
    layer: 'architecture',
    data: {
      ...data,
      description: archStore.readDescription(fullPath),
      diagram: archStore.readDiagram(fullPath),
    },
    children: archStore.listChildren(fullPath),
  }, null, 2));
}

async function printV2CodeNodeContext(projectRoot: string, nodeId: string): Promise<boolean> {
  const dbPath = path.join(projectRoot, '.cotx', 'v2', 'truth.lbug');
  if (!fs.existsSync(dbPath)) return false;
  const store = new GraphTruthStore({ dbPath, readOnly: true });
  await store.open();
  try {
    const context = await store.codeNodeContext(nodeId);
    if (!context) return false;

    console.log(JSON.stringify(formatCodeNodeContext(context), null, 2));

    return true;
  } finally {
    await store.close();
  }
}

function formatCodeNodeContext(typed: CodeNodeContextResult): unknown {
  const outgoing = typed.outgoing.map((item) => ({
    to: item.to,
    layer: item.label,
    relation: item.type,
    name: item.name,
    filePath: item.filePath,
    confidence: item.confidence,
    reason: item.reason,
    step: item.step,
  }));
  const incoming = typed.incoming.map((item) => ({
    from: item.from,
    layer: item.label,
    relation: item.type,
    name: item.name,
    filePath: item.filePath,
    confidence: item.confidence,
    reason: item.reason,
    step: item.step,
  }));
  return {
    status: 'found',
    symbol: {
      uid: typed.id,
      name: typed.name,
      kind: typed.label,
      filePath: typed.filePath,
      startLine: typed.startLine,
      endLine: typed.endLine,
      isExported: typed.isExported,
      properties: typed.properties,
    },
    incoming,
    outgoing,
    incoming_by_type: groupRelationsByType(incoming),
    outgoing_by_type: groupRelationsByType(outgoing),
    processes: typed.processes,
  };
}

function groupRelationsByType(relations: Array<{ relation: string } & Record<string, unknown>>): Record<string, unknown[]> {
  const grouped: Record<string, unknown[]> = {};
  for (const relation of relations) {
    const key = relation.relation.toLowerCase();
    (grouped[key] ??= []).push(relation);
  }
  return grouped;
}
