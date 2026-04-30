import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../..');
const cliPath = path.join(repoRoot, 'dist', 'index.js');
const defaultProjects = [repoRoot, path.join(repoRoot, 'example', 'oh-my-mermaid')];
const copyExcludes = ['node_modules', 'dist', '.git', '.cotx'];
const checkKeys = [
  'cliCompile',
  'cliStatus',
  'cliQuery',
  'cliContext',
  'cliImpact',
  'cliMap',
  'cliWrite',
  'cliLint',
  'cliSnapshot',
  'cliDiff',
  'cliRename',
  'cliUpdate',
  'mcpTools',
  'mcpCompile',
  'mcpQuery',
  'mcpContext',
  'mcpImpact',
  'mcpMap',
  'mcpWrite',
  'mcpEnrich',
  'mcpBatchWrite',
  'mcpLint',
  'mcpDiff',
  'mcpCompileDelta',
  'httpStreamable',
  'httpSse',
];

function makeChecks() {
  return Object.fromEntries(checkKeys.map((key) => [key, false]));
}

async function copyProject(source) {
  const tmpBase = await fsp.mkdtemp(path.join(os.tmpdir(), 'cotx-acceptance-'));
  const dest = path.join(tmpBase, path.basename(source));
  await fsp.mkdir(dest, { recursive: true });

  const rsyncArgs = ['-a', ...copyExcludes.flatMap((entry) => ['--exclude', entry]), `${source}/`, `${dest}/`];
  const result = spawnSync('rsync', rsyncArgs, {
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
  });

  if (result.status !== 0) {
    throw new Error(
      [
        `rsync copy failed for ${source}`,
        result.stdout && `stdout:\n${result.stdout}`,
        result.stderr && `stderr:\n${result.stderr}`,
      ]
        .filter(Boolean)
        .join('\n\n'),
    );
  }

  return dest;
}

function runCli(cwd, args, quiet, options = {}) {
  const captureStdout = options.captureStdout ?? true;
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
    env: process.env,
    stdio: captureStdout ? 'pipe' : ['ignore', 'ignore', 'pipe'],
  });

  if (result.status !== 0) {
    throw new Error(
      [
        `CLI failed: cotx ${args.join(' ')}`,
        `cwd: ${cwd}`,
        `exit: ${result.status}`,
        captureStdout && result.stdout && `stdout:\n${result.stdout}`,
        result.stderr && `stderr:\n${result.stderr}`,
      ]
        .filter(Boolean)
        .join('\n\n'),
    );
  }

  if (captureStdout && !quiet && result.stdout.trim()) {
    console.log(result.stdout.trim());
  }

  return captureStdout ? result.stdout : '';
}

let builtCommandsPromise;

async function loadBuiltCommands() {
  if (!builtCommandsPromise) {
    builtCommandsPromise = Promise.all([
      import(pathToFileURL(path.join(repoRoot, 'dist/commands/compile.js')).href),
      import(pathToFileURL(path.join(repoRoot, 'dist/commands/status.js')).href),
      import(pathToFileURL(path.join(repoRoot, 'dist/commands/query.js')).href),
      import(pathToFileURL(path.join(repoRoot, 'dist/commands/context.js')).href),
      import(pathToFileURL(path.join(repoRoot, 'dist/commands/impact.js')).href),
      import(pathToFileURL(path.join(repoRoot, 'dist/commands/map.js')).href),
      import(pathToFileURL(path.join(repoRoot, 'dist/commands/write.js')).href),
      import(pathToFileURL(path.join(repoRoot, 'dist/commands/lint.js')).href),
      import(pathToFileURL(path.join(repoRoot, 'dist/commands/snapshot.js')).href),
      import(pathToFileURL(path.join(repoRoot, 'dist/commands/diff.js')).href),
      import(pathToFileURL(path.join(repoRoot, 'dist/commands/rename.js')).href),
      import(pathToFileURL(path.join(repoRoot, 'dist/commands/update.js')).href),
    ]).then(
      ([
        compile,
        status,
        query,
        context,
        impact,
        map,
        write,
        lint,
        snapshot,
        diff,
        rename,
        update,
      ]) => ({
        commandCompile: compile.commandCompile,
        commandStatus: status.commandStatus,
        commandQuery: query.commandQuery,
        commandContext: context.commandContext,
        commandImpact: impact.commandImpact,
        commandMap: map.commandMap,
        commandWrite: write.commandWrite,
        commandLint: lint.commandLint,
        commandSnapshot: snapshot.commandSnapshot,
        commandDiff: diff.commandDiff,
        commandRename: rename.commandRename,
        commandUpdate: update.commandUpdate,
      }),
    );
  }

  return builtCommandsPromise;
}

