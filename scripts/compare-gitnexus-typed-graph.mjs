#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  formatQualityProbeSummary,
  qualityProbeScoreContributions,
  runQualityProbes,
} from './typed-graph-probes/index.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const reposRoot = process.env.REPOS_ROOT ?? '/data/dev/goalx_test/repos';
const repos = (process.env.REPOS ?? 'fastmcp,github-mcp-server,ruff').split(',').filter(Boolean);
const cotxCli = process.env.COTX_CLI ?? path.join(projectRoot, 'dist', 'index.js');
const outDir = process.env.OUT_DIR ?? '/data/dev/goalx_test/results/2026-04-13';
const outJsonl = path.join(outDir, 'cotx-gitnexus-quality-v3.jsonl');
const outSummary = path.join(outDir, 'cotx-gitnexus-quality-v3.md');
const timeoutMs = Number(process.env.TIMEOUT_MS ?? 300_000);

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outJsonl, '', 'utf-8');

function run(cmd, args, cwd, timeout = timeoutMs) {
  const started = Date.now();
  try {
    const stdout = execFileSync(cmd, args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 160 * 1024 * 1024,
      timeout,
    });
    return { ok: true, seconds: Number(((Date.now() - started) / 1000).toFixed(3)), stdout };
  } catch (error) {
    return {
      ok: false,
      seconds: Number(((Date.now() - started) / 1000).toFixed(3)),
      error: error instanceof Error ? error.message : String(error),
      stdout: error.stdout?.toString?.() ?? '',
      stderr: error.stderr?.toString?.() ?? '',
    };
  }
}

function jsonCommand(cmd, args, cwd, timeout) {
  const result = run(cmd, args, cwd, timeout);
  if (!result.ok) return { error: result.error, stderr: result.stderr?.slice(0, 2000) };
  try {
    return JSON.parse(result.stdout);
  } catch {
    return { raw: result.stdout.slice(0, 2000) };
  }
}

function cotxJson(repoPath, args, timeout) {
  return jsonCommand('node', [cotxCli, ...args], repoPath, timeout);
}

function countCotx(repoPath, query) {
  return countFromCypherResult(cotxJson(repoPath, ['cypher', query]));
}

function gitnexusJson(repoName, repoPath, query) {
  return jsonCommand('gitnexus', ['cypher', '--repo', repoName, query], repoPath, 180_000);
}

function countGitNexus(repoName, repoPath, query) {
  return countFromCypherResult(gitnexusJson(repoName, repoPath, query));
}

function countFromCypherResult(result) {
  if (result?.rows?.[0]?.n !== undefined) return Number(result.rows[0].n);
  const row = firstMarkdownRow(result);
  if (row?.n !== undefined) return Number(row.n);
  return 0;
}

function firstCotxCallSample(repoPath) {
  return cotxJson(repoPath, [
    'cypher',
    "MATCH (f:Function)-[r:CodeRelation {type:'CALLS'}]->(g:Function) RETURN f.id AS id, f.name AS name, count(r) AS out_degree ORDER BY out_degree DESC LIMIT 1",
  ]).rows?.[0] ?? null;
}

function firstMarkdownRow(result) {
  const markdown = String(result?.markdown ?? '');
  const lines = markdown.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length < 3) return null;
  const headers = markdownCells(lines[0]);
  const values = markdownCells(lines[2]);
  if (headers.length === 0 || headers.length !== values.length) return null;
  return Object.fromEntries(headers.map((header, index) => [header, parseMarkdownValue(values[index])]));
}

function markdownCells(line) {
  return line.split('|').map((cell) => cell.trim()).filter(Boolean);
}

