# cotx-engine

Compile any codebase into a persistent, queryable semantic map. AI agents use the map to understand project structure without reading every file.

## Install

```bash
npm install -g cotx-engine
```

Or use directly:

```bash
npx cotx-engine compile
```

## Quick Start

```bash
# Compile the current project
cotx compile

# Optional: choose compile enrichment policy
cotx compile --enrich-policy bootstrap-if-available

# See what was found
cotx status

# Prepare a task before development/review
cotx codrive "change API response"

# Search for a concept
cotx query "authentication"

# Inspect a specific module
cotx context src/auth

# Check blast radius before editing
cotx impact src/auth
```

## What It Does

cotx-engine parses your source code with Tree-sitter, builds a deterministic storage-v2 truth graph, compiles semantic and architecture layers, and optionally runs built-in bootstrap or incremental enrichment when LLM is configured.

```
Source code
  -> Tree-sitter parse (15 languages)
  -> Knowledge graph (symbols + relationships)
  -> Leiden community detection (module boundaries)
  -> BFS flow tracing (execution paths)
  -> storage-v2 truth graph + semantic artifacts
  -> architecture workspace / recursion / doctrine / decision facts
  -> optional bootstrap or incremental enrich
  -> MCP / CLI / HTTP workbench access
```

Architecture compilation now uses a deterministic source-root inventory:

- discover all candidate code roots, not just the first matching convention
- classify roots by role (`repo-core`, `app`, `package`, peripheral)
- project `overall-architecture` from selected roots only
- keep optional LLM/agent review advisory-only, never as architecture truth

### Bootstrap and Incremental Enrich

`cotx compile` remains deterministic first, but now supports built-in LLM enrichment policies:

```bash
# Default: on cold start, compile deterministic truth first and then bootstrap enrich
cotx compile --enrich-policy bootstrap-if-available

# Never auto-enrich during compile
cotx compile --enrich-policy never

# Require built-in LLM bootstrap and fail if it cannot run
cotx compile --enrich-policy force-bootstrap
```

Cold-start bootstrap is intended to create a reusable global cognition baseline:

- workspace summary
- onboarding summary
- overall architecture / data-flow architecture views
- module responsibility enrichment
- architecture narrative enrichment when no architecture baseline exists yet

Incremental refresh supports a separate enrich policy:

```bash
# Default: recompile and enrich only affected stale nodes when LLM is configured
cotx update --enrich-policy affected-if-available

# Re-enrich every stale node after update
cotx update --enrich-policy stale-if-available

# Skip incremental enrich completely
cotx update --enrich-policy never

# Require affected incremental enrich and fail if it cannot run
cotx update --enrich-policy force-affected
```

The bootstrap baseline is recorded in `.cotx/meta.yaml` with git/worktree metadata so later compiles can reuse existing enrichment instead of rerunning full bootstrap blindly. `.cotx/` is treated as a local build artifact: cotx writes a local git exclude entry by default, and new git worktrees auto-seed from a fresh sibling `.cotx/` when one is available.

### Semantic Layers

| Layer | What it captures |
|-------|-----------------|
| **Modules** | Directory + community-based grouping of related files |
| **Concepts** | Word roots extracted from symbol names (what the code is about) |
| **Contracts** | Cross-module interface functions (how modules talk to each other) |
| **Flows** | Execution traces from entry points to terminals |

### Supported Languages

TypeScript, JavaScript, Python, Java, Kotlin, Go, Rust, C, C++, C#, Ruby, PHP, Swift, Dart, Vue

## CLI Commands

| Command | Purpose |
|---------|---------|
| `cotx compile` | Full compile with optional cold-start bootstrap enrich |
| `cotx status` | Show map stats (modules, concepts, contracts, flows) |
| `cotx query <keyword>` | BM25 search across all layers |
| `cotx context <node-id>` | 360-degree view: data + incoming/outgoing edges |
| `cotx impact <node-id>` | BFS blast radius analysis |
| `cotx map --scope overview` | Markdown summary of project structure |
| `cotx codrive [task...]` | Print a bounded CLI/MCP co-driving workflow |
| `cotx plan-change <target>` | Plan a coherent project change before editing |
| `cotx review-change [files...]` | Review current changes against project doctrine |
| `cotx cypher <query>` | Read-only Cypher query against storage-v2 truth |
| `cotx decision-query <kind> <target>` | Query canonical/closure decision rules |
| `cotx doctrine` | Show compiled project doctrine |
| `cotx canonical-paths` | Show compiled canonical paths |
| `cotx source-roots` | Show deterministic source-root inventory (`--assist` adds non-authoritative agent review) |
| `cotx enrich --auto` | Enrich stale semantic or architecture nodes with built-in LLM |
| `cotx agent-analyze --layer ... --task ...` | Run built-in agentic layer analysis |
| `cotx write <id> <field> <value>` | Write enrichment or annotation to a node |
| `cotx lint` | Check map-to-code consistency |
| `cotx snapshot --tag <name>` | Save current map state |
| `cotx diff --snapshot <name>` | Semantic diff against a snapshot |
| `cotx update [files...]` | Incremental refresh with optional incremental enrich |
| `cotx serve` | Start MCP server (stdio) |
| `cotx serve --http --port 3000` | Start HTTP MCP server |
| `cotx daemon start [--port 3000]` | Start the HTTP MCP daemon in the background (PID-tracked) |
| `cotx daemon stop` | Stop the running daemon |
| `cotx daemon status` | Show daemon state, port, and uptime |
| `cotx embed` | Build `.cotx/embeddings.json` (powers semantic-similarity `cotx query --mode semantic`) |