async function captureStdout(fn) {
  const chunks = [];
  const originalLog = console.log;
  const originalWrite = process.stdout.write.bind(process.stdout);

  console.log = (...args) => {
    chunks.push(`${args.join(' ')}\n`);
  };
  process.stdout.write = ((chunk, encoding, callback) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString(encoding));
    if (typeof callback === 'function') callback();
    return true;
  });

  try {
    await fn();
  } finally {
    console.log = originalLog;
    process.stdout.write = originalWrite;
  }

  return chunks.join('');
}

function runNpm(cwd, args, quiet) {
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
    env: process.env,
  });

  if (result.status !== 0) {
    throw new Error(
      [
        `npm ${args.join(' ')} failed`,
        `cwd: ${cwd}`,
        `exit: ${result.status}`,
        result.stdout && `stdout:\n${result.stdout}`,
        result.stderr && `stderr:\n${result.stderr}`,
      ]
        .filter(Boolean)
        .join('\n\n'),
    );
  }

  if (!quiet && result.stdout.trim()) {
    console.log(result.stdout.trim());
  }
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
    server.on('error', reject);
  });
}

async function waitForHealth(url, timeoutMs = 15_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function startHttpServerProcess(cwd, quiet) {
  const port = await getFreePort();
  const child = spawn(
    process.execPath,
    [cliPath, 'serve', '--http', '--host', '127.0.0.1', '--port', String(port)],
    {
      cwd,
      env: process.env,
      stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    },
  );

  if (quiet) {
    child.stdout?.on('data', () => {});
    child.stderr?.on('data', () => {});
  }

  await waitForHealth(`http://127.0.0.1:${port}/health`);

  return {
    child,
    baseUrl: `http://127.0.0.1:${port}`,
    mcpUrl: `http://127.0.0.1:${port}/mcp`,
    sseUrl: `http://127.0.0.1:${port}/sse`,
    close: async () => {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    },
  };
}

function readIndex(cwd) {
  return JSON.parse(fs.readFileSync(path.join(cwd, '.cotx', 'index.json'), 'utf-8'));
}

function readModule(cwd, moduleId) {
  const filename = `${encodeURIComponent(moduleId)}.yaml`;
  return yaml.load(
    fs.readFileSync(path.join(cwd, '.cotx', 'modules', filename), 'utf-8'),
  );
}

function selectModuleId(cwd) {
  const moduleIds = readIndex(cwd).graph.nodes
    .filter((node) => node.layer === 'module')
    .map((node) => node.id)
    .filter((id) => id !== 'acceptance_probe');

  return moduleIds.find((id) => id !== '_root') ?? moduleIds[0];
}

function parseToolJson(result) {
  const first = result.content?.[0];
  if (!first || first.type !== 'text') {
    throw new Error(`Unexpected MCP tool result: ${JSON.stringify(result)}`);
  }
  return JSON.parse(first.text);
}

async function withMcpClient(cwd, fn) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, 'serve'],
    cwd,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'cotx-acceptance', version: '1.0.0' });
  await client.connect(transport);

  try {
    return await fn(client);
  } finally {
    await transport.close();
  }
}

