import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandCompile } from '../../src/commands/compile.js';
import { commandUpdate } from '../../src/commands/update.js';
import { CotxStore } from '../../src/store/store.js';
import { ArchitectureStore } from '../../src/store/architecture-store.js';

describe('commandUpdate', () => {
  let tmpDir: string;
  let tmpHome: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-update-test-'));
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-update-home-'));
    previousHome = process.env.HOME;
    process.env.HOME = tmpHome;
    fs.mkdirSync(path.join(tmpDir, 'api'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'db'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'api', 'main.ts'),
      [
        "import { helper } from '../db/helper.js';",
        'export function mainEntry() {',
        '  return helper();',
        '}',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(tmpDir, 'db', 'helper.ts'),
      [
        'export function helper() {',
        '  return 1;',
        '}',
        '',
      ].join('\n'),
    );
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('removes deleted modules and refreshes the derived index', async () => {
    await commandCompile(tmpDir, { silent: true });
    const store = new CotxStore(tmpDir);
    expect(store.listModules()).toContain('db');

    fs.unlinkSync(path.join(tmpDir, 'db', 'helper.ts'));
    await commandUpdate(tmpDir, ['db/helper.ts'], { silent: true });

    expect(store.listModules()).not.toContain('db');
    expect(store.readIndex().graph.nodes.some((node) => node.id === 'db')).toBe(false);
  });

  it('detects newly added files even when no existing module claims them yet', async () => {
    fs.rmSync(path.join(tmpDir, 'db'), { recursive: true, force: true });
    await commandCompile(tmpDir, { silent: true });
    const store = new CotxStore(tmpDir);
    expect(store.listModules()).not.toContain('db');

    fs.mkdirSync(path.join(tmpDir, 'db'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'db', 'helper.ts'),
      [
        'export function helper() {',
        '  return 2;',
        '}',
        '',
      ].join('\n'),
    );

    await commandUpdate(tmpDir, ['db/helper.ts'], { silent: true });

    expect(store.listModules()).toContain('db');
    expect(store.readIndex().graph.nodes.some((node) => node.id === 'db')).toBe(true);
  });

  it('preserves architecture sidecars across update rebuilds', async () => {
    await commandCompile(tmpDir, { silent: true });
    const archStore = new ArchitectureStore(tmpDir);
    archStore.writeDescription('overall-architecture', 'Preserved overview');
    archStore.writeMeta({ ...archStore.readMeta(), mode: 'agent' });

    fs.writeFileSync(
      path.join(tmpDir, 'db', 'helper.ts'),
      [
        'export function helper() {',
        '  return 2;',
        '}',
        '',
      ].join('\n'),
    );

    await commandUpdate(tmpDir, ['db/helper.ts'], { silent: true });

    expect(archStore.readDescription('overall-architecture')).toBe('Preserved overview');
  });

  it('writes a latest change summary with added symbols after update', async () => {
    await commandCompile(tmpDir, { silent: true });
    const store = new CotxStore(tmpDir);

    fs.writeFileSync(
      path.join(tmpDir, 'api', 'main.ts'),
      [
        "import { helper } from '../db/helper.js';",
        'export function mainEntry() {',
        '  return helper();',
        '}',
        '',
        'export function extraEntry() {',
        '  return mainEntry();',
        '}',
        '',
      ].join('\n'),
    );

    await commandUpdate(tmpDir, ['api/main.ts'], { silent: true });

    const summary = store.readLatestChangeSummary();
    expect(summary).not.toBeNull();
    expect(summary?.trigger).toBe('update');
    expect(summary?.changed_files).toContain('api/main.ts');
    expect(summary?.symbols.added.some((symbol) => symbol.id.includes('extraEntry'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.cotx', 'v2', 'truth.lbug'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.cotx', 'v2', 'rules.db'))).toBe(true);
  });

  it('refreshes cached workspace layout during update', async () => {
    await commandCompile(tmpDir, { silent: true });
    const store = new CotxStore(tmpDir);
    store.writeWorkspaceLayout({
      project_root: tmpDir,
      generated_at: '2026-04-14T00:00:00.000Z',
      directories: [
        { path: '.', kind: 'repo-root', depth: 0 },
        { path: '.cotx', kind: 'cotx', depth: 1 },
      ],
      candidates: [
        { path: '.cotx/meta.yaml', kind: 'cotx', reason: 'cotx sidecar metadata', boundary: '.' },
      ],
      summary: {
        directories: 2,
        candidates: 1,
        asset_dirs: 0,
        repo_boundaries: 1,
        packages: 0,
        docs_dirs: 0,
        example_dirs: 0,
        cotx_present: true,
        architecture_store_present: true,
      },
    });

    fs.writeFileSync(
      path.join(tmpDir, 'db', 'helper.ts'),
      [
        'export function helper() {',
        '  return 3;',
        '}',
        '',
      ].join('\n'),
    );

    await commandUpdate(tmpDir, ['db/helper.ts'], { silent: true });

    const layout = store.readWorkspaceLayout();
    expect(layout?.candidates.some((candidate) => candidate.path.startsWith('.cotx/'))).toBe(false);
  });
});
