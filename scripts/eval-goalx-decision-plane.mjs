#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const reposRoot = '/data/dev/goalx_test/repos';
const distCli = process.env.COTX_EVAL_CLI ?? '/data/dev/cotx-engine/.worktrees/decision-plane-exec/dist/index.js';
const outDir = '/data/dev/goalx_test/results/2026-04-11';
const outFile = path.join(outDir, 'decision-plane-eval.jsonl');
const timeoutMs = Number(process.env.COTX_EVAL_TIMEOUT_MS ?? 180_000);

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, '', 'utf-8');

function runNode(repoPath, args) {
  return execFileSync('node', [distCli, ...args], {
    cwd: repoPath,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 20 * 1024 * 1024,
    timeout: timeoutMs,
  });
}

function visibleCanonicalCount(output) {
  return output
    .split('\n')
    .filter((line) => line.startsWith('- ['))
    .length;
}

function suppressedCount(output) {
  const match = output.match(/Suppressed (\d+) /);
  return match ? Number(match[1]) : 0;
}

function visibleUnknownCount(output) {
  return output
    .split('\n')
    .filter((line) => line.includes(':unknown'))
    .length;
}

function topLines(output, limit = 12) {
  return output.split('\n').slice(0, limit);
}

const repos = fs.readdirSync(reposRoot)
  .map((name) => path.join(reposRoot, name))
  .filter((fullPath) => fs.statSync(fullPath).isDirectory())
  .sort();

for (const repoPath of repos) {
  const repo = path.basename(repoPath);
  const record = {
    repo,
    ok: false,
    compile_seconds: null,
    visible_canonicals: 0,
    suppressed_canonicals: 0,
    visible_unknowns: 0,
    notes: [],
    canonical_preview: [],
  };

  try {
    fs.rmSync(path.join(repoPath, '.cotx'), { recursive: true, force: true });
    const started = Date.now();
    runNode(repoPath, ['compile']);
    record.compile_seconds = Number(((Date.now() - started) / 1000).toFixed(3));

    const canonicalOutput = runNode(repoPath, ['canonical-paths']);
    record.visible_canonicals = visibleCanonicalCount(canonicalOutput);
    record.suppressed_canonicals = suppressedCount(canonicalOutput);
    record.visible_unknowns = visibleUnknownCount(canonicalOutput);
    record.canonical_preview = topLines(canonicalOutput);

    if (record.visible_unknowns > 0) {
      record.notes.push('visible_unknown_candidates');
    }
    if (record.visible_canonicals === 0 && record.suppressed_canonicals > 0) {
      record.notes.push('all_candidates_suppressed');
    }
    if (record.visible_canonicals > 12) {
      record.notes.push('too_many_visible_canonicals');
    }

    record.ok = true;
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
  }

  fs.appendFileSync(outFile, JSON.stringify(record) + '\n', 'utf-8');
  console.log(`${repo}: ${record.ok ? 'ok' : 'fail'}`);
}

console.log(`wrote ${outFile}`);
