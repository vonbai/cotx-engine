import { CotxStore } from '../store/store.js';
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
import { analyzeComplexity } from '../compiler/complexity-analyzer.js';
import { analyzeChurn, type TemporalCouplingEdge } from '../compiler/churn-analyzer.js';
import { analyzeTestDensity } from '../compiler/test-density.js';
import { detectStale } from '../compiler/stale-detector.js';
import { readConfig } from '../config.js';
import { compileArchitecture } from '../compiler/architecture-compiler.js';
import { buildArchitectureWorkspace, planArchitectureRecursion } from '../compiler/architecture-workspace-planner.js';
import { ArchitectureStore } from '../store/architecture-store.js';
import { scanWorkspaceLayout } from '../compiler/workspace-scan.js';
import fs from 'node:fs';
import {
  exportGraphToJsonLines,
  exportCommunitiesToJsonLines,
  exportProcessesToJsonLines,
  type GraphNode,
  type GraphEdge,
  type CommunityData,
  type ProcessData,
} from '../core/export/json-exporter.js';
import { runPipelineFromRepo } from '../core/parser/pipeline.js';
import {
  bridgeNodes,
  bridgeEdges,
  bridgeCommunities,
  bridgeProcesses,
} from '../core/bridge.js';
import path from 'node:path';
import { rebuildDerivedIndex } from '../store/derived-index.js';
import { CotxGraph } from '../query/graph-index.js';
import { registerProject } from '../registry.js';
import {
  captureGitFingerprint,
  ensureCotxGitignored,
  findBestCotxSeedWorktree,
  getDiffedFiles,
  tryReadGitValue,
} from '../lib/git.js';
import { commandUpdate } from './update.js';
import { IncrementalCache, buildEngineVersion } from '../compiler/incremental-cache.js';
import { compileDoctrine } from '../compiler/doctrine-compiler.js';
import { buildDecisionInputs } from '../compiler/decision-inputs.js';
import { buildConcernFamilies } from '../compiler/concern-family-builder.js';
import { compileCanonicalPaths } from '../compiler/canonical-path-compiler.js';
import { buildSymmetryEdges } from '../compiler/symmetry-engine.js';
import { analyzeCochange } from '../compiler/cochange-analyzer.js';
import { buildClosureSets } from '../compiler/closure-engine.js';
import { detectAbstractionOpportunities } from '../compiler/abstraction-opportunity.js';
import { writeStorageV2 } from '../store-v2/write-storage-v2.js';
import { preserveSemanticZones, readPreviousSemanticLayers } from '../compiler/semantic-zones.js';
import {
  runCompileBootstrapEnrichment,
  type CompileBootstrapExecution,
} from '../compiler/compile-bootstrap.js';
import type { CompileEnrichPolicy } from '../store/schema.js';

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

function profiler(log: (line: string) => void) {
  const enabled = Boolean(process.env.COTX_PROFILE);
  let last = Date.now();
  return (label: string): void => {
    if (!enabled) return;
    const now = Date.now();
    log(`  [profile] ${label}: ${((now - last) / 1000).toFixed(3)}s`);
    last = now;
  };
}

export interface SeedCompileResult {
  seeded: true;
  source_path: string;
  source_head?: string;
  current_head?: string;
  drifted_files: string[];
  delta_ran: boolean;
  duration_ms: number;
}

/**
 * Bootstrap a new worktree's .cotx/ by copying from a sibling worktree and
 * delta-compiling only the files that differ between the two HEADs. Avoids
 * a multi-minute cold full compile per worktree.
 */
