import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandCompile } from '../../src/commands/compile.js';
import { CotxStore } from '../../src/store/store.js';
import { compareChangePlans } from '../../src/compiler/plan-comparator.js';

describe('compareChangePlans', () => {
  let tmpDir: string;
  let store: CotxStore;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-plan-comparator-'));
    fs.mkdirSync(path.join(tmpDir, 'src', 'api'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src', 'service'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src', 'db'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'tests', 'api'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# repo\n');
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'api', 'user.ts'),
      "import { validateUser } from '../service/user.js';\nexport function handleCreateUser() { return validateUser(); }\n",
    );
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'api', 'admin.ts'),
      "import { validateAdmin } from '../service/admin.js';\nexport function handleCreateAdmin() { return validateAdmin(); }\n",
    );
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'service', 'user.ts'),
      "import { saveState } from '../db/store.js';\nexport function validateUser() { return saveState(); }\n",
    );
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'service', 'admin.ts'),
      "import { saveState } from '../db/store.js';\nexport function validateAdmin() { return saveState(); }\n",
    );
    fs.writeFileSync(path.join(tmpDir, 'src', 'db', 'store.ts'), 'export function saveState() { return 1; }\n');
    fs.writeFileSync(path.join(tmpDir, 'tests', 'api', 'user.test.ts'), 'export function handleCreateUser() { return 1; }\n');
    await commandCompile(tmpDir, { silent: true });
    store = new CotxStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('compares explicit plan options and recommends a non-bridge strategy', () => {
    const plan = compareChangePlans(tmpDir, store, 'api');
    expect(plan).not.toBeNull();
    expect(plan?.recommended_modules.every((id) => {
      try {
        store.readModule(id);
        return true;
      } catch {
        return false;
      }
    })).toBe(true);
    expect((plan?.scope_hints ?? []).length).toBeGreaterThan(0);
    expect(plan?.recommended_modules.some((id) => id.includes('tests'))).toBe(false);
    expect(plan?.scope_hints.some((id) => id.includes('tests'))).toBe(false);
    expect(plan?.options.some((option) => option.kind === 'cluster_wide_closure')).toBe(true);
    expect(plan?.recommended_option_id).not.toBe('compatibility_bridge');
  });
});
