import fs from 'node:fs';
import path from 'node:path';
import { CotxStore } from '../store/store.js';
import { CotxGraph } from '../query/graph-index.js';
import type { ModuleNode, ContractNode, FlowNode, ConcernNode } from '../store/schema.js';
import { generateOverviewHtml } from '../viz/overview-template.js';
import { ArchitectureStore } from '../store/architecture-store.js';
import { extendArray } from '../core/shared/array-utils.js';

const TOKEN_LIMITS = {
  overview: 1500,
  module: 1000,
  flow: 800,
};

/** Max dependencies to show inline in overview table */
const MAX_DEPS_INLINE = 5;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export async function commandMap(
  projectRoot: string,
  options: { scope?: string; depth?: number },
): Promise<void> {
  const store = new CotxStore(projectRoot);
  if (!store.exists()) {
    console.log('No .cotx/ found. Run: cotx compile');
    return;
  }

  const scope = options.scope ?? 'overview';
  const depth = options.depth ?? 2;
  const markdown = generateMapSummary(store, scope, depth);
  console.log(markdown);
}

// Exported for MCP tool use
export function generateMapSummary(store: CotxStore, scope: string, depth: number): string {
  if (scope === 'overview') {
    return generateOverview(store, depth);
  } else if (scope === 'architecture') {
    return generateArchitectureSummary(store, depth);
  } else if (scope.startsWith('module:')) {
    const moduleId = scope.slice('module:'.length);
    return generateModuleSummary(store, moduleId, depth);
  } else if (scope.startsWith('flow:')) {
    const flowId = scope.slice('flow:'.length);
    return generateFlowSummary(store, flowId, depth);
  } else {
    return `Unknown scope: ${scope}. Use: overview, architecture, module:<id>, or flow:<id>`;
  }
}

function renderRecentChangeSummary(store: CotxStore): string[] {
  const summary = store.readLatestChangeSummary();
  if (!summary) return [];

  const lines: string[] = [];
  lines.push('### Recent Changes');
  if (summary.changed_files.length > 0) {
    lines.push(`- Files: ${summary.changed_files.join(', ')}`);
  }
  for (const symbol of summary.symbols.added.slice(0, 5)) {
    lines.push(`- Added symbol: [${symbol.label}] ${symbol.id}`);
  }
  for (const layer of summary.layers.changed.slice(0, 5)) {
    const changes = layer.changes?.length ? ` (${layer.changes.join(', ')})` : '';
    lines.push(`- Changed ${layer.layer}: ${layer.id}${changes}`);
  }
  return lines.length > 1 ? lines : [];
}

function renderStaleSummary(store: CotxStore): string[] {
  const summary = store.readLatestChangeSummary();
  if (!summary) return [];
  if (summary.stale.enrichments.length === 0 && summary.stale.annotations.length === 0) {
    return [];
  }

  const lines: string[] = [];
  lines.push('### Stale Explanations');
  for (const item of summary.stale.enrichments.slice(0, 5)) {
    lines.push(`- Enrichment stale: [${item.layer}] ${item.nodeId} — ${item.reason ?? 'stale'}`);
  }
  for (const item of summary.stale.annotations.slice(0, 5)) {
    lines.push(`- Annotation stale: [${item.layer}] ${item.nodeId}#${item.annotationIndex} — ${item.reason}`);
  }
  return lines;
}