export async function commandCompileFromSeed(
  projectRoot: string,
  sourcePath: string,
  options?: { silent?: boolean },
): Promise<SeedCompileResult> {
  const log = options?.silent ? (() => {}) : console.log.bind(console);
  const started = Date.now();

  const resolvedSource = path.resolve(sourcePath);
  if (!fs.existsSync(resolvedSource)) {
    throw new Error(`Seed source path does not exist: ${resolvedSource}`);
  }
  const sourceCotxDir = path.join(resolvedSource, '.cotx');
  if (!fs.existsSync(sourceCotxDir)) {
    throw new Error(`Seed source has no .cotx/ directory: ${resolvedSource}`);
  }
  if (path.resolve(projectRoot) === resolvedSource) {
    throw new Error('Seed source must differ from target project root.');
  }

  const targetCotxDir = path.join(projectRoot, '.cotx');
  if (fs.existsSync(targetCotxDir)) {
    log(`Overwriting existing ${targetCotxDir}`);
    fs.rmSync(targetCotxDir, { recursive: true, force: true });
  }

  log(`Seeding from ${resolvedSource}...`);
  fs.cpSync(sourceCotxDir, targetCotxDir, { recursive: true });
  ensureCotxGitignored(projectRoot, log);

  const store = new CotxStore(projectRoot);
  const meta = store.readMeta();
  const sourceHead = meta.git?.head;
  const currentFingerprint = captureGitFingerprint(projectRoot);
  const currentHead = currentFingerprint?.head;

  // Compute drifted files between source HEAD and target HEAD. If either side
  // isn't git-tracked we still include target worktree edits below.
  const driftedFiles = new Set<string>();
  if (sourceHead && currentHead && sourceHead !== currentHead) {
    const raw = tryReadGitValue(projectRoot, ['diff', '--name-only', sourceHead, 'HEAD']) ?? '';
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) driftedFiles.add(trimmed);
    }
  }
  if (currentFingerprint) {
    for (const file of getDiffedFiles(projectRoot)) {
      driftedFiles.add(file);
    }
  }

  let deltaRan = false;
  const driftedFileList = [...driftedFiles].sort();
  if (driftedFileList.length > 0) {
    log(`Running delta compile for ${driftedFileList.length} drifted file(s)...`);
    await commandUpdate(projectRoot, driftedFileList, {
      silent: options?.silent,
      enrichPolicy: 'stale-if-available',
    });
    deltaRan = true;
  } else if (currentFingerprint) {
    // No drift but we still need to update meta.git to reflect the current
    // worktree (source fingerprint is stale for this location).
    store.updateMeta({ git: currentFingerprint });
  }

  const duration_ms = Date.now() - started;
  log(`Seeded in ${(duration_ms / 1000).toFixed(1)}s (delta: ${deltaRan ? driftedFileList.length + ' files' : 'skipped'})`);

  return {
    seeded: true,
    source_path: resolvedSource,
    source_head: sourceHead,
    current_head: currentHead,
    drifted_files: driftedFileList,
    delta_ran: deltaRan,
    duration_ms,
  };
}

