import type { GraphNode, GraphEdge } from '../core/export/json-exporter.js';
import type { ModuleNode, ContractNode } from '../store/schema.js';
import { structHash } from '../lib/hash.js';

/**
 * Compile GraphNode + GraphEdge + ModuleNode data into ContractNode records.
 *
 * Algorithm:
 * 1. Build file→module map from ModuleNode[].
 * 2. Build nodeId→module map by looking up each GraphNode's filePath.
 * 3. Find cross-module CALLS edges (source module ≠ target module).
 * 4. Group by (provider, consumer): target's module = provider, source's module = consumer.
 * 5. Collect unique target function names per (provider, consumer) pair as interface[].
 * 6. Generate contract ID as `${consumer}--${provider}` (consumer < provider alphabetically).
 * 7. Compute struct_hash from { id, provider, consumer, interface }.
 * 8. Return ContractNode[] sorted alphabetically by id.
 */
export function compileContracts(
  nodes: GraphNode[],
  edges: GraphEdge[],
  modules: ModuleNode[],
): ContractNode[] {
  // Step 1: build file→module map
  const fileToModule = new Map<string, string>();
  for (const mod of modules) {
    for (const file of mod.files) {
      fileToModule.set(file, mod.id);
    }
  }

  // Step 2: build nodeId→module map
  const nodeToModule = new Map<string, string>();
  for (const node of nodes) {
    const filePath = node.properties.filePath as string | undefined;
    if (!filePath) continue;
    const modId = fileToModule.get(filePath);
    if (modId !== undefined) {
      nodeToModule.set(node.id, modId);
    }
  }

  // Build nodeId→name map for looking up target function names
  const nodeToName = new Map<string, string>();
  for (const node of nodes) {
    const name = node.properties.name as string | undefined;
    if (name !== undefined) {
      nodeToName.set(node.id, name);
    }
  }

  // Step 3 & 4: find cross-module CALLS and group by (provider, consumer)
  // key: `${consumer}::${provider}`, value: Set of function names
  const pairInterface = new Map<string, Set<string>>();

  for (const edge of edges) {
    if (edge.type !== 'CALLS') continue;

    const srcMod = nodeToModule.get(edge.sourceId);
    const tgtMod = nodeToModule.get(edge.targetId);

    if (!srcMod || !tgtMod) continue;
    if (srcMod === tgtMod) continue;

    // source = consumer, target = provider
    const consumer = srcMod;
    const provider = tgtMod;
    const pairKey = `${consumer}::${provider}`;

    if (!pairInterface.has(pairKey)) {
      pairInterface.set(pairKey, new Set());
    }

    const fnName = nodeToName.get(edge.targetId);
    if (fnName !== undefined) {
      pairInterface.get(pairKey)!.add(fnName);
    }
  }

  // Step 5–8: assemble ContractNode records
  const contracts: ContractNode[] = [];

  for (const [pairKey, fnNames] of pairInterface) {
    const colonIdx = pairKey.indexOf('::');
    const consumer = pairKey.slice(0, colonIdx);
    const provider = pairKey.slice(colonIdx + 2);

    // Step 6: ID is always consumer--provider
    const id = `${consumer}--${provider}`;

    // Step 5: sorted, deduplicated interface list
    const iface = [...fnNames].sort();

    // Step 7: struct_hash
    const hash = structHash({ id, provider, consumer, interface: iface });

    contracts.push({
      id,
      provider,
      consumer,
      interface: iface,
      struct_hash: hash,
    } satisfies ContractNode);
  }

  // Step 8: sort alphabetically by id
  contracts.sort((a, b) => a.id.localeCompare(b.id));

  return contracts;
}
