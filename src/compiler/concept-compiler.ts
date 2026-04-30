import type { GraphNode } from '../core/export/json-exporter.js';
import type { ModuleNode, ConceptNode } from '../store/schema.js';
import { splitCompoundName, moduleIdForFile } from '../lib/naming.js';
import { structHash } from '../lib/hash.js';
import { eng as ENGLISH_STOPWORDS } from 'stopword';

/** Minimum word length to be considered a concept. */
const MIN_WORD_LENGTH = 3;

/**
 * Words too generic to carry domain meaning.
 * Combines English stopwords + code-specific noise.
 */
const NOISE_WORDS = new Set([
  // English stopwords (about, after, all, also, and, any, are, as, at, be, ...)
  ...ENGLISH_STOPWORDS,
  // Code-generic verbs/nouns
  'get', 'set', 'new', 'create', 'handle', 'error', 'config', 'init',
  'type', 'data', 'info', 'item', 'list', 'map', 'test', 'mock', 'base',
  'default', 'internal', 'util', 'helper', 'manager', 'service', 'handler',
  'processor', 'builder', 'factory', 'impl', 'abstract', 'interface',
  // Common low-signal code words
  'load', 'save', 'read', 'write', 'parse', 'string', 'value', 'result',
  'node', 'file', 'path', 'name', 'func', 'call', 'args', 'options',
  'command', 'input', 'output', 'check', 'find', 'make', 'return',
  'run', 'start', 'stop', 'open', 'close', 'send', 'copy', 'move',
  'true', 'false', 'null', 'none', 'empty', 'count', 'size', 'length',
  'index', 'key', 'val', 'err', 'msg', 'log', 'flag', 'mode', 'kind',
  'uses', 'used', 'using', 'with', 'from', 'into', 'when', 'then',
  'each', 'next', 'prev', 'last', 'first', 'has', 'was', 'did', 'does',
  'should', 'must', 'can', 'may', 'will', 'try', 'not', 'only',
]);

/** Node labels that are potential concept carriers. */
const CONCEPT_LABELS = new Set(['Class', 'Interface', 'Struct', 'Enum', 'Type', 'Function']);

/**
 * Produce CamelCase, snake_case, and kebab-case variants of a word root.
 */
function buildAliases(word: string): string[] {
  const camel = word.charAt(0).toUpperCase() + word.slice(1);
  const snake = word; // already lower-cased word root = snake_case atom
  const kebab = word; // single word: same as snake
  return [...new Set([camel, snake, kebab])];
}


export interface ConceptCompilerOptions {
  /** Minimum distinct symbols a word root must appear in. Default: 3 */
  minSymbolCount?: number;
}

/**
 * Compile exported symbols into ConceptNode[].
 *
 * Algorithm:
 * 1. Collect candidate nodes: exported types + functions.
 * 2. Split each symbol name into word roots via splitCompoundName().
 * 3. Count how many distinct symbols each word root appears in.
 * 4. Threshold filter: keep roots appearing in ≥ 3 distinct symbols.
 * 5. Noise filter: remove generic programming words.
 * 6. For each surviving root, collect all file paths where it appears.
 * 7. Assign to the module where it appears most frequently (→ layer).
 * 8. Compute struct_hash from { id, aliases, appears_in }.
 * 9. Return ConceptNode[] sorted alphabetically by id.
 */
export function compileConcepts(
  nodes: GraphNode[],
  modules: ModuleNode[],
  options?: ConceptCompilerOptions,
): ConceptNode[] {
  const minSymbolCount = options?.minSymbolCount ?? 3;
  // Step 1: filter to exported symbols (types + functions)
  const candidates = nodes.filter(
    (n) =>
      CONCEPT_LABELS.has(n.label) &&
      (n.properties.isExported as boolean | undefined) === true,
  );

  // Build a lookup: moduleId → Set<filePath> (for tie-breaking later, not strictly needed)
  const moduleFileSet = new Map<string, Set<string>>();
  for (const mod of modules) {
    moduleFileSet.set(mod.id, new Set(mod.files));
  }

  // Step 2 & 3: map word root → Set of symbol IDs that contain it
  // Also track word root → Set of file paths where it appears
  const rootToSymbols = new Map<string, Set<string>>();
  const rootToFiles = new Map<string, Set<string>>();

  for (const node of candidates) {
    const name = node.properties.name as string | undefined;
    if (!name) continue;

    const filePath = node.properties.filePath as string | undefined;
    const words = splitCompoundName(name);

    for (const word of words) {
      if (word.length < MIN_WORD_LENGTH) continue;
      if (!rootToSymbols.has(word)) {
        rootToSymbols.set(word, new Set());
        rootToFiles.set(word, new Set());
      }
      rootToSymbols.get(word)!.add(node.id);
      if (filePath) {
        rootToFiles.get(word)!.add(filePath);
      }
    }
  }

  // Step 4 & 5: threshold ≥ 3 distinct symbols, remove noise
  const concepts: ConceptNode[] = [];

  for (const [word, symbolIds] of rootToSymbols) {
    if (symbolIds.size < minSymbolCount) continue;
    if (NOISE_WORDS.has(word)) continue;

    // Step 6: file paths where this concept appears
    const appearsIn = [...rootToFiles.get(word)!].sort();

    // Step 7: find module where this concept appears most
    const moduleCount = new Map<string, number>();
    for (const filePath of appearsIn) {
      const modId = moduleIdForFile(filePath);
      moduleCount.set(modId, (moduleCount.get(modId) ?? 0) + 1);
    }

    let layer = '_root';
    let maxCount = 0;
    for (const [modId, count] of moduleCount) {
      if (count > maxCount || (count === maxCount && modId < layer)) {
        maxCount = count;
        layer = modId;
      }
    }

    // Step 8: struct_hash
    const aliases = buildAliases(word);
    const hash = structHash({ id: word, aliases, appears_in: appearsIn });

    concepts.push({
      id: word,
      aliases,
      appears_in: appearsIn,
      layer,
      struct_hash: hash,
    });
  }

  // Step 9: sort alphabetically by id
  concepts.sort((a, b) => a.id.localeCompare(b.id));

  return concepts;
}
