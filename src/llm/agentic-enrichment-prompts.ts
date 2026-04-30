/**
 * System prompts for the agentic enrichment session.
 *
 * Design principle: cotx orchestrates; agent has intelligence. These prompts
 * state the goal, the resources available, and the quality bar. They do NOT
 * prescribe how many rounds, when to read, or how to batch — that's the
 * agent's decision. If the agent needs to Read a file, let it decide; if the
 * skeleton is enough, let it decide that too.
 */

import type { CotxMeta } from '../store/schema.js';

// Single system prompt shared by every enrichment invocation. The input
// describes WHAT to enrich (which nodes, which fields); the prompt
// describes HOW to enrich it (tools, quality bar). No stage-specific
// branching.
export const ENRICHMENT_SYSTEM_PROMPT = `You are enriching a cotx semantic map. Each input node carries:
- its algorithmically-extracted skeleton (file list, aliases, interface names, call chain — whatever the compiler derived from source)
- \`auto_description\` — a deterministic keyword/path summary that is always present as a fallback
- the target field to fill

Possible target fields, by layer:
- module        → enriched.responsibility   (what this module owns)
- concept       → enriched.definition        (domain meaning in THIS project)
- contract      → enriched.guarantees        (what provider promises consumer)
- flow          → enriched.error_paths       (actual thrown exceptions / guard clauses / early returns)
- architecture  → enriched.description / enriched.diagram (Mermaid)  — component role in the hierarchy, referencing module responsibilities by name

You have full repo tools: Read, Grep, Glob, ls, cotx_context. Use whatever helps; skip the tools you don't need. The input may mix layers in one call — process them in whatever order makes sense (e.g. module responsibilities before architecture descriptions that reference them).

Quality bar:
- Cite specifics — file names, function names, literal behaviors. A sentence that could apply to any codebase isn't an enrichment.
- Skip honestly. If a node can't be grounded confidently, auto_description stays as the fallback — that's better than a plausible-sounding guess.

Emit independent tool calls in parallel when you can; the execution layer runs them concurrently. Call cotx_finalize when done. Budget cap: 300 tool calls.`;


/**
 * Build the user-facing context payload for the agent's first prompt.
 * Content is a JSON string the agent parses on its own.
 */
export interface EnrichmentSessionInput {
  /** Informational label for logs and prompt context. */
  label: string;
  project_root: string;
  project_name: string;
  compile_stats: CotxMeta['stats'];
  /** Skeleton data — shape is caller-defined (nodes list, module list, architecture list, etc.). */
  skeleton: Record<string, unknown>;
}

export function formatEnrichmentInput(input: EnrichmentSessionInput): string {
  return JSON.stringify(input, null, 2);
}
