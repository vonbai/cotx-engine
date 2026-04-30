import type { ModuleNode } from '../store/schema.js';
import type { GraphNode, GraphEdge, CommunityData } from '../core/export/json-exporter.js';
import { structHash } from '../lib/hash.js';
import { splitCompoundName, moduleIdForFile } from '../lib/naming.js';
import { isTestFile } from '../core/parser/entry-point-scoring.js';

/** Minimum files in a directory module before community splitting kicks in. */
const COMMUNITY_SPLIT_THRESHOLD = 50;

/** Sub-modules below this file count get merged into their closest neighbor. */
const MIN_SUBMODULE_FILES = 5;

/** Sub-modules above this count get directory-aware refinement. */
const DIRECTORY_REFINE_THRESHOLD = 100;

/**
 * Generate a sub-module label from member function/symbol names.
 * Finds the most common non-noise word root across member names.
 */
function generateSubModuleLabel(memberNodeIds: string[], nodeById: Map<string, GraphNode>): string {
  const NOISE = new Set([
    'get', 'set', 'new', 'create', 'handle', 'error', 'config', 'init',
    'type', 'data', 'info', 'item', 'list', 'map', 'test', 'mock', 'base',
    'default', 'internal', 'util', 'helper', 'manager', 'service', 'handler',
    'processor', 'builder', 'factory', 'impl', 'abstract', 'interface',
    'command', 'func', 'run', 'load', 'write', 'read', 'parse', 'string',
    'options', 'args', 'result', 'value', 'node', 'file', 'path', 'name',
  ]);

  const wordCounts = new Map<string, number>();

  for (const nodeId of memberNodeIds) {
    const node = nodeById.get(nodeId);
    if (!node) continue;
    const name = node.properties.name as string | undefined;
    if (!name) continue;

    const words = splitCompoundName(name);
    // Count each word once per symbol (not per occurrence)
    const seen = new Set<string>();
    for (const w of words) {
      if (NOISE.has(w) || seen.has(w)) continue;
      seen.add(w);
      wordCounts.set(w, (wordCounts.get(w) ?? 0) + 1);
    }
  }

  // Pick word with highest count; tie-break by length desc (longer = more meaningful)
  let best = '';
  let bestCount = 0;
  for (const [word, count] of wordCounts) {
    if (
      count > bestCount ||
      (count === bestCount && word.length > best.length) ||
      (count === bestCount && word.length === best.length && word < best)
    ) {
      bestCount = count;
      best = word;
    }
  }

  return best || 'misc';
}

/**
 * Compile GraphNode + GraphEdge data into ModuleNode records.
 *
 * Algorithm:
 * 1. Group nodes by top-level directory of their filePath.
 * 2. For large modules (> COMMUNITY_SPLIT_THRESHOLD files), use community
 *    data to split into sub-modules with labels derived from member names.
 * 3. Build deduplicated file sets per module.
 * 4. Map each node ID → module ID.
 * 5. Count external in-calls per node (caller module ≠ callee module).
 * 6. Canonical entry = most externally called exported function in module.
 * 7. Build depends_on / depended_by from cross-module CALLS edges.
 * 8. Compute struct_hash from { id, canonical_entry, files }.
 * 9. Sort modules alphabetically.
 */
