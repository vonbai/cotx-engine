import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandCompile } from '../../src/commands/compile.js';
import { CotxStore } from '../../src/store/store.js';
import { generateMapSummary } from '../../src/commands/map.js';

describe('benchmark guardrail: architecture narrative regression', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-bench-arch-'));
    fs.mkdirSync(path.join(tmpDir, 'api'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'db'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'api', 'main.ts'),
      [
        "import { query } from '../db/query.js';",
        'export function runApi() {',
        '  return query();',
        '}',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(tmpDir, 'db', 'query.ts'),
      [
        'export function query() {',
        '  return 1;',
        '}',
        '',
      ].join('\n'),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('produces a readable architecture summary with perspectives and components', async () => {
    await commandCompile(tmpDir, { silent: true });
    const output = generateMapSummary(new CotxStore(tmpDir), 'architecture', 2);
    expect(output).toContain('## Architecture:');
    expect(output).toContain('### Overall Architecture');
    expect(output).toContain('Api');
  });
});
