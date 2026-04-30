import type { ModuleNode, ConceptNode, ContractNode, FlowNode } from '../store/schema.js';
import type { GraphNode } from '../core/export/json-exporter.js';
import { splitCompoundName } from '../lib/naming.js';
import { eng as ENGLISH_STOPWORDS } from 'stopword';

const SKIP_WORDS = new Set([
  ...ENGLISH_STOPWORDS,
  'get', 'set', 'new', 'create', 'handle', 'error', 'config', 'init',
  'test', 'mock', 'base', 'default', 'internal', 'util', 'helper',
  'func', 'run', 'load', 'save', 'read', 'write', 'parse',
  'string', 'value', 'result', 'node', 'file', 'path', 'name',
  'args', 'options', 'command', 'true', 'false', 'null',
]);

/**
 * Generate deterministic one-line descriptions for modules that lack
 * enriched.responsibility. Uses function/type names to extract the
 * top action verbs and domain nouns.
 *
 * Only writes auto_description (not enriched.responsibility) to avoid
 * overwriting LLM-quality enrichments. The map display prefers
 * enriched.responsibility when available, falls back to auto_description.
 * Mutates in place; persistence is the caller's responsibility.
 */
export function applyAutoDescriptionsToModules(
  nodes: GraphNode[],
  modules: ModuleNode[],
): void {
  // Build: moduleId → list of exported function/type names
  const moduleNames = new Map<string, string[]>();

  // Map file → moduleId
  const fileToModule = new Map<string, string>();
  for (const mod of modules) {
    for (const f of mod.files) {
      fileToModule.set(f, mod.id);
    }
  }

  for (const node of nodes) {
    const fp = node.properties.filePath as string | undefined;
    const name = node.properties.name as string | undefined;
    const exported = node.properties.isExported as boolean | undefined;
    if (!fp || !name || !exported) continue;

    const modId = fileToModule.get(fp);
    if (!modId) continue;

    if (!moduleNames.has(modId)) moduleNames.set(modId, []);
    moduleNames.get(modId)!.push(name);
  }

  for (const mod of modules) {
    const names = moduleNames.get(mod.id) ?? [];
    // Always generate a description — even if there are no function names,
    // fall back to file-based metadata so no module is left without an
    // auto_description.
    const desc = generateDescription(names, mod.canonical_entry) ?? describeByFiles(mod);
    if (!desc) continue;

    // Write as auto_description — a deterministic fallback.
    // Never overwrites LLM-written responsibility.
    const enriched = mod.enriched ?? {
      source_hash: mod.struct_hash,
      enriched_at: new Date().toISOString(),
    };
    (enriched as Record<string, unknown>).auto_description = desc;
    enriched.source_hash = mod.struct_hash;
    enriched.enriched_at = new Date().toISOString();
    mod.enriched = enriched;
  }
}

/**
 * Fallback module description for doc-only / config-only modules with no
 * exported function names. Categorizes files by extension and returns a
 * short factual summary.
 */
function describeByFiles(mod: ModuleNode): string | null {
  if (mod.files.length === 0) return null;
  const extCounts = new Map<string, number>();
  for (const f of mod.files) {
    const ext = (f.match(/\.([a-zA-Z0-9]+)$/)?.[1] ?? '<none>').toLowerCase();
    extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
  }
  const kinds = [...extCounts.entries()].sort((a, b) => b[1] - a[1]);
  const kindLabel = (ext: string, count: number): string => {
    if (ext === 'md') return `${count} markdown doc${count > 1 ? 's' : ''}`;
    if (ext === 'json') return `${count} JSON config${count > 1 ? 's' : ''}`;
    if (ext === 'yaml' || ext === 'yml') return `${count} YAML file${count > 1 ? 's' : ''}`;
    return `${count} .${ext}`;
  };
  const composition = kinds.slice(0, 3).map(([ext, c]) => kindLabel(ext, c)).join(', ');
  const sample = mod.files.slice(0, 3).join(', ');
  return `${mod.files.length} file${mod.files.length > 1 ? 's' : ''} (${composition}). Sample: ${sample}`;
}

/**
 * Concept auto_description: summarize via aliases + appears_in.
 * Always produces output when the concept has any aliases or appearances.
 * Mutates nodes in place; persistence is the caller's responsibility.
 */
export function applyAutoDescriptionsToConcepts(concepts: ConceptNode[]): void {
  for (const c of concepts) {
    const desc = buildConceptAutoDescription(c);
    if (!desc) continue;
    const enriched = c.enriched ?? {
      source_hash: c.struct_hash,
      enriched_at: new Date().toISOString(),
    };
    (enriched as Record<string, unknown>).auto_description = desc;
    enriched.source_hash = c.struct_hash;
    enriched.enriched_at = new Date().toISOString();
    c.enriched = enriched;
  }
}