function generateOverview(store: CotxStore, depth: number): string {
  const meta = store.readMeta();
  const graph = CotxGraph.fromStore(store);

  // Load all modules with file counts
  const modules: Array<{ id: string; mod: ModuleNode }> = graph
    .allNodes('module')
    .map((node) => ({ id: node.id, mod: node.data as ModuleNode }));

  // Sort by file count descending for truncation purposes
  modules.sort((a, b) => (b.mod.files?.length ?? 0) - (a.mod.files?.length ?? 0));

  const lines: string[] = [];
  lines.push(`## Project: ${meta.project}`);
  lines.push('');

  // Build module table
  lines.push(`### Modules (${modules.length})`);

  if (depth === 1) {
    // Minimal: just names and file counts
    lines.push('| Module | Files |');
    lines.push('|--------|-------|');
    for (const { id, mod } of modules) {
      lines.push(`| ${id} | ${mod.files?.length ?? 0} |`);
    }
  } else if (depth >= 2) {
    // Add dependencies and responsibility
    lines.push('| Module | Files | Responsibility | Dependencies |');
    lines.push('|--------|-------|---------------|-------------|');
    for (const { id, mod } of modules) {
      const allDeps = mod.depends_on ?? [];
      const shownDeps = allDeps.slice(0, MAX_DEPS_INLINE).join(', ');
      const depsCell = allDeps.length > MAX_DEPS_INLINE
        ? `→ ${shownDeps}, +${allDeps.length - MAX_DEPS_INLINE}`
        : allDeps.length > 0 ? `→ ${shownDeps}` : '—';
      const resp = mod.enriched?.responsibility ?? (mod.enriched as Record<string, unknown> | undefined)?.auto_description as string ?? '—';
      lines.push(`| ${id} | ${mod.files?.length ?? 0} | ${resp} | ${depsCell} |`);
    }
  }

  // Key constraints from annotations (depth >= 2)
  if (depth >= 2) {
    const constraints: string[] = [];
    for (const { mod } of modules) {
      if (mod.annotations) {
        for (const ann of mod.annotations) {
          if (ann.type === 'constraint' && !ann.stale) {
            constraints.push(ann.content);
          }
        }
      }
    }
    if (constraints.length > 0) {
      lines.push('');
      lines.push('### Key Constraints');
      for (const c of constraints) {
        lines.push(`- ${c}`);
      }
    }
  }

  // Concept counts per module (depth >= 3)
  if (depth >= 3) {
    const conceptsByModule = new Map<string, number>();
    for (const node of graph.allNodes('concept')) {
      const concept = node.data as { layer?: string };
      const modId = concept.layer;
      if (modId) {
        conceptsByModule.set(modId, (conceptsByModule.get(modId) ?? 0) + 1);
      }
    }
    if (conceptsByModule.size > 0) {
      lines.push('');
      lines.push('### Concept Distribution');
      for (const [modId, count] of [...conceptsByModule.entries()].sort((a, b) => b[1] - a[1])) {
        lines.push(`- ${modId}: ${count} concept${count !== 1 ? 's' : ''}`);
      }
    }
  }

  // Active concerns
  const concernIds = store.listConcerns();
  const activeConcerns: ConcernNode[] = [];
  for (const cid of concernIds) {
    activeConcerns.push(store.readConcern(cid));
  }
  if (activeConcerns.length > 0) {
    lines.push('');
    lines.push('### Active Concerns');
    for (const c of activeConcerns) {
      lines.push(`- [${c.type}] ${c.description} (${c.severity})`);
    }
  }

  const recentChanges = renderRecentChangeSummary(store);
  if (recentChanges.length > 0) {
    lines.push('');
    extendArray(lines, recentChanges);
  }

  const staleSummary = renderStaleSummary(store);
  if (staleSummary.length > 0) {
    lines.push('');
    extendArray(lines, staleSummary);
  }

  lines.push('');
  lines.push(
    `Compiled: ${meta.compiled_at} | Resolution: ${meta.module_resolution}`,
  );

  let result = lines.join('\n');

  // Enforce token budget: truncate to top modules by file count
  const limit = TOKEN_LIMITS.overview * 4; // chars
  if (result.length > limit) {
    // Keep reducing modules until we fit
    let truncated = modules.length;
    while (result.length > limit && truncated > 1) {
      truncated = Math.floor(truncated * 0.75);
      const reducedModules = modules.slice(0, truncated);
      const truncLines: string[] = [];
      truncLines.push(`## Project: ${meta.project}`);
      truncLines.push('');
      truncLines.push(`### Modules (${modules.length}, showing top ${truncated} by file count)`);

      if (depth === 1) {
        truncLines.push('| Module | Files |');
        truncLines.push('|--------|-------|');
        for (const { id, mod } of reducedModules) {
          truncLines.push(`| ${id} | ${mod.files?.length ?? 0} |`);
        }
      } else {
        truncLines.push('| Module | Files | Responsibility | Dependencies |');
        truncLines.push('|--------|-------|---------------|-------------|');
        for (const { id, mod } of reducedModules) {
          const allDeps = mod.depends_on ?? [];
          const shownDeps = allDeps.slice(0, MAX_DEPS_INLINE).join(', ');
          const depsCell = allDeps.length > MAX_DEPS_INLINE
            ? `→ ${shownDeps}, +${allDeps.length - MAX_DEPS_INLINE}`
            : allDeps.length > 0 ? `→ ${shownDeps}` : '—';
          const resp = mod.enriched?.responsibility ?? (mod.enriched as Record<string, unknown> | undefined)?.auto_description as string ?? '—';
          truncLines.push(`| ${id} | ${mod.files?.length ?? 0} | ${resp} | ${depsCell} |`);
        }
      }

      truncLines.push('');
      truncLines.push(`Compiled: ${meta.compiled_at} | Resolution: ${meta.module_resolution}`);
      result = truncLines.join('\n');
    }
  }

  return result;
}