export async function commandCompile(
  projectRoot: string,
  options?: { silent?: boolean; enrichPolicy?: CompileEnrichPolicy; seedFrom?: string; forceFull?: boolean },
): Promise<void> {
  if (options?.seedFrom) {
    await commandCompileFromSeed(projectRoot, options.seedFrom, { silent: options.silent });
    return;
  }
  const forceFull = options?.forceFull || process.env.COTX_FORCE_FULL === '1';
  if (forceFull) {
    // Signal downstream layers (Phase B cache, Phase D incremental cache) to
    // bypass all caching. For now exposed as an env var consumed by cache
    // modules; CLI/MCP flags simply set it. This is the knob we'll use for
    // A/B comparison during Phase D rollout.
    process.env.COTX_FORCE_FULL = '1';
  }

  const store = new CotxStore(projectRoot);
  const projectName = path.basename(projectRoot);
  const log = options?.silent ? (() => {}) : console.log.bind(console);
  const mark = profiler(log);

  if (!store.exists() && !forceFull) {
    const seed = findBestCotxSeedWorktree(projectRoot);
    if (seed) {
      log(`Auto-seeding .cotx/ from sibling worktree ${seed.path}...`);
      await commandCompileFromSeed(projectRoot, seed.path, { silent: options?.silent });
      return;
    }
  }

  ensureCotxGitignored(projectRoot, log);
  if (!store.exists()) {
    store.init(projectName);
  }

  log(`Compiling ${projectName}...`);
  const startTime = Date.now();
  const compiledAt = new Date().toISOString();
  const previousSemantic = readPreviousSemanticLayers(store);
  const workspaceLayout = scanWorkspaceLayout(projectRoot, { generatedAt: compiledAt });
  store.writeWorkspaceLayout(workspaceLayout);
  mark('scan workspace layout');

  // Phase 1: Build code graph
  const { nodes, edges, communities, processes } = await buildCodeGraph(projectRoot, options?.silent);
  mark('build code graph');

  // Export graph to JSON lines
  const graphExport = exportGraphToJsonLines({ nodes, edges });
  store.writeGraphFile('nodes.json', graphExport.nodes);
  store.writeGraphFile('edges.json', graphExport.edges);
  store.writeGraphFile('communities.json', exportCommunitiesToJsonLines(communities));
  store.writeGraphFile('processes.json', exportProcessesToJsonLines(processes));
  store.writeGraphFile('meta.json', [JSON.stringify({
    compiled_at: compiledAt,
    stats: { nodes: nodes.length, edges: edges.length, communities: communities.length, processes: processes.length },
  })]);
  mark('write raw graph files');

  // Phase 2: Semantic compilation
  const modules = compileModules(nodes, edges, communities);
  mark('compile modules');

  // Phase 3: Intelligence analyzers
  // Complexity analysis (re-parses AST for function-level metrics)
  await analyzeComplexity(projectRoot, nodes, modules);
  mark('analyze complexity');

  // Churn analysis (reads snapshots if available)
  const temporalCouplingEdges: TemporalCouplingEdge[] = analyzeChurn(projectRoot, modules);
  mark('analyze churn');

  // Test density (import-based heuristic)
  const testDensities = analyzeTestDensity(nodes, edges, modules);
  mark('analyze test density');

  // Write temporal coupling edges (always rewrite to avoid stale data)
  store.writeGraphFile(
    'temporal-coupling.json',
    temporalCouplingEdges.map((e) => JSON.stringify(e)),
  );

  // Write test density data
  const testDensityData: Record<string, number> = {};
  for (const [id, density] of testDensities) {
    testDensityData[id] = density;
  }
  store.writeGraphFile('test-density.json', [JSON.stringify(testDensityData)]);
  mark('write analyzer graph files');

  const concepts = compileConcepts(nodes, modules);
  mark('compile concepts');
  const contracts = compileContracts(nodes, edges, modules);
  mark('compile contracts');
  const flows = compileFlows(processes, nodes, modules);
  mark('compile flows');
  preserveSemanticZones(modules, previousSemantic.modules);
  preserveSemanticZones(concepts, previousSemantic.concepts);
  preserveSemanticZones(contracts, previousSemantic.contracts);
  preserveSemanticZones(flows, previousSemantic.flows);
  applyAutoDescriptionsToModules(nodes, modules);
  applyAutoDescriptionsToConcepts(concepts);
  applyAutoDescriptionsToContracts(contracts);
  applyAutoDescriptionsToFlows(flows);
  mark('preserve semantic zones');
  const decisionInputs = buildDecisionInputs({ nodes, edges, processes, modules, contracts, flows });
  mark('build decision inputs');
  const concernFamilyResult = buildConcernFamilies(decisionInputs);
  mark('build concern families');
  const canonicalPathResult = compileCanonicalPaths(decisionInputs, concernFamilyResult);
  mark('compile canonical paths');
  const symmetryEdges = buildSymmetryEdges(concernFamilyResult);
  mark('build symmetry edges');
  const cochangeRules = analyzeCochange(projectRoot);
  mark('analyze cochange');
  const closureSets = buildClosureSets(concernFamilyResult, symmetryEdges, cochangeRules);
  mark('build closure sets');
  const abstractionOpportunities = detectAbstractionOpportunities(concernFamilyResult, canonicalPathResult);
  mark('detect abstraction opportunities');
  const storageV2Result = await writeStorageV2(projectRoot, {
    nodes,
    edges,
    processes,
    modules,
    concepts,
    contracts,
    flows,
    concerns: previousSemantic.concerns,
    decisionOverrides: previousSemantic.decisionOverrides,
    concernFamilies: concernFamilyResult.families,
    canonicalPaths: [...canonicalPathResult.canonical_paths, ...canonicalPathResult.candidate_paths],
    symmetryEdges,
    closureSets,
    abstractionOpportunities,
  });
  mark('write storage v2');

  const concernCount = store.listConcerns().length;
  const gitFingerprint = captureGitFingerprint(projectRoot);
  store.updateMeta({
    compiled_at: compiledAt,
    ...(gitFingerprint ? { git: gitFingerprint } : {}),
    stats: {
      concepts: concepts.length,
      modules: modules.length,
      contracts: contracts.length,
      flows: flows.length,
      concerns: concernCount,
    },
  });
  rebuildDerivedIndex(store);
  CotxGraph.invalidateCache();
  mark('meta and derived index');

  // Phase 4: Architecture layer
  const previousArchitecture = snapshotArchitectureSidecars(projectRoot);
  mark('snapshot architecture sidecars');
  let complexityData: Record<string, unknown> = {};
  try {
    const complexityFile = path.join(projectRoot, '.cotx', 'graph', 'complexity.json');
    if (fs.existsSync(complexityFile)) {
      complexityData = JSON.parse(fs.readFileSync(complexityFile, 'utf-8'));
    }
  } catch {}

  const archResult = compileArchitecture(projectName, nodes, edges, communities, processes, complexityData as any, {
    workspaceLayout,
  });
  mark('compile architecture');
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
  const archWorkspace = buildArchitectureWorkspace(projectName, archResult, {
    workspaceLayout,
    generatedAt: compiledAt,
    sourceGraphCompiledAt: compiledAt,
  });
  archStore.writeWorkspace(archWorkspace);
  archStore.writeRecursionPlan(planArchitectureRecursion(archWorkspace, { generatedAt: compiledAt }));
  if (previousArchitecture.mode && previousArchitecture.mode !== 'auto') {
    archStore.writeMeta({ ...archStore.readMeta(), mode: previousArchitecture.mode });
  }
  mark('write architecture');
  const refreshedWorkspaceLayout = scanWorkspaceLayout(projectRoot, { generatedAt: compiledAt });
  store.writeWorkspaceLayout(refreshedWorkspaceLayout);
  mark('refresh workspace layout');

  const doctrine = compileDoctrine(projectRoot, store, { modules, contracts, flows });
  store.writeDoctrine(doctrine);
  mark('compile/write doctrine');

  let bootstrapResult: CompileBootstrapExecution | null = null;
  try {
    const { autoEnrich } = await import('../llm/enricher.js');
    const { enrichArchitecture } = await import('../llm/architecture-enricher.js');
    bootstrapResult = await runCompileBootstrapEnrichment(
      projectRoot,
      store,
      archStore,
      options?.enrichPolicy ?? 'bootstrap-if-available',
      { autoEnrich, enrichArchitecture },
      log,
    );
  } catch (error) {
    throw error;
  }
  mark('bootstrap enrich');

  registerProject(projectRoot, compiledAt, {
    modules: modules.length,
    concepts: concepts.length,
    contracts: contracts.length,
    flows: flows.length,
    concerns: concernCount,
  });

  store.appendLog({ operation: 'compile', summary: `${modules.length} modules, ${concepts.length} concepts, ${contracts.length} contracts, ${flows.length} flows` });
  mark('registry and log');

  const staleResult = detectStale(store);
  mark('detect stale');
  const staleCount = staleResult.staleEnrichments.length;
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  log(`Compiled in ${elapsed}s:`);
  log(`  ${nodes.length} symbols → ${modules.length} modules`);
  log(`  ${concepts.length} concepts, ${contracts.length} contracts, ${flows.length} flows`);
  log(`  Complexity: ${modules.filter(m => m.complexity).length} modules analyzed`);
  log(`  Churn: ${modules.filter(m => m.churn).length} modules with history`);
  log(`  Temporal coupling: ${temporalCouplingEdges.length} edges`);
  log(`  Architecture: ${archResult.perspectives.length} perspective(s), ${archResult.perspectives.reduce((s, p) => s + p.components.length, 0)} components`);
  log(`  Workspace: ${refreshedWorkspaceLayout.summary.repo_boundaries} repo boundary/boundaries, ${refreshedWorkspaceLayout.summary.packages} package boundary/boundaries, ${refreshedWorkspaceLayout.summary.candidates} candidate inputs`);
  log(`  Doctrine: ${doctrine.statements.length} statements`);
  log(`  Decision plane: ${concernFamilyResult.families.length} concern families, ${canonicalPathResult.canonical_paths.length} canonical paths`);
  log(`  Symmetry: ${symmetryEdges.length} edges, ${closureSets.length} closure sets, ${abstractionOpportunities.length} abstraction opportunities`);
  log(`  Storage v2: ${storageV2Result.graph.nodes} code nodes, ${storageV2Result.graph.relations} code relations, ${storageV2Result.semanticArtifacts.modules} modules, ${storageV2Result.decisions.closureMembers} closure members`);
  log(`  Output: .cotx/`);

  if (staleCount > 0) {
    let hasLlmConfig = false;
    try {
      hasLlmConfig = Boolean(readConfig().llm?.chat_model);
    } catch {
      hasLlmConfig = false;
    }
    if (hasLlmConfig) {
      log(`  ${staleCount} stale enrichments — run \`cotx enrich --auto\` to update`);
    } else {
      log(`  ${staleCount} stale enrichments`);
    }
  }

  if (bootstrapResult?.ran) {
    const layers = bootstrapResult.layers.join(', ');
    log(`  Bootstrap enrich: ${layers}`);
  } else if (bootstrapResult?.skipped_reason) {
    log(`  Bootstrap enrich skipped: ${bootstrapResult.skipped_reason}`);
  }
}

