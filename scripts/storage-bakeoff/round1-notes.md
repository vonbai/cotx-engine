# Storage V2 Bakeoff - Round 1 Notes

Date: 2026-04-12
Branch: `storage-v2-bakeoff`

## Goal

Choose a stronger cotx v2 truth-store direction without prematurely copying
GitNexus's LadybugDB choice.

The desired architecture is likely:

- graph/query database as truth store for code facts and decision-plane facts
- YAML/Markdown as artifact/export/review surface, not primary query storage
- optional search/vector sidecar only if the graph database choice does not cover it well

## Candidates Installed

| Candidate | Package | Version | Initial note |
| --- | --- | --- | --- |
| LadybugDB | `@ladybugdb/core` | `0.15.3` | GitNexus-proven path, Cypher, vector extension docs |
| Kuzu | `kuzu` | `0.11.3` | Cypher/property graph, but npm package is deprecated |
| CozoDB | `cozo-node` | `0.7.6` | Datalog/rule-first, very promising for closure/symmetry |
| DuckDB | `@duckdb/node-api` | `1.5.1-r.2` | Fast relational/analytics sidecar, graph traversal less natural |

Official references used:

- LadybugDB vector extension: https://docs.ladybugdb.com/extensions/vector
- Kuzu npm readme/docs pointer: https://kuzudb.github.io/docs
- CozoDB docs: https://docs.cozodb.org/en/latest/index.html
- DuckDB Node API: https://duckdb.org/docs/stable/clients/node_neo/overview.html
- Flatgraph/Joern storage reference: https://flatgraph.joern.io/

## Implemented Harness

Files:

- `package.json`: isolated candidate dependencies, not root cotx dependencies
- `smoke.mjs`: tiny shared dataset with code facts + decision facts
- `repo-benchmark.mjs`: imports sampled `.cotx/graph/{nodes,edges}.json` into each backend
- `results/*.json`: round 1 outputs

Smoke query families:

- symbol context
- 2-hop impact traversal
- API route shape evidence pair
- closure obligations

Repo query families:

- production-ish code context
- 2-hop graph traversal

## Round 1 Results

Toy smoke:

| Candidate | Result | elapsed_ms |
| --- | --- | ---: |
| LadybugDB | ok | 115.55 |
| Kuzu | ok | 168.95 |
| CozoDB | ok | 55.88 |
| DuckDB | ok | 211.81 |

Sample import/query, `1000` nodes and `3000` edges:

| Repo | LadybugDB | Kuzu | CozoDB | DuckDB |
| --- | ---: | ---: | ---: | ---: |
| fastmcp | 3967.05ms | 3669.92ms | 87.04ms | 242.75ms |
| zellij | 3900.11ms | 3814.82ms | 95.64ms | 244.70ms |
| ruff | 3886.05ms | 3196.03ms | 94.24ms | 258.29ms |

Important caveat: LadybugDB and Kuzu are currently using naive per-node/per-edge
Cypher `CREATE` in the harness. Their real path should use bulk load / COPY.
Do not interpret this as final database write performance.

## Findings

1. All four candidates can express the minimal code-fact and decision-fact model.
2. LadybugDB and Kuzu provide the most natural GitNexus-like Cypher model.
3. CozoDB was dramatically faster on the naive insert path and its Datalog model is a strong fit for rule-like relationships such as closure and symmetry.
4. DuckDB works and is fast enough, but graph traversal requires recursive SQL and edge tables; it looks more like an analytics/search sidecar than the primary graph store.
5. Loading LadybugDB and Kuzu in the same process caused an initial segmentation fault in the harness. Running each adapter in a subprocess fixed it. This matters for the bakeoff harness and suggests native binding isolation should be part of future tests.
6. LadybugDB minimal scripts also showed teardown sensitivity during close/delete. This needs deeper validation before making it the cotx primary store.
7. Kuzu's npm package is marked deprecated. That is a significant product risk even if the database itself remains usable.
8. `npm audit --omit=dev` reports four high-severity findings in the isolated bakeoff package, mainly through `kuzu`/`cmake-js`/`tar` and `cozo-node`'s `@mapbox/node-pre-gyp` chain. This does not affect root cotx dependencies, but it must affect final selection.

