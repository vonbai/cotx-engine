import fs from 'node:fs';
import path from 'node:path';
import { GraphTruthStore } from '../store-v2/graph-truth-store.js';
import { quoteCypher } from '../store-v2/escaping.js';

const IMPACT_RELATIONS = [
  'CALLS',
  'IMPORTS',
  'EXTENDS',
  'IMPLEMENTS',
  'HAS_METHOD',
  'HAS_PROPERTY',
  'METHOD_OVERRIDES',
  'METHOD_IMPLEMENTS',
  'ACCESSES',
  'HANDLES_ROUTE',
  'FETCHES',
  'HANDLES_TOOL',
  'STEP_IN_PROCESS',
] as const;

export interface ImpactSummary {
  root: string;
  affected: string[];
  risk: 'LOW' | 'MEDIUM' | 'HIGH';
  status: 'grounded' | 'gap' | 'unknown';
  statusReason: string | null;
  targetPaths?: string[];
}

interface FileCodeNode {
  id: string;
  filePath: string;
}

interface ImpactedNode {
  id: string;
  label: string;
  name: string;
  filePath: string;
  properties: Record<string, unknown>;
}

function truthDbPath(projectRoot: string): string {
  return path.join(projectRoot, '.cotx', 'v2', 'truth.lbug');
}

function riskForAffectedCount(count: number): 'LOW' | 'MEDIUM' | 'HIGH' {
  if (count === 0) return 'LOW';
  if (count <= 9) return 'MEDIUM';
  return 'HIGH';
}

async function openTruthStore(projectRoot: string): Promise<GraphTruthStore | null> {
  const dbPath = truthDbPath(projectRoot);
  if (!fs.existsSync(dbPath)) return null;
  const store = new GraphTruthStore({ dbPath, readOnly: true });
  await store.open();
  return store;
}

function normalizeSourcePath(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/g, '');
  return normalized === '.' ? '.' : normalized.replace(/^\.\//, '');
}

function sourcePathMatchesFilePath(sourcePath: string, filePath: string): boolean {
  const normalizedSource = normalizeSourcePath(sourcePath);
  const normalizedFile = normalizeSourcePath(filePath);
  if (!normalizedSource || !normalizedFile) return false;
  if (normalizedSource === '.') return true;
  return normalizedFile === normalizedSource || normalizedFile.startsWith(`${normalizedSource}/`);
}

async function findFileNodes(
  store: GraphTruthStore,
  sourcePaths: string[],
): Promise<FileCodeNode[]> {
  const uniquePaths = [...new Set(sourcePaths.map(normalizeSourcePath).filter(Boolean))].sort();
  if (uniquePaths.length === 0) return [];

  const rows = await store.query(
    `MATCH (n:CodeNode)
     WHERE n.label = 'File'
     RETURN n.id AS id, n.filePath AS filePath`,
  );

  const matches = rows.flatMap((row) => {
    const id = String(row.id ?? '');
    const filePath = String(row.filePath ?? '');
    if (!id || !filePath) return [];
    if (!uniquePaths.some((sourcePath) => sourcePathMatchesFilePath(sourcePath, filePath))) return [];
    return [{ id, filePath }];
  });

  return matches.filter((value, index, array) =>
    array.findIndex((candidate) => candidate.id === value.id) === index,
  );
}

async function readImpactedNodes(
  store: GraphTruthStore,
  nodeIds: Iterable<string>,
): Promise<ImpactedNode[]> {
  const nodes = await Promise.all(
    [...new Set([...nodeIds].filter(Boolean))].map(async (nodeId) => {
      const context = await store.codeNodeContext(nodeId);
      if (!context) return null;
      return {
        id: context.id,
        label: context.label,
        name: context.name,
        filePath: context.filePath,
        properties: context.properties,
      } satisfies ImpactedNode;
    }),
  );
  return nodes.filter((node): node is ImpactedNode => Boolean(node));
}