function parseMarkdownValue(value) {
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function queryRowCotx(repoPath, query) {
  const result = cotxJson(repoPath, ['cypher', query], 120_000);
  return result.rows?.[0] ?? firstMarkdownRow(result) ?? {};
}

function queryRowGitNexus(repoName, repoPath, query) {
  return firstMarkdownRow(gitnexusJson(repoName, repoPath, query)) ?? {};
}

function compareRepo(name) {
  const repoPath = path.join(reposRoot, name);
  const record = { repo: name };

  fs.rmSync(path.join(repoPath, '.cotx'), { recursive: true, force: true });
  const cotxCompile = run('node', [cotxCli, 'compile'], repoPath);
  record.cotx_ok = cotxCompile.ok;
  record.cotx_compile_seconds = cotxCompile.seconds;
  if (cotxCompile.ok) {
    record.cotx = {
      code_nodes: countCotx(repoPath, 'MATCH (n:CodeNode) RETURN count(n) AS n'),
      code_relations: countCotx(repoPath, 'MATCH ()-[r:CodeRelation]->() RETURN count(r) AS n'),
      typed_relations: countCotx(repoPath, 'MATCH ()-[r:CodeRelation]->() RETURN count(r) AS n'),
      typed_calls: countCotx(repoPath, "MATCH (f:Function)-[r:CodeRelation {type:'CALLS'}]->(g:Function) RETURN count(r) AS n"),
      routes: countCotx(repoPath, "MATCH (n:CodeNode {label:'Route'}) RETURN count(n) AS n"),
      tools: countCotx(repoPath, "MATCH (n:CodeNode {label:'Tool'}) RETURN count(n) AS n"),
      fetches: countCotx(repoPath, "MATCH ()-[r:CodeRelation {type:'FETCHES'}]->() RETURN count(r) AS n"),
    };

    const sample = firstCotxCallSample(repoPath);
    record.cotx_sample = sample;
    if (sample?.id) {
      record.cotx_context = cotxJson(repoPath, ['context', sample.id], 120_000);
      const impact = run('node', [cotxCli, 'impact', sample.id], repoPath, 120_000);
      record.cotx_impact = impact.ok ? parseJsonOrRaw(impact.stdout) : { error: impact.error };
    }
  } else {
    record.cotx_error = cotxCompile.error;
  }

  const gitnexusAnalyze = run('gitnexus', ['analyze', '--force', '--skip-agents-md', repoPath], repoPath);
  record.gitnexus_ok = gitnexusAnalyze.ok;
  record.gitnexus_analyze_seconds = gitnexusAnalyze.seconds;
  if (gitnexusAnalyze.ok) {
    record.gitnexus = {
      code_nodes: countGitNexus(name, repoPath, 'MATCH (n) RETURN count(n) AS n'),
      code_relations: countGitNexus(name, repoPath, 'MATCH ()-[r:CodeRelation]->() RETURN count(r) AS n'),
      typed_calls: countGitNexus(name, repoPath, "MATCH (f:Function)-[r:CodeRelation {type:'CALLS'}]->(g:Function) RETURN count(r) AS n"),
      routes: countGitNexus(name, repoPath, 'MATCH (n:Route) RETURN count(n) AS n'),
      tools: countGitNexus(name, repoPath, 'MATCH (n:Tool) RETURN count(n) AS n'),
      fetches: countGitNexus(name, repoPath, "MATCH ()-[r:CodeRelation {type:'FETCHES'}]->() RETURN count(r) AS n"),
    };

    if (record.cotx_sample?.id) {
      const context = run('gitnexus', ['context', '--repo', name, '--uid', record.cotx_sample.id], repoPath, 120_000);
      record.gitnexus_context = context.ok ? parseJsonOrRaw(context.stdout) : { error: context.error, stderr: context.stderr.slice(0, 1000) };
      const impact = run('gitnexus', ['impact', '--repo', name, record.cotx_sample.id], repoPath, 120_000);
      record.gitnexus_impact = impact.ok ? parseJsonOrRaw(impact.stdout) : { error: impact.error, stderr: impact.stderr.slice(0, 1000) };
    }
  } else {
    record.gitnexus_error = gitnexusAnalyze.error;
  }

  if (record.cotx_ok && record.gitnexus_ok) {
    record.quality_probes = runQualityProbes(name, repoPath, {
      countCotx,
      countGitNexus,
      queryRowCotx,
      queryRowGitNexus,
    });
  }
  record.score = scoreRecord(record);
  return record;
}

function parseJsonOrRaw(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return { raw: stdout.slice(0, 2000) };
  }
}

function ratio(a, b) {
  return b > 0 ? Number((a / b).toFixed(3)) : null;
}

