#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const defaultCotxBin = path.join(repoRoot, 'dist', 'index.js');

const args = parseArgs(process.argv.slice(2));
const reposRoot = path.resolve(args.reposRoot ?? process.env.REPOS_ROOT ?? '/data/dev/goalx_test/repos');
const outDir = path.resolve(args.outDir ?? process.env.OUT_DIR ?? path.join(repoRoot, '.cotx', 'eval', 'agentic-llm-smoke'));
const cotxBin = path.resolve(args.cotxBin ?? process.env.COTX_BIN ?? defaultCotxBin);
const layers = splitCsv(args.layers ?? process.env.LAYERS ?? args.layer ?? process.env.LAYER ?? 'module');
const timeoutMs = Number(args.timeoutMs ?? process.env.TIMEOUT_MS ?? 180000);
const cleanCotx = Boolean(args.cleanCotx) || process.env.CLEAN_COTX === '1';
const shouldCompile = cleanCotx || Boolean(args.compile) || process.env.COMPILE === '1';
const fresh = Boolean(args.fresh) || process.env.FRESH === '1';
const failOnValidation = Boolean(args.failOnValidation) || process.env.FAIL_ON_VALIDATION === '1';
const failOnNonPassing = Boolean(args.failOnNonPassing) || process.env.FAIL_ON_NON_PASSING === '1';
const strictTruthCorrections = Boolean(args.strictTruthCorrections) || process.env.STRICT_TRUTH_CORRECTIONS === '1';
const repos = resolveRepos(args, reposRoot);