export function compileModules(
  nodes: GraphNode[],
  edges: GraphEdge[],
  communities: CommunityData[],
): ModuleNode[] {
  // Build a lookup of node properties for quick access
  const nodeById = new Map<string, GraphNode>();
  for (const node of nodes) {
    nodeById.set(node.id, node);
  }

  // Step 1: group nodes by top-level directory
  const dirFiles = new Map<string, Set<string>>();
  const dirNodeIds = new Map<string, Set<string>>();

  for (const node of nodes) {
    const filePath = node.properties.filePath as string | undefined;
    if (!filePath) continue;

    const dirId = moduleIdForFile(filePath);

    if (!dirFiles.has(dirId)) {
      dirFiles.set(dirId, new Set());
      dirNodeIds.set(dirId, new Set());
    }
    dirFiles.get(dirId)!.add(filePath);
    dirNodeIds.get(dirId)!.add(node.id);
  }

  // Step 2: community-based splitting for large modules
  // Build community membership lookup: nodeId → communityId
  const nodeToCommunity = new Map<string, string>();
  for (const comm of communities) {
    for (const memberId of comm.members) {
      nodeToCommunity.set(memberId, comm.id);
    }
  }

  // Final module maps (after potential splitting)
  const moduleFiles = new Map<string, Set<string>>();
  const moduleNodeIds = new Map<string, Set<string>>();

  for (const [dirId, fileSet] of dirFiles) {
    const nodeIds = dirNodeIds.get(dirId)!;

    if (fileSet.size > COMMUNITY_SPLIT_THRESHOLD && communities.length > 0) {
      // Phase A: label each community, then MERGE same-label communities
      const communityGroups = new Map<string, Set<string>>(); // commId → nodeIds

      for (const nodeId of nodeIds) {
        const commId = nodeToCommunity.get(nodeId);
        if (commId) {
          if (!communityGroups.has(commId)) communityGroups.set(commId, new Set());
          communityGroups.get(commId)!.add(nodeId);
        }
      }

      // Compute label for each community, then merge by label
      const labelToNodes = new Map<string, Set<string>>();
      for (const [, members] of communityGroups) {
        if (members.size === 0) continue;
        const label = generateSubModuleLabel([...members], nodeById);
        if (!labelToNodes.has(label)) labelToNodes.set(label, new Set());
        const merged = labelToNodes.get(label)!;
        for (const n of members) merged.add(n);
      }

      // Phase B: FILE-LEVEL assignment — assign each file to the label
      // that has the most community-member nodes in that file
      const fileToNodeIds = new Map<string, string[]>();
      for (const nodeId of nodeIds) {
        const fp = (nodeById.get(nodeId)?.properties.filePath as string | undefined);
        if (!fp) continue;
        if (!fileToNodeIds.has(fp)) fileToNodeIds.set(fp, []);
        fileToNodeIds.get(fp)!.push(nodeId);
      }

      // Build node→label lookup for community-assigned nodes
      const nodeToLabel = new Map<string, string>();
      for (const [label, nodes2] of labelToNodes) {
        for (const nid of nodes2) nodeToLabel.set(nid, label);
      }

      // For each file, count which label has the most members in it
      const fileToLabel = new Map<string, string>();
      for (const [fp, fNodes] of fileToNodeIds) {
        const labelCounts = new Map<string, number>();
        for (const nid of fNodes) {
          const label = nodeToLabel.get(nid);
          if (label) labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
        }

        if (labelCounts.size > 0) {
          let best = '';
          let bestCount = 0;
          for (const [label, count] of labelCounts) {
            if (count > bestCount || (count === bestCount && label < best)) {
              bestCount = count;
              best = label;
            }
          }
          fileToLabel.set(fp, best);
        }
        // else: file has no community members, will be assigned in Phase C
      }

      // Phase C: assign remaining files by co-location — if a file has the
      // same basename prefix (e.g. control_state.go ↔ control_ops.go) as
      // assigned files, group them together. Otherwise use edge proximity.
      const unassignedFiles = [...fileToNodeIds.keys()].filter((fp) => !fileToLabel.has(fp));

      // Build file basename → label mapping from assigned files
      const prefixToLabel = new Map<string, Map<string, number>>();
      for (const [fp, label] of fileToLabel) {
        const base = fp.split('/').pop()!.replace(/\.[^.]+$/, '');
        const prefix = base.replace(/_test$/, '').split('_')[0];
        if (!prefixToLabel.has(prefix)) prefixToLabel.set(prefix, new Map());
        const counts = prefixToLabel.get(prefix)!;
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }

      for (const fp of unassignedFiles) {
        const base = fp.split('/').pop()!.replace(/\.[^.]+$/, '');
        const prefix = base.replace(/_test$/, '').split('_')[0];

        // Try prefix match
        const counts = prefixToLabel.get(prefix);
        if (counts && counts.size > 0) {
          let best = '';
          let bestCount = 0;
          for (const [label, count] of counts) {
            if (count > bestCount) { bestCount = count; best = label; }
          }
          fileToLabel.set(fp, best);
          continue;
        }

        // Last resort: use the file's own nodes' word roots as a label
        const fNodes = fileToNodeIds.get(fp) ?? [];
        const selfLabel = generateSubModuleLabel(fNodes, nodeById);
        fileToLabel.set(fp, selfLabel);
      }

      // Phase D: assemble sub-modules from file assignments
      const labelModFiles = new Map<string, Set<string>>();
      const labelModNodes = new Map<string, Set<string>>();

      for (const [fp, label] of fileToLabel) {
        if (!labelModFiles.has(label)) {
          labelModFiles.set(label, new Set());
          labelModNodes.set(label, new Set());
        }
        labelModFiles.get(label)!.add(fp);
        for (const nid of (fileToNodeIds.get(fp) ?? [])) {
          labelModNodes.get(label)!.add(nid);
        }
      }

      // Phase E: merge small sub-modules into their closest large neighbor
      // Find which labels are "small" (below threshold)
      const smallLabels = new Set<string>();
      const largeLabels = new Set<string>();
      for (const [label, files] of labelModFiles) {
        if (files.size < MIN_SUBMODULE_FILES) smallLabels.add(label);
        else largeLabels.add(label);
      }

      if (smallLabels.size > 0 && largeLabels.size > 0) {
        // Single-pass edge bucketing: build nodeId → label map, then one
        // pass over edges to accumulate mergeScores[smallLabel][largeLabel].
        const allNodeToLabel = new Map<string, string>();
        for (const [label, nids] of labelModNodes) {
          for (const nid of nids) allNodeToLabel.set(nid, label);
        }

        const mergeScores = new Map<string, Map<string, number>>();
        for (const sl of smallLabels) mergeScores.set(sl, new Map());

        for (const edge of edges) {
          if (edge.type !== 'CALLS') continue;
          const srcLabel = allNodeToLabel.get(edge.sourceId);
          const tgtLabel = allNodeToLabel.get(edge.targetId);
          if (!srcLabel || !tgtLabel || srcLabel === tgtLabel) continue;

          // One must be small, the other large
          if (smallLabels.has(srcLabel) && largeLabels.has(tgtLabel)) {
            const counts = mergeScores.get(srcLabel)!;
            counts.set(tgtLabel, (counts.get(tgtLabel) ?? 0) + 1);
          } else if (smallLabels.has(tgtLabel) && largeLabels.has(srcLabel)) {
            const counts = mergeScores.get(tgtLabel)!;
            counts.set(srcLabel, (counts.get(srcLabel) ?? 0) + 1);
          }
        }

        for (const smallLabel of smallLabels) {
          const edgeCounts = mergeScores.get(smallLabel)!;

          // Pick the most connected large label, or the largest by file count
          let bestTarget = '';
          let bestScore = 0;
          for (const [label, count] of edgeCounts) {
            if (count > bestScore) { bestScore = count; bestTarget = label; }
          }
          if (!bestTarget) {
            // Fallback: merge into the largest sub-module
            let maxFiles = 0;
            for (const ll of largeLabels) {
              const size = labelModFiles.get(ll)!.size;
              if (size > maxFiles) { maxFiles = size; bestTarget = ll; }
            }
          }

          if (bestTarget) {
            // Merge small into large
            const smallNodes = labelModNodes.get(smallLabel)!;
            const targetFiles = labelModFiles.get(bestTarget)!;
            const targetNodes = labelModNodes.get(bestTarget)!;
            for (const f of labelModFiles.get(smallLabel)!) targetFiles.add(f);
            for (const n of smallNodes) targetNodes.add(n);
            labelModFiles.delete(smallLabel);
            labelModNodes.delete(smallLabel);
          }
        }
      }

      // Phase F: directory-aware refinement for still-large sub-modules
      for (const [label, files] of [...labelModFiles.entries()]) {
        if (files.size <= DIRECTORY_REFINE_THRESHOLD) continue;

        // Check if files span multiple subdirectories
        const subdirCounts = new Map<string, Set<string>>();
        for (const fp of files) {
          const parts = fp.split('/');
          const subdir = parts.length >= 3 ? parts[1] : '_flat';
          if (!subdirCounts.has(subdir)) subdirCounts.set(subdir, new Set());
          subdirCounts.get(subdir)!.add(fp);
        }

        // Only refine if there are multiple meaningful subdirs
        if (subdirCounts.size < 2) continue;

        // Split: each subdir becomes its own sub-module
        const nodes2 = labelModNodes.get(label)!;
        labelModFiles.delete(label);
        labelModNodes.delete(label);

        for (const [subdir, subdirFiles] of subdirCounts) {
          const refinedLabel = subdir === '_flat' ? label : subdir;
          const refinedNodes = new Set<string>();
          for (const nid of nodes2) {
            const fp = (nodeById.get(nid)?.properties.filePath as string | undefined);
            if (fp && subdirFiles.has(fp)) refinedNodes.add(nid);
          }
          if (!labelModFiles.has(refinedLabel)) {
            labelModFiles.set(refinedLabel, new Set());
            labelModNodes.set(refinedLabel, new Set());
          }
          const existing = labelModFiles.get(refinedLabel)!;
          const existingNodes = labelModNodes.get(refinedLabel)!;
          for (const f of subdirFiles) existing.add(f);
          for (const n of refinedNodes) existingNodes.add(n);
        }
      }

      for (const [label, files] of labelModFiles) {
        if (files.size === 0) continue;
        const subModId = `${dirId}/${label}`;
        moduleFiles.set(subModId, files);
        moduleNodeIds.set(subModId, labelModNodes.get(label)!);
      }
    } else {
      // Small module — keep as-is
      moduleFiles.set(dirId, fileSet);
      moduleNodeIds.set(dirId, nodeIds);
    }
  }

  // Step 3: map node ID → module ID for fast lookup
  const nodeToModule = new Map<string, string>();
  for (const [modId, nodeIds] of moduleNodeIds) {
    for (const nodeId of nodeIds) {
      nodeToModule.set(nodeId, modId);
    }
  }

  // Step 4: count external in-calls per node (CALLS edges only)
  const externalInCallCount = new Map<string, number>();
  const dependsOnSet = new Map<string, Set<string>>();
  const dependedBySet = new Map<string, Set<string>>();

  for (const modId of moduleFiles.keys()) {
    dependsOnSet.set(modId, new Set());
    dependedBySet.set(modId, new Set());
  }

  for (const edge of edges) {
    if (edge.type !== 'CALLS') continue;

    const srcMod = nodeToModule.get(edge.sourceId);
    const tgtMod = nodeToModule.get(edge.targetId);

    if (!srcMod || !tgtMod) continue;

    if (srcMod !== tgtMod) {
      externalInCallCount.set(edge.targetId, (externalInCallCount.get(edge.targetId) ?? 0) + 1);
      dependsOnSet.get(srcMod)!.add(tgtMod);
      dependedBySet.get(tgtMod)!.add(srcMod);
    }
  }

  // Step 5: find canonical_entry per module
  const moduleCanonicalEntry = new Map<string, string>();

  for (const [modId, nodeIds] of moduleNodeIds) {
    let bestNodeId: string | undefined;
    let bestCount = -1;

    for (const nodeId of nodeIds) {
      const node = nodeById.get(nodeId)!;
      const isExported = node.properties.isExported as boolean | undefined;
      if (!isExported) continue;
      const filePath = node.properties.filePath as string | undefined;
      if (filePath && isTestFile(filePath)) continue;

      const count = externalInCallCount.get(nodeId) ?? 0;
      if (count > bestCount) {
        bestCount = count;
        bestNodeId = nodeId;
      }
    }

    if (bestNodeId) {
      const node = nodeById.get(bestNodeId)!;
      moduleCanonicalEntry.set(modId, node.properties.name as string);
    } else {
      const exportedNodes = [...nodeIds]
        .map((id) => nodeById.get(id)!)
        .filter((n) => n.properties.isExported)
        .filter((n) => {
          const filePath = n.properties.filePath as string | undefined;
          return !filePath || !isTestFile(filePath);
        })
        .sort((a, b) => String(a.properties.name).localeCompare(String(b.properties.name)));

      if (exportedNodes.length > 0) {
        moduleCanonicalEntry.set(modId, exportedNodes[0].properties.name as string);
      } else {
        moduleCanonicalEntry.set(modId, '');
      }
    }
  }

  // Step 6: assemble ModuleNode records and sort alphabetically
  const moduleIds = [...moduleFiles.keys()].sort();

  return moduleIds.map((modId) => {
    const files = [...moduleFiles.get(modId)!].sort();
    const canonical_entry = moduleCanonicalEntry.get(modId) ?? '';
    const depends_on = [...(dependsOnSet.get(modId) ?? [])].sort();
    const depended_by = [...(dependedBySet.get(modId) ?? [])].sort();

    const hash = structHash({ id: modId, canonical_entry, files });

    return {
      id: modId,
      canonical_entry,
      files,
      depends_on,
      depended_by,
      struct_hash: hash,
    } satisfies ModuleNode;
  });
}
