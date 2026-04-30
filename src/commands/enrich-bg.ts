/**
 * Phase C proper: detached enrichment worker.
 *
 * Invoked as `cotx enrich-bg <projectRoot>` by commandCompile after the
 * structural phase completes. Runs the agentic enrichment pipeline to
 * completion, updating `.cotx/enrichment-status.json` as it goes. The
 * parent process doesn't wait — it returns to the caller immediately
 * after spawning this worker.
 *
 * Status file schema:
 * {
 *   status: 'running' | 'complete' | 'degraded' | 'error',
 *   phase: 'structural' | 'synthesis' | 'done' | 'retry',
 *   started_at: ISO timestamp,
 *   updated_at: ISO timestamp,
 *   pid: number,
 *   done: number,        // nodes enriched so far
 *   total: number,       // total nodes to enrich
 *   layers: { modules, concepts, contracts, flows, architecture },
 *   error?: string
 * }
 */

import fs from 'node:fs';
import path from 'node:path';
import { readExistingConfig } from '../config.js';
import { runAgenticBootstrapEnrichment } from '../llm/agentic-enrichment-session.js';
import { readSemanticArtifactsSync } from '../store-v2/graph-truth-store.js';
import { rebuildDerivedIndex } from '../store/derived-index.js';
import { CotxStore } from '../store/store.js';

export interface EnrichmentStatusFile {
  status: 'running' | 'complete' | 'degraded' | 'error';
  phase: 'structural' | 'synthesis' | 'retry' | 'done';
  started_at: string;
  updated_at: string;
  pid: number;
  done: number;
  total: number;
  layers?: {
    modules?: { done: number; total: number };
    concepts?: { done: number; total: number };
    contracts?: { done: number; total: number };
    flows?: { done: number; total: number };
    architecture?: { done: number; total: number };
  };
  error?: string;
}

function statusFilePath(projectRoot: string): string {
  return path.join(projectRoot, '.cotx', 'enrichment-status.json');
}

export function writeEnrichmentStatus(
  projectRoot: string,
  patch: Partial<EnrichmentStatusFile>,
): void {
  const file = statusFilePath(projectRoot);
  let current: Partial<EnrichmentStatusFile> = {};
  try {
    current = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    // first write
  }
  const merged: EnrichmentStatusFile = {
    status: 'running',
    phase: 'structural',
    started_at: new Date().toISOString(),
    pid: process.pid,
    done: 0,
    total: 0,
    ...current,
    ...patch,
    updated_at: new Date().toISOString(),
  };
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

export function readEnrichmentStatus(projectRoot: string): EnrichmentStatusFile | null {
  try {
    return JSON.parse(fs.readFileSync(statusFilePath(projectRoot), 'utf-8')) as EnrichmentStatusFile;
  } catch {
    return null;
  }
}

/**
 * Command entry point. Call pattern: `cotx enrich-bg <projectRoot>`.
 * Runs agentic enrichment to completion, writes final status.
 */
export async function commandEnrichBg(projectRoot: string): Promise<void> {
  const store = new CotxStore(projectRoot);
  if (!store.exists()) {
    writeEnrichmentStatus(projectRoot, {
      status: 'error',
      phase: 'done',
      error: 'No .cotx/ found at projectRoot',
    });
    return;
  }

  const config = readExistingConfig();
  if (!config?.llm?.chat_model) {
    writeEnrichmentStatus(projectRoot, {
      status: 'error',
      phase: 'done',
      error: 'No LLM configured (add llm.chat_model to ~/.cotx/config.json)',
    });
    return;
  }

  // Default enrichment scope is modules only — concepts/contracts/flows use
  // auto_description, and architecture is written via synthesis (counted
  // separately when reported). Total reflects what we actually plan to write.
  const totalNodes = store.listModules().length;

  writeEnrichmentStatus(projectRoot, {
    status: 'running',
    phase: 'structural',
    started_at: new Date().toISOString(),
    pid: process.pid,
    done: 0,
    total: totalNodes,
  });

  try {
    // Only refresh the "done" counter on session finalize. Per-tool_done
    // reads of all modules contended with live writes, spun through lock-
    // retry, and drove CPU to 99%. Callers that need live progress can
    // read .cotx/v2/truth.lbug directly or poll the compiled-at timestamp.
    const result = await runAgenticBootstrapEnrichment(projectRoot, {
      llm: config.llm,
      log: (msg: string) => {
        console.log(msg);
        if (msg.includes('done in')) {
          try {
            const done = countEnrichedNodes(store);
            writeEnrichmentStatus(projectRoot, { done });
          } catch {
            // Ignore read-vs-write lock races; the next finalize (or the
            // end-of-run summary) will pick up the correct count.
          }
        }
      },
    });
    // Rebuild the derived index once after the write burst completes. Each
    // write used to trigger this eagerly; that made the per-write cost O(n)
    // in artifacts and opened LadybugDB concurrently with other writers.
    try {
      rebuildDerivedIndex(store);
    } catch (err) {
      console.log(`[enrich] derived index rebuild failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Incremental embedding refresh — only when the user has opted into
    // semantic search by previously running `cotx embed`. Adding this to
    // auto-compile is safe because the incremental path reuses every
    // unchanged vector (cheap: 1.6s when nothing changed on cotx-engine's
    // 679 nodes). We never create a fresh index from compile because users
    // who don't need semantic search shouldn't be billed for it.
    const embeddingsPath = path.join(projectRoot, '.cotx', 'embeddings.json');
    if (fs.existsSync(embeddingsPath)) {
      try {
        const { buildEmbeddingIndex } = await import('../llm/embeddings.js');
        console.log('[enrich] embedding index present — refreshing incrementally');
        const r = await buildEmbeddingIndex(projectRoot, {
          log: (msg: string) => console.log(`[embed] ${msg}`),
        });
        console.log(`[enrich] embed refresh: ${r.embedded} fresh, ${r.cached} cached, ${r.removed} dropped (total ${r.total})`);
      } catch (err) {
        console.log(`[enrich] embedding refresh failed: ${err instanceof Error ? err.message : String(err)} — semantic search may return stale results`);
      }
    }
    const done = countEnrichedNodes(store);
    const finalStatus =
      result.module_summary.failed === 0 && done === totalNodes ? 'complete' : 'degraded';
    writeEnrichmentStatus(projectRoot, {
      status: finalStatus,
      phase: 'done',
      done,
      total: totalNodes,
      layers: {
        modules: {
          done: result.module_summary.succeeded,
          total: result.module_summary.total,
        },
        architecture: {
          done: result.architecture_summary.descriptions_written,
          total: result.architecture_summary.perspectives_enriched,
        },
      },
    });
  } catch (err) {
    writeEnrichmentStatus(projectRoot, {
      status: 'error',
      phase: 'done',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function countEnrichedNodes(store: CotxStore): number {
  try {
    // One bulk query instead of N per-node opens. Same reason as everywhere
    // else: LBug open is expensive; one MATCH scan amortizes it.
    const dbPath = path.join(store.projectRoot, '.cotx', 'v2', 'truth.lbug');
    let n = 0;
    for (const a of readSemanticArtifactsSync(dbPath, 'module')) {
      const r = (a.payload as { enriched?: { responsibility?: string } }).enriched?.responsibility;
      if (r) n++;
    }
    return n;
  } catch {
    return 0;
  }
}
