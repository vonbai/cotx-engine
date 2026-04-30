#!/usr/bin/env node
import { Command } from 'commander';
import { commandInit } from './commands/init.js';
import { commandCompile } from './commands/compile.js';
import { runCompileInChildWithRetry, isCompileChild } from './commands/compile-retry-wrapper.js';
import { commandEnrichBg } from './commands/enrich-bg.js';
import { commandStatus } from './commands/status.js';
import { commandQuery, QUERY_LAYER_HELP } from './commands/query.js';
import { commandContext } from './commands/context.js';
import { commandImpact } from './commands/impact.js';
import { commandMap, commandMapHtml } from './commands/map.js';
import { commandWrite } from './commands/write.js';
import { commandLint } from './commands/lint.js';
import { commandUpdate } from './commands/update.js';
import { commandSnapshot } from './commands/snapshot.js';
import { commandRename } from './commands/rename.js';
import { commandMigrate } from './commands/migrate.js';
import { commandDiff } from './commands/diff.js';
import { commandCypher } from './commands/cypher.js';
import { commandDecisionQuery } from './commands/decision-query.js';
import { commandDoctrine } from './commands/doctrine.js';
import { commandCanonicalPaths } from './commands/canonical-paths.js';
import { commandPlanChange } from './commands/plan-change.js';
import { commandReviewChange } from './commands/review-change.js';
import { commandSourceRoots } from './commands/source-roots.js';
import { commandCodrive } from './commands/codrive.js';
import { commandTruthCorrections } from './commands/truth-corrections.js';
import { commandSetup, commandUninstall } from './commands/setup.js';
import { commandDaemonStart, commandDaemonStop, commandDaemonStatus } from './commands/daemon.js';
import { commandProjectsList, commandProjectsRemove } from './commands/projects.js';
import { startMcpHttpServer, startMcpServer } from './mcp/server.js';
import type { CompileEnrichPolicy } from './store/schema.js';
import type { IncrementalEnrichPolicy } from './store/schema.js';

const program = new Command();

program
  .name('cotx')
  .description('Cognitive context engine — compile codebases into semantic maps')
  .version('0.1.0');

program
  .command('init')
  .description('Initialize .cotx/ in current project')
  .action(() => commandInit(process.cwd()));

function parseCompileEnrichPolicy(value: string): CompileEnrichPolicy {
  if (value === 'never' || value === 'bootstrap-if-available' || value === 'force-bootstrap') {
    return value;
  }
  throw new Error(`Invalid enrich policy: ${value}. Use never, bootstrap-if-available, or force-bootstrap.`);
}

function parseIncrementalEnrichPolicy(value: string): IncrementalEnrichPolicy {
  if (value === 'never' || value === 'affected-if-available' || value === 'stale-if-available' || value === 'force-affected') {
    return value;
  }
  throw new Error(`Invalid enrich policy: ${value}. Use never, affected-if-available, stale-if-available, or force-affected.`);
}

program
  .command('enrich-bg <projectRoot>')
  .description('(internal) Background enrichment worker. Spawned by compile; not typically called directly.')
  .action(async (projectRoot: string) => {
    await commandEnrichBg(projectRoot);
    process.exit(0);
  });

program
  .command('compile')
  .description('Full compile: parse codebase → build graph → emit .cotx/ (auto-seeds sibling worktrees when possible)')
  .option('--enrich-policy <policy>', 'never | bootstrap-if-available | force-bootstrap', 'bootstrap-if-available')
  .option('--seed-from <path>', 'Override auto-seed source and bootstrap .cotx/ from a specific sibling worktree')
  .option('--force-full', 'Bypass all incremental caches and take the full legacy compile path (debug / A-B comparison)', false)
  .option('--no-retry-wrapper', 'Skip the subprocess retry wrapper (internal; used by the wrapper itself)')
  .action(async (options) => {
    // Phase D step 2c: if we're not already the child of the retry wrapper,
    // fork ourselves so SIGABRT from intermittent native crashes can be
    // caught and retried transparently. --no-retry-wrapper and COTX_COMPILE_CHILD
    // opt out (the wrapper itself sets the env var to prevent recursion).
    const inChild = isCompileChild();
    const skipWrapper =
      options.noRetryWrapper ||
      options.forceFull ||
      process.env.COTX_FORCE_FULL === '1';
    if (!inChild && !skipWrapper) {
      const forwarded: string[] = [];
      if (options.enrichPolicy) forwarded.push('--enrich-policy', options.enrichPolicy);
      if (options.seedFrom) forwarded.push('--seed-from', options.seedFrom);
      const code = await runCompileInChildWithRetry({ args: forwarded });
      process.exit(code);
    }
    await commandCompile(process.cwd(), {
      enrichPolicy: parseCompileEnrichPolicy(options.enrichPolicy),
      seedFrom: options.seedFrom,
      forceFull: options.forceFull || process.env.COTX_FORCE_FULL === '1',
    });
  });