async function runCliChecks(source, quiet, checks) {
  const commands = await loadBuiltCommands();
  const workdir = await copyProject(source);
  if (!quiet) console.log(`CLI scenario: ${source}`);
  await commands.commandCompile(workdir, { silent: true });
  checks.cliCompile = fs.existsSync(path.join(workdir, '.cotx', 'index.json'));

  const status = await captureStdout(() => commands.commandStatus(workdir));
  checks.cliStatus = status.includes('Modules:') && status.includes('Concepts:');

  const moduleId = selectModuleId(workdir);
  const query = await captureStdout(() => commands.commandQuery(workdir, moduleId, {}));
  checks.cliQuery = query.includes(moduleId);

  const context = await captureStdout(() => commands.commandContext(workdir, moduleId));
  checks.cliContext = context.includes(moduleId);

  const impact = await captureStdout(() =>
    commands.commandImpact(workdir, moduleId, { direction: 'upstream' }),
  );
  checks.cliImpact = impact.includes('Risk:');

  const map = await captureStdout(() =>
    commands.commandMap(workdir, { scope: 'overview', depth: 2 }),
  );
  checks.cliMap = map.includes('## Project:');

  const lint = await commands.commandLint(workdir, {
    json: false,
    strict: false,
    silent: true,
    fix: false,
  });
  checks.cliLint = lint.every((issue) => issue.level !== 'ERROR');

  const snapshot = await commands.commandSnapshot(workdir, { tag: 'baseline' });
  checks.cliSnapshot =
    snapshot.success &&
    fs.existsSync(path.join(workdir, '.cotx', 'snapshots', 'baseline', 'index.json'));

  const write = await commands.commandWrite(
    workdir,
    moduleId,
    'enriched.responsibility',
    'Acceptance responsibility',
  );
  const enrichedContext = await captureStdout(() => commands.commandContext(workdir, moduleId));
  checks.cliWrite = write.success && enrichedContext.includes('Acceptance responsibility');

  await commands.commandWrite(workdir, moduleId, 'annotation.intent', 'acceptance annotation');
  const diff = await commands.commandDiff(workdir, { snapshot: 'baseline', silent: true });
  checks.cliDiff = diff.modified.length >= 1;

  const renamedId = `${moduleId}--acceptance`;
  const rename = await commands.commandRename(workdir, 'module', moduleId, renamedId);
  const renamedContext = await captureStdout(() => commands.commandContext(workdir, renamedId));
  checks.cliRename = rename.success && renamedContext.includes(renamedId);

  return workdir;
}

async function runUpdateCheck(source, quiet, checks) {
  const commands = await loadBuiltCommands();
  const workdir = await copyProject(source);
  if (!quiet) console.log(`Update scenario: ${source}`);
  await commands.commandCompile(workdir, { silent: true });

  const probeDir = path.join(workdir, 'acceptance_probe');
  await fsp.mkdir(probeDir, { recursive: true });
  await fsp.writeFile(
    path.join(probeDir, 'feature.ts'),
    ['export function acceptanceProbe() {', '  return 42;', '}', ''].join('\n'),
    'utf-8',
  );

  await commands.commandUpdate(workdir, ['acceptance_probe/feature.ts'], { silent: true });
  checks.cliUpdate = readIndex(workdir).graph.nodes.some(
    (node) => node.layer === 'module' && node.id === 'acceptance_probe',
  );

  return workdir;
}

