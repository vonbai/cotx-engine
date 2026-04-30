#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { runWithLocalBins } from './run-with-local-bins.mjs';

export function qualityGatePlan() {
  return [
    ['--npm', 'run', 'lint'],
    ['--npm', 'test'],
    ['--npm', 'run', 'build'],
    ['--npm', 'run', 'pack:check'],
    ['git', 'diff', '--check'],
  ];
}

export function runQualityGates() {
  for (const step of qualityGatePlan()) {
    const exitCode = runWithLocalBins(step);
    if (exitCode !== 0) return exitCode;
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = runQualityGates();
}
