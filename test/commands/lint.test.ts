import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CotxStore } from '../../src/store/store.js';
import { commandLint } from '../../src/commands/lint.js';

describe('commandLint', () => {
  let tmpDir: string;
  let store: CotxStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-lint-test-'));
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'example/\n');
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'example'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'main.ts'), 'export function main() { return 1; }\n');
    fs.writeFileSync(path.join(tmpDir, 'example', 'ignored.py'), 'def ignored():\n    return 1\n');

    store = new CotxStore(tmpDir);
    store.init('lint-test');
    store.writeModule({
      id: 'src',
      canonical_entry: 'main',
      files: ['src/main.ts'],
      depends_on: [],
      depended_by: [],
      struct_hash: 'lint1234',
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('uses the same ignore behavior as compile when checking uncovered files', async () => {
    const issues = await commandLint(tmpDir, { silent: true });

    expect(
      issues.some(
        (issue) =>
          issue.type === 'UNCOVERED_FILE' &&
          issue.message.includes('example/ignored.py'),
      ),
    ).toBe(false);
  });
});
