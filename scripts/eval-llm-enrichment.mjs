#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const distModule = path.join(repoRoot, 'dist', 'compiler', 'llm-enrichment-eval.js');
const distRunnerModule = path.join(repoRoot, 'dist', 'compiler', 'caller-agent-runner.js');
const distConfigModule = path.join(repoRoot, 'dist', 'config.js');

if (!fs.existsSync(distModule) || !fs.existsSync(distRunnerModule) || !fs.existsSync(distConfigModule)) {
  console.error('Missing dist eval support modules. Run `npm run build` before this eval script.');
  process.exit(1);
}

const {
  buildLlmEnrichmentEvalRecord,
  writeLlmEnrichmentEvalReport,
} = await import(pathToFileURL(distModule).href);
const { runCallerAgentRunner } = await import(pathToFileURL(distRunnerModule).href);
const { hasConfiguredLlm } = await import(pathToFileURL(distConfigModule).href);

const args = parseArgs(process.argv.slice(2));
const modes = splitCsv(args.mode ?? process.env.MODE ?? 'cotx-deterministic');
const layers = splitCsv(args.layers ?? process.env.LAYERS ?? args.layer ?? process.env.LAYER ?? 'architecture');
const product = args.product ?? process.env.PRODUCT;
const task = args.task ?? process.env.TASK ?? 'architecture enrichment baseline';
const budget = args.budget ?? process.env.BUDGET ?? 'standard';
const outDir = args.outDir ?? process.env.OUT_DIR ?? path.join(repoRoot, '.cotx', 'eval', 'llm-enrichment');
const writeJsonl = Boolean(args.jsonl) || process.env.WRITE_JSONL === '1';
const projectRoots = resolveProjectRoots(args);
const llmConfigured = Boolean(args.llmConfigured) || process.env.LLM_CONFIGURED === '1' || hasConfiguredLlm();
const externalRunnerAvailable = Boolean(args.runnerAvailable) || process.env.RUNNER_AVAILABLE === '1';
const callerAgentRunnerCommand = args.callerAgentRunner ?? process.env.COTX_CALLER_AGENT_RUNNER;
const callerAgentRunnerArgs = parseJsonArrayArg(
  args.callerAgentRunnerArgsJson ?? process.env.COTX_CALLER_AGENT_RUNNER_ARGS_JSON ?? '[]',
  'caller-agent runner args',
);
const callerAgentRunnerTimeoutMs = positiveInteger(
  args.callerAgentTimeoutMs ?? process.env.COTX_CALLER_AGENT_TIMEOUT_MS,
  120_000,
);

const records = [];
for (const { repo, projectRoot } of projectRoots) {
  for (const layer of layers) {
    for (const mode of modes) {
      records.push(buildLlmEnrichmentEvalRecord({
      projectRoot,
      repo,
      task,
      layer,
      mode,
      product,
      budget,
      llmConfigured,
      runnerAvailable: mode === 'cotx-caller-agent'
        ? Boolean(callerAgentRunnerCommand)
        : externalRunnerAvailable,
      }));
    }
  }
}

if (callerAgentRunnerCommand) {
  for (const record of records) {
    if (record.mode !== 'cotx-caller-agent' || record.execution.status !== 'ready') continue;
    record.caller_agent_runner = await runCallerAgentRunner(record, {
      command: callerAgentRunnerCommand,
      args: callerAgentRunnerArgs,
      timeoutMs: callerAgentRunnerTimeoutMs,
    });
  }
}

const result = writeLlmEnrichmentEvalReport(records, {
  outDir,
  writeJsonl,
});

console.log(`wrote ${result.markdown_path}`);
if (result.jsonl_path) console.log(`wrote ${result.jsonl_path}`);

function resolveProjectRoots(parsedArgs) {
  const explicit = parsedArgs.projectRoot ?? process.env.PROJECT_ROOT;
  if (explicit) {
    const roots = splitCsv(explicit).map((item) => path.resolve(item));
    return roots.map((projectRoot) => ({ repo: path.basename(projectRoot), projectRoot }));
  }

  const explicitRoots = parsedArgs.projectRoots ?? process.env.PROJECT_ROOTS;
  if (explicitRoots) {
    const roots = splitCsv(explicitRoots).map((item) => path.resolve(item));
    return roots.map((projectRoot) => ({ repo: path.basename(projectRoot), projectRoot }));
  }

  const repos = parsedArgs.repos ?? process.env.REPOS;
  if (repos) {
    const reposRoot = path.resolve(parsedArgs.reposRoot ?? process.env.REPOS_ROOT ?? process.cwd());
    return splitCsv(repos).map((repo) => ({
      repo,
      projectRoot: path.join(reposRoot, repo),
    }));
  }

  const cwd = process.cwd();
  return [{ repo: path.basename(cwd), projectRoot: cwd }];
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--jsonl' || arg === '--llm-configured' || arg === '--runner-available') {
      result[toCamel(arg.slice(2))] = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
    const key = toCamel(arg.slice(2));
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${arg}`);
    }
    result[key] = value;
    index += 1;
  }
  return result;
}

function parseJsonArrayArg(value, label) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid ${label}: expected JSON array: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
    throw new Error(`Invalid ${label}: expected JSON array of strings`);
  }
  return parsed;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function splitCsv(value) {
  return String(value).split(',').map((item) => item.trim()).filter(Boolean);
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}
