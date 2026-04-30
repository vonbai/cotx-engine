// src/compiler/architecture-compiler.ts
import type {
  GraphNode,
  GraphEdge,
  CommunityData,
  ProcessData,
} from '../core/export/json-exporter.js';
import type {
  PerspectiveData,
  ArchitectureElement,
  ArchitectureEdge,
  ArchitectureStats,
  ArchitectureMeta,
} from '../store/schema.js';
import { structHash } from '../lib/hash.js';
import { extendArray } from '../core/shared/array-utils.js';
import {
  collectSourceRootInventory,
  isSourceCodeFilePath,
  type SourceRootInventory,
} from './source-root-inventory.js';
import type { WorkspaceLayoutScan } from './workspace-scan.js';

export { collectSourceRootInventory, detectSourceRoots } from './source-root-inventory.js';

// ── Types ─────────────────────────────────────────────────────────────────

interface FunctionComplexityEntry {
  cyclomatic: number;
  nestingDepth: number;
  loc: number;
  filePath: string;
  name: string;
}

function filenameStem(filePath: string): string {
  const base = filePath.split('/').pop() ?? filePath;
  return base.replace(/\.[^.]+$/, '');
}

function deriveFlatComponentId(filePath: string): string {
  const stem = filenameStem(filePath);
  const prefix = stem.split(/[-_.]/)[0];
  return prefix || stem;
}

