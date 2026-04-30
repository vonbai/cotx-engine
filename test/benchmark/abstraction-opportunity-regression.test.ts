import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandCompile } from '../../src/commands/compile.js';
import { CotxStore } from '../../src/store/store.js';
import { compareChangePlans } from '../../src/compiler/plan-comparator.js';
import { DecisionRuleIndex } from '../../src/store-v2/index.js';

describe('benchmark guardrail: abstraction opportunity regression', () => {
  let tmpDir: string;
  let store: CotxStore;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-bench-abstraction-'));
    fs.mkdirSync(path.join(tmpDir, 'api'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'service'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'db'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# repo\n');
    fs.writeFileSync(path.join(tmpDir, 'api', 'user.ts'), "import { validateUser } from '../service/user.js';\nexport function updateUser() { return validateUser(); }\n");
    fs.writeFileSync(path.join(tmpDir, 'api', 'admin.ts'), "import { validateAdmin } from '../service/admin.js';\nexport function updateAdmin() { return validateAdmin(); }\n");
    fs.writeFileSync(path.join(tmpDir, 'api', 'bot.ts'), "import { validateBot } from '../service/bot.js';\nexport function updateBot() { return validateBot(); }\n");
    fs.writeFileSync(path.join(tmpDir, 'service', 'user.ts'), "import { saveState } from '../db/store.js';\nexport function validateUser() { return saveState(); }\n");
    fs.writeFileSync(path.join(tmpDir, 'service', 'admin.ts'), "import { saveState } from '../db/store.js';\nexport function validateAdmin() { return saveState(); }\n");
    fs.writeFileSync(path.join(tmpDir, 'service', 'bot.ts'), "import { saveState } from '../db/store.js';\nexport function validateBot() { return saveState(); }\n");
    fs.writeFileSync(path.join(tmpDir, 'db', 'store.ts'), 'export function saveState() { return 1; }\n');
    await commandCompile(tmpDir, { silent: true });
    store = new CotxStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('surfaces abstraction opportunities and compares helper extraction against local patching', async () => {
    const index = new DecisionRuleIndex({ dbPath: path.join(tmpDir, '.cotx', 'v2', 'rules.db') });
    await index.open();
    try {
      const targets = await index.abstractionTargets(1);
      expect(targets.length).toBeGreaterThan(0);
    } finally {
      index.close();
    }

    const plan = compareChangePlans(tmpDir, store, 'api');
    expect(plan?.options.some((option) => option.kind === 'extract_helper')).toBe(true);
  });
});