function normalizeImpactedNode(node: ImpactedNode): string {
  const filePath = normalizeSourcePath(node.filePath);
  const name = node.name.trim();
  if (node.label === 'File' && filePath) return filePath;
  if (node.label === 'Folder' && filePath) return `${filePath}/`;
  if (node.label === 'Route') {
    const routePath = typeof node.properties.path === 'string' ? node.properties.path : name;
    const method = typeof node.properties.method === 'string' ? node.properties.method : '';
    return routePath ? `route:${method ? `${method} ` : ''}${routePath}` : 'route';
  }
  if (node.label === 'Tool') return name ? `tool:${name}` : 'tool';
  if (node.label === 'Process') return name ? `process:${name}` : 'process';
  if (filePath && name) return `${filePath}#${name}`;
  if (filePath) return filePath;
  if (name) return node.label ? `${node.label.toLowerCase()}:${name}` : name;
  return node.label ? node.label.toLowerCase() : 'unknown-target';
}

export async function collectCodeNodeImpact(
  projectRoot: string,
  nodeId: string,
  direction: 'upstream' | 'downstream',
): Promise<ImpactSummary | null> {
  const store = await openTruthStore(projectRoot);
  if (!store) return null;

  try {
    const context = await store.codeNodeContext(nodeId);
    if (!context) return null;

    const affected = await store.codeImpact(nodeId, direction, 3, [...IMPACT_RELATIONS]);
    return {
      root: nodeId,
      affected,
      risk: riskForAffectedCount(affected.length),
      status: 'grounded',
      statusReason: null,
      targetPaths: context.filePath ? [context.filePath] : undefined,
    };
  } catch (err) {
    // Binder exception → the CodeNode table hasn't been created (no v2
    // compile yet, or the schema migration didn't run). Treat the same as
    // "no typed graph" so the caller can print the standard not-found hint.
    const msg = err instanceof Error ? err.message : String(err);
    if (/Binder exception|Table .* does not exist|node table .* does not exist/i.test(msg)) {
      return null;
    }
    throw err;
  } finally {
    await store.close();
  }
}

export async function collectFileBackedImpact(
  projectRoot: string,
  root: string,
  sourcePaths: string[],
  direction: 'upstream' | 'downstream',
): Promise<ImpactSummary> {
  const uniquePaths = [...new Set(sourcePaths.map(normalizeSourcePath).filter(Boolean))].sort();
  if (uniquePaths.length === 0) {
    return {
      root,
      affected: [],
      risk: 'LOW',
      status: 'gap',
      statusReason: 'No architecture source coverage was available for this element.',
    };
  }

  const store = await openTruthStore(projectRoot);
  if (!store) {
    return {
      root,
      affected: [],
      risk: 'LOW',
      status: 'unknown',
      statusReason: 'No storage-v2 typed graph is available for impact analysis.',
      targetPaths: uniquePaths,
    };
  }

  try {
    const fileNodes = await findFileNodes(store, uniquePaths);
    if (fileNodes.length === 0) {
      return {
        root,
        affected: [],
        risk: 'LOW',
        status: 'gap',
        statusReason: 'The typed graph does not contain file coverage for the current architecture source paths yet.',
        targetPaths: uniquePaths,
      };
    }

    const affectedNodeIds = new Set<string>();
    for (const node of fileNodes) {
      const impacted = await store.codeImpact(node.id, direction, 3, [...IMPACT_RELATIONS]);
      for (const target of impacted) {
        affectedNodeIds.add(target);
      }
    }

    const affected = [...new Set(
      (await readImpactedNodes(store, affectedNodeIds))
        .map((node) => normalizeImpactedNode(node))
        .filter(Boolean),
    )].sort();

    return {
      root,
      affected,
      risk: riskForAffectedCount(affected.length),
      status: 'grounded',
      statusReason: null,
      targetPaths: uniquePaths,
    };
  } finally {
    await store.close();
  }
}

export async function commandImpact(
  projectRoot: string,
  target: string,
  options: { direction?: string },
): Promise<void> {
  const direction = options.direction === 'downstream' ? 'downstream' : 'upstream';
  const impact = await collectCodeNodeImpact(projectRoot, target, direction);
  if (!impact) {
    console.log(`Code node "${target}" not found in storage-v2 typed graph.`);
    return;
  }

  console.log(JSON.stringify({
    target: { id: target },
    direction,
    depths: {
      d1: {
        label: impact.affected.length === 0 ? 'NO DIRECT IMPACT' : 'AFFECTED CODE NODES',
        nodes: impact.affected.slice(0, 200),
        total: impact.affected.length,
      },
    },
    summary: {
      total_affected: impact.affected.length,
      risk: impact.risk,
    },
  }, null, 2));
}