## Current Ranking

This is not a final selection.

| Rank | Candidate | Reason |
| --- | --- | --- |
| 1 | CozoDB | Best early speed and strongest fit for rule/closure reasoning; needs query ergonomics and ecosystem validation |
| 2 | LadybugDB | Closest to GitNexus and likely easiest Cypher migration; native lifecycle concerns need validation |
| 3 | Kuzu | Strong graph DB shape, but npm deprecation is a serious risk |
| 4 | DuckDB | Best as sidecar candidate, not primary graph truth store |

## Next Round

1. Add bulk-load paths for LadybugDB and Kuzu before judging performance.
2. Add route/tool/API-shape schema to the repo benchmark, not only generic Node/Edge.
3. Add decision-plane facts: CanonicalPath, SymmetryEdge, ClosureSet, PlanOption, ReviewFinding.
4. Measure DB file size and query latency separately from import time.
5. Run `10k nodes / 30k edges` samples on `fastmcp`, `zellij`, and `ruff`.
6. Evaluate whether CozoDB can support the ergonomics agents need, or whether Cypher compatibility is worth prioritizing.

## Round 2 Update - Bulk Load

Implemented CSV `COPY` loading for LadybugDB and Kuzu in `repo-benchmark.mjs`.
This materially changed the performance interpretation from Round 1.

`10k nodes / 30k edges`, COPY mode:

| Repo | LadybugDB | Kuzu | CozoDB | DuckDB |
| --- | ---: | ---: | ---: | ---: |
| fastmcp | 450.09ms | 874.41ms | 533.08ms | 1859.04ms |
| zellij | 440.57ms | 808.62ms | 522.41ms | 1766.02ms |
| ruff | 381.45ms | 785.23ms | 503.88ms | 1738.25ms |

Revised interpretation:

1. LadybugDB is competitive when used through its intended bulk path.
2. CozoDB remains very strong and still looks attractive for rule/closure queries.
3. Kuzu is slower in these runs and has a package deprecation/audit risk, but remains semantically strong.
4. DuckDB should stay in the sidecar category unless a later analytics-heavy benchmark changes the result.

Revised current ranking:

| Rank | Candidate | Reason |
| --- | --- | --- |
| 1 | LadybugDB | Best bulk-load result, Cypher ergonomics, closest to GitNexus path |
| 2 | CozoDB | Strong performance and Datalog fit for decision rules; ergonomics/ecosystem still need validation |
| 3 | Kuzu | Strong graph model but slower here and npm deprecation/security risk |
| 4 | DuckDB | Viable sidecar, not primary graph truth store |

This ranking is provisional and performance-biased. It must not be treated as
the final storage decision.

## Selection Scorecard

Final selection must score more than speed:

| Dimension | Weight | What to measure |
| --- | ---: | --- |
| Query quality / expressiveness | 25% | Can it naturally express context, impact, API shape, canonical path, closure, plan/review evidence, and recursive architecture cuts? |
| Schema scalability | 20% | Can code facts and decision facts stay first-class without collapsing into a generic property bag? |
| Operational reliability | 20% | Native stability, teardown behavior, concurrent access, corruption recovery, package maintenance, audit risk |
| Performance | 15% | Bulk ingest, incremental update, query latency, DB size on fastmcp/zellij/ruff/ollama |
| Agent ergonomics | 10% | Can agents inspect schema and write ad-hoc queries safely? Cypher/Datalog/SQL learnability |
| Migration fit | 10% | How hard is it to migrate from `.cotx` YAML artifacts while preserving exports/overrides/enrichments? |

Current qualitative read:

| Candidate | Speed | Quality / expressiveness | Scalability | Risk | Notes |
| --- | --- | --- | --- | --- | --- |
| LadybugDB | High after COPY | High for Cypher graph facts | High | Medium | Strong GitNexus precedent; native lifecycle concerns must be tested |
| CozoDB | High | High for rule/closure; medium for agent ad-hoc queries | Medium-high | Medium | Datalog may fit decision-plane better than Cypher, but ecosystem is smaller |
| Kuzu | Medium | High for Cypher graph facts | High | High | Package deprecated and audit chain is concerning |
| DuckDB | Medium-low here | Medium for graph, high for analytics | Medium | Low-medium | Better sidecar than graph truth store |

Next concrete gap: the benchmark still uses a generic `Node/Edge` schema. Round 3
must test typed code-fact + decision-fact schemas before final selection.

## Round 3 Update - Typed Schema Smoke

Added `typed-schema-benchmark.mjs`.

Typed facts covered:

- `Symbol`
- `Route`
- `Consumer`
- `Tool`
- `Process`
- `OperationUnit`
- `ClosureSet`
- `PlanOption`
- `ReviewFinding`

Typed relationships covered:

- `Calls`
- `HandlesRoute`
- `Fetches`
- `HandlesTool`
- `StepInProcess`
- `ClosureRequires`
- `PlanCoversClosure`
- `ReviewFlagsPlan`

Queries covered:

- symbol context
- route response shape mismatch (`missing` key detected)
- tool map
- process trace
- closure obligations
- review finding -> plan option -> closure

Typed schema smoke:

| Candidate | Result | elapsed_ms | Query style |
| --- | --- | ---: | --- |
| LadybugDB | ok | 267.08 | typed node/rel tables + Cypher |
| Kuzu | ok | 331.76 | typed node/rel tables + Cypher |
| CozoDB | ok | 83.12 | typed relations + Datalog |
| DuckDB | ok | 166.78 | typed SQL tables |

Interpretation:

1. All candidates can express the first typed decision-plane schema.
2. LadybugDB and Kuzu are most natural for GitNexus-style agent ad-hoc graph queries.
3. CozoDB remains compelling for rule-like decision relationships and performed best in this small typed schema smoke.
4. DuckDB is viable for typed facts, but still feels better as an analytics/search sidecar than the graph truth store.

Updated selection stance:

- Primary contenders: LadybugDB and CozoDB.
- Kuzu remains technically plausible but needs a package/maintenance risk answer.
- DuckDB remains a sidecar candidate.

Round 4 should test mixed architecture:

- LadybugDB primary graph + Cozo rule sidecar
- Cozo primary + optional Cypher/query adapter feasibility
- LadybugDB primary + DuckDB analytics/FTS sidecar

The final decision should optimize speed, query quality, schema extensibility,
operational reliability, and agent ergonomics together.

## Round 4 Update - Hybrid Architecture Smoke

Added `hybrid-benchmark.mjs`.

Scenarios:

| Scenario | Result | elapsed_ms | Interpretation |
| --- | --- | ---: | --- |
| LadybugDB primary + Cozo rule sidecar | ok | 269.16 | Keeps Cypher graph ergonomics and adds Datalog rule strength; requires dual-store sync/query orchestration |
| CozoDB primary + query adapter | ok | 74.19 | Single rule-capable store and fastest; requires cotx-owned query adapter/templates for agent graph queries |
| LadybugDB primary + DuckDB analytics sidecar | ok | 324.42 | Good analytics sidecar shape, but does not add much for closure/review reasoning |

Important observation:

- LadybugDB + CozoDB in the same scenario completed successfully.
- This did not reproduce the earlier LadybugDB + Kuzu native binding crash.
- The earlier crash still matters for Kuzu risk and for harness design, but it does not currently block a LadybugDB + CozoDB mixed architecture.

Updated strategic read:

1. **LadybugDB primary + CozoDB rule sidecar** is the most balanced architecture if agent ergonomics and GitNexus-level Cypher parity are top priorities.
2. **CozoDB primary** is attractive if decision-plane rules become the dominant workload, but cotx would need to own a query adapter layer to avoid exposing Datalog complexity to agents.
3. **DuckDB sidecar** remains useful for reporting/analytics/possibly FTS, but is not the best answer to canonical/closure/review reasoning.

Recommended Round 5:

- Implement a persistent sync model prototype for LadybugDB -> CozoDB decision facts.
- Measure whether sync overhead is acceptable on `10k/30k` samples.
- Prototype a minimal agent-facing query API over Cozo primary and judge whether it feels worse than Cypher.
- Only after that choose between:
  - LadybugDB primary + CozoDB rule sidecar
  - CozoDB primary + cotx query adapter

## Round 5 Update - Real Decision Artifact Sync

Added `sync-benchmark.mjs`.

This reads real `.cotx` decision artifacts and syncs them into a CozoDB rule
sidecar:

- `canonical-paths`
- `symmetry`
- `closures`
- `abstractions`

Cozo relations:

- `canonical`
- `canonical_entry`
- `canonical_deviation`
- `symmetry`
- `closure`
- `closure_member`
- `abstraction`
- `abstraction_unit`

Results:

| Repo | Artifact rows | parse_ms | insert_ms | query_ms | total_ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| fastmcp | 23,711 | 325.36 | 196.12 | 33.00 | 561.47 |
| zellij | 75,112 | 1065.72 | 516.97 | 95.50 | 1697.23 |
| ruff | 277,799 | 3101.81 | 1885.36 | 243.37 | 5237.12 |

Interpretation:

1. CozoDB can ingest the real decision-plane artifact volume from current cotx output.
2. Query latency for rule-style questions remains acceptable at this scale.
3. The dominant cost is reading/parsing thousands of YAML artifact files, not Cozo itself.
4. This strengthens the argument that YAML should not be the primary fact store for decision facts. It is useful as export/review material, but too expensive/noisy as the sync source of truth.
5. If LadybugDB primary + CozoDB sidecar is selected, decision facts should be written directly to both stores during compile rather than re-parsed from YAML.

Updated recommendation:

- Prefer **LadybugDB primary + CozoDB rule sidecar** for the next implementation spike.
- Keep Cozo-primary as a serious alternative only if the query adapter can be made small and safe.
- Do not choose YAML as the decision-fact source of truth.

## Round 6 Update - Cozo Primary Query Adapter

Added `query-adapter-benchmark.mjs`.

It compares nine agent-facing query templates between LadybugDB/Cypher and a
CozoDB/Datalog adapter:

- `context`
- `downstreamImpact`
- `upstreamImpact`
- `routeShape`
- `toolMap`
- `processTrace`
- `canonicalForConcern`
- `closureForUnit`
- `reviewForPlan`

Result:

| Adapter | elapsed_ms | templates | total_chars | avg_chars |
| --- | ---: | ---: | ---: | ---: |
| LadybugDB/Cypher | 285.90 | 9 | 992 | 110 |
| CozoDB adapter | 70.42 | 9 | 1206 | 134 |

All nine query results matched.

Interpretation:

1. Cozo primary can reproduce the current planned tool query set.
2. The adapter is not huge for a fixed tool surface, but it is a real product component.
3. Cozo does not give agents native ad-hoc Cypher-style graph exploration; cotx would need to expose safe query templates or a custom query DSL.
4. This keeps Cozo primary viable for a fixed MCP tool surface, but LadybugDB primary remains better if arbitrary graph exploration is a first-class goal.

Updated recommendation after Round 6:

- Choose **LadybugDB primary + CozoDB rule sidecar** if GitNexus-level ad-hoc graph query parity is required.
- Choose **CozoDB primary + query adapter** only if we intentionally narrow the agent surface to curated cotx tools and accept that arbitrary graph querying goes through a cotx-owned DSL.