function buildConceptAutoDescription(c: ConceptNode): string | null {
  const aliases = (c.aliases ?? []).slice(0, 4);
  const appears = (c.appears_in ?? []).slice(0, 3);
  if (aliases.length === 0 && appears.length === 0) return null;
  const parts: string[] = [];
  if (c.layer && c.layer !== 'unknown') parts.push(`layer=${c.layer}`);
  if (aliases.length) parts.push(`aliases: ${aliases.join(', ')}`);
  if (appears.length) parts.push(`appears in: ${appears.join(', ')}${c.appears_in.length > 3 ? ` (+${c.appears_in.length - 3})` : ''}`);
  return `\`${c.id}\` — ${parts.join('; ')}`;
}

/**
 * Contract auto_description: provider/consumer + interface summary.
 * Mutates in place.
 */
export function applyAutoDescriptionsToContracts(contracts: ContractNode[]): void {
  for (const ct of contracts) {
    const desc = buildContractAutoDescription(ct);
    if (!desc) continue;
    const enriched = ct.enriched ?? {
      source_hash: ct.struct_hash,
      enriched_at: new Date().toISOString(),
    };
    (enriched as Record<string, unknown>).auto_description = desc;
    enriched.source_hash = ct.struct_hash;
    enriched.enriched_at = new Date().toISOString();
    ct.enriched = enriched;
  }
}

function buildContractAutoDescription(ct: ContractNode): string | null {
  if (!ct.provider || !ct.consumer) return null;
  const iface = (ct.interface ?? []).slice(0, 5);
  const ifaceStr = iface.length ? ` via ${iface.map((i) => typeof i === 'string' ? i : (i as { name?: string }).name ?? String(i)).join(', ')}` : '';
  const more = ct.interface && ct.interface.length > iface.length ? ` (+${ct.interface.length - iface.length} more)` : '';
  return `${ct.provider} → ${ct.consumer}${ifaceStr}${more}`;
}

/**
 * Flow auto_description: trigger + step chain summary.
 * Mutates in place.
 */
export function applyAutoDescriptionsToFlows(flows: FlowNode[]): void {
  for (const f of flows) {
    const desc = buildFlowAutoDescription(f);
    if (!desc) continue;
    const enriched = f.enriched ?? {
      source_hash: f.struct_hash,
      enriched_at: new Date().toISOString(),
    };
    (enriched as Record<string, unknown>).auto_description = desc;
    enriched.source_hash = f.struct_hash;
    enriched.enriched_at = new Date().toISOString();
    f.enriched = enriched;
  }
}

function buildFlowAutoDescription(f: FlowNode): string | null {
  const steps = Array.isArray(f.steps) ? f.steps : [];
  if (!f.trigger && steps.length === 0) return null;
  const firstSteps = steps
    .slice(0, 4)
    .map((s) => {
      const fn = (s as { function?: string }).function ?? '?';
      return fn;
    });
  const trigger = f.trigger ?? '(unknown)';
  const chain = firstSteps.length > 0 ? ` → ${firstSteps.join(' → ')}${steps.length > firstSteps.length ? ` → (+${steps.length - firstSteps.length} more)` : ''}` : '';
  const modules = Array.from(new Set(steps.map((s) => (s as { module?: string }).module).filter(Boolean))).slice(0, 3);
  const moduleStr = modules.length ? `. Touches ${modules.join(', ')}` : '';
  return `Entry: ${trigger}${chain}${moduleStr}`;
}

function generateDescription(names: string[], canonicalEntry: string): string | null {
  // Extract word roots from all exported names
  const wordCounts = new Map<string, number>();
  for (const name of names) {
    const words = splitCompoundName(name);
    for (const w of words) {
      if (w.length < 3 || SKIP_WORDS.has(w)) continue;
      wordCounts.set(w, (wordCounts.get(w) ?? 0) + 1);
    }
  }

  if (wordCounts.size === 0) return null;

  // Top 5 words by frequency, then alphabetically
  const sorted = [...wordCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5);

  const topWords = sorted.map(([w]) => w);

  // Build: "Handles <top words> operations via <canonical entry>"
  const wordsStr = topWords.join(', ');
  if (canonicalEntry) {
    return `${capitalize(topWords[0])} operations: ${wordsStr} (entry: ${canonicalEntry})`;
  }
  return `${capitalize(topWords[0])} operations: ${wordsStr}`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
