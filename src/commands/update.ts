import { CotxStore } from '../store/store.js';
import { detectDelta } from '../compiler/delta-detector.js';
import { compileModules } from '../compiler/module-compiler.js';
import { compileConcepts } from '../compiler/concept-compiler.js';
import { compileContracts } from '../compiler/contract-compiler.js';
import { compileFlows } from '../compiler/flow-compiler.js';
import {
  applyAutoDescriptionsToModules,
  applyAutoDescriptionsToConcepts,
  applyAutoDescriptionsToContracts,
  applyAutoDescriptionsToFlows,
} from '../compiler/auto-describe.js';
import { detectStale } from '../compiler/stale-detector.js';
import {
  exportGraphToJsonLines,
  exportCommunitiesToJsonLines,
  exportProcessesToJsonLines,
} from '../core/export/json-exporter.js';
import { runPipelineFromRepo } from '../core/parser/pipeline.js';
import {
  bridgeNodes,
  bridgeEdges,
  bridgeCommunities,
  bridgeProcesses,
} from '../core/bridge.js';
import { rebuildDerivedIndex } from '../store/derived-index.js';
import { CotxGraph } from '../query/graph-index.js';
import { execSync } from 'node:child_process';
import { captureGitFingerprint } from '../lib/git.js';
import { IncrementalCache, buildEngineVersion } from '../compiler/incremental-cache.js';
import { compileArchitecture } from '../compiler/architecture-compiler.js';
import { ArchitectureStore } from '../store/architecture-store.js';
import { scanWorkspaceLayout } from '../compiler/workspace-scan.js';
import fs from 'node:fs';
import path from 'node:path';
import { buildChangeSummary, printChangeSummary, readGraphNodesFile } from '../compiler/change-summary.js';
import { compileDoctrine } from '../compiler/doctrine-compiler.js';
import { buildDecisionInputs } from '../compiler/decision-inputs.js';
import { buildConcernFamilies } from '../compiler/concern-family-builder.js';
import { compileCanonicalPaths } from '../compiler/canonical-path-compiler.js';
import { buildSymmetryEdges } from '../compiler/symmetry-engine.js';
import { analyzeCochange } from '../compiler/cochange-analyzer.js';
import { buildClosureSets } from '../compiler/closure-engine.js';
import { detectAbstractionOpportunities } from '../compiler/abstraction-opportunity.js';
import { writeStorageV2 } from '../store-v2/write-storage-v2.js';
import {
  collectChangedIds,
  markStaleAnnotationsInNodes,
  preserveSemanticZones,
  readPreviousSemanticLayers,
  structHashMap,
} from '../compiler/semantic-zones.js';
import {
  runIncrementalSemanticEnrichment,
  type IncrementalEnrichmentExecution,
} from '../compiler/compile-bootstrap.js';
import type { IncrementalEnrichPolicy } from '../store/schema.js';

function snapshotArchitectureSidecars(projectRoot: string): {
  descriptions: Map<string, string>;
  diagrams: Map<string, string>;
  mode?: 'auto' | 'llm' | 'agent';
} {
  const archStore = new ArchitectureStore(projectRoot);
  const descriptions = new Map<string, string>();
  const diagrams = new Map<string, string>();

  if (!archStore.exists()) {
    return { descriptions, diagrams };
  }

  for (const archPath of archStore.listAllPaths()) {
    const desc = archStore.readDescription(archPath);
    if (desc !== null) descriptions.set(archPath, desc);
    const diagram = archStore.readDiagram(archPath);
    if (diagram !== null) diagrams.set(archPath, diagram);
  }

  return { descriptions, diagrams, mode: archStore.readMeta().mode };
}

function shouldPreserveArchitectureDescription(
  previousArchitecture: { mode?: 'auto' | 'llm' | 'agent' },
  content: string,
): boolean {
  if (previousArchitecture.mode === undefined || previousArchitecture.mode === 'auto') return false;
  return !isGeneratedArchitecturePlaceholder(content);
}