if (!fs.existsSync(cotxBin)) {
  console.error(`Missing cotx dist CLI: ${cotxBin}. Run npm run build first.`);
  process.exit(1);
}
if (repos.length === 0) {
  console.error('No repos selected.');
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
const records = [];

for (const repo of repos) {
  const projectRoot = repo.projectRoot;
  for (const layer of layers) {
    const task = args.task ?? process.env.TASK ?? defaultTask(layer);
    const startedAt = new Date().toISOString();
    const record = {
      schema_version: 'cotx.agentic_llm_smoke.v1',
      repo: repo.name,
      project_root: projectRoot,
      started_at: startedAt,
      mode: 'cotx-built-in-llm',
      layer,
      task,
      strict_truth_corrections: strictTruthCorrections,
      status: 'not-run',
      compile: null,
      agent: null,
      truth_corrections: null,
      validation: null,
      truth_graph_fact_check: null,
      errors: [],
    };
    records.push(record);

    if (!fs.existsSync(projectRoot)) {
      record.status = 'blocked';
      record.errors.push(`missing repo root: ${projectRoot}`);
      continue;
    }

    try {
      console.error(`[agentic-smoke] ${repo.name}/${layer}: start`);
      if (cleanCotx) {
        console.error(`[agentic-smoke] ${repo.name}/${layer}: removing .cotx`);
        fs.rmSync(path.join(projectRoot, '.cotx'), { recursive: true, force: true });
      }
      if (fresh) {
        fs.rmSync(path.join(projectRoot, '.cotx', 'agent', 'truth-corrections.jsonl'), { force: true });
      }
      if (shouldCompile) {
        console.error(`[agentic-smoke] ${repo.name}/${layer}: compile`);
        const compile = await runNode(cotxBin, ['compile'], { cwd: projectRoot, timeoutMs });
        record.compile = summarizeCommand(compile);
        if (compile.exitCode !== 0) {
          record.status = 'blocked';
          record.errors.push(`compile failed: ${compile.stderr || compile.stdout}`);
          continue;
        }
      }

      const truthGraphSnapshots = [];
      truthGraphSnapshots.push(await truthGraphFactSnapshot(cotxBin, projectRoot, 'before-agent'));

      console.error(`[agentic-smoke] ${repo.name}/${layer}: agent-analyze`);
      const agentArgs = [
        'agent-analyze',
        '--layer',
        layer,
        '--task',
        task,
        '--json',
      ];
      if (strictTruthCorrections) agentArgs.push('--strict-truth-corrections');
      const agent = await runNode(cotxBin, agentArgs, { cwd: projectRoot, timeoutMs });
      record.agent = summarizeCommand(agent);
      const parsedAgent = tryExtractJsonObject(agent.stdout);
      if (parsedAgent) record.agent.parsed = parsedAgent;
      if (agent.exitCode !== 0) {
        record.status = 'failed';
        record.errors.push(`agent-analyze failed: ${agent.stderr || agent.stdout}`);
        continue;
      }
      if (!parsedAgent) throw new Error(`Could not parse JSON object from output:\n${tail(agent.stdout, 2000)}`);
      record.agent.parsed = parsedAgent;
      truthGraphSnapshots.push(await truthGraphFactSnapshot(cotxBin, projectRoot, 'after-agent'));

      console.error(`[agentic-smoke] ${repo.name}/${layer}: truth-corrections`);
      const corrections = await runNode(cotxBin, ['truth-corrections', '--json'], { cwd: projectRoot, timeoutMs: 30000 });
      record.truth_corrections = summarizeCommand(corrections);
      record.truth_corrections.parsed = corrections.exitCode === 0 ? extractJsonObject(corrections.stdout) : null;
      console.error(`[agentic-smoke] ${repo.name}/${layer}: validate truth-corrections`);
      const validation = await runNode(cotxBin, ['truth-corrections', '--validate'], { cwd: projectRoot, timeoutMs: 30000 });
      record.validation = summarizeCommand(validation);
      record.validation.parsed = validation.exitCode === 0 ? extractJsonObject(validation.stdout) : null;
      truthGraphSnapshots.push(await truthGraphFactSnapshot(cotxBin, projectRoot, 'after-validation'));
      record.truth_graph_fact_check = compareTruthGraphFacts(truthGraphSnapshots);
      if (!record.truth_graph_fact_check.stable) {
        record.status = 'failed';
        record.errors.push('logical truth graph facts changed or could not be checked; inspect truth_graph_fact_check');
        console.error(`[agentic-smoke] ${repo.name}/${layer}: failed`);
        continue;
      }
      if (failOnValidation && record.validation.parsed && record.validation.parsed.ok === false) {
        record.status = 'failed';
        record.errors.push('truth correction validation failed');
        console.error(`[agentic-smoke] ${repo.name}/${layer}: failed`);
        continue;
      }
      record.status = 'passed';
      console.error(`[agentic-smoke] ${repo.name}/${layer}: passed`);
    } catch (error) {
      record.status = 'failed';
      record.errors.push(error instanceof Error ? error.message : String(error));
      console.error(`[agentic-smoke] ${repo.name}: failed`);
    } finally {
      record.finished_at = new Date().toISOString();
    }
  }
}

const jsonlPath = path.join(outDir, 'agentic-llm-smoke.jsonl');
const markdownPath = path.join(outDir, 'agentic-llm-smoke.md');
fs.writeFileSync(jsonlPath, records.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf-8');
fs.writeFileSync(markdownPath, formatMarkdown(records), 'utf-8');
console.log(`wrote ${markdownPath}`);
console.log(`wrote ${jsonlPath}`);

const nonPassing = records.filter((record) => record.status !== 'passed');
if (failOnNonPassing && nonPassing.length > 0) {
  console.error(`[agentic-smoke] FAIL_ON_NON_PASSING=1 and ${nonPassing.length} non-passing row(s) were recorded.`);
  for (const record of nonPassing.slice(0, 10)) {
    console.error(`- ${record.repo}/${record.layer}: ${record.status}${record.errors.length > 0 ? ` (${record.errors.join('; ')})` : ''}`);
  }
  process.exitCode = 1;
}

function resolveRepos(parsedArgs, root) {
  if (parsedArgs.projectRoots) {
    return splitCsv(parsedArgs.projectRoots).map((projectRoot) => ({
      name: path.basename(projectRoot),
      projectRoot: path.resolve(projectRoot),
    }));
  }
  if (parsedArgs.projectRoot) {
    const projectRoot = path.resolve(parsedArgs.projectRoot);
    return [{ name: path.basename(projectRoot), projectRoot }];
  }
  const selected = splitCsv(parsedArgs.repos ?? process.env.REPOS ?? 'open-swe,fastmcp,github-mcp-server,deer-flow');
  return selected.map((name) => ({ name, projectRoot: path.join(root, name) }));
}

function defaultTask(selectedLayer) {
  return `Analyze whether cotx ${selectedLayer} evidence is sufficient for grounded enrichment. Use repository tools before final synthesis. Check onboarding_context.summary.graph_file_index_status before claiming graph gaps. Truth correction proposals are optional feedback artifacts; record them only for confirmed deterministic parser/compiler/architecture/doc gaps. Use missing-node only for absent graph CodeNode/file facts; use architecture-grouping-gap for missing or too-coarse module boundaries over existing graph files.`;
}

function summarizeCommand(result) {
  return {
    exit_code: result.exitCode,
    duration_ms: result.durationMs,
    stdout_tail: tail(result.stdout, 4000),
    stderr_tail: tail(result.stderr, 4000),
  };
}

async function truthGraphFactSnapshot(cotxBinary, projectRoot, phase) {
  if (!fs.existsSync(path.join(projectRoot, '.cotx', 'v2', 'truth.lbug'))) {
    return { phase, status: 'missing', facts: null, errors: [] };
  }

  const queries = [
    ['nodes', 'MATCH (n) RETURN count(n) AS count'],
    ['relations', 'MATCH ()-[r]->() RETURN count(r) AS count'],
    ['code_nodes', 'MATCH (n:CodeNode) RETURN count(n) AS count'],
    ['code_relations', 'MATCH ()-[r:CodeRelation]->() RETURN count(r) AS count'],
  ];
  const facts = {};
  const errors = [];
  for (const [key, query] of queries) {
    const result = await runNode(cotxBinary, ['cypher', query], { cwd: projectRoot, timeoutMs: 30000 });
    if (result.exitCode !== 0) {
      errors.push(`${key}: ${tail(result.stderr || result.stdout, 1000)}`);
      continue;
    }
    try {
      const parsed = extractJsonObject(result.stdout);
      const value = parsed?.rows?.[0]?.count;
      const count = Number(value);
      if (!Number.isFinite(count)) throw new Error(`missing numeric count in ${key} result`);
      facts[key] = count;
    } catch (error) {
      errors.push(`${key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    phase,
    status: errors.length === 0 ? 'ok' : 'error',
    facts: errors.length === 0 ? facts : null,
    errors,
  };
}

function compareTruthGraphFacts(snapshots) {
  const comparable = snapshots.filter((snapshot) => snapshot.status === 'ok');
  const errors = snapshots.flatMap((snapshot) => (snapshot.errors ?? []).map((error) => `${snapshot.phase}: ${error}`));
  const differences = [];
  const baseline = comparable[0];
  if (baseline) {
    for (const snapshot of comparable.slice(1)) {
      for (const key of Object.keys(baseline.facts ?? {})) {
        const before = baseline.facts[key];
        const after = snapshot.facts?.[key];
        if (before !== after) differences.push({ phase: snapshot.phase, key, before, after });
      }
    }
  }
  return {
    standard: 'logical graph facts: compare node/relation count query results, not .lbug file hash alone',
    stable: errors.length === 0 && differences.length === 0,
    compared_phases: comparable.map((snapshot) => snapshot.phase),
    snapshots,
    differences,
    errors,
  };
}

function extractJsonObject(output) {
  const candidates = [];
  for (let index = output.indexOf('{'); index >= 0; index = output.indexOf('{', index + 1)) {
    candidates.push(index);
  }
  for (const index of candidates.reverse()) {
    try {
      return JSON.parse(output.slice(index).trim());
    } catch {
      // try earlier brace
    }
  }
  throw new Error(`Could not parse JSON object from output:\n${tail(output, 2000)}`);
}

function tryExtractJsonObject(output) {
  try {
    return extractJsonObject(output);
  } catch {
    return null;
  }
}

function formatMarkdown(items) {
  const lines = [
    '# Agentic LLM Smoke',
    '',
    `Generated: ${new Date().toISOString()}`,
    'Mode: cotx-built-in-llm',
    `Layers: ${layers.join(', ')}`,
    `Strict truth corrections: ${strictTruthCorrections ? 'yes' : 'no'}`,
    '',
    '| Repo | Layer | Status | Tools | Proposals | High | Agent ms | Strict | Errors |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- |',
  ];
  for (const item of items) {
    const agent = item.agent?.parsed;
    const corrections = item.truth_corrections?.parsed;
    lines.push([
      item.repo,
      item.layer,
      item.status,
      agent?.tool_calls?.length ?? 0,
      corrections?.total ?? agent?.truth_correction_proposals?.length ?? 0,
      corrections?.high_confidence ?? countHigh(agent?.truth_correction_proposals),
      item.agent?.duration_ms ?? 0,
      item.strict_truth_corrections ? 'yes' : 'no',
      oneLine(item.errors.join('; ')),
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }

  for (const item of items) {
    lines.push('', `## ${item.repo}/${item.layer}`, '');
    lines.push(`Project root: ${item.project_root}`);
    lines.push(`Task: ${item.task}`);
    lines.push(`Status: ${item.status}`);
    if (item.truth_graph_fact_check) {
      lines.push(`Truth graph fact check: ${item.truth_graph_fact_check.stable ? 'stable' : 'changed/error'}`);
      lines.push(`Truth graph fact standard: ${item.truth_graph_fact_check.standard}`);
      for (const snapshot of item.truth_graph_fact_check.snapshots ?? []) {
        lines.push(`- ${snapshot.phase}: ${snapshot.status}${snapshot.facts ? ` ${JSON.stringify(snapshot.facts)}` : ''}`);
      }
      for (const difference of item.truth_graph_fact_check.differences ?? []) {
        lines.push(`- changed ${difference.key} at ${difference.phase}: ${difference.before} -> ${difference.after}`);
      }
      for (const error of item.truth_graph_fact_check.errors ?? []) {
        lines.push(`- error: ${error}`);
      }
    }
    const parsed = item.agent?.parsed;
    if (parsed) {
      lines.push(`Tools: ${(parsed.tool_calls ?? []).join(', ') || 'none'}`);
      lines.push('');
      lines.push('Agent output:');
      lines.push('```');
      lines.push(String(parsed.raw_output ?? '').slice(0, 4000));
      lines.push('```');
    }
    if (item.agent && (item.status !== 'passed' || !parsed)) {
      lines.push('');
      lines.push('Agent diagnostics:');
      lines.push(`- exit_code: ${item.agent.exit_code}`);
      lines.push(`- duration_ms: ${item.agent.duration_ms}`);
      lines.push(`- tool_context: ${formatToolContext(item, parsed)}`);
      if (item.agent.stdout_tail) {
        lines.push('');
        lines.push('stdout tail:');
        lines.push('```');
        lines.push(item.agent.stdout_tail);
        lines.push('```');
      }
      if (item.agent.stderr_tail) {
        lines.push('');
        lines.push('stderr tail:');
        lines.push('```');
        lines.push(item.agent.stderr_tail);
        lines.push('```');
      }
    }
    const corrections = item.truth_corrections?.parsed;
    if (corrections?.samples?.length) {
      lines.push('');
      lines.push('Truth correction samples:');
      for (const sample of corrections.samples) {
        lines.push(`- ${sample.layer}/${sample.kind}: ${sample.title} (${sample.confidence})`);
      }
    }
    const validation = item.validation?.parsed;
    if (validation) {
      lines.push('');
      lines.push(`Validation: ${validation.ok ? 'ok' : 'failed'} (${validation.findings?.length ?? 0} finding(s))`);
      for (const finding of (validation.findings ?? []).slice(0, 8)) {
        lines.push(`- ${finding.level}/${finding.code}: ${finding.message}`);
      }
    }
    if (item.errors.length > 0) {
      lines.push('');
      lines.push('Errors:');
      for (const error of item.errors) lines.push(`- ${error}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function countHigh(proposals) {
  return Array.isArray(proposals) ? proposals.filter((proposal) => proposal.confidence === 'high').length : 0;
}

function formatToolContext(item, parsed) {
  if (parsed) return (parsed.tool_calls ?? []).join(', ') || 'none';
  const commandText = `${item.agent?.stdout_tail ?? ''}\n${item.agent?.stderr_tail ?? ''}`;
  if (/\bused tools\b/i.test(commandText)) {
    return 'agent reported tool use before JSON result; inspect stdout/stderr tails below';
  }
  return 'unavailable because agent-analyze did not emit parseable JSON';
}

function runNode(script, scriptArgs, { cwd, timeoutMs }) {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...scriptArgs], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      stderr += `\nTimed out after ${timeoutMs}ms`;
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
        durationMs: Date.now() - started,
      });
    });
  });
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--compile' || arg === '--fresh' || arg === '--clean-cotx' || arg === '--fail-on-validation' || arg === '--fail-on-non-passing' || arg === '--strict-truth-corrections') {
      result[toCamel(arg.slice(2))] = true;
      continue;
    }
    if (!arg.startsWith('--')) throw new Error(`Unexpected positional argument: ${arg}`);
    const key = toCamel(arg.slice(2));
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    result[key] = value;
    index += 1;
  }
  return result;
}

function splitCsv(value) {
  return String(value).split(',').map((item) => item.trim()).filter(Boolean);
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function tail(value, maxChars) {
  return value.length > maxChars ? value.slice(-maxChars) : value;
}

function oneLine(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}
