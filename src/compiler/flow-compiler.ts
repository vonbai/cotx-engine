import type { GraphNode, ProcessData } from '../core/export/json-exporter.js';
import type { ModuleNode, FlowNode } from '../store/schema.js';
import { structHash } from '../lib/hash.js';

/**
 * Compile ProcessData[] (from BFS detection) into FlowNode[] records.
 *
 * Algorithm:
 * 1. Build nodeId→moduleId map: for each ModuleNode, expand its files set;
 *    for each GraphNode, find which module owns its filePath.
 * 2. Build nodeId→name map from GraphNode properties.
 * 3. Map each ProcessData → FlowNode:
 *    - id: process ID as-is
 *    - type: 'flow'
 *    - trigger: entryPointId resolved to function name (or "unknown")
 *    - steps: sorted by step number, each resolved to { module, function }
 *    - struct_hash: over { id, trigger, steps: [{module, function}] }
 * 4. Return FlowNode[] sorted alphabetically by id.
 */
export function compileFlows(
  processes: ProcessData[],
  nodes: GraphNode[],
  modules: ModuleNode[],
): FlowNode[] {
  // Step 1: build nodeId → moduleId map via ModuleNode file sets
  const fileToModule = new Map<string, string>();
  for (const mod of modules) {
    for (const file of mod.files) {
      fileToModule.set(file, mod.id);
    }
  }

  const nodeToModule = new Map<string, string>();
  for (const node of nodes) {
    const filePath = node.properties.filePath as string | undefined;
    if (filePath) {
      const modId = fileToModule.get(filePath);
      if (modId !== undefined) {
        nodeToModule.set(node.id, modId);
      }
    }
  }

  // Step 2: build nodeId → function name map
  const nodeToName = new Map<string, string>();
  for (const node of nodes) {
    const name = node.properties.name as string | undefined;
    if (name !== undefined) {
      nodeToName.set(node.id, name);
    }
  }

  // Step 3: map each ProcessData → FlowNode
  const flows: FlowNode[] = processes.map((proc) => {
    const trigger = nodeToName.get(proc.entryPointId) ?? 'unknown';

    const steps = [...proc.steps]
      .sort((a, b) => a.step - b.step)
      .map((s) => ({
        module: nodeToModule.get(s.nodeId) ?? 'unknown',
        function: nodeToName.get(s.nodeId) ?? 'unknown',
      }));

    const hash = structHash({
      id: proc.id,
      trigger,
      steps: steps.map((s) => ({ module: s.module, function: s.function })),
    });

    return {
      id: proc.id,
      type: 'flow' as const,
      trigger,
      steps,
      struct_hash: hash,
    } satisfies FlowNode;
  });

  // Step 4: sort alphabetically by id
  flows.sort((a, b) => a.id.localeCompare(b.id));

  return flows;
}
