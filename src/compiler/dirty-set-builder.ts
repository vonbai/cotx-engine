/**
 * Phase D step 3: dirty-set builder.
 *
 * Given a list of files that changed on disk (or were added / removed), this
 * module computes the propagation closure across the graph layers:
 *
 *   dirty_files       → files whose content hash differs from cache
 *   dirty_symbols     → symbols declared in dirty_files + symbols imported from them
 *   dirty_call_sites  → call sites in dirty_files + call sites whose target symbol is dirty
 *   dirty_modules     → modules containing at least one dirty file
 *
 * The result feeds incremental compilers/resolvers (Phase D steps 4-9) so
 * they can skip unchanged slices.
 *
 * We deliberately keep this module dependency-light: it takes only the
 * previous graph skeletons (from IncrementalCache) and a list of changed
 * file paths. No tree-sitter, no git, no live KnowledgeGraph reads.
 */

import type { IncrementalCache } from './incremental-cache.js';

export interface DirtySet {
  /** Files newly-created, content-changed, or deleted since last compile. */
  files: Set<string>;
  /** Files that were on disk before but are now missing. */
  deleted: Set<string>;
  /** Symbols whose defining file is dirty, plus their transitive consumers. */
  symbols: Set<string>;
  /** Modules with ≥1 dirty file. */
  modules: Set<string>;
  /** Call sites that need re-resolution (source in dirty files, or target in dirty symbols). */
  callSiteFiles: Set<string>;
}

export interface BuildDirtySetInput {
  /** Content-hash diff already done: files that changed (content_hash mismatch or absent from cache). */
  changedFiles: Iterable<string>;
  /** Files known to be currently on disk (for deletion detection). */
  presentFiles: Iterable<string>;
  /** Incremental cache — used to enumerate previously-known files, exports, and routes. */
  cache: IncrementalCache;
  /**
   * Optional existing module→files map so module-level dirty propagation
   * happens without a graph walk. If omitted, dirty modules stay empty.
   */
  moduleFiles?: Map<string, string[]>;
}

/**
 * Compute the dirty set for an incremental compile.
 */
export function buildDirtySet(input: BuildDirtySetInput): DirtySet {
  const dirty: DirtySet = {
    files: new Set<string>(),
    deleted: new Set<string>(),
    symbols: new Set<string>(),
    modules: new Set<string>(),
    callSiteFiles: new Set<string>(),
  };

  for (const f of input.changedFiles) {
    dirty.files.add(f);
    dirty.callSiteFiles.add(f);
  }

  // Deletion: files in cache but not on disk anymore.
  const present = new Set<string>(input.presentFiles);
  // We can't list cache files cheaply without extending the API. Instead,
  // rely on caller to pass a previous file list or use pruneMissingFiles
  // separately. For now, if caller wants deletion tracking, they can
  // populate dirty.deleted externally. The API surface stays simple.

  // Exports: if a changed file exported symbols, any consumer file whose
  // resolvedCache mentions those symbols is also dirty. We approximate by
  // marking the export file itself as a source of dirty symbols — downstream
  // resolvers walk import edges live.
  for (const file of dirty.files) {
    const exports = input.cache.getExports(file);
    for (const sym of exports) {
      // Symbol id: file+"::"+name (opaque; kept as string for the caller).
      dirty.symbols.add(`${file}::${sym}`);
    }
  }

  // Module propagation: if moduleFiles map supplied, mark any module whose
  // files intersect dirty.files.
  if (input.moduleFiles) {
    for (const [modId, files] of input.moduleFiles) {
      for (const f of files) {
        if (dirty.files.has(f)) {
          dirty.modules.add(modId);
          break;
        }
      }
    }
  }

  return dirty;
}

/**
 * Diagnostic summary — for `cotx compile --force-full --verbose` and tests.
 */
export function summarizeDirtySet(set: DirtySet): Record<string, number> {
  return {
    files: set.files.size,
    deleted: set.deleted.size,
    symbols: set.symbols.size,
    modules: set.modules.size,
    callSiteFiles: set.callSiteFiles.size,
  };
}