async function runMcpChecks(source, quiet, checks) {
  const workdir = await copyProject(source);
  if (!quiet) console.log(`MCP scenario: ${source}`);

  await withMcpClient(workdir, async (client) => {
    const tools = await client.listTools();
    checks.mcpTools = tools.tools.length >= 10;

    const compile = parseToolJson(
      await client.callTool({
        name: 'cotx_compile',
        arguments: { project_root: workdir },
      }),
    );
    checks.mcpCompile = compile.status === 'compiled';

    runCli(workdir, ['snapshot', '--tag', 'baseline'], quiet);
    const moduleId = selectModuleId(workdir);

    const query = parseToolJson(
      await client.callTool({
        name: 'cotx_query',
        arguments: { project_root: workdir, query: moduleId },
      }),
    );
    checks.mcpQuery = query.count > 0;

    const context = parseToolJson(
      await client.callTool({
        name: 'cotx_context',
        arguments: { project_root: workdir, node_id: moduleId },
      }),
    );
    checks.mcpContext = context.id === moduleId;

    const impact = parseToolJson(
      await client.callTool({
        name: 'cotx_impact',
        arguments: { project_root: workdir, target: moduleId },
      }),
    );
    checks.mcpImpact = Boolean(impact.summary?.risk);

    const map = parseToolJson(
      await client.callTool({
        name: 'cotx_map',
        arguments: { project_root: workdir, scope: 'overview', depth: 2 },
      }),
    );
    checks.mcpMap = typeof map === 'string' && map.includes('## Project:');

    const write = parseToolJson(
      await client.callTool({
        name: 'cotx_write',
        arguments: {
          project_root: workdir,
          node_id: moduleId,
          field: 'enriched.responsibility',
          content: 'MCP responsibility',
        },
      }),
    );
    const refreshed = parseToolJson(
      await client.callTool({
        name: 'cotx_context',
        arguments: { project_root: workdir, node_id: moduleId },
      }),
    );
    checks.mcpWrite =
      write.success === true &&
      refreshed.data.enriched?.responsibility === 'MCP responsibility';

    const enrich = parseToolJson(
      await client.callTool({
        name: 'cotx_enrich',
        arguments: { project_root: workdir, layer: 'module', limit: 1 },
      }),
    );
    checks.mcpEnrich = Array.isArray(enrich.tasks);

    const batchWrite = parseToolJson(
      await client.callTool({
        name: 'cotx_batch_write',
        arguments: {
          project_root: workdir,
          writes: [
            {
              node_id: moduleId,
              field: 'annotation.intent',
              content: 'mcp batch annotation',
            },
          ],
        },
      }),
    );
    checks.mcpBatchWrite = batchWrite.succeeded === 1;

    const lint = parseToolJson(
      await client.callTool({
        name: 'cotx_lint',
        arguments: { project_root: workdir },
      }),
    );
    checks.mcpLint = lint.issues.every((issue) => issue.level !== 'ERROR');

    const diff = parseToolJson(
      await client.callTool({
        name: 'cotx_diff',
        arguments: { project_root: workdir, snapshot: 'baseline' },
      }),
    );
    checks.mcpDiff = Array.isArray(diff.modified) && diff.modified.length >= 1;

    const probeDir = path.join(workdir, 'acceptance_probe');
    await fsp.mkdir(probeDir, { recursive: true });
    await fsp.writeFile(
      path.join(probeDir, 'feature.ts'),
      ['export function acceptanceProbe() {', '  return 7;', '}', ''].join('\n'),
      'utf-8',
    );

    const delta = parseToolJson(
      await client.callTool({
        name: 'cotx_compile',
        arguments: {
          project_root: workdir,
          mode: 'delta',
          files: ['acceptance_probe/feature.ts'],
        },
      }),
    );
    const probeQuery = parseToolJson(
      await client.callTool({
        name: 'cotx_query',
        arguments: { project_root: workdir, query: 'acceptance_probe' },
      }),
    );
    checks.mcpCompileDelta =
      delta.status === 'updated' && probeQuery.results.some((item) => item.id === 'acceptance_probe');
  });

  return workdir;
}

