import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandCompile } from '../../src/commands/compile.js';
import { commandDecisionQuery } from '../../src/commands/decision-query.js';

describe('commandDecisionQuery', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-decision-query-test-'));
    fs.mkdirSync(path.join(tmpDir, 'api'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'service'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'db'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'api', 'user.ts'), "import { prepareUser } from '../service/user.js';\nexport function saveUser() { return prepareUser(); }\n");
    fs.writeFileSync(path.join(tmpDir, 'service', 'user.ts'), "import { saveState } from '../db/store.js';\nexport function prepareUser() { return saveState(); }\n");
    fs.writeFileSync(path.join(tmpDir, 'db', 'store.ts'), 'export function saveState() { return 1; }\n');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('queries canonical decision facts from the storage-v2 rule index', async () => {
    await commandCompile(tmpDir, { silent: true });

    const result = await commandDecisionQuery(tmpDir, 'canonical', 'save:repository_write');

    expect(result.kind).toBe('canonical');
    expect(result.row_count).toBeGreaterThan(0);
  });
});
