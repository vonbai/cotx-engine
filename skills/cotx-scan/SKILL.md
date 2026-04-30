---
name: cotx-scan
description: Architecture scanning skill. Reviews auto-generated architecture and enriches with domain-specific descriptions, diagram adjustments, and boundary corrections. Use when the user says "cotx scan", "scan architecture", "enrich architecture", or "update architecture perspectives".
---

# cotx-scan — Evidence-Backed Architecture Scanner

## Purpose

Review and enrich cotx architecture context using the canonical workspace and graph-backed evidence.

The agent should not start by Glob/Read over the full source tree. cotx's static analysis and workspace scan provide bounded starting context. Use MCP tools first, then read targeted source files only when needed to verify implementation details, resolve graph gaps, or answer a question that the map cannot support.

- `.cotx/workspace-layout.json` is a deterministic layout sidecar, not truth graph.
- `.cotx/architecture/workspace.json` is the canonical C4/Structurizr-style architecture model.
- `.cotx/architecture/recursion-plan.json` records deterministic leaf/recurse decisions.
- LLM or agent output may enrich narrative fields only. It must not create graph truth.

---

## Step 1: Get Minimal Context

```
cotx_minimal_context project_root=<project_root> task="scan architecture" budget=standard
```

If `.cotx/` is missing, run `cotx_compile` first. Do not read the full repository.

---

## Step 2: Review Architecture Summary

```
cotx_map scope=architecture
```

This includes the workspace layout summary and available architecture perspectives. The canonical workspace is the source for future exports; legacy perspective sidecars remain readable context.

---

## Step 3: Read Targeted Context

Use targeted cotx tools:

```
cotx_map scope=overview
cotx_context node_id=architecture/<perspective-id>
cotx_context node_id=architecture/<perspective-id>/<component-id>
cotx_query query="<domain term>" layer=architecture
```

---

## Step 4: Enrich Only With Evidence

For each enrichment draft:

- Cite evidence anchors from returned cotx context.
- Use `cotx_write` only for enrichment or architecture narrative fields.
- Do not mutate deterministic files, functions, edges, routes, tools, processes, or workspace facts.
- Prefer writing descriptions over diagrams. Adjust diagrams only when the rendered view is misleading and IDs still map to canonical elements.

```
cotx_write node_id=architecture/<perspective-id> field=description content="..."
cotx_write node_id=architecture/<perspective-id>/<component-id> field=description content="..."
```

---

## Step 5: Recursive Drill-Down

Use the recursion plan when available. Recurse only into elements marked `recurse`; treat `leaf` as terminal unless new graph evidence contradicts it.

---

## Step 6: Verify

Search for key domain concepts to confirm the architecture is queryable:

```
cotx_query query="<key domain term>" layer=architecture
```

Verify that results point to relevant perspectives and components.

---

## Tips

- **Descriptions answer "why"**: Write what responsibility a component *owns*, not what files it *contains*. The data already shows files.
- **Don't over-recurse**: If a component has 2-3 files and one purpose, it's a leaf. Recurse only when there are genuinely distinct sub-responsibilities.
- **For monorepos**: Check workspace layout and package boundaries before module-level interpretation.
- **Preserve deterministic data**: Auto-generated workspace/graph data captures structural truth; agent descriptions add semantic meaning.

## Important

- Do NOT start with broad source reads. Use cotx tools first, then read targeted files when the graph/context is insufficient or needs verification.
- Do NOT modify `files`, `exported_functions`, or other structural fields — only `description` and `diagram`.
- Do NOT create or mutate truth graph facts from LLM output.
- Write each field as a separate `cotx_write` call.
