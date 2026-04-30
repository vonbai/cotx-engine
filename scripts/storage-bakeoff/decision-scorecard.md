# Storage V2 Decision Scorecard

Date: 2026-04-12
Branch: `storage-v2-bakeoff`

## Decision Context

cotx-engine should not keep YAML as the bottom-layer truth store.

The selected storage architecture must make cotx's non-LLM bottom layer at
least comparable to GitNexus on graph facts and stronger on decision-plane
facts. YAML/Markdown should remain an artifact/export layer for review,
human edits, and LLM-enriched documentation.

This scorecard treats future implementation/adapter maintenance cost as low.
The score therefore focuses on bottom-layer capability rather than "how much
code we need to write."

## Evidence Used

Artifacts:

- `results/smoke.json`
- `results/typed-schema-smoke.json`
- `results/fastmcp-10k-copy.json`
- `results/zellij-10k-copy.json`
- `results/ruff-10k-copy.json`
- `results/hybrid-smoke.json`
- `results/sync-fastmcp.json`
- `results/sync-zellij.json`
- `results/sync-ruff.json`
- `results/query-adapter.json`
- `results/npm-audit.json`

Key measured facts:

- LadybugDB COPY path on `10k nodes / 30k edges`: `381-450ms`.
- CozoDB typed decision smoke: `83ms`.
- CozoDB real decision artifact sync:
  - `fastmcp`: `23,711` rows, `561ms`.
  - `zellij`: `75,112` rows, `1697ms`.
  - `ruff`: `277,799` rows, `5237ms`.
- Cozo adapter matched Ladybug/Cypher on `9/9` agent-facing query templates.
- Kuzu npm package is deprecated and the isolated bakeoff package has `4` high audit findings, including a direct `kuzu -> cmake-js -> tar` risk chain.
- LadybugDB + Kuzu in one process segfaulted during early harness work; subprocess isolation fixed it. LadybugDB + CozoDB hybrid smoke completed successfully.

## Evaluation Dimensions

Total: `100`.

| Dimension | Weight | Meaning |
| --- | ---: | --- |
| Code-fact graph expressiveness | 20 | Can it model Symbol/Class/Method/Property/Route/Tool/Process and arbitrary relationships cleanly? |
| Decision-rule expressiveness | 20 | Can it naturally represent canonical paths, symmetry, closure, abstraction, plan/review evidence, and recursive rules? |
| Query quality / agent ergonomics | 15 | Can agents inspect and query the store effectively, including ad-hoc graph questions? |
| Performance / scale | 15 | Bulk ingest, query latency, and observed behavior on `fastmcp`, `zellij`, `ruff`. |
| Operational reliability / ecosystem risk | 15 | Native stability, package health, audit risk, deployment risk. |
| Migration architecture fit | 10 | Can it replace YAML truth without fighting cotx's artifact/export model? |
| Extensibility ceiling | 5 | Can it support future vector/search/analytics/rule use cases? |

## Option Scores

| Option | Code graph | Decision rules | Query quality | Perf | Reliability | Migration fit | Extensibility | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| LadybugDB primary + CozoDB derived rule index | 20 | 20 | 15 | 13 | 11 | 9 | 5 | 93 |
| CozoDB primary + cotx query adapter | 17 | 20 | 12 | 15 | 12 | 8 | 4 | 88 |
| LadybugDB only | 20 | 13 | 15 | 14 | 12 | 9 | 3 | 86 |
| CozoDB only, no explicit query adapter | 17 | 20 | 8 | 15 | 12 | 8 | 4 | 84 |
| LadybugDB primary + DuckDB analytics sidecar | 20 | 13 | 15 | 11 | 12 | 8 | 4 | 83 |
| Kuzu primary + CozoDB rule sidecar | 20 | 20 | 15 | 11 | 4 | 6 | 4 | 80 |
| DuckDB primary | 12 | 10 | 8 | 10 | 12 | 7 | 4 | 63 |

## Recommendation

Choose:

```text
LadybugDB primary truth store + CozoDB derived rule index
```

This should be a logical single-source-of-truth architecture:

- LadybugDB is the primary truth store for code facts and persisted decision facts.
- CozoDB is a rebuildable derived rule index for closure/symmetry/canonical/plan-review inference.
- YAML/Markdown are exports, not source-of-truth storage.

## Why This Beats GitNexus Strategically

GitNexus already proves the value of a LadybugDB graph core and Cypher-based
agent exploration. Copying only that would make cotx a follower.

The selected architecture keeps the GitNexus-grade graph surface:

- typed code facts
- Cypher
- context
- impact
- route/tool/API-shape queries

Then it adds a rule-native layer GitNexus does not currently systematize:

- canonical-path reasoning
- symmetry/closure reasoning
- abstraction opportunity reasoning
- plan/review evidence reasoning

That is the strongest path to a bottom layer that is not merely comparable to
GitNexus, but broader.

## Why Not CozoDB Primary

CozoDB primary is viable and should remain the fallback if LadybugDB native
lifecycle risk becomes unacceptable.

It is especially strong if cotx intentionally exposes only curated tools and a
cotx-owned query DSL. Given adapter maintenance cost is considered low, this
option is credible.

The reason it is not the top recommendation is not implementation effort. It is
bottom-layer product surface:

- Cypher is more natural for GitNexus-style ad-hoc graph exploration.
- Cozo/Datalog is less familiar to general agents and users.
- A query adapter can cover known tool queries, but it is not equivalent to
native arbitrary graph querying.

## Why Not Kuzu

Kuzu is technically plausible and expressive, but current package health makes
it a poor primary choice:

- npm package is deprecated.
- audit chain includes high severity issues through `cmake-js` / `tar`.
- observed performance was behind LadybugDB in COPY-mode samples.

It should not be selected unless its package/distribution story changes.

## Why Not DuckDB Primary

DuckDB remains useful as a possible analytics/reporting/search sidecar, but not
as the primary graph truth store:

- graph traversal requires recursive SQL patterns;
- canonical/closure/review rules are not as natural;
- it does not solve the core "code graph + decision rule graph" problem alone.

## Implementation Spike

Next branch should implement:

1. `GraphTruthStore` using LadybugDB.
2. `DecisionRuleIndex` using CozoDB.
3. Dual-write/projection during compile:
   - raw code facts and decision facts into LadybugDB;
   - decision-rule projection into CozoDB.
4. YAML/Markdown export from DB, not compile-time primary writes.
5. Minimum parity tools:
   - `cypher`
   - `context`
   - `impact`
   - `route_map`
   - `shape_check`
   - `canonical_for`
   - `closure_for`
   - `review_findings_for_patch`
6. Verification repos:
   - `fastmcp`
   - `zellij`
   - `ruff`

Exit criteria:

- cotx can answer GitNexus-class graph queries from LadybugDB;
- cotx can answer decision-plane closure/canonical/review queries from CozoDB;
- YAML artifacts are generated exports and can be deleted/rebuilt from DB;
- compile/runtime does not require reparsing YAML to feed the rule index.
