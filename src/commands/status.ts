import { CotxStore } from '../store/store.js';
import { CotxGraph } from '../query/graph-index.js';

export async function commandStatus(projectRoot: string): Promise<void> {
  const store = new CotxStore(projectRoot);

  if (!store.exists()) {
    console.log('No .cotx/ found. Run: cotx init && cotx compile');
    return;
  }

  const meta = store.readMeta();

  console.log(`Project: ${meta.project}`);
  console.log(`Version: ${meta.version}`);
  console.log(`Last compiled: ${meta.compiled_at}`);
  console.log(`Resolution: ${meta.module_resolution}`);
  console.log(`Stats:`);
  console.log(`  Modules:   ${meta.stats.modules}`);
  console.log(`  Concepts:  ${meta.stats.concepts}`);
  console.log(`  Contracts: ${meta.stats.contracts}`);
  console.log(`  Flows:     ${meta.stats.flows}`);
  console.log(`  Concerns:  ${meta.stats.concerns}`);

  // Enrichment coverage
  const graph = CotxGraph.fromStore(store);
  const modules = graph.allNodes('module');
  let enrichedModules = 0;
  let staleCount = 0;
  for (const node of modules) {
    const mod = node.data as { enriched?: { source_hash?: string }; struct_hash?: string };
    if (mod.enriched) {
      enrichedModules++;
      if (mod.enriched.source_hash !== mod.struct_hash) {
        staleCount++;
      }
    }
  }

  const concepts = graph.allNodes('concept');
  let enrichedConcepts = 0;
  for (const node of concepts) {
    const concept = node.data as { enriched?: unknown };
    if (concept.enriched) enrichedConcepts++;
  }

  console.log(`Enrichment:`);
  console.log(`  Modules:  ${enrichedModules}/${modules.length} enriched`);
  console.log(`  Concepts: ${enrichedConcepts}/${concepts.length} enriched`);
  if (staleCount > 0) {
    console.log(`  Stale:    ${staleCount}`);
  }

  // Count stale annotations
  let staleAnnotationCount = 0;
  for (const node of graph.allNodes()) {
    const data = node.data as { annotations?: Array<{ stale?: boolean }> };
    if (data.annotations) {
      staleAnnotationCount += data.annotations.filter((a) => a.stale).length;
    }
  }
  if (staleAnnotationCount > 0) {
    console.log(`  Stale annotations: ${staleAnnotationCount}`);
  }

  const latestSummary = store.readLatestChangeSummary();
  if (
    latestSummary &&
    (latestSummary.stale.enrichments.length > 0 || latestSummary.stale.annotations.length > 0)
  ) {
    console.log(`Stale explanations:`);
    if (latestSummary.changed_files.length > 0) {
      console.log(`  Changed files: ${latestSummary.changed_files.join(', ')}`);
    }
    for (const item of latestSummary.stale.enrichments.slice(0, 5)) {
      console.log(`  Enrichment [${item.layer}] ${item.nodeId}: ${item.reason ?? 'stale'}`);
    }
    for (const item of latestSummary.stale.annotations.slice(0, 5)) {
      console.log(`  Annotation [${item.layer}] ${item.nodeId}#${item.annotationIndex}: ${item.reason}`);
    }
  }
}