## MCP Server

cotx-engine exposes a wider MCP tool surface than the original 10-tool release. The current server defines 22 task-relevant tool endpoints, including bootstrap/context tools, route/tool maps, detect-changes, plan/review, and storage-v2 query surfaces.

```bash
# stdio (for Claude Code, Cursor, etc.)
cotx serve

# HTTP (Streamable HTTP + legacy SSE)
cotx serve --http --host 127.0.0.1 --port 3000
```

Stdio mode now includes a lifecycle watchdog for embedded agent sessions:

- startup timeout if the parent launches `cotx serve` but never sends MCP traffic
- idle timeout after a period with no stdio activity
- parent-exit detection when the launching process disappears

Defaults are conservative (`60s` startup, idle timeout disabled by default). Tune with:

- `COTX_STDIO_STARTUP_TIMEOUT_MS`
- `COTX_STDIO_IDLE_TIMEOUT_MS`
- `COTX_STDIO_WATCHDOG_INTERVAL_MS`
- `COTX_STDIO_WATCHDOG_DISABLED=1`

| Tool | Purpose |
|------|---------|
| `cotx_compile` | Full/delta compile |
| `cotx_query` | BM25 search across all layers |
| `cotx_context` | Node 360-degree view |
| `cotx_impact` | Blast radius analysis |
| `cotx_map` | Markdown project summary |
| `cotx_write` | Write enrichment to a node |
| `cotx_lint` | Map-to-code consistency check |
| `cotx_diff` | Semantic diff against snapshot |
| `cotx_doctrine` | Compiled project doctrine |
| `cotx_cypher` | Read-only Cypher over storage-v2 truth |
| `cotx_decision_query` | Canonical/closure decision rule queries |
| `cotx_canonical_paths` | Canonical path summary |
| `cotx_route_map` | Route handler/consumer map |
| `cotx_shape_check` | Response-shape mismatch check |
| `cotx_api_impact` | Route/file pre-change impact |
| `cotx_tool_map` | Tool handler map |
| `cotx_detect_changes` | Diff hunks -> typed graph impact |
| `cotx_plan_change` | Change planning |
| `cotx_review_change` | Doctrine-backed change review |
| `cotx_onboarding_context` | Deterministic onboarding context |
| `cotx_minimal_context` | Deterministic route map before code reading |
| `cotx_prepare_task` | Unified bootstrap entrypoint that decides bootstrap/enrich/develop/review and recommends next tools |

Prompt/workflow surfaces are also designed so agents can:

1. `cotx_prepare_task`
2. bootstrap/enrich only if needed
3. `cotx_plan_change` before editing
4. `cotx_detect_changes` / `cotx_review_change` after editing

## Output Structure

```
.cotx/
├── meta.yaml           # version, compiled_at, stats
├── workspace-layout.json
├── index.json          # full node/edge listing
├── graph/              # raw parse output
├── v2/                 # truth.lbug + rules.db
├── architecture/       # canonical workspace, perspectives, recursion plan
├── doctrine/
├── plans/
├── reviews/
├── modules/*.yaml      # module definitions
├── concepts/*.yaml     # extracted concepts
├── contracts/*.yaml    # cross-module interfaces
├── flows/*.yaml        # execution traces
└── log.jsonl           # operation log
```

## Performance

Tested on real projects:

| Project | Language | Files | Compile Time |
|---------|----------|-------|-------------|
| envconfig | Go | 17 | 0.4s |
| gum | Go | 116 | 0.6s |
| flask | Python | 236 | 1.8s |
| zod | TypeScript | 564 | 3.1s |
| spring-petclinic | Java | 127 | 0.6s |
| mini-redis | Rust | 33 | 0.5s |

## License

[BSL 1.1](LICENSE) — free for individuals and teams of 10 or fewer. Converts to Apache 2.0 two years after each release.
