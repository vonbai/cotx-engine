import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { CotxStore } from '../../src/store/store.js';
import { handleToolCall } from '../../src/mcp/tools.js';

function parse(result: Awaited<ReturnType<typeof handleToolCall>>) {
  return JSON.parse(result.content[0].text);
}

describe('MCP doctrine / planner / review dispatch', () => {
  let tmpDir: string;
  let store: CotxStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-mcp-doctrine-'));
    store = new CotxStore(tmpDir);
    store.init('mcp-doctrine-test');
    store.writeModule({
      id: 'api',
      canonical_entry: 'src/api/main.ts:runApi',
      files: ['src/api/main.ts'],
      depends_on: [],
      depended_by: [],
      struct_hash: 'mod1',
    });
    store.writeDoctrine({
      generated_at: '2026-04-11T00:00:00Z',
      struct_hash: 'doctrine1',
      statements: [
        {
          id: 'doctrine-1',
          kind: 'principle',
          title: 'Prefer module-local fixes',
          statement: 'Change the owning module first.',
          strength: 'soft',
          scope: 'repo',
          inferred: true,
          evidence: [{ kind: 'module', ref: 'api' }],
        },
      ],
    });
    execSync('git init', { cwd: tmpDir });
    execSync('git config user.email "test@example.com"', { cwd: tmpDir });
    execSync('git config user.name "Test User"', { cwd: tmpDir });
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'api.ts'), 'export function compatWrapper() { return 1; }\n');
    execSync('git add . && git commit -m "baseline"', { cwd: tmpDir });
    fs.writeFileSync(path.join(tmpDir, 'src', 'api.ts'), 'export function compatWrapper() { return 2; }\n');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('serves doctrine, plan-change, and review-change results', async () => {
    const doctrine = parse(await handleToolCall('cotx_doctrine', { project_root: tmpDir }));
    expect(doctrine.statements[0].id).toBe('doctrine-1');

    const plan = parse(await handleToolCall('cotx_plan_change', { project_root: tmpDir, target: 'api' }));
    expect(plan.target).toBe('api');

    const review = parse(await handleToolCall('cotx_review_change', { project_root: tmpDir }));
    expect(Array.isArray(review.findings)).toBe(true);
  });
});