function labelForId(id: string): string {
  const tail = id.split('/').pop() ?? id;
  return tail
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export interface ArchitectureCompileResult {
  meta: ArchitectureMeta;
  perspectives: PerspectiveData[];
  elementDocs: Array<{
    perspectiveId: string;
    elementPath: string;       // e.g. "compiler/module-compiler"
    data: ArchitectureElement;
  }>;
  mermaidByPath: Map<string, string>;       // "overall-architecture" or "overall-architecture/compiler"
  descriptionsByPath: Map<string, string>;  // same path convention
  sourceRootInventory: SourceRootInventory;
}

// ── Directory Grouping ────────────────────────────────────────────────────

interface DirectoryGroup {
  directory: string;
  files: string[];
  functions: GraphNode[];
}

function groupByDirectory(
  nodes: GraphNode[],
  sourceRoots: string[],
): Map<string, DirectoryGroup> {
  const groups = new Map<string, DirectoryGroup>();

  // Build file -> functions mapping
  const fileFunctions = new Map<string, GraphNode[]>();
  const allFiles = new Set<string>();

  for (const node of nodes) {
    const filePath = node.properties.filePath as string | undefined;
    if (!filePath || !isSourceCodeFilePath(filePath)) continue;
    allFiles.add(filePath);
    if (node.label === 'Function' || node.label === 'Method') {
      const existing = fileFunctions.get(filePath) ?? [];
      existing.push(node);
      fileFunctions.set(filePath, existing);
    }
  }

  for (const filePath of allFiles) {
    const componentDir = resolveComponentDir(filePath, sourceRoots);
    const componentPath = resolveComponentDirectory(filePath, sourceRoots);
    if (!componentDir || !componentPath) continue;

    const existing = groups.get(componentDir) ?? {
      directory: componentPath,
      files: [],
      functions: [],
    };
    if (!existing.files.includes(filePath)) {
      existing.files.push(filePath);
    }
    const fns = fileFunctions.get(filePath) ?? [];
    extendArray(existing.functions, fns);
    groups.set(componentDir, existing);
  }

  return groups;
}

function resolveComponentDir(filePath: string, sourceRoots: string[]): string | null {
  // Find which source root this file belongs to
  let relativePath = filePath;
  let rootPrefix = '';

  for (const root of sourceRoots) {
    if (filePath === root || filePath.startsWith(root + '/')) {
      relativePath = filePath.slice(root.length + 1);
      if (filePath === root) relativePath = filePath;
      rootPrefix = root;
      break;
    }
  }

  if (sourceRoots.length > 0 && !rootPrefix) {
    return null;
  }

  // Extract first meaningful directory level
  const parts = relativePath.split('/');
  if (parts.length <= 1) {
    if (rootPrefix === 'src') return null;
    if (rootPrefix.startsWith('packages/') || rootPrefix.startsWith('apps/') || rootPrefix.startsWith('libs/')) {
      const rootParts = rootPrefix.split('/');
      return rootParts[1] || deriveFlatComponentId(filePath);
    }
    if (rootPrefix.startsWith('cmd/')) {
      return rootPrefix.slice('cmd/'.length);
    }
    return deriveFlatComponentId(filePath);
  }

  // Root-aware component IDs:
  //   src/store/store.ts             -> store
  //   packages/core/src/llm/x.ts     -> core/llm
  //   cmd/server/main.go             -> server
  if (rootPrefix.startsWith('packages/') || rootPrefix.startsWith('apps/') || rootPrefix.startsWith('libs/')) {
    const rootParts = rootPrefix.split('/');
    const pkgName = rootParts[1];
    return parts.length > 1 ? `${pkgName}/${parts[0]}` : pkgName;
  }
  if (rootPrefix === 'src/main/java' || rootPrefix === 'src/main/kotlin') {
    return parts[parts.length - 2] ?? deriveFlatComponentId(filePath);
  }
  if (rootPrefix.startsWith('cmd/')) {
    return rootPrefix.slice('cmd/'.length);
  }
  return parts[0];
}

function resolveComponentDirectory(filePath: string, sourceRoots: string[]): string | null {
  let relativePath = filePath;
  let rootPrefix = '';

  for (const root of sourceRoots) {
    if (filePath === root || filePath.startsWith(root + '/')) {
      relativePath = filePath.slice(root.length + 1);
      if (filePath === root) relativePath = filePath;
      rootPrefix = root;
      break;
    }
  }

  if (sourceRoots.length > 0 && !rootPrefix) {
    return null;
  }

  const parts = relativePath.split('/');
  const fileDir = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : filePath;

  if (parts.length <= 1) {
    if (rootPrefix === 'src') return null;
    return fileDir;
  }

  if (rootPrefix.startsWith('packages/') || rootPrefix.startsWith('apps/') || rootPrefix.startsWith('libs/')) {
    return `${rootPrefix}/${parts[0]}`;
  }
  if (rootPrefix === 'src/main/java' || rootPrefix === 'src/main/kotlin') {
    return fileDir;
  }
  if (rootPrefix.startsWith('cmd/')) {
    return rootPrefix;
  }
  if (rootPrefix) {
    return `${rootPrefix}/${parts[0]}`;
  }
  return fileDir;
}

// ── Stats Computation ─────────────────────────────────────────────────────

function computeLeafStats(
  files: string[],
  functions: GraphNode[],
  complexityData: Record<string, FunctionComplexityEntry>,
): ArchitectureStats {
  const funcNodes = functions.filter(
    n => n.label === 'Function' || n.label === 'Method',
  );

  let totalCyclomatic = 0;
  let maxCyclomatic = 0;
  let maxNestingDepth = 0;

  for (const fn of funcNodes) {
    const filePath = fn.properties.filePath as string;
    const name = fn.properties.name as string;
    const key = `${filePath}:${name}`;
    const entry = complexityData[key];
    if (entry) {
      totalCyclomatic += entry.cyclomatic;
      maxCyclomatic = Math.max(maxCyclomatic, entry.cyclomatic);
      maxNestingDepth = Math.max(maxNestingDepth, entry.nestingDepth);
    }
  }

  const risk = computeLeafRisk(totalCyclomatic, maxCyclomatic, maxNestingDepth, files.length);

  return {
    file_count: files.length,
    function_count: funcNodes.length,
    total_cyclomatic: totalCyclomatic,
    max_cyclomatic: maxCyclomatic,
    max_nesting_depth: maxNestingDepth,
    risk_score: risk,
  };
}

function computeLeafRisk(
  _totalCyclomatic: number,
  maxCyclomatic: number,
  maxNesting: number,
  fileCount: number,
): number {
  // Risk = complexity_factor * size_factor
  // complexity_factor: max_cyclomatic * max_nesting (0-100)
  const complexityRaw = maxCyclomatic * maxNesting;
  const complexityFactor = Math.min(50, complexityRaw);
  // size_factor: file_count (scaled)
  const sizeFactor = Math.min(50, fileCount * 3);
  return Math.round(complexityFactor + sizeFactor);
}

function buildContractsAndFlows(
  functions: GraphNode[],
  edges: GraphEdge[],
  allNodes: GraphNode[],
  processes: ProcessData[],
): Pick<ArchitectureElement, 'contracts_provided' | 'contracts_consumed' | 'related_flows'> {
  const nodeIds = new Set(functions.map((fn) => fn.id));
  const nodeById = new Map<string, GraphNode>(allNodes.map((node) => [node.id, node]));
  const provided = new Set<string>();
  const consumed = new Set<string>();
  const relatedFlows = new Set<string>();

  for (const edge of edges) {
    if (edge.type !== 'CALLS') continue;
    const srcInside = nodeIds.has(edge.sourceId);
    const tgtInside = nodeIds.has(edge.targetId);
    if (srcInside === tgtInside) continue;

    const targetNode = nodeById.get(edge.targetId);
    const targetName = targetNode?.properties.name as string | undefined;
    if (!targetName) continue;

    if (tgtInside) provided.add(targetName);
    if (srcInside) consumed.add(targetName);
  }

  for (const proc of processes) {
    if (proc.steps.some((step) => nodeIds.has(step.nodeId))) {
      relatedFlows.add(proc.label || proc.id);
    }
  }

  return {
    contracts_provided: [...provided].sort(),
    contracts_consumed: [...consumed].sort(),
    related_flows: [...relatedFlows].sort(),
  };
}

function computeGroupStats(children: ArchitectureElement[]): ArchitectureStats {
  if (children.length === 0) {
    return { file_count: 0, function_count: 0, total_cyclomatic: 0, max_cyclomatic: 0, max_nesting_depth: 0, risk_score: 0 };
  }

  const fileCount = children.reduce((s, c) => s + c.stats.file_count, 0);
  const functionCount = children.reduce((s, c) => s + c.stats.function_count, 0);
  const totalCyclomatic = children.reduce((s, c) => s + c.stats.total_cyclomatic, 0);
  const maxCyclomatic = Math.max(...children.map(c => c.stats.max_cyclomatic));
  const maxNesting = Math.max(...children.map(c => c.stats.max_nesting_depth));

  // Weighted average risk by file_count
  let weightedRisk = 0;
  let totalWeight = 0;
  for (const child of children) {
    weightedRisk += child.stats.risk_score * child.stats.file_count;
    totalWeight += child.stats.file_count;
  }
  const riskScore = totalWeight > 0 ? Math.round(weightedRisk / totalWeight) : 0;

  return { file_count: fileCount, function_count: functionCount, total_cyclomatic: totalCyclomatic, max_cyclomatic: maxCyclomatic, max_nesting_depth: maxNesting, risk_score: riskScore };
}

// ── Edge Generation ───────────────────────────────────────────────────────

function generateEdges(
  edges: GraphEdge[],
  nodes: GraphNode[],
  _componentDirs: Map<string, DirectoryGroup>,
  sourceRoots: string[],
): ArchitectureEdge[] {
  // Build nodeId -> componentId mapping
  const nodeToComponent = new Map<string, string>();
  for (const node of nodes) {
    const filePath = node.properties.filePath as string | undefined;
    if (!filePath) continue;
    const compDir = resolveComponentDir(filePath, sourceRoots);
    if (compDir) nodeToComponent.set(node.id, compDir);
  }

  // Build nodeId -> node for fast lookup
  const nodeById = new Map<string, GraphNode>();
  for (const node of nodes) {
    nodeById.set(node.id, node);
  }

  // Count cross-component calls and collect function names
  const edgeMap = new Map<string, { count: number; functions: string[] }>();

  for (const edge of edges) {
    if (edge.type !== 'CALLS') continue;
    const fromComp = nodeToComponent.get(edge.sourceId);
    const toComp = nodeToComponent.get(edge.targetId);
    if (!fromComp || !toComp || fromComp === toComp) continue;

    const key = `${fromComp}\0${toComp}`;
    const existing = edgeMap.get(key) ?? { count: 0, functions: [] };
    existing.count++;

    // Get the target function name for the label
    const targetNode = nodeById.get(edge.targetId);
    const fnName = targetNode?.properties.name as string | undefined;
    if (fnName && !existing.functions.includes(fnName)) {
      existing.functions.push(fnName);
    }
    edgeMap.set(key, existing);
  }

  const result: ArchitectureEdge[] = [];
  for (const [key, { count, functions }] of edgeMap) {
    const [from, to] = key.split('\0');
    result.push({
      from,
      to,
      label: functions.slice(0, 3).join(', '),
      type: 'dependency',
      weight: count,
    });
  }

  return result;
}

// ── Leaf vs Group Decision ────────────────────────────────────────────────

const LEAF_FILE_THRESHOLD = 15;
const LEAF_COHESION_THRESHOLD = 0.7;

function decideKind(
  group: DirectoryGroup,
  edges: GraphEdge[],
  _allNodes: GraphNode[],
  depth: number,
): 'group' | 'leaf' {
  if (group.files.length <= LEAF_FILE_THRESHOLD) return 'leaf';
  if (depth >= 3) return 'leaf';

  // Compute cohesion: internal edges / total edges
  const nodeIds = new Set(group.functions.map(n => n.id));
  let internal = 0;
  let total = 0;
  for (const edge of edges) {
    const srcIn = nodeIds.has(edge.sourceId);
    const tgtIn = nodeIds.has(edge.targetId);
    if (srcIn || tgtIn) {
      total++;
      if (srcIn && tgtIn) internal++;
    }
  }
  const cohesion = total > 0 ? internal / total : 1;
  if (cohesion > LEAF_COHESION_THRESHOLD) return 'leaf';

  return 'group';
}

// ── Build Elements (recursive) ───────────────────────────────────────────

interface BuildResult {
  topLevel: ArchitectureElement[];
  docs: ArchitectureCompileResult['elementDocs'];
  mermaids: Map<string, string>;
}

function buildElements(
  parentPath: string,
  groups: Map<string, DirectoryGroup>,
  edges: GraphEdge[],
  allNodes: GraphNode[],
  complexityData: Record<string, FunctionComplexityEntry>,
  processes: ProcessData[],
  depth: number,
): BuildResult {
  const topLevel: ArchitectureElement[] = [];
  const docs: ArchitectureCompileResult['elementDocs'] = [];
  const mermaids = new Map<string, string>();

  for (const [dirName, group] of groups) {
    const fullPath = parentPath ? `${parentPath}/${dirName}` : dirName;
    let kind = decideKind(group, edges, allNodes, depth);
    const uniqueFiles = [...new Set(group.files)];
    const label = labelForId(dirName);

    const subGroups = kind === 'group' ? subdivideGroup(group) : new Map<string, DirectoryGroup>();

    if (kind === 'leaf') {
      const stats = computeLeafStats(uniqueFiles, group.functions, complexityData);
      const exportedFns = group.functions
        .filter(n => n.properties.isExported === true)
        .map(n => n.properties.name as string);
      const rel = buildContractsAndFlows(group.functions, edges, allNodes, processes);

      const element: ArchitectureElement = {
        id: dirName,
        label,
        kind: 'leaf',
        directory: group.directory,
        files: uniqueFiles,
        exported_functions: [...new Set(exportedFns)],
        contracts_provided: rel.contracts_provided,
        contracts_consumed: rel.contracts_consumed,
        related_flows: rel.related_flows,
        stats,
      };
      topLevel.push(element);
      docs.push({
        perspectiveId: 'overall-architecture',
        elementPath: fullPath,
        data: element,
      });
    } else {
      const childBuilt = buildElements(
        fullPath,
        subGroups,
        edges,
        allNodes,
        complexityData,
        processes,
        depth + 1,
      );

      const groupStats = computeGroupStats(childBuilt.topLevel);
      const groupElement: ArchitectureElement = {
        id: dirName,
        label,
        kind: 'group',
        directory: group.directory,
        children: childBuilt.topLevel.map((child) => child.id),
        stats: groupStats,
      };
      topLevel.push(groupElement);
      docs.push({
        perspectiveId: 'overall-architecture',
        elementPath: fullPath,
        data: groupElement,
      });
      extendArray(docs, childBuilt.docs);
      for (const [pathKey, mermaid] of childBuilt.mermaids) {
        mermaids.set(pathKey, mermaid);
      }
      mermaids.set(
        `overall-architecture/${fullPath}`,
        generateMermaid({
          id: fullPath,
          label: groupElement.label,
          components: childBuilt.topLevel,
          edges: generateInternalEdges(edges, childBuilt.topLevel, subGroups, allNodes),
        }),
      );
    }
  }

  return { topLevel, docs, mermaids };
}

function generateInternalEdges(
  edges: GraphEdge[],
  childElements: ArchitectureElement[],
  childGroups: Map<string, DirectoryGroup>,
  allNodes: GraphNode[],
): ArchitectureEdge[] {
  const elementIds = new Set(childElements.map((child) => child.id));
  const nodeToChild = new Map<string, string>();
  const nodeById = new Map<string, GraphNode>(allNodes.map((node) => [node.id, node]));
  for (const [childId, group] of childGroups) {
    for (const fn of group.functions) {
      nodeToChild.set(fn.id, childId);
    }
  }

  const result = new Map<string, ArchitectureEdge & { _labels?: string[] }>();
  for (const edge of edges) {
    if (edge.type !== 'CALLS') continue;
    const from = nodeToChild.get(edge.sourceId);
    const to = nodeToChild.get(edge.targetId);
    if (!from || !to || from === to || !elementIds.has(from) || !elementIds.has(to)) continue;
    const key = `${from}\0${to}`;
    const existing = result.get(key) ?? { from, to, label: '', type: 'dependency' as const, weight: 0, _labels: [] };
    existing.weight += 1;
    const targetNode = nodeById.get(edge.targetId);
    const targetName = targetNode?.properties.name as string | undefined;
    if (targetName && !existing._labels!.includes(targetName)) {
      existing._labels!.push(targetName);
    }
    result.set(key, existing);
  }
  return [...result.values()].map((edge) => ({
    from: edge.from,
    to: edge.to,
    label: edge._labels?.slice(0, 3).join(', ') ?? '',
    type: edge.type,
    weight: edge.weight,
  }));
}

/**
 * Subdivide a large group into sub-directories based on the next path segment
 * within the component directory.
 */
function subdivideGroup(group: DirectoryGroup): Map<string, DirectoryGroup> {
  const subGroups = new Map<string, DirectoryGroup>();

  // Group files by their next directory segment after the group directory
  for (const filePath of group.files) {
    const relative = filePath.startsWith(group.directory + '/')
      ? filePath.slice(group.directory.length + 1)
      : filePath;
    const parts = relative.split('/');
    // Use the next directory level, or a filename-derived bucket for direct files
    const subKey = parts.length > 1 ? parts[0] : deriveFlatComponentId(filePath);

    const existing = subGroups.get(subKey) ?? {
      directory: parts.length > 1 ? `${group.directory}/${subKey}` : group.directory,
      files: [],
      functions: [],
    };
    existing.files.push(filePath);
    subGroups.set(subKey, existing);
  }

  // Assign functions to sub-groups
  for (const fn of group.functions) {
    const fnFile = fn.properties.filePath as string;
    const relative = fnFile.startsWith(group.directory + '/')
      ? fnFile.slice(group.directory.length + 1)
      : fnFile;
    const parts = relative.split('/');
    const subKey = parts.length > 1 ? parts[0] : deriveFlatComponentId(fnFile);
    const sub = subGroups.get(subKey);
    if (sub) sub.functions.push(fn);
  }

  return subGroups;
}

// ── Mermaid Generation ────────────────────────────────────────────────────

function generateMermaid(perspective: PerspectiveData): string {
  const direction = perspective.id === 'data-flow' ? 'LR' : 'TD';
  const lines: string[] = [`graph ${direction}`];

  for (const comp of perspective.components) {
    const safeName = comp.id.replace(/[^a-zA-Z0-9_-]/g, '_');
    const label = `${comp.label}\\n${comp.directory}`;
    lines.push(`  ${safeName}["${label}"]`);
  }

  for (const edge of perspective.edges) {
    const fromSafe = edge.from.replace(/[^a-zA-Z0-9_-]/g, '_');
    const toSafe = edge.to.replace(/[^a-zA-Z0-9_-]/g, '_');
    const label = edge.label ? `|"${edge.label}"| ` : '';
    lines.push(`  ${fromSafe} -->${label}${toSafe}`);
  }

  return lines.join('\n');
}

// ── Main Compiler ─────────────────────────────────────────────────────────

export function compileArchitecture(
  projectName: string,
  nodes: GraphNode[],
  edges: GraphEdge[],
  _communities: CommunityData[],
  processes: ProcessData[],
  complexityData: Record<string, FunctionComplexityEntry> = {},
  options: { workspaceLayout?: WorkspaceLayoutScan | null } = {},
): ArchitectureCompileResult {
  // Step 0: Source root normalization
  const allFiles = [...new Set(
    nodes
      .map(n => n.properties.filePath as string | undefined)
      .filter((f): f is string => f !== undefined && isSourceCodeFilePath(f)),
  )];
  const sourceRootInventory = collectSourceRootInventory(allFiles, {
    workspaceLayout: options.workspaceLayout,
  });
  const sourceRoots = sourceRootInventory.selected_paths;

  // Step 1: Directory grouping
  const groups = groupByDirectory(nodes, sourceRoots);

  // Step 2-5: Build components recursively
  const built = buildElements('', groups, edges, nodes, complexityData, processes, 0);
  const components: ArchitectureElement[] = built.topLevel;
  const elementDocs: ArchitectureCompileResult['elementDocs'] = built.docs;

  // Step 3: Generate edges
  const archEdges = generateEdges(edges, nodes, groups, sourceRoots);

  // Build overall-architecture perspective
  const overallPerspective: PerspectiveData = {
    id: 'overall-architecture',
    label: 'Overall Architecture',
    components,
    edges: archEdges,
  };

  const perspectives: PerspectiveData[] = [overallPerspective];
  const mermaidByPath = new Map<string, string>();
  const descriptionsByPath = new Map<string, string>();
  mermaidByPath.set('overall-architecture', generateMermaid(overallPerspective));
  for (const [pathKey, mermaid] of built.mermaids) {
    mermaidByPath.set(pathKey, mermaid);
  }
  descriptionsByPath.set(
    'overall-architecture',
    `High-level architecture of ${projectName} with ${components.length} components and ${archEdges.length} cross-component dependencies.`,
  );
  for (const doc of elementDocs) {
    descriptionsByPath.set(`overall-architecture/${doc.elementPath}`, describeArchitectureElement(doc.data));
  }

  // Step 8: Additional perspectives
  if (processes.length > 0) {
    const dataFlowPerspective = buildDataFlowPerspective(
      processes, nodes, edges, groups, sourceRoots, complexityData,
    );
    perspectives.push(dataFlowPerspective);
    mermaidByPath.set('data-flow', generateMermaid(dataFlowPerspective));
    descriptionsByPath.set(
      'data-flow',
      `Execution and data flow view across ${dataFlowPerspective.components.length} components touched by detected processes.`,
    );
  }

  // Build struct hash for delta detection
  const hash = structHash({
    components: components.map(c => c.id).sort(),
    edges: archEdges.map(e => `${e.from}->${e.to}`).sort(),
  });

  const meta: ArchitectureMeta = {
    perspectives: perspectives.map(p => p.id),
    generated_at: new Date().toISOString(),
    mode: 'auto',
    struct_hash: hash,
  };

  return { meta, perspectives, elementDocs, mermaidByPath, descriptionsByPath, sourceRootInventory };
}

function describeArchitectureElement(element: ArchitectureElement): string {
  if (element.kind === 'group') {
    const childList = (element.children ?? []).slice(0, 6).map(labelForId).join(', ');
    return childList
      ? `${element.label} groups related architecture areas under ${element.directory}: ${childList}.`
      : `${element.label} groups related architecture areas under ${element.directory}.`;
  }

  const parts: string[] = [];
  const functions = (element.exported_functions ?? []).slice(0, 6);
  const provided = (element.contracts_provided ?? []).slice(0, 6);
  const consumed = (element.contracts_consumed ?? []).slice(0, 6);
  const flows = (element.related_flows ?? []).slice(0, 4);

  if (provided.length > 0) {
    parts.push(`provides ${provided.join(', ')}`);
  } else if (functions.length > 0) {
    parts.push(`defines ${functions.join(', ')}`);
  }
  if (consumed.length > 0) {
    parts.push(`uses ${consumed.join(', ')}`);
  }
  if (flows.length > 0) {
    parts.push(`participates in ${flows.join(', ')}`);
  }

  if (parts.length === 0) {
    return `${element.label} is a source-backed architecture element under ${element.directory}.`;
  }

  return `${element.label} ${parts.join('; ')}.`;
}

function buildDataFlowPerspective(
  processes: ProcessData[],
  nodes: GraphNode[],
  _edges: GraphEdge[],
  groups: Map<string, DirectoryGroup>,
  sourceRoots: string[],
  complexityData: Record<string, FunctionComplexityEntry>,
): PerspectiveData {
  // Collect components touched by processes
  const touchedComponents = new Set<string>();
  const processEdges: ArchitectureEdge[] = [];

  for (const proc of processes) {
    let prevComp: string | null = null;
    for (const step of proc.steps) {
      const node = nodes.find(n => n.id === step.nodeId);
      if (!node) continue;
      const filePath = node.properties.filePath as string | undefined;
      if (!filePath) continue;
      const comp = resolveComponentDir(filePath, sourceRoots);
      if (!comp) continue;

      touchedComponents.add(comp);

      if (prevComp && prevComp !== comp) {
        processEdges.push({
          from: prevComp,
          to: comp,
          label: proc.label || proc.id,
          type: 'data_flow',
          weight: 1,
        });
      }
      prevComp = comp;
    }
  }

  // Build components for touched directories only
  const components: ArchitectureElement[] = [];
  for (const dirName of touchedComponents) {
    const group = groups.get(dirName);
    if (!group) continue;
    const stats = computeLeafStats(group.files, group.functions, complexityData);
    components.push({
      id: dirName,
      label: dirName.charAt(0).toUpperCase() + dirName.slice(1),
      kind: 'leaf',
      directory: group.directory,
      files: [...new Set(group.files)],
      stats,
    });
  }

  // Deduplicate edges
  const edgeKeys = new Set<string>();
  const dedupedEdges: ArchitectureEdge[] = [];
  for (const edge of processEdges) {
    const key = `${edge.from}\0${edge.to}`;
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    dedupedEdges.push(edge);
  }

  return {
    id: 'data-flow',
    label: 'Data Flow',
    components,
    edges: dedupedEdges,
  };
}