async function buildCodeGraph(projectRoot: string, silent?: boolean): Promise<{
  nodes: GraphNode[];
  edges: GraphEdge[];
  communities: CommunityData[];
  processes: ProcessData[];
}> {
  // Phase D step 2: spin up the incremental parse cache and hand it to the
  // pipeline. Force-full bypasses the cache (COTX_FORCE_FULL=1 is honored
  // inside pipeline; we still construct the cache so fresh results still
  // persist for subsequent runs).
  const pkgVersion = '0.1.0'; // keep in sync with package.json; semver bump → cache wipe
  const engineVersion = buildEngineVersion(pkgVersion, 'tree-sitter-v1');
  const incrementalCache = new IncrementalCache(projectRoot, engineVersion);

  const result = await runPipelineFromRepo(
    projectRoot,
    (progress) => {
      if (!silent && progress.message) {
        process.stdout.write(`\r  ${progress.message}`);
      }
    },
    { incrementalCache },
  );

  if (!silent) {
    process.stdout.write('\n');
    const stats = incrementalCache.getStats();
    if (stats.hits > 0 || stats.misses > 0) {
      const ratio = stats.hits / Math.max(1, stats.hits + stats.misses);
      process.stdout.write(
        `  Parse cache: ${stats.hits} hits / ${stats.misses} misses (${Math.round(ratio * 100)}% hit rate), ${stats.files} total files tracked\n`,
      );
    }
  }
  incrementalCache.close();

  return {
    nodes: bridgeNodes(result.graph),
    edges: bridgeEdges(result.graph),
    communities: bridgeCommunities(result.communityResult),
    processes: bridgeProcesses(result.processResult),
  };
}