program
  .command('status')
  .description('Show .cotx/ map status')
  .action(() => commandStatus(process.cwd()));

program
  .command('query <keyword>')
  .description('Search map nodes by keyword')
  .option('--layer <layer>', QUERY_LAYER_HELP)
  .action((keyword, options) => commandQuery(process.cwd(), keyword, options));

program
  .command('context <node-id>')
  .description('Show 360° view of a map node')
  .action((nodeId) => commandContext(process.cwd(), nodeId));

program
  .command('impact <target>')
  .description('Show blast radius of changing a node')
  .option('--direction <dir>', 'upstream (default) or downstream', 'upstream')
  .action((target, options) => commandImpact(process.cwd(), target, options));

program
  .command('map')
  .description('Generate map summary (markdown or interactive HTML)')
  .option('--scope <scope>', 'overview, module:<id>, or flow:<id>', 'overview')
  .option('--depth <n>', 'Detail level 1-3', '2')
  .option('--html', 'Generate interactive HTML map')
  .option('--out <path>', 'Output path for HTML (default: .cotx/map.html)')
  .option('--no-open', 'Do not open browser after generating HTML')
  .action(async (options) => {
    if (options.html) {
      await commandMapHtml(process.cwd(), { out: options.out, noOpen: !options.open });
      return;
    }
    await commandMap(process.cwd(), { scope: options.scope, depth: parseInt(options.depth) });
  });

program
  .command('write <node-id> <field> <content>')
  .description('Write to enriched or annotation zone of a map node')
  .action(async (nodeId, field, content) => {
    const result = await commandWrite(process.cwd(), nodeId, field, content);
    console.log(result.message);
    if (!result.success) process.exitCode = 1;
  });

program
  .command('lint')
  .description('Check map ↔ code consistency')
  .option('--json', 'Output as JSON')
  .option('--strict', 'Exit with error code on any ERROR')
  .option('--fix', 'Auto-fix removable issues')
  .action((options) => {
    void commandLint(process.cwd(), options);
  });

program
  .command('update [files...]')
  .description('Incremental update: recompile affected nodes from changed files')
  .option('--enrich-policy <policy>', 'never | affected-if-available | stale-if-available | force-affected', 'affected-if-available')
  .action((files: string[], options) => {
    void commandUpdate(process.cwd(), files.length > 0 ? files : undefined, {
      enrichPolicy: parseIncrementalEnrichPolicy(options.enrichPolicy),
    });
  });

program
  .command('snapshot')
  .description('Save current map as a named snapshot')
  .requiredOption('--tag <name>', 'Snapshot tag name')
  .action(async (options) => {
    const result = await commandSnapshot(process.cwd(), options);
    console.log(result.message);
    if (!result.success) process.exitCode = 1;
  });

program
  .command('rename <layer> <old-id> <new-id>')
  .description('Rename a node and update all cross-layer references')
  .action(async (layer, oldId, newId) => {
    const result = await commandRename(process.cwd(), layer, oldId, newId);
    console.log(result.message);
    if (!result.success) process.exitCode = 1;
  });

program
  .command('migrate')
  .description('Migrate annotations from a snapshot to current map')
  .option('--from <tag>', 'Source snapshot tag')
  .option('--status', 'Show migration status (orphaned annotations)')
  .action((options) => { void commandMigrate(process.cwd(), options); });

program
  .command('diff')
  .description('Semantic diff between current map and a snapshot')
  .option('--snapshot <tag>', 'Snapshot tag to compare against')
  .action((options) => {
    void commandDiff(process.cwd(), options);
  });