function scoreRecord(record) {
  const cotx = record.cotx ?? {};
  const gitnexus = record.gitnexus ?? {};
  const nodeRatio = ratio(cotx.code_nodes ?? 0, gitnexus.code_nodes ?? 0);
  const relationRatio = ratio(cotx.code_relations ?? 0, gitnexus.code_relations ?? 0);
  const callRatio = ratio(cotx.typed_calls ?? 0, gitnexus.typed_calls ?? 0);
  const routeRatio = ratio(cotx.routes ?? 0, gitnexus.routes ?? 0);
  const toolRatio = ratio(cotx.tools ?? 0, gitnexus.tools ?? 0);
  const structuralScore = average([
    cappedRatioScore(nodeRatio),
    cappedRatioScore(relationRatio),
    cappedRatioScore(callRatio),
    routeRatio === null ? null : cappedRatioScore(routeRatio),
    toolRatio === null ? null : cappedRatioScore(toolRatio),
  ]);
  const contextScore = record.cotx_context?.symbol && record.cotx_context?.incoming_by_type && record.cotx_context?.outgoing_by_type ? 1 : 0;
  const qualityScore = average([
    structuralScore,
    contextScore,
    ...qualityProbeScoreContributions(record),
  ]);
  return {
    speed_ratio_vs_gitnexus: ratio(record.cotx_compile_seconds, record.gitnexus_analyze_seconds),
    node_ratio_vs_gitnexus: nodeRatio,
    relation_ratio_vs_gitnexus: relationRatio,
    typed_call_ratio_vs_gitnexus: callRatio,
    route_ratio_vs_gitnexus: routeRatio,
    tool_ratio_vs_gitnexus: toolRatio,
    structural_score: round3(structuralScore),
    quality_score_vs_gitnexus: round3(qualityScore),
    cotx_context_structured: Boolean(record.cotx_context?.symbol && record.cotx_context?.incoming_by_type && record.cotx_context?.outgoing_by_type),
    gitnexus_context_structured: Boolean(record.gitnexus_context?.symbol && record.gitnexus_context?.incoming && record.gitnexus_context?.outgoing),
  };
}

function cappedRatioScore(value) {
  if (value === null || value === undefined) return null;
  return Math.min(1, Math.max(0, value));
}

function average(values) {
  const usable = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (usable.length === 0) return 0;
  return usable.reduce((sum, value) => sum + value, 0) / usable.length;
}

function round3(value) {
  return Number(value.toFixed(3));
}

function writeSummary(records) {
  const lines = [
    '# cotx vs GitNexus Typed Graph Quality',
    '',
    `Repos: ${records.map((record) => record.repo).join(', ')}`,
    '',
    '| Repo | cotx s | GitNexus s | speed ratio | quality | structural | node ratio | relation ratio | call ratio | route ratio | tool ratio |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const record of records) {
    const score = record.score ?? {};
    lines.push([
      record.repo,
      record.cotx_compile_seconds ?? '',
      record.gitnexus_analyze_seconds ?? '',
      score.speed_ratio_vs_gitnexus ?? '',
      score.quality_score_vs_gitnexus ?? '',
      score.structural_score ?? '',
      score.node_ratio_vs_gitnexus ?? '',
      score.relation_ratio_vs_gitnexus ?? '',
      score.typed_call_ratio_vs_gitnexus ?? '',
      score.route_ratio_vs_gitnexus ?? '',
      score.tool_ratio_vs_gitnexus ?? '',
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }
  const probeSummary = formatQualityProbeSummary(records);
  if (probeSummary.length > 0) {
    lines.push('', 'Quality probe notes:', ...probeSummary);
  }
  lines.push('', `JSONL: ${outJsonl}`);
  fs.writeFileSync(outSummary, `${lines.join('\n')}\n`, 'utf-8');
}

const records = [];
for (const repo of repos) {
  const record = compareRepo(repo);
  records.push(record);
  fs.appendFileSync(outJsonl, `${JSON.stringify(record)}\n`, 'utf-8');
  console.log(`${repo}: cotx=${record.cotx_compile_seconds}s gitnexus=${record.gitnexus_analyze_seconds}s speedRatio=${record.score.speed_ratio_vs_gitnexus}`);
}
writeSummary(records);
console.log(`wrote ${outJsonl}`);
console.log(`wrote ${outSummary}`);