async function runHttpChecks(source, quiet, checks) {
  const commands = await loadBuiltCommands();
  const workdir = await copyProject(source);
  if (!quiet) console.log(`HTTP scenario: ${source}`);

  await commands.commandCompile(workdir, { silent: true });
  const moduleId = selectModuleId(workdir);
  const server = await startHttpServerProcess(workdir, quiet);

  try {
    const streamClient = new Client({ name: 'cotx-http-streamable', version: '1.0.0' });
    const streamTransport = new StreamableHTTPClientTransport(new URL(server.mcpUrl));
    await streamClient.connect(streamTransport);
    await streamClient.listTools();
    parseToolJson(
      await streamClient.callTool({
        name: 'cotx_write',
        arguments: {
          project_root: workdir,
          node_id: moduleId,
          field: 'annotation.intent',
          content: 'http streamable annotation',
        },
      }),
    );
    const streamContext = parseToolJson(
      await streamClient.callTool({
        name: 'cotx_context',
        arguments: { project_root: workdir, node_id: moduleId },
      }),
    );
    checks.httpStreamable = streamContext.id === moduleId;
    await streamTransport.close();

    const sseClient = new Client({ name: 'cotx-http-sse', version: '1.0.0' });
    const sseTransport = new SSEClientTransport(new URL(server.sseUrl));
    await sseClient.connect(sseTransport);
    await sseClient.listTools();
    const sseMap = parseToolJson(
      await sseClient.callTool({
        name: 'cotx_map',
        arguments: { project_root: workdir, scope: 'overview', depth: 1 },
      }),
    );
    checks.httpSse = typeof sseMap === 'string' && sseMap.includes('## Project:');
    await sseTransport.close();
  } finally {
    await server.close();
  }
}

export async function runAcceptanceSuites(options = {}) {
  const projects = options.projects ?? defaultProjects;
  const quiet = options.quiet ?? false;
  const results = { projects: [], failedChecks: [] };

  if (!quiet) console.log('Building current dist before acceptance...');
  runNpm(repoRoot, ['run', 'build'], quiet);

  for (const source of projects) {
    const checks = makeChecks();
    const failures = [];

    try {
      await runCliChecks(source, quiet, checks);
    } catch (error) {
      failures.push({ check: 'cliScenario', reason: error instanceof Error ? error.message : String(error) });
    }

    try {
      await runUpdateCheck(source, quiet, checks);
    } catch (error) {
      failures.push({ check: 'cliUpdate', reason: error instanceof Error ? error.message : String(error) });
    }

    try {
      await runMcpChecks(source, quiet, checks);
    } catch (error) {
      failures.push({ check: 'mcpScenario', reason: error instanceof Error ? error.message : String(error) });
    }

    try {
      await runHttpChecks(source, quiet, checks);
    } catch (error) {
      failures.push({ check: 'httpScenario', reason: error instanceof Error ? error.message : String(error) });
    }

    for (const [key, passed] of Object.entries(checks)) {
      if (!passed) {
        results.failedChecks.push({ project: source, check: key });
      }
    }

    for (const failure of failures) {
      results.failedChecks.push({ project: source, check: failure.check, reason: failure.reason });
    }

    results.projects.push({ source, checks });
  }

  return results;
}

function printSummary(results) {
  for (const project of results.projects) {
    console.log(`\nProject: ${project.source}`);
    for (const [check, passed] of Object.entries(project.checks)) {
      console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${check}`);
    }
  }

  if (results.failedChecks.length > 0) {
    console.log('\nFailed checks:');
    for (const failure of results.failedChecks) {
      console.log(`  ${failure.project} :: ${failure.check}`);
      if (failure.reason) {
        console.log(`    ${failure.reason}`);
      }
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const quiet = process.argv.includes('--quiet');
  const json = process.argv.includes('--json');

  const results = await runAcceptanceSuites({ quiet });

  if (json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    printSummary(results);
  }

  if (results.failedChecks.length > 0) {
    process.exit(1);
  }
}
