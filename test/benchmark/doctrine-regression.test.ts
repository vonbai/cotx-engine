import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandCompile } from '../../src/commands/compile.js';
import { CotxStore } from '../../src/store/store.js';

describe('benchmark guardrail: doctrine regression', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-bench-doctrine-'));
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
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('produces doctrine after compile', async () => {
    await commandCompile(tmpDir, { silent: true });
    const doctrine = new CotxStore(tmpDir).readDoctrine();
    expect(doctrine?.statements.length).toBeGreaterThan(0);
  });
});