function isGeneratedArchitecturePlaceholder(content: string): boolean {
  const trimmed = content.trim();
  return /\bowns code under\b.*\bexposes \d+ exported functions\b/i.test(trimmed) ||
    /\bgroups \d+ child elements under\b/i.test(trimmed);
}

export async function commandUpdate(
  projectRoot: string,
  files?: string[],
  options?: { silent?: boolean; enrichPolicy?: IncrementalEnrichPolicy },
): Promise<{
  updatedModules: number;
  updatedContracts: number;
  updatedFlows: number;
  staleEnrichments: number;
  incrementalEnrichment?: IncrementalEnrichmentExecution | null;
}> {
  const store = new CotxStore(projectRoot);
  const log = options?.silent ? (() => {}) : console.log.bind(console);

  if (!store.exists()) {
    log('No .cotx/ found. Run: cotx compile');
    return { updatedModules: 0, updatedContracts: 0, updatedFlows: 0, staleEnrichments: 0, incrementalEnrichment: null };
  }

  // Detect changed files
  let changedFiles = files ?? [];
  if (changedFiles.length === 0) {
    // Auto-detect from git diff (unstaged + staged)
    try {
      const diff = execSync('git diff --name-only HEAD', { cwd: projectRoot, encoding: 'utf-8' });
      const staged = execSync('git diff --cached --name-only', { cwd: projectRoot, encoding: 'utf-8' });
      changedFiles = [
        ...new Set([
          ...diff.trim().split('\n'),
          ...staged.trim().split('\n'),
        ]),
      ].filter(Boolean);
    } catch {
      log(
        'Could not detect changed files from git. Specify files explicitly: cotx update <file1> <file2>',
      );
      return { updatedModules: 0, updatedContracts: 0, updatedFlows: 0, staleEnrichments: 0, incrementalEnrichment: null };
    }
  }

  if (changedFiles.length === 0) {
    log('No changed files detected.');
    return { updatedModules: 0, updatedContracts: 0, updatedFlows: 0, staleEnrichments: 0, incrementalEnrichment: null };
  }

  log(`Updating ${changedFiles.length} changed file(s)...`);
  const startTime = Date.now();
  const previousGraphNodes = readGraphNodesFile(path.join(projectRoot, '.cotx', 'graph', 'nodes.json'));

  // Find affected nodes BEFORE recompile (uses current store state)
  const delta = detectDelta(store, changedFiles);
  const previousSemantic = readPreviousSemanticLayers(store);
  const previousModules = previousSemantic.modules;
  const previousConcepts = previousSemantic.concepts;
  const previousContracts = previousSemantic.contracts;
  const previousFlows = previousSemantic.flows;
  const previousModuleHashes = structHashMap(previousModules);
  const previousConceptHashes = structHashMap(previousConcepts);
  const previousContractHashes = structHashMap(previousContracts);
  const previousFlowHashes = structHashMap(previousFlows);

  if (delta.affectedModules.length === 0) {
    log('No previously claimed semantic nodes matched. Continuing full refresh to catch new or moved files.');
  }

  // Phase D step 4-6: delta mode reuses the Phase D parse cache so files
  // not in `changedFiles` skip the Tree-sitter parse entirely. The cache
  // persists across compile/update invocations, so a typical delta update
  // touches only the changed file count (usually 1-10 files) rather than
  // reparsing the whole repo.
  const pkgVersion = '0.1.0';
  const engineVersion = buildEngineVersion(pkgVersion, 'tree-sitter-v1');
  const incrementalCache = new IncrementalCache(projectRoot, engineVersion);
  const result = await runPipelineFromRepo(
    projectRoot,
    (p) => {
      if (!options?.silent && p.message) process.stdout.write(`\r  ${p.message}`);
    },
    { incrementalCache },
  );
  if (!options?.silent) {
    process.stdout.write('\n');
    const cacheStats = incrementalCache.getStats();
    if (cacheStats.hits > 0 || cacheStats.misses > 0) {
      const ratio = cacheStats.hits / Math.max(1, cacheStats.hits + cacheStats.misses);
      log(
        `  Parse cache: ${cacheStats.hits} hits / ${cacheStats.misses} misses (${Math.round(ratio * 100)}% hit rate)`,
      );
    }
  }
  incrementalCache.close();

  const nodes = bridgeNodes(result.graph);
  const edges = bridgeEdges(result.graph);
  const communities = bridgeCommunities(result.communityResult);
  const processes = bridgeProcesses(result.processResult);
  const compiledAt = new Date().toISOString();

  // Recompile all layers (needed for correct cross-module dependencies)
  const allModules = compileModules(nodes, edges, communities);
  const allConcepts = compileConcepts(nodes, allModules);
  const allContracts = compileContracts(nodes, edges, allModules);
  const allFlows = compileFlows(processes, nodes, allModules);
  preserveSemanticZones(allModules, previousModules);
  preserveSemanticZones(allConcepts, previousConcepts);
  preserveSemanticZones(allContracts, previousContracts);
  preserveSemanticZones(allFlows, previousFlows);
  applyAutoDescriptionsToModules(nodes, allModules);
  applyAutoDescriptionsToConcepts(allConcepts);
  applyAutoDescriptionsToContracts(allContracts);
  applyAutoDescriptionsToFlows(allFlows);

  const changedNodeIds = new Set<string>();
  collectChangedIds(previousModuleHashes, allModules, changedNodeIds);
  collectChangedIds(previousConceptHashes, allConcepts, changedNodeIds);
  collectChangedIds(previousContractHashes, allContracts, changedNodeIds);
  collectChangedIds(previousFlowHashes, allFlows, changedNodeIds);
  markStaleAnnotationsInNodes(allModules, changedNodeIds, 'struct_hash changed during update');
  markStaleAnnotationsInNodes(allConcepts, changedNodeIds, 'struct_hash changed during update');
  markStaleAnnotationsInNodes(allContracts, changedNodeIds, 'struct_hash changed during update');
  markStaleAnnotationsInNodes(allFlows, changedNodeIds, 'struct_hash changed during update');

  const decisionInputs = buildDecisionInputs({
    nodes,
    edges,
    processes,
    modules: allModules,
    contracts: allContracts,
    flows: allFlows,
  });
  const concernFamilyResult = buildConcernFamilies(decisionInputs);
  const canonicalPathResult = compileCanonicalPaths(decisionInputs, concernFamilyResult);
  const symmetryEdges = buildSymmetryEdges(concernFamilyResult);
  const cochangeRules = analyzeCochange(projectRoot);
  const closureSets = buildClosureSets(concernFamilyResult, symmetryEdges, cochangeRules);
  const abstractionOpportunities = detectAbstractionOpportunities(concernFamilyResult, canonicalPathResult);
  await writeStorageV2(projectRoot, {
    nodes,
    edges,
    processes,
    modules: allModules,
    concepts: allConcepts,
    contracts: allContracts,
    flows: allFlows,
    concerns: previousSemantic.concerns,
    decisionOverrides: previousSemantic.decisionOverrides,
    concernFamilies: concernFamilyResult.families,
    canonicalPaths: [...canonicalPathResult.canonical_paths, ...canonicalPathResult.candidate_paths],
    symmetryEdges,
    closureSets,
    abstractionOpportunities,
  });

  // Refresh graph files
  const graphExport = exportGraphToJsonLines({ nodes, edges });
  store.writeGraphFile('nodes.json', graphExport.nodes);
  store.writeGraphFile('edges.json', graphExport.edges);
  store.writeGraphFile('communities.json', exportCommunitiesToJsonLines(communities));
  store.writeGraphFile('processes.json', exportProcessesToJsonLines(processes));
  store.writeGraphFile('meta.json', [
    JSON.stringify({
      compiled_at: compiledAt,
      stats: {
        nodes: nodes.length,
        edges: edges.length,
        communities: communities.length,
        processes: processes.length,
      },
    }),
  ]);

  const updatedModules = countChanged(previousModuleHashes, allModules);
  const updatedContracts = countChanged(previousContractHashes, allContracts);
  const updatedFlows = countChanged(previousFlowHashes, allFlows);
  const preEnrichStaleResult = detectStale(store);
  let incrementalEnrichment: IncrementalEnrichmentExecution | null = null;
  try {
    const { autoEnrich } = await import('../llm/enricher.js');
    incrementalEnrichment = await runIncrementalSemanticEnrichment(
      projectRoot,
      store,
      options?.enrichPolicy ?? 'affected-if-available',
      preEnrichStaleResult.staleEnrichments,
      changedNodeIds,
      { autoEnrich },
      log,
    );
  } catch (error) {
    throw error;
  }
  const staleResult = detectStale(store);
  const staleEnrichments = staleResult.summary.enrichments;
  const concernCount = store.listConcerns().length;

  // Update meta timestamp + stats
  const gitFingerprint = captureGitFingerprint(projectRoot);
  store.updateMeta({
    compiled_at: compiledAt,
    ...(gitFingerprint ? { git: gitFingerprint } : {}),
    stats: {
      concepts: allConcepts.length,
      modules: allModules.length,
      contracts: allContracts.length,
      flows: allFlows.length,
      concerns: concernCount,
    },
  });
  rebuildDerivedIndex(store);
  CotxGraph.invalidateCache();

  // Architecture rebuild (always rebuild — cheap and avoids stale risk)
  const previousArchitecture = snapshotArchitectureSidecars(projectRoot);
  let complexityData: Record<string, unknown> = {};
  try {
    const complexityFile = path.join(projectRoot, '.cotx', 'graph', 'complexity.json');
    if (fs.existsSync(complexityFile)) {
      complexityData = JSON.parse(fs.readFileSync(complexityFile, 'utf-8'));
    }
  } catch {}

  const projectName = path.basename(projectRoot);
  const workspaceLayout = store.readWorkspaceLayout();
  const archResult = compileArchitecture(projectName, nodes, edges, communities, processes, complexityData as any, {
    workspaceLayout,
  });
  const archStore = new ArchitectureStore(projectRoot);
  archStore.clear();
  archStore.init(archResult.meta);
  const preserveGeneratedSidecars = previousArchitecture.mode !== undefined && previousArchitecture.mode !== 'auto';
  for (const perspective of archResult.perspectives) {
    archStore.writePerspective(perspective);
    const mermaid = archResult.mermaidByPath.get(perspective.id);
    const desc = archResult.descriptionsByPath.get(perspective.id);
    const previousDescription = previousArchitecture.descriptions.get(perspective.id);
    if (preserveGeneratedSidecars && previousDescription !== undefined && shouldPreserveArchitectureDescription(previousArchitecture, previousDescription)) {
      archStore.writeDescription(perspective.id, previousDescription);
    } else if (desc) {
      archStore.writeDescription(perspective.id, desc);
    }
    if (preserveGeneratedSidecars && previousArchitecture.diagrams.has(perspective.id)) {
      archStore.writeDiagram(perspective.id, previousArchitecture.diagrams.get(perspective.id)!);
    } else if (mermaid) {
      archStore.writeDiagram(perspective.id, mermaid);
    }
  }
  for (const doc of archResult.elementDocs) {
    const fullPath = `${doc.perspectiveId}/${doc.elementPath}`;
    archStore.writeElement(doc.perspectiveId, doc.elementPath, doc.data);
    const mermaid = archResult.mermaidByPath.get(fullPath);
    const desc = archResult.descriptionsByPath.get(fullPath);
    const previousDescription = previousArchitecture.descriptions.get(fullPath);
    if (preserveGeneratedSidecars && previousDescription !== undefined && shouldPreserveArchitectureDescription(previousArchitecture, previousDescription)) {
      archStore.writeDescription(fullPath, previousDescription);
    } else if (desc) {
      archStore.writeDescription(fullPath, desc);
    }
    if (preserveGeneratedSidecars && previousArchitecture.diagrams.has(fullPath)) {
      archStore.writeDiagram(fullPath, previousArchitecture.diagrams.get(fullPath)!);
    } else if (mermaid) {
      archStore.writeDiagram(fullPath, mermaid);
    }
  }
  if (previousArchitecture.mode && previousArchitecture.mode !== 'auto') {
    archStore.writeMeta({ ...archStore.readMeta(), mode: previousArchitecture.mode });
  }
  const refreshedWorkspaceLayout = scanWorkspaceLayout(projectRoot, { generatedAt: compiledAt });
  store.writeWorkspaceLayout(refreshedWorkspaceLayout);

  const doctrine = compileDoctrine(projectRoot, store, {
    modules: allModules,
    contracts: allContracts,
    flows: allFlows,
  });
  store.writeDoctrine(doctrine);

  const changeSummary = buildChangeSummary({
    trigger: 'update',
    changedFiles,
    previousGraphNodes,
    currentGraphNodes: nodes,
    previousModules,
    currentModules: allModules,
    previousConcepts,
    currentConcepts: allConcepts,
    previousContracts,
    currentContracts: allContracts,
    previousFlows,
    currentFlows: allFlows,
    affectedModules: delta.affectedModules,
    affectedContracts: delta.affectedContracts,
    affectedFlows: delta.affectedFlows,
    staleEnrichments: staleResult.staleEnrichments.map((item) => ({
      nodeId: item.nodeId,
      layer: item.layer,
      source_hash: item.source_hash,
      struct_hash: item.struct_hash,
      reason: `source_hash ${item.source_hash} != struct_hash ${item.struct_hash}`,
    })),
    staleAnnotations: staleResult.staleAnnotations.map((item) => ({
      nodeId: item.nodeId,
      layer: item.layer,
      annotationIndex: item.annotationIndex,
      reason: item.reason,
    })),
  });
  store.writeLatestChangeSummary(changeSummary);
  store.appendChangeSummary(changeSummary);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  store.appendLog({ operation: 'update', affected_nodes: [...delta.affectedModules], summary: `${updatedModules} modules, ${updatedContracts} contracts, ${updatedFlows} flows updated` });

  log(`Updated in ${elapsed}s:`);
  log(`  ${updatedModules} modules, ${updatedContracts} contracts, ${updatedFlows} flows`);
  log(`  Doctrine: ${doctrine.statements.length} statements`);
  if (staleEnrichments > 0) {
    log(`  ${staleEnrichments} stale enrichment(s) — run: cotx write <id> enriched.*`);
  }
  if (incrementalEnrichment?.ran && incrementalEnrichment.summary) {
    log(`  Incremental enrich: ${incrementalEnrichment.summary.succeeded}/${incrementalEnrichment.summary.total} updated (${incrementalEnrichment.summary.failed} failed)`);
  } else if (incrementalEnrichment?.skipped_reason) {
    log(`  Incremental enrich skipped: ${incrementalEnrichment.skipped_reason}`);
  }
  if (!options?.silent) {
    printChangeSummary(changeSummary, log);
  }

  return { updatedModules, updatedContracts, updatedFlows, staleEnrichments, incrementalEnrichment };
}

function countChanged(
  previousHashes: Map<string, string>,
  nextNodes: Array<{ id: string; struct_hash: string }>,
): number {
  const seenIds = new Set<string>();
  let changed = 0;

  for (const node of nextNodes) {
    seenIds.add(node.id);
    if (previousHashes.get(node.id) !== node.struct_hash) {
      changed++;
    }
  }

  for (const id of previousHashes.keys()) {
    if (!seenIds.has(id)) {
      changed++;
    }
  }

  return changed;
}
