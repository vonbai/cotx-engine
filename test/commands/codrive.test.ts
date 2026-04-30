import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CotxStore } from '../../src/store/store.js';
import { commandCodrive } from '../../src/commands/codrive.js';

describe('commandCodrive', () => {
  let tmpDir: string;
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-codrive-command-'));
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Co-Drive Fixture\n\nThe API is in src/api.ts.\n', 'utf-8');
    fs.mkdirSync(path.join(tmpDir, 'assets', 'icons'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'assets', 'icons', 'logo.png'), 'png', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'src', 'api.ts'), 'export function handler() { return 1; }\n', 'utf-8');
    const store = new CotxStore(tmpDir);
    store.init('codrive-test');
    store.writeModule({
      id: 'api',
      canonical_entry: 'src/api.ts:handler',
      files: ['src/api.ts'],
      depends_on: [],
      depended_by: [],
      struct_hash: 'mod1',
    });
    spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    spy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('prints a bounded CLI and MCP workflow with stale/gap context', async () => {
    await commandCodrive(tmpDir, ['change', 'api'], { focus: 'api', budget: 'tiny' });

    const output = spy.mock.calls.flat().join('\n');
    expect(output).toContain('## cotx Co-Driving Workflow: change api');
    expect(output).toContain('Graph file index:');
    expect(output).toContain('Asset directories: 1');
    expect(output).toContain('### Consistency Signals');
    expect(output).toContain('### Asset Directories');
    expect(output).toContain('assets/icons');
    expect(output).toContain('cotx plan-change "api"');
    expect(output).toContain('cotx_prepare_task');
    expect(output).toContain('cotx_review_change');
  });

  it('rejects invalid budgets without running a broad scan', async () => {
    await commandCodrive(tmpDir, ['change', 'api'], { budget: 'wide' });

    const output = spy.mock.calls.flat().join('\n');
    expect(output).toContain('Invalid budget. Use: tiny, standard, or deep.');
  });
});
