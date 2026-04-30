import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMcpHttpServer, type HttpServerHandle } from '../../../../src/mcp/server.js';
import { ArchitectureStore } from '../../../../src/store/architecture-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workbenchDist = path.resolve(__dirname, '../../dist');

let server: HttpServerHandle;
let tmpDir: string;
let tmpHome: string;
let previousHome: string | undefined;
let previousWorkbenchDist: string | undefined;
let previousCwd: string;

test.beforeAll(async () => {
  previousCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-workbench-e2e-'));
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-workbench-e2e-home-'));
  previousHome = process.env.HOME;
  previousWorkbenchDist = process.env.COTX_WORKBENCH_DIST;
  process.env.HOME = tmpHome;
  process.env.COTX_WORKBENCH_DIST = workbenchDist;

  const archStore = new ArchitectureStore(tmpDir);
  archStore.init({
    perspectives: ['overall-architecture', 'data-flow'],
    generated_at: '2026-04-10T00:00:00Z',
    mode: 'auto',
    struct_hash: 'e2e',
  });

  archStore.writePerspective({
    id: 'overall-architecture',
    label: 'Overall Architecture',
    components: [
      {
        id: 'commands',
        label: 'Commands',
        kind: 'group',
        directory: 'src/commands',
        children: ['write', 'map'],
        stats: { file_count: 2, function_count: 6, total_cyclomatic: 6, max_cyclomatic: 3, max_nesting_depth: 2, risk_score: 8 },
      },
      {
        id: 'core',
        label: 'Core',
        kind: 'leaf',
        directory: 'src/core',
        files: ['src/core/index.ts'],
        stats: { file_count: 1, function_count: 3, total_cyclomatic: 3, max_cyclomatic: 2, max_nesting_depth: 1, risk_score: 5 },
      },
    ],
    edges: [
      { from: 'commands', to: 'core', label: 'uses', type: 'dependency', weight: 2 },
    ],
  });
  archStore.writeElement('overall-architecture', 'commands', {
    id: 'commands',
    label: 'Commands',
    kind: 'group',
    directory: 'src/commands',
    children: ['write', 'map'],
    stats: { file_count: 2, function_count: 6, total_cyclomatic: 6, max_cyclomatic: 3, max_nesting_depth: 2, risk_score: 8 },
  });
  archStore.writeElement('overall-architecture', 'commands/write', {
    id: 'write',
    label: 'Write',
    kind: 'leaf',
    directory: 'src/commands/write.ts',
    files: ['src/commands/write.ts'],
    stats: { file_count: 1, function_count: 2, total_cyclomatic: 2, max_cyclomatic: 1, max_nesting_depth: 1, risk_score: 4 },
    description: 'Write command',
  });
  archStore.writeElement('overall-architecture', 'commands/map', {
    id: 'map',
    label: 'Map',
    kind: 'leaf',
    directory: 'src/commands/map.ts',
    files: ['src/commands/map.ts'],
    stats: { file_count: 1, function_count: 2, total_cyclomatic: 2, max_cyclomatic: 1, max_nesting_depth: 1, risk_score: 4 },
    description: 'Map command',
  });

  archStore.writePerspective({
    id: 'data-flow',
    label: 'Data Flow',
    components: [
      {
        id: 'commands',
        label: 'Commands',
        kind: 'leaf',
        directory: 'src/commands',
        files: ['src/commands/write.ts', 'src/commands/map.ts'],
        stats: { file_count: 2, function_count: 4, total_cyclomatic: 4, max_cyclomatic: 2, max_nesting_depth: 1, risk_score: 6 },
      },
      {
        id: 'core',
        label: 'Core',
        kind: 'leaf',
        directory: 'src/core',
        files: ['src/core/index.ts'],
        stats: { file_count: 1, function_count: 3, total_cyclomatic: 3, max_cyclomatic: 2, max_nesting_depth: 1, risk_score: 5 },
      },
    ],
    edges: [
      { from: 'commands', to: 'core', label: 'runs', type: 'flow', weight: 1 },
    ],
  });

  const registryDir = path.join(tmpHome, '.cotx');
  fs.mkdirSync(registryDir, { recursive: true });
  fs.writeFileSync(
    path.join(registryDir, 'registry.json'),
    JSON.stringify([
      {
        name: path.basename(tmpDir),
        path: tmpDir,
        compiled_at: '2026-04-10T00:00:00Z',
        stats: { modules: 2, concepts: 0, contracts: 0, flows: 1, concerns: 0 },
      },
    ]),
    'utf-8',
  );

  process.chdir(tmpDir);
  server = await startMcpHttpServer({
    host: '127.0.0.1',
    port: 0,
    installSignalHandlers: false,
  });
});

test.afterAll(async () => {
  await server?.close();
  process.chdir(previousCwd);
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousWorkbenchDist === undefined) delete process.env.COTX_WORKBENCH_DIST;
  else process.env.COTX_WORKBENCH_DIST = previousWorkbenchDist;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('workbench supports perspective switching, nav toggle, and node inspection', async ({ page }) => {
  const projectName = path.basename(tmpDir);
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });

  await page.goto(`${server.baseUrl}/workbench`, { waitUntil: 'networkidle' });
  await expect(page.getByTestId('workbench-home')).toBeVisible();
  await page.getByRole('link', { name: new RegExp(projectName) }).click();
  await expect(page.getByRole('tab', { name: 'Overall Architecture' })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/workbench/${projectName}/overall-architecture(?:\\?|$)`));

  await expect(page.getByRole('tab', { name: 'Overall Architecture' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Data Flow' })).toBeVisible();

  await page.getByRole('button', { name: 'Hide navigation' }).click();
  await expect(page.getByTestId('workbench-tree-shell')).toHaveAttribute('data-nav-visible', 'false');

  await page.getByRole('button', { name: 'Show navigation' }).click();
  await expect(page.getByTestId('workbench-tree-shell')).toHaveAttribute('data-nav-visible', 'true');

  await page.getByRole('tab', { name: 'Data Flow' }).click();
  await page.waitForURL(`**/workbench/${projectName}/data-flow`);
  await expect(page.getByText('Commands')).toBeVisible();

  await page.goto(`${server.baseUrl}/workbench/${projectName}/overall-architecture`, { waitUntil: 'networkidle' });
  await page.getByText('Commands').click();
  await expect(page.getByTestId('architecture-inspector')).toBeVisible();
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