function generateArchitectureSummary(store: CotxStore, depth: number): string {
  const archStore = new ArchitectureStore(store.projectRoot);
  if (!archStore.exists()) {
    return 'No architecture data. Run: cotx compile';
  }

  const meta = store.readMeta();
  const lines: string[] = [];
  lines.push(`## Architecture: ${meta.project}`);
  lines.push('');

  const workspaceLayout = store.readWorkspaceLayout();
  if (workspaceLayout) {
    const assetDirs = workspaceLayout.summary.asset_dirs ?? 0;
    lines.push('### Workspace Layout');
    lines.push(
      `${workspaceLayout.summary.repo_boundaries} repo boundary/boundaries, ` +
      `${workspaceLayout.summary.packages} package boundary/boundaries, ` +
      `${workspaceLayout.summary.docs_dirs} docs director${workspaceLayout.summary.docs_dirs === 1 ? 'y' : 'ies'}, ` +
      `${assetDirs} asset director${assetDirs === 1 ? 'y' : 'ies'}, ` +
      `${workspaceLayout.summary.candidates} candidate input(s).`,
    );
    if (depth >= 2) {
      const packageDirs = workspaceLayout.directories
        .filter((entry) => entry.kind === 'package')
        .map((entry) => entry.path)
        .slice(0, 8);
      const assetDirectories = workspaceLayout.directories
        .filter((entry) => entry.kind === 'asset')
        .map((entry) => entry.path)
        .slice(0, 8);
      if (packageDirs.length > 0) {
        lines.push(`Packages: ${packageDirs.join(', ')}`);
      }
      if (assetDirectories.length > 0) {
        lines.push(`Assets: ${assetDirectories.join(', ')}`);
      }
    }
    lines.push('');
  }

  for (const perspectiveId of archStore.listPerspectives()) {
    const perspective = archStore.readPerspective(perspectiveId);
    lines.push(`### ${perspective.label}`);
    lines.push(archStore.readDescription(perspectiveId) ?? `Perspective ${perspective.label} with ${perspective.components.length} components.`);
    lines.push('');
    const maxComponents = depth >= 2 ? Math.min(perspective.components.length, 8) : Math.min(perspective.components.length, 5);
    for (const component of perspective.components.slice(0, maxComponents)) {
      const desc = archStore.readDescription(`${perspectiveId}/${component.id}`)
        ?? `${component.label} owns code under ${component.directory}.`;
      lines.push(`- ${component.label}: ${desc}`);
    }
    if (perspective.components.length > maxComponents) {
      lines.push(`- ... and ${perspective.components.length - maxComponents} more components`);
    }
    if (depth >= 2 && perspective.edges.length > 0) {
      lines.push('');
      lines.push('#### Key Edges');
      for (const edge of perspective.edges.slice(0, 8)) {
        const label = edge.label ? ` (${edge.label})` : '';
        lines.push(`- ${edge.from} -> ${edge.to}${label}`);
      }
    }
    lines.push('');
  }

  const recentChanges = renderRecentChangeSummary(store);
  if (recentChanges.length > 0) {
    extendArray(lines, recentChanges);
    lines.push('');
  }

  const staleSummary = renderStaleSummary(store);
  if (staleSummary.length > 0) {
    extendArray(lines, staleSummary);
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

function generateModuleSummary(store: CotxStore, moduleId: string, depth: number): string {
  const graph = CotxGraph.fromStore(store);
  const moduleNodes = graph.allNodes('module');
  const moduleNode = moduleNodes.find((node) => node.id === moduleId);
  if (!moduleNode) {
    return `Module "${moduleId}" not found. Available modules: ${moduleNodes.map((node) => node.id).join(', ')}`;
  }

  const mod = moduleNode.data as ModuleNode;
  const lines: string[] = [];

  lines.push(`## Module: ${moduleId}`);
  lines.push('');
  if (mod.enriched?.responsibility) {
    lines.push(`> ${mod.enriched.responsibility}`);
    lines.push('');
  }
  lines.push(`Entry: ${mod.canonical_entry}`);
  lines.push(`Files: ${mod.files?.length ?? 0}`);

  const deps = (mod.depends_on ?? []).join(', ');
  lines.push(`Dependencies: ${deps.length > 0 ? `→ ${deps}` : '—'}`);

  const revDeps = (mod.depended_by ?? []).join(', ');
  lines.push(`Depended by: ${revDeps.length > 0 ? `← ${revDeps}` : '—'}`);

  // Contracts involving this module
  const relatedContracts: ContractNode[] = [];
  for (const node of graph.allNodes('contract')) {
    const contract = node.data as ContractNode;
    if (contract.provider === moduleId || contract.consumer === moduleId) {
      relatedContracts.push(contract);
    }
  }

  if (relatedContracts.length > 0) {
    lines.push('');
    lines.push('### Contracts');
    const maxContracts = depth >= 2 ? 10 : 5;
    for (const contract of relatedContracts.slice(0, maxContracts)) {
      const iface = contract.interface.slice(0, 5).join(', ');
      const ifaceStr = contract.interface.length > 5
        ? `${iface}, ...+${contract.interface.length - 5}`
        : iface;
      lines.push(`- ${contract.consumer} → ${contract.provider}: ${ifaceStr}`);
    }
    if (relatedContracts.length > maxContracts) {
      lines.push(`- ... and ${relatedContracts.length - maxContracts} more contracts`);
    }
  }

  // Concepts owned by this module
  const ownedConcepts: string[] = [];
  for (const node of graph.allNodes('concept')) {
    const concept = node.data as { layer?: string };
    if (concept.layer === moduleId) {
      ownedConcepts.push(node.id);
    }
  }

  if (ownedConcepts.length > 0) {
    lines.push('');
    lines.push('### Concepts');
    const maxConcepts = depth >= 3 ? ownedConcepts.length : 10;
    const shown = ownedConcepts.slice(0, maxConcepts);
    lines.push(`- ${shown.join(', ')}${ownedConcepts.length > maxConcepts ? `, ...+${ownedConcepts.length - maxConcepts}` : ''}`);
  }

  // Concerns affecting this module
  const concernIds = store.listConcerns();
  const affectingConcerns: ConcernNode[] = [];
  for (const cid of concernIds) {
    const concern = store.readConcern(cid);
    if ((concern.affected_modules ?? []).includes(moduleId)) {
      affectingConcerns.push(concern);
    }
  }

  if (affectingConcerns.length > 0) {
    lines.push('');
    lines.push('### Concerns');
    for (const c of affectingConcerns) {
      lines.push(`- [${c.type}] ${c.description} (${c.severity})`);
    }
  }

  // Annotations on the module
  if (mod.annotations && mod.annotations.length > 0) {
    lines.push('');
    lines.push('### Annotations');
    for (const ann of mod.annotations) {
      const staleTag = ann.stale ? ' [STALE]' : '';
      lines.push(`- [${ann.type}] ${ann.content} (${ann.author}, ${ann.date})${staleTag}`);
    }
  }

  let result = lines.join('\n');

  // Enforce token budget
  const limit = TOKEN_LIMITS.module * 4;
  if (result.length > limit) {
    // Truncate: remove file-heavy sections first, cap contracts at 5
    const truncLines: string[] = [];
    truncLines.push(`## Module: ${moduleId}`);
    truncLines.push('');
    truncLines.push(`Entry: ${mod.canonical_entry}`);
    truncLines.push(`Files: ${mod.files?.length ?? 0}`);
    truncLines.push(`Dependencies: ${deps.length > 0 ? `→ ${deps}` : '—'}`);
    truncLines.push(`Depended by: ${revDeps.length > 0 ? `← ${revDeps}` : '—'}`);

    if (relatedContracts.length > 0) {
      truncLines.push('');
      truncLines.push('### Contracts');
      for (const contract of relatedContracts.slice(0, 5)) {
        const iface = contract.interface.slice(0, 3).join(', ');
        truncLines.push(`- ${contract.consumer} → ${contract.provider}: ${iface}`);
      }
      if (relatedContracts.length > 5) {
        truncLines.push(`- ... and ${relatedContracts.length - 5} more`);
      }
    }

    result = truncLines.join('\n');
  }

  return result;
}

function generateFlowSummary(store: CotxStore, flowId: string, depth: number): string {
  const graph = CotxGraph.fromStore(store);
  const flowNodes = graph.allNodes('flow');
  const flowNode = flowNodes.find((node) => node.id === flowId);
  if (!flowNode) {
    return `Flow "${flowId}" not found. Available flows: ${flowNodes.map((node) => node.id).join(', ')}`;
  }

  const flow = flowNode.data as FlowNode;
  const lines: string[] = [];

  lines.push(`## Flow: ${flowId}`);
  lines.push('');

  if (flow.type === 'flow') {
    lines.push(`Trigger: ${flow.trigger ?? '—'}`);
    lines.push(`Type: flow`);

    if (flow.steps && flow.steps.length > 0) {
      lines.push('');
      lines.push('### Steps');
      const maxSteps = depth >= 3 ? flow.steps.length : depth >= 2 ? 20 : 10;
      for (let i = 0; i < Math.min(flow.steps.length, maxSteps); i++) {
        const step = flow.steps[i];
        const action = step.action ? `: ${step.action}` : '';
        lines.push(`${i + 1}. ${step.module}.${step.function}${action}`);
      }
      if (flow.steps.length > maxSteps) {
        lines.push(`... and ${flow.steps.length - maxSteps} more steps`);
      }
    }

    // Error paths from enrichment
    const errorPaths = normalizeErrorPaths(flow.enriched?.error_paths);
    if (errorPaths.length > 0) {
      lines.push('');
      lines.push('### Error Paths');
      for (const ep of errorPaths) {
        lines.push(`- ${ep.condition}: ${ep.behavior}`);
      }
    }
  } else if (flow.type === 'state_machine') {
    lines.push(`Owner: ${flow.owner_module ?? '—'}`);
    lines.push(`State field: ${flow.state_field ?? '—'}`);
    lines.push(`Type: state_machine`);

    if (flow.states && flow.states.length > 0) {
      lines.push('');
      lines.push('### States');
      for (const s of flow.states) {
        lines.push(`- ${s.id} (${s.source})`);
      }
    }

    if (flow.transitions && flow.transitions.length > 0) {
      lines.push('');
      lines.push('### Transitions');
      const maxTransitions = depth >= 2 ? 20 : 10;
      for (const t of flow.transitions.slice(0, maxTransitions)) {
        lines.push(`- ${t.from} → ${t.to} via ${t.trigger}`);
      }
      if (flow.transitions.length > maxTransitions) {
        lines.push(`- ... and ${flow.transitions.length - maxTransitions} more`);
      }
    }

    // Guards from enrichment
    if (flow.enriched?.guards && flow.enriched.guards.length > 0) {
      lines.push('');
      lines.push('### Guards');
      for (const g of flow.enriched.guards) {
        lines.push(`- ${g.transition}: ${g.condition}`);
      }
    }
  }

  // Annotations
  if (flow.annotations && flow.annotations.length > 0) {
    lines.push('');
    lines.push('### Annotations');
    for (const ann of flow.annotations) {
      const staleTag = ann.stale ? ' [STALE]' : '';
      lines.push(`- [${ann.type}] ${ann.content} (${ann.author}, ${ann.date})${staleTag}`);
    }
  }

  let result = lines.join('\n');

  // Enforce token budget: truncate steps
  const limit = TOKEN_LIMITS.flow * 4;
  if (result.length > limit && flow.steps && flow.steps.length > 0) {
    const truncLines: string[] = [];
    truncLines.push(`## Flow: ${flowId}`);
    truncLines.push('');
    truncLines.push(`Trigger: ${flow.trigger ?? '—'}`);
    truncLines.push(`Type: flow`);
    truncLines.push('');
    truncLines.push('### Steps');

    // Binary-search for how many steps fit
    let maxSteps = 10;
    let candidate = '';
    while (maxSteps > 1) {
      truncLines.length = 6; // reset after header lines
      for (let i = 0; i < Math.min(flow.steps.length, maxSteps); i++) {
        const step = flow.steps[i];
        const action = step.action ? `: ${step.action}` : '';
        truncLines.push(`${i + 1}. ${step.module}.${step.function}${action}`);
      }
      if (flow.steps.length > maxSteps) {
        truncLines.push(`... and ${flow.steps.length - maxSteps} more steps`);
      }
      candidate = truncLines.join('\n');
      if (candidate.length <= limit) break;
      maxSteps = Math.floor(maxSteps * 0.7);
    }
    result = candidate || truncLines.join('\n');
  }

  return result;
}

function normalizeErrorPaths(
  value: unknown,
): Array<{ condition: string; behavior: string }> {
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is { condition: string; behavior: string } =>
        Boolean(item) &&
        typeof item === 'object' &&
        typeof (item as Record<string, unknown>).condition === 'string' &&
        typeof (item as Record<string, unknown>).behavior === 'string',
    );
  }

  if (typeof value === 'string') {
    try {
      return normalizeErrorPaths(JSON.parse(value));
    } catch {
      return [];
    }
  }

  return [];
}

export function getOpenCommand(
  platform: NodeJS.Platform,
  outPath: string,
): { command: string; args: string[] } {
  if (platform === 'darwin') {
    return { command: 'open', args: [outPath] };
  }

  if (platform === 'win32') {
    return {
      command: process.env.ComSpec ?? 'cmd.exe',
      args: ['/c', 'start', '', outPath],
    };
  }

  return { command: 'xdg-open', args: [outPath] };
}

export async function commandMapHtml(
  projectRoot: string,
  options: { out?: string; noOpen?: boolean },
): Promise<void> {
  const store = new CotxStore(projectRoot);
  if (!store.exists()) {
    console.log('No .cotx/ found. Run: cotx compile');
    return;
  }

  const html = generateOverviewHtml(projectRoot);
  const outPath = options.out ?? path.join(projectRoot, '.cotx', 'map.html');

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html, 'utf-8');
  console.log(`Map written to ${outPath}`);

  if (!options.noOpen) {
    const { execFile } = await import('node:child_process');
    const openCommand = getOpenCommand(process.platform, outPath);
    execFile(openCommand.command, openCommand.args, (err) => {
      if (err) console.log(`Open manually: ${outPath}`);
    });
  }
}
