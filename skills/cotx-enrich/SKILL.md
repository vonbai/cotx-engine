---
name: cotx-enrich
description: Enrich stale nodes in the cognitive map with semantic descriptions. Run after cotx compile or cotx update when stale enrichments are reported.
---

## When to Use

After `cotx compile` or `cotx update` reports stale enrichments, or when `cotx lint` shows STALE_ENRICHMENT warnings.

## Workflow

### Step 1: Get bounded context first

Use cotx context tools before reading source files directly.

For MCP clients:

```text
cotx_minimal_context project_root=<project_root> task="enrich stale semantic descriptions" budget=standard
cotx_query project_root=<project_root> filter=stale layer=all
```

For CLI-only usage, start with:

```bash
cotx lint --json
```

Do not read the full repository. Use the returned modules, contracts, flows, files, and recommendations to pick a small set of enrichment targets.

### Step 2: Find stale nodes

Run: `cotx lint --json`

This returns a JSON array of issues. Filter for `type: "STALE_ENRICHMENT"` entries.

### Step 3: For each stale node

1. **Read the node**: `cotx context <node_id>`
   - Note the `layer` and `struct_hash`
   - Note what fields are stale (enriched.source_hash ≠ struct_hash)

2. **Use cotx graph context first**:
   - For modules: inspect dependencies, depended-by modules, contracts, and flows from cotx context/query output.
   - For contracts: inspect provider/consumer and interface functions.
   - For flows: inspect trigger and step chain.

3. **Read source only when the cotx context is insufficient**: Use targeted file reads for the small file set referenced by the node.
   - For modules: read the files listed in the module
   - For concepts: read files in `appears_in`
   - For contracts: read the interface functions in provider module
   - For flows: read the functions in each step

4. **Understand the change**: Compare what the old enrichment says vs what the code actually does now

5. **Write updated enrichment**:
   ```bash
   cotx write <node_id> enriched.responsibility "new description based on code"
   cotx write <node_id> enriched.key_patterns "observed patterns"
   ```

### Step 4: Verify

Run: `cotx lint --json`
Confirm the stale enrichment warnings are resolved (source_hash now matches struct_hash).

## Field Guide

| Layer | Enrichable Fields | What to Write |
|-------|------------------|---------------|
| Module | `enriched.responsibility` | One-sentence module purpose |
| Module | `enriched.key_patterns` | Key design patterns used |
| Concept | `enriched.definition` | Natural language definition |
| Contract | `enriched.guarantees` | What the interface promises |
| Contract | `enriched.invariants` | Rules that must hold |
| Flow | `enriched.error_paths` | What happens when steps fail |

## Important

- Only enrich nodes you understand. Skip nodes where the code is unclear.
- Do NOT modify deterministic fields (files, struct_hash, etc.) — only enriched.* fields.
- Do NOT create or mutate truth graph facts from LLM output.
- Prefer cotx tool context over full-repository source reads.
- Enrichment is optional — stale enrichments don't block any operation.
- Focus on the most important nodes first (modules and contracts over individual concepts).