program
  .command('cypher <query>')
  .description('Execute a Cypher query against the storage-v2 truth graph')
  .action(async (query) => {
    try {
      const result = await commandCypher(process.cwd(), query);
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

program
  .command('decision-query <kind> <target>')
  .description('Query storage-v2 decision rule index (kind: canonical|closure)')
  .action(async (kind, target) => {
    try {
      if (kind !== 'canonical' && kind !== 'closure') {
        throw new Error('kind must be: canonical or closure');
      }
      const result = await commandDecisionQuery(process.cwd(), kind, target);
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

program
  .command('doctrine')
  .description('Show compiled project doctrine')
  .action(() => {
    void commandDoctrine(process.cwd());
  });

program
  .command('canonical-paths')
  .description('Show compiled canonical paths')
  .option('--target <text>', 'Only show canonical paths relevant to this target')
  .action((options) => {
    void commandCanonicalPaths(process.cwd(), options);
  });

program
  .command('source-roots')
  .description('Show the deterministic source-root inventory used by architecture compilation')
  .option('--assist', 'Run a non-authoritative agent/LLM advisory review when configured')
  .option('--budget <mode>', 'Onboarding budget for advisory mode: tiny, standard, or deep', 'standard')
  .option('--json', 'Output as JSON')
  .action((options) => {
    void commandSourceRoots(process.cwd(), options);
  });

program
  .command('plan-change <target>')
  .description('Plan a coherent project change before editing')
  .option('--intent <text>', 'Optional human intent for the change')
  .action((target, options) => {
    void commandPlanChange(process.cwd(), target, options);
  });

program
  .command('review-change [files...]')
  .description('Review current changes against project doctrine')
  .action((files: string[]) => {
    void commandReviewChange(process.cwd(), files.length > 0 ? files : undefined);
  });

program
  .command('codrive [task...]')
  .description('Print a bounded CLI/MCP co-driving workflow for a task')
  .option('--focus <text>', 'Optional focus term, file, symbol, route, or module')
  .option('--budget <mode>', 'Onboarding budget: tiny, standard, or deep', 'standard')
  .option('--json', 'Output as JSON')
  .action((task: string[] | undefined, options) => {
    void commandCodrive(process.cwd(), task ?? [], options);
  });

program
  .command('truth-corrections')
  .description('Show agent-discovered deterministic truth correction proposals')
  .option('--json', 'Output as JSON')
  .option('--limit <n>', 'Maximum recent proposals to show', parseInt)
  .option('--plan', 'Show a deterministic regression plan for recorded proposals')
  .option('--min-confidence <level>', 'Minimum confidence for --plan (low|medium|high)', 'medium')
  .option('--validate', 'Validate proposals against evidence files and storage-v2 graph facts')
  .option('--set-status <id>', 'Set lifecycle status for one proposal id')
  .option('--status <status>', 'Lifecycle status for --set-status (open|accepted|rejected|fixed|stale)')
  .option('--reason <text>', 'Optional reason for --set-status')
  .action((options) => {
    void commandTruthCorrections(process.cwd(), options);
  });

program
  .command('setup')
  .description('Configure MCP servers and install platform service')
  .option('--port <port>', 'HTTP port for the daemon', parseInt)
  .option('--host <host>', 'HTTP host for the daemon')
  .option('--uninstall', 'Remove all cotx configuration and services')
  .action(async (options) => {
    if (options.uninstall) {
      await commandUninstall();
    } else {
      await commandSetup({ port: options.port, host: options.host });
    }
  });

program
  .command('daemon')
  .description('Manage the cotx HTTP daemon')
  .argument('<action>', 'start | stop | status')
  .action(async (action: string) => {
    if (action === 'start') await commandDaemonStart();
    else if (action === 'stop') await commandDaemonStop();
    else if (action === 'status') await commandDaemonStatus();
    else { console.error(`Unknown daemon action: ${action}`); process.exitCode = 1; }
  });

const projectsCmd = program
  .command('projects')
  .description('Manage the global project registry')
  .action(() => commandProjectsList());

projectsCmd
  .command('remove <name>')
  .description('Remove a project from the registry')
  .action((name: string) => commandProjectsRemove(name));

program
  .command('enrich')
  .description('Enrich stale semantic map nodes')
  .option('--auto', 'Auto-enrich using configured LLM')
  .option('--limit <n>', 'Maximum nodes to enrich', parseInt)
  .option('--layer <layer>', 'Only enrich this layer (module|concept|contract|flow|architecture)')
  .option('--dry-run', 'Preview prompts without calling LLM')
  .action(async (options) => {
    if (!options.auto) {
      console.log('Use --auto to auto-enrich with configured LLM, or use an agent via MCP.');
      return;
    }
    try {
      // Architecture enrichment: separate code path (LLM Mode 2)
      if (options.layer === 'architecture') {
        const { enrichArchitecture } = await import('./llm/architecture-enricher.js');
        const result = await enrichArchitecture(process.cwd(), {
          dryRun: options.dryRun,
          log: console.log,
        });
        console.log(`\nEnriched ${result.perspectives_enriched} perspective(s), ${result.descriptions_written} description(s) written`);
        return;
      }

      // Standard layer enrichment (existing logic)
      const { autoEnrich } = await import('./llm/enricher.js');
      const result = await autoEnrich(process.cwd(), {
        limit: options.limit,
        layer: options.layer,
        dryRun: options.dryRun,
        log: console.log,
      });
      console.log(`\nEnriched ${result.succeeded}/${result.total} nodes (${result.failed} failed)`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

program
  .command('agent-analyze')
  .description('Run the built-in cotx agentic analysis loop for a semantic layer')
  .requiredOption('--layer <layer>', 'module|concept|contract|flow|route|tool|process|decision|architecture')
  .requiredOption('--task <text>', 'Analysis task for the built-in agent')
  .option('--json', 'Output full JSON result')
  .option('--strict-truth-corrections', 'Fail if the agent claims a deterministic cotx gap without recording a truth correction proposal')
  .action(async (options) => {
    try {
      const { readConfig } = await import('./config.js');
      const { runCotxLayerAnalysisAgent } = await import('./llm/agentic-runtime.js');
      const config = readConfig();
      const result = await runCotxLayerAnalysisAgent({
        projectRoot: process.cwd(),
        layer: options.layer,
        task: options.task,
        llm: config.llm,
        requireTruthCorrectionProposals: Boolean(options.strictTruthCorrections),
        log: console.log,
      });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(result.raw_output);
      if (result.truth_correction_proposals.length > 0) {
        console.log(`\nRecorded ${result.truth_correction_proposals.length} truth correction proposal(s) in .cotx/agent/truth-corrections.jsonl`);
      }
      if (result.tool_calls.length > 0) {
        console.log(`\nTool calls: ${result.tool_calls.join(', ')}`);
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

program
  .command('embed')
  .description('Build or refresh the semantic embedding index (incremental by default — only re-embeds changed nodes)')
  .option('--force', 'Re-embed every node, ignoring the existing index')
  .action(async (options) => {
    try {
      const { buildEmbeddingIndex } = await import('./llm/embeddings.js');
      const result = await buildEmbeddingIndex(process.cwd(), {
        log: console.log,
        force: Boolean(options.force),
      });
      console.log(`Embedded ${result.embedded} fresh, reused ${result.cached} cached, dropped ${result.removed} stale. Total ${result.total}.`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

program
  .command('serve')
  .description('Start MCP server (stdio by default, optional HTTP transports)')
  .option('--http', 'Start standalone HTTP server with /mcp and legacy /sse endpoints')
  .option('--host <host>', 'Host for HTTP server', '127.0.0.1')
  .option('--port <port>', 'Port for HTTP server', '3000')
  .action(async (options) => {
    if (options.http) {
      const handle = await startMcpHttpServer({
        host: options.host,
        port: parseInt(options.port, 10),
      });
      console.log(`cotx MCP HTTP server listening on ${handle.baseUrl}`);
      console.log(`  Landing page:    ${handle.landingUrl}`);
      console.log(`  Workbench:       ${handle.workbenchUrl}`);
      console.log(`  Streamable HTTP: ${handle.mcpUrl}`);
      console.log(`  Legacy SSE:      ${handle.sseUrl}`);
      console.log(`  Legacy messages: ${handle.messagesUrl}`);
      return;
    }

    await startMcpServer();
  });

program.parse();
