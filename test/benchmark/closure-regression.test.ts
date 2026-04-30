import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandCompile } from '../../src/commands/compile.js';
import { DecisionRuleIndex } from '../../src/store-v2/index.js';

describe('benchmark guardrail: closure regression', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-bench-closure-'));
    fs.mkdirSync(path.join(tmpDir, 'api'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'service'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'db'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# repo\n');
    fs.writeFileSync(path.join(tmpDir, 'api', 'user.ts'), "import { validateUser } from '../service/user.js';\nexport function handleCreateUser() { return validateUser(); }\n");
    fs.writeFileSync(path.join(tmpDir, 'api', 'admin.ts'), "import { validateAdmin } from '../service/admin.js';\nexport function handleCreateAdmin() { return validateAdmin(); }\n");
    fs.writeFileSync(path.join(tmpDir, 'service', 'user.ts'), "import { saveState } from '../db/store.js';\nexport function validateUser() { return saveState(); }\n");
    fs.writeFileSync(path.join(tmpDir, 'service', 'admin.ts'), "import { saveState } from '../db/store.js';\nexport function validateAdmin() { return saveState(); }\n");
    fs.writeFileSync(path.join(tmpDir, 'db', 'store.ts'), 'export function saveState() { return 1; }\n');
    await commandCompile(tmpDir, { silent: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('expands sibling handlers into a must-review closure set in v2 rule index', async () => {
    const index = new DecisionRuleIndex({ dbPath: path.join(tmpDir, '.cotx', 'v2', 'rules.db') });
    await index.open();
    try {
      const members = await index.closureFor('closure:api:handleCreateUser');
      expect(members.some((member) => member.unitId === 'api:handleCreateAdmin' && member.level === 'must_review')).toBe(true);
    } finally {
      index.close();
    }
  });
});
