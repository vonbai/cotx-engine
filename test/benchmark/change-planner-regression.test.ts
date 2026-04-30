import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandCompile } from '../../src/commands/compile.js';
import { CotxStore } from '../../src/store/store.js';
import { buildChangePlan } from '../../src/compiler/change-planner.js';

describe('benchmark guardrail: change planner regression', () => {
  let tmpDir: string;
  let store: CotxStore;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-bench-plan-'));
    fs.mkdirSync(path.join(tmpDir, 'api'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'db'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# repo\n');
    fs.writeFileSync(
      path.join(tmpDir, 'api', 'main.ts'),
      "import { query } from '../db/query.js';\nexport function runApi() { return query(); }\n",
    );
    fs.writeFileSync(
      path.join(tmpDir, 'db', 'query.ts'),
      'export function query() { return 1; }\n',
    );
    await commandCompile(tmpDir, { silent: true });
    store = new CotxStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('keeps the plan scoped while still exposing non-local strategy options', () => {
    const plan = buildChangePlan(tmpDir, store, 'api');
    expect(plan.recommended_modules).toContain('api');
    expect(plan.recommended_option_id).not.toBe('compatibility_bridge');
    expect(plan.options.some((option) => option.kind === 'canonicalize_path' || option.kind === 'cluster_wide_closure')).toBe(true);
  });
});
