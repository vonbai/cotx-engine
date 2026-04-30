import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandCompile } from '../../src/commands/compile.js';
import { DecisionRuleIndex } from '../../src/store-v2/index.js';

describe('benchmark guardrail: canonical path regression', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-bench-canonical-'));
    fs.mkdirSync(path.join(tmpDir, 'api'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'service'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'db'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# repo\n');
    fs.writeFileSync(path.join(tmpDir, 'api', 'user.ts'), "import { validateUser } from '../service/user.js';\nexport function saveUser() { return validateUser(); }\n");
    fs.writeFileSync(path.join(tmpDir, 'api', 'admin.ts'), "import { validateAdmin } from '../service/admin.js';\nexport function saveAdmin() { return validateAdmin(); }\n");
    fs.writeFileSync(path.join(tmpDir, 'api', 'legacy.ts'), "import { directWrite } from '../db/direct.js';\nexport function legacySaveAdmin() { return directWrite(); }\n");
    fs.writeFileSync(path.join(tmpDir, 'service', 'user.ts'), "import { saveState } from '../db/store.js';\nexport function validateUser() { return saveState(); }\n");
    fs.writeFileSync(path.join(tmpDir, 'service', 'admin.ts'), "import { saveState } from '../db/store.js';\nexport function validateAdmin() { return saveState(); }\n");
    fs.writeFileSync(path.join(tmpDir, 'db', 'store.ts'), 'export function saveState() { return 1; }\n');
    fs.writeFileSync(path.join(tmpDir, 'db', 'direct.ts'), 'export function directWrite() { return 1; }\n');
    await commandCompile(tmpDir, { silent: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('selects a canonical path and stores it in the v2 rule index', async () => {
    const index = new DecisionRuleIndex({ dbPath: path.join(tmpDir, '.cotx', 'v2', 'rules.db') });
    await index.open();
    let canonicalPaths: Awaited<ReturnType<DecisionRuleIndex['listCanonical']>>;
    try {
      canonicalPaths = await index.listCanonical();
    } finally {
      index.close();
    }
    expect(canonicalPaths.some((path) => path.status === 'canonical')).toBe(true);
    expect(canonicalPaths.some((path) => path.confidence > 0.5)).toBe(true);
  });
});
