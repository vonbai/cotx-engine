import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandCompile } from '../../src/commands/compile.js';
import { commandUpdate } from '../../src/commands/update.js';
import { CotxStore } from '../../src/store/store.js';

describe('benchmark guardrail: change summary regression', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-bench-change-'));
    fs.writeFileSync(
      path.join(tmpDir, 'main.ts'),
      [
        'export function run() {',
        '  return 1;',
        '}',
        '',
      ].join('\n'),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('surfaces newly added exported symbols in latest change summary', async () => {
    await commandCompile(tmpDir, { silent: true });
    fs.writeFileSync(
      path.join(tmpDir, 'main.ts'),
      [
        'export function run() {',
        '  return 1;',
        '}',
        '',
        'export function runList() {',
        '  return run();',
        '}',
        '',
      ].join('\n'),
    );

    await commandUpdate(tmpDir, ['main.ts'], { silent: true });

    const summary = new CotxStore(tmpDir).readLatestChangeSummary();
    expect(summary?.symbols.added.some((item) => item.id.includes('runList'))).toBe(true);
  });
});
