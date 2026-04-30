#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { runWithLocalBins } from './run-with-local-bins.mjs';

export function workflowUiSdkPlan() {
  return [
    [
      '--npm',
      'run',
      'test',
      '--workspace',
      'apps/cotx-workbench',
      '--',
      'test/app.test.tsx',
      'test/accessibility.test.ts',
      'test/performance-budget.test.ts',
    ],
    ['vitest', 'run', 'test/mcp/workbench-routes.test.ts'],
  ];
}

export function runWorkflowUiSdk() {
  for (const step of workflowUiSdkPlan()) {
    const exitCode = runWithLocalBins(step);
    if (exitCode !== 0) return exitCode;
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = runWorkflowUiSdk();
}
