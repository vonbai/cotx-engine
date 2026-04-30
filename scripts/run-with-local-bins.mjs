#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(scriptDir, '..');

export function localBinTargets(rootDir = repoRoot) {
  return {
    tsc: path.join(rootDir, 'node_modules', 'typescript', 'bin', 'tsc'),
    'tsc-alias': path.join(rootDir, 'node_modules', 'tsc-alias', 'dist', 'index.js'),
    vitest: path.join(rootDir, 'node_modules', 'vitest', 'vitest.mjs'),
    vite: path.join(rootDir, 'node_modules', 'vite', 'bin', 'vite.js'),
  };
}

function posixLauncher(nodePath, targetPath) {
  return `#!/bin/sh
exec "${nodePath}" "${targetPath}" "$@"
`;
}

function cmdLauncher(nodePath, targetPath) {
  const escapedNode = nodePath.replaceAll('/', '\\');
  const escapedTarget = targetPath.replaceAll('/', '\\');
  return `@echo off\r\n"${escapedNode}" "${escapedTarget}" %*\r\n`;
}

export function createLocalBinDir(rootDir = repoRoot) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-local-bin-'));
  for (const [name, targetPath] of Object.entries(localBinTargets(rootDir))) {
    if (!fs.existsSync(targetPath)) continue;
    const launcherPath = path.join(binDir, name);
    fs.writeFileSync(launcherPath, posixLauncher(process.execPath, targetPath), { mode: 0o755 });
    fs.writeFileSync(`${launcherPath}.cmd`, cmdLauncher(process.execPath, targetPath), 'utf8');
  }
  return binDir;
}

export function resolveCommand(argv, env = process.env) {
  if (argv.length === 0) {
    throw new Error('Usage: node scripts/run-with-local-bins.mjs [--npm] <command> [args...]');
  }
  if (argv[0] === '--npm') {
    if (!env.npm_execpath) {
      throw new Error('npm_execpath is required when using --npm');
    }
    return {
      command: process.execPath,
      args: [env.npm_execpath, ...argv.slice(1)],
    };
  }
  return {
    command: argv[0],
    args: argv.slice(1),
  };
}

export function runWithLocalBins(argv, options = {}) {
  const binDir = createLocalBinDir(repoRoot);
  try {
    const resolved = resolveCommand(argv, options.env ?? process.env);
    const result = spawnSync(resolved.command, resolved.args, {
      cwd: options.cwd ?? process.cwd(),
      env: {
        ...(options.env ?? process.env),
        PATH: `${binDir}${path.delimiter}${(options.env ?? process.env).PATH ?? ''}`,
      },
      stdio: 'inherit',
    });
    if (typeof result.status === 'number') return result.status;
    return result.error ? 1 : 0;
  } finally {
    fs.rmSync(binDir, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = runWithLocalBins(process.argv.slice(2));
}
