import { CotxStore } from '../store/store.js';
import { CotxGraph } from '../query/graph-index.js';
import { ArchitectureIndex } from '../store/architecture-index.js';
import { ArchitectureStore } from '../store/architecture-store.js';

export const QUERY_LAYER_HELP = 'Filter by layer (module|concept|contract|flow|concern|architecture)';

export async function commandQuery(projectRoot: string, keyword: string, options: { layer?: string }): Promise<void> {
  const store = new CotxStore(projectRoot);
  if (!store.exists()) {
    console.log('No .cotx/ found. Run: cotx compile');
    return;
  }

  if (options.layer === 'architecture') {
    printArchitectureQuery(projectRoot, keyword);
    return;
  }

  const graph = CotxGraph.fromStore(store);
  const results = graph.search(keyword, options.layer);
  const latestSummary = store.readLatestChangeSummary();
  const recentMatches = latestSummary
    ? [...latestSummary.symbols.added, ...latestSummary.symbols.changed].filter((symbol) => {
        const haystack = `${symbol.id} ${symbol.label}`.toLowerCase();
        return haystack.includes(keyword.toLowerCase());
      })
    : [];

  if (results.length === 0) {
    if (recentMatches.length > 0) {
      console.log(`No map results for "${keyword}", but recently changed symbols match:\n`);
      for (const symbol of recentMatches.slice(0, 10)) {
        console.log(`[recent ${symbol.label}] ${symbol.id}`);
      }
      return;
    }
    console.log(`No results for "${keyword}"`);
    return;
  }

  console.log(`Found ${results.length} results for "${keyword}":\n`);

  if (recentMatches.length > 0) {
    console.log('Recently changed symbols:');
    for (const symbol of recentMatches.slice(0, 5)) {
      console.log(`  [${symbol.label}] ${symbol.id}`);
    }
    console.log();
  }

  for (const node of results) {
    const edges = graph.neighbors(node.id, 'both');
    console.log(`[${node.layer}] ${node.id}`);

    // Show key info based on layer
    const data = node.data as any;
    if (node.layer === 'module' && data.canonical_entry) {
      console.log(`  entry: ${data.canonical_entry}`);
      console.log(`  files: ${data.files?.length ?? 0}`);
    } else if (node.layer === 'concept') {
      console.log(`  appears_in: ${data.appears_in?.length ?? 0} files`);
      console.log(`  module: ${data.layer}`);
    } else if (node.layer === 'contract') {
      console.log(`  ${data.consumer} → ${data.provider}`);
      console.log(`  interface: ${data.interface?.join(', ')}`);
    } else if (node.layer === 'flow') {
      console.log(`  trigger: ${data.trigger}`);
      console.log(`  steps: ${data.steps?.length ?? 0}`);
    } else if (node.layer === 'concern') {
      console.log(`  type: ${data.type}, severity: ${data.severity}`);
    }

    if (edges.length > 0) {
      const rels = edges.slice(0, 5).map(e =>
        e.from === node.id ? `→ ${e.to} (${e.relation})` : `← ${e.from} (${e.relation})`
      );
      console.log(`  relations: ${rels.join(', ')}`);
    }
    console.log();
  }
}

function printArchitectureQuery(projectRoot: string, keyword: string): void {
  const archStore = new ArchitectureStore(projectRoot);
  if (!archStore.exists()) {
    console.log('No architecture data. Run: cotx compile');
    return;
  }

  const results = ArchitectureIndex.fromStore(archStore).search(keyword);
  if (results.length === 0) {
    console.log(`No results for "${keyword}"`);
    return;
  }

  console.log(`Found ${results.length} architecture results for "${keyword}":\n`);
  for (const result of results) {
    console.log(`[architecture:${result.kind}] ${result.id}`);
    console.log(`  score: ${result.score.toFixed(3)}`);
  }
}
