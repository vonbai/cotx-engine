import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import rootPackage from '../../package.json' with { type: 'json' };
import { qualityGatePlan } from '../../scripts/run-proof-quality-gates.mjs';
import { workflowUiSdkPlan } from '../../scripts/run-proof-workflow-ui-sdk.mjs';

describe('root proof script contract', () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it('keeps SDK root scripts on workspace-driven npm execution', () => {
    const scripts = rootPackage.scripts;
    expect(scripts['build:sdk']).toBe('node scripts/run-with-local-bins.mjs --npm run build --workspaces --if-present');
    expect(scripts['test:sdk']).toBe('node scripts/run-with-local-bins.mjs --npm run test --workspaces --if-present');
    expect(scripts['lint:sdk']).toBe('node scripts/run-with-local-bins.mjs --npm run lint --workspaces --if-present');
    expect(scripts['proof:quality-gates']).not.toContain('bash -lc');
    expect(scripts['proof:workflow:ui-sdk']).not.toContain('bash -lc');
  });

  it('preserves workspace npm args when running the local-bin wrapper in npm mode', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-root-script-contract-'));
    const fakeNpmPath = path.join(tmpDir, 'fake-npm.mjs');
    const logPath = path.join(tmpDir, 'npm-args.json');
    fs.writeFileSync(
      fakeNpmPath,
      `import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)));
`,
      'utf8',
    );

    const result = spawnSync(process.execPath, [
      path.join(process.cwd(), 'scripts', 'run-with-local-bins.mjs'),
      '--npm',
      'run',
      'build',
      '--workspaces',
      '--if-present',
    ], {
      cwd: process.cwd(),
      encoding: 'utf-8',
      env: {
        ...process.env,
        npm_execpath: fakeNpmPath,
      },
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(logPath, 'utf8'))).toEqual([
      'run',
      'build',
      '--workspaces',
      '--if-present',
    ]);
  });

  it('documents the explicit proof command plans for quality gates and UI workflow', () => {
    expect(qualityGatePlan()).toEqual([
      ['--npm', 'run', 'lint'],
      ['--npm', 'test'],
      ['--npm', 'run', 'build'],
      ['--npm', 'run', 'pack:check'],
      ['git', 'diff', '--check'],
    ]);
    expect(workflowUiSdkPlan()).toEqual([
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
    ]);
  });
});
