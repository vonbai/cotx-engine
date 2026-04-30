import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandCompile } from '../../src/commands/compile.js';
import { CotxStore } from '../../src/store/store.js';
import { ArchitectureStore } from '../../src/store/architecture-store.js';
import { commandDecisionQuery } from '../../src/commands/decision-query.js';

describe('commandCompile', () => {
  let tmpDir: string;
  let tmpHome: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-compile-test-'));
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-home-test-'));
    previousHome = process.env.HOME;
    process.env.HOME = tmpHome;

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
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('succeeds even when global LLM config is malformed', async () => {
    fs.mkdirSync(path.join(tmpHome, '.cotx'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.cotx', 'config.json'), '{"port":"bad"}', 'utf-8');

    await expect(commandCompile(tmpDir, { silent: true })).resolves.toBeUndefined();

    const store = new CotxStore(tmpDir);
    expect(store.exists()).toBe(true);
    expect(store.listModules().length).toBeGreaterThan(0);
  });

  it('preserves architecture sidecars across recompiles for unchanged paths', async () => {
    await commandCompile(tmpDir, { silent: true });

    const archStore = new ArchitectureStore(tmpDir);
    archStore.writeDescription('overall-architecture', 'Manual overview description');
    const firstComponent = archStore.readPerspective('overall-architecture').components[0];
    archStore.writeDescription(`overall-architecture/${firstComponent.id}`, 'Manual component description');
    archStore.writeMeta({ ...archStore.readMeta(), mode: 'agent' });

    await commandCompile(tmpDir, { silent: true });

    expect(archStore.readDescription('overall-architecture')).toBe('Manual overview description');
    expect(archStore.readDescription(`overall-architecture/${firstComponent.id}`)).toBe('Manual component description');
  });

  it('refreshes generated architecture placeholder descriptions even when previous mode is agent', async () => {
    fs.mkdirSync(path.join(tmpDir, 'webapp'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'webapp', 'handler.ts'),
      [
        'export function githubWebhook() {',
        '  return 1;',
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );
    await commandCompile(tmpDir, { silent: true });

    const archStore = new ArchitectureStore(tmpDir);
    archStore.writeDescription('overall-architecture/webapp', 'Webapp owns code under webapp and exposes 1 exported functions.');
    archStore.writeMeta({ ...archStore.readMeta(), mode: 'agent' });

    await commandCompile(tmpDir, { silent: true });

    const refreshed = archStore.readDescription('overall-architecture/webapp') ?? '';
    expect(refreshed).toContain('githubWebhook');
    expect(refreshed).not.toContain('owns code under');
  });

  it('writes decision-plane facts to storage v2 during compile', async () => {
    fs.mkdirSync(path.join(tmpDir, 'api'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'service'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'db'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'api', 'user.ts'),
      [
        "import { prepareUser } from '../service/user.js';",
        'export function saveUser() {',
        '  return prepareUser();',
        '}',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(tmpDir, 'service', 'user.ts'),
      [
        "import { saveState } from '../db/store.js';",
        'export function prepareUser() {',
        '  return saveState();',
        '}',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(tmpDir, 'db', 'store.ts'),
      [
        'export function saveState() {',
        '  return 1;',
        '}',
        '',
      ].join('\n'),
    );

    await commandCompile(tmpDir, { silent: true });

    expect(fs.existsSync(path.join(tmpDir, '.cotx', 'v2', 'truth.lbug'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.cotx', 'v2', 'rules.db'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.cotx', 'workspace-layout.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.cotx', 'architecture', 'workspace.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.cotx', 'architecture', 'recursion-plan.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.cotx', 'canonical-paths'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.cotx', 'closures'))).toBe(false);

    const layout = new CotxStore(tmpDir).readWorkspaceLayout();
    expect(layout?.summary.repo_boundaries).toBe(1);
    expect(layout?.summary.architecture_store_present).toBe(true);
    expect(layout?.summary.candidates).toBe(0);
    expect(layout?.candidates.some((candidate) => candidate.path.startsWith('.cotx/'))).toBe(false);
    const workspace = new ArchitectureStore(tmpDir).readWorkspace();
    expect(workspace?.schema_version).toBe('cotx.architecture.workspace.v1');
    expect(workspace?.elements.some((element) => element.level === 'software_system')).toBe(true);
    const recursion = new ArchitectureStore(tmpDir).readRecursionPlan();
    expect(recursion?.schema_version).toBe('cotx.architecture.recursion_plan.v1');
    expect(recursion?.decisions.length).toBeGreaterThan(0);

    const canonical = await commandDecisionQuery(tmpDir, 'canonical', 'save:repository_write');
    expect(canonical.row_count).toBeGreaterThan(0);
  });
});
