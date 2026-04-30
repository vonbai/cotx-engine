import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMcpHttpServer, type HttpServerHandle } from '../../src/mcp/server.js';
import { ArchitectureStore } from '../../src/store/architecture-store.js';
import { GraphTruthStore, type GraphFacts } from '../../src/store-v2/index.js';

const DEFAULT_STATS = {
  file_count: 1,
  function_count: 1,
  total_cyclomatic: 1,
  max_cyclomatic: 1,
  max_nesting_depth: 1,
  risk_score: 1,
};

async function writeImpactTruth(projectRoot: string): Promise<void> {
  const store = new GraphTruthStore({ dbPath: path.join(projectRoot, '.cotx', 'v2', 'truth.lbug') });
  await store.open();
  try {
    await store.writeFacts(sampleImpactGraphFacts());
  } finally {
    await store.close();
  }
}

function sampleImpactGraphFacts(): GraphFacts {
  return {
    codeNodes: [
      {
        id: 'File:src/core/parser/index.ts',
        label: 'File',
        name: 'index.ts',
        filePath: 'src/core/parser/index.ts',
        startLine: 1,
        endLine: 20,
        isExported: false,
        properties: JSON.stringify({ filePath: 'src/core/parser/index.ts' }),
      },
      {
        id: 'File:src/core/ast.ts',
        label: 'File',
        name: 'ast.ts',
        filePath: 'src/core/ast.ts',
        startLine: 1,
        endLine: 20,
        isExported: false,
        properties: JSON.stringify({ filePath: 'src/core/ast.ts' }),
      },
      {
        id: 'Function:src/features/build.ts:build',
        label: 'Function',
        name: 'build',
        filePath: 'src/features/build.ts',
        startLine: 1,
        endLine: 5,
        isExported: true,
        properties: JSON.stringify({ name: 'build', filePath: 'src/features/build.ts' }),
      },
      {
        id: 'Function:src/features/introspect.ts:introspect',
        label: 'Function',
        name: 'introspect',
        filePath: 'src/features/introspect.ts',
        startLine: 1,
        endLine: 5,
        isExported: true,
        properties: JSON.stringify({ name: 'introspect', filePath: 'src/features/introspect.ts' }),
      },
    ],
    codeRelations: [
      {
        from: 'Function:src/features/build.ts:build',
        to: 'File:src/core/parser/index.ts',
        type: 'IMPORTS',
        confidence: 1,
        reason: 'fixture',
        step: 0,
      },
      {
        from: 'Function:src/features/introspect.ts:introspect',
        to: 'File:src/core/ast.ts',
        type: 'IMPORTS',
        confidence: 1,
        reason: 'fixture',
        step: 0,
      },
    ],
  };
}

describe('Workbench HTTP routes', () => {
  let tmpDir: string;
  let tmpHome: string;
  let tmpWorkbenchDist: string;
  let server: HttpServerHandle;
  let previousHome: string | undefined;
  let previousCwd: string;
  let previousWorkbenchDist: string | undefined;

  beforeEach(() => {
    previousCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-workbench-'));
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-wb-home-'));
    tmpWorkbenchDist = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-wb-dist-'));
    previousHome = process.env.HOME;
    previousWorkbenchDist = process.env.COTX_WORKBENCH_DIST;
    process.env.HOME = tmpHome;
    process.env.COTX_WORKBENCH_DIST = tmpWorkbenchDist;

    fs.mkdirSync(path.join(tmpWorkbenchDist, 'assets'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpWorkbenchDist, 'index.html'),
      [
        '<!DOCTYPE html>',
        '<html lang="en">',
        '<head><meta charset="utf-8"><title>cotx workbench app</title></head>',
        '<body>',
        '  <div id="root"></div>',
        '  <script type="module" src="/workbench/assets/main.js"></script>',
        '</body>',
        '</html>',
      ].join('\n'),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(tmpWorkbenchDist, 'assets', 'main.js'),
      'window.__cotxWorkbenchLoaded = true;',
      'utf-8',
    );

    // Set up a minimal architecture store
    const archStore = new ArchitectureStore(tmpDir);
    archStore.init({
      perspectives: ['overall-architecture', 'data-flow'],
      generated_at: '2026-04-09T12:00:00Z',
      mode: 'auto',
      struct_hash: 'test123',
    });
    archStore.writePerspective({
      id: 'overall-architecture',
      label: 'Overall Architecture',
      components: [
        {
          id: 'core',
          label: 'Core',
          kind: 'group',
          directory: 'src/core',
          children: ['parser'],
          stats: { file_count: 5, function_count: 10, total_cyclomatic: 8, max_cyclomatic: 3, max_nesting_depth: 2, risk_score: 12 },
        },
        {
          id: 'parser',
          label: 'Parser',
          kind: 'leaf',
          directory: 'src/core/parser',
          files: ['src/core/parser/index.ts'],
          stats: { file_count: 1, function_count: 3, total_cyclomatic: 3, max_cyclomatic: 2, max_nesting_depth: 1, risk_score: 5 },
        },
      ],
      edges: [
        { from: 'core', to: 'parser', label: 'contains', type: 'dependency', weight: 1 },
      ],
    });
    archStore.writePerspective({
      id: 'data-flow',
      label: 'Data Flow',
      components: [],
      edges: [],
    });

    // Also write element data so readPerspective can resolve components
    archStore.writeElement('overall-architecture', 'core', {
      id: 'core',
      label: 'Core',
      kind: 'group',
      directory: 'src/core',
      children: ['parser'],
      stats: { file_count: 5, function_count: 10, total_cyclomatic: 8, max_cyclomatic: 3, max_nesting_depth: 2, risk_score: 12 },
    });
    archStore.writeElement('overall-architecture', 'parser', {
      id: 'parser',
      label: 'Parser',
      kind: 'leaf',
      directory: 'src/core/parser',
      files: ['src/core/parser/index.ts'],
      stats: { file_count: 1, function_count: 3, total_cyclomatic: 3, max_cyclomatic: 2, max_nesting_depth: 1, risk_score: 5 },
    });
    archStore.writeElement('overall-architecture', 'core/ast', {
      id: 'ast',
      label: 'AST',
      kind: 'leaf',
      directory: 'src/core/ast',
      files: ['src/core/ast.ts'],
      stats: { file_count: 1, function_count: 2, total_cyclomatic: 2, max_cyclomatic: 1, max_nesting_depth: 1, risk_score: 3 },
    });
    archStore.writeElement('overall-architecture', 'orphan', {
      id: 'orphan',
      label: 'Orphan',
      kind: 'group',
      directory: '',
      children: [],
      stats: DEFAULT_STATS,
    });

    // Register the project in the registry
    const registryDir = path.join(tmpHome, '.cotx');
    fs.mkdirSync(registryDir, { recursive: true });
    const projectName = path.basename(tmpDir);
    fs.writeFileSync(
      path.join(registryDir, 'registry.json'),
      JSON.stringify([
        {
          name: projectName,
          path: tmpDir,
          compiled_at: '2026-04-09T12:00:00Z',
          stats: { modules: 2, concepts: 3, contracts: 1, flows: 1, concerns: 0 },
        },
      ]),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(tmpDir, '.cotx', 'workspace-layout.json'),
      JSON.stringify({
        project_root: tmpDir,
        generated_at: '2026-04-09T12:00:00Z',
        directories: [
          { path: '.', kind: 'repo-root', depth: 0 },
          { path: 'packages/ui', kind: 'package', depth: 2 },
          { path: 'apps/web/public', kind: 'asset', depth: 3 },
        ],
        candidates: [],
        summary: {
          directories: 3,
          candidates: 0,
          repo_boundaries: 1,
          packages: 1,
          asset_dirs: 1,
          docs_dirs: 0,
          example_dirs: 0,
          cotx_present: true,
          architecture_store_present: true,
        },
      }),
      'utf-8',
    );
  });

  afterEach(async () => {
    process.chdir(previousCwd);
    if (server) {
      await server.close();
    }
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousWorkbenchDist === undefined) {
      delete process.env.COTX_WORKBENCH_DIST;
    } else {
      process.env.COTX_WORKBENCH_DIST = previousWorkbenchDist;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpWorkbenchDist, { recursive: true, force: true });
  });

  it('GET /api/v1/:project/meta returns project metadata', async () => {
    process.chdir(tmpDir);
    server = await startMcpHttpServer({
      host: '127.0.0.1',
      port: 0,
      installSignalHandlers: false,
    });

    const projectName = path.basename(tmpDir);
    const res = await fetch(`${server.apiUrl}/${encodeURIComponent(projectName)}/meta`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');

    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty('id');
    expect(body).toHaveProperty('compiledAt');
    expect(body).toHaveProperty('hasArchitecture', true);
    expect(body).toHaveProperty('workspaceLayout');
    expect(typeof body.id).toBe('string');
    expect(typeof body.compiledAt).toBe('string');
    expect(body.workspaceLayout).toEqual({
      repoBoundaries: 1,
      packageBoundaries: 1,
      assetDirectories: 1,
      assetPaths: ['apps/web/public'],
    });
  });

  it('GET /api/v1/:project/meta returns 404 for unknown project', async () => {
    server = await startMcpHttpServer({
      host: '127.0.0.1',
      port: 0,
      installSignalHandlers: false,
    });

    const res = await fetch(`${server.apiUrl}/nonexistent-project/meta`);
    expect(res.status).toBe(404);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty('error');
  });

  it('GET /api/v1/:project/perspectives returns perspective summaries', async () => {
    process.chdir(tmpDir);
    server = await startMcpHttpServer({
      host: '127.0.0.1',
      port: 0,
      installSignalHandlers: false,
    });

    const projectName = path.basename(tmpDir);
    const res = await fetch(`${server.apiUrl}/${encodeURIComponent(projectName)}/perspectives`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(2);

    const overall = body.find((p) => p.id === 'overall-architecture');
    expect(overall).toBeDefined();
    expect(overall!.label).toBe('Overall Architecture');
    expect(overall!.nodeCount).toBe(4);
    expect(overall!.edgeCount).toBe(1);

    const dataFlow = body.find((p) => p.id === 'data-flow');
    expect(dataFlow).toBeDefined();
    expect(dataFlow!.label).toBe('Data Flow');
    expect(dataFlow!.nodeCount).toBe(0);
  });

  it('GET /api/v1/:project/perspectives/:id returns full perspective data', async () => {
    process.chdir(tmpDir);
    server = await startMcpHttpServer({
      host: '127.0.0.1',
      port: 0,
      installSignalHandlers: false,
    });

    const projectName = path.basename(tmpDir);
    const res = await fetch(`${server.apiUrl}/${encodeURIComponent(projectName)}/perspectives/overall-architecture`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe('overall-architecture');
    expect(body.label).toBe('Overall Architecture');
    expect(Array.isArray(body.components)).toBe(true);
    expect(Array.isArray(body.edges)).toBe(true);

    const components = body.components as Array<Record<string, unknown>>;
    expect(components.length).toBe(4);
    expect(components.some((c) => c.id === 'core')).toBe(true);
    expect(components.some((c) => c.id === 'parser')).toBe(true);
    expect(components.some((c) => c.path === 'core/ast')).toBe(true);
    expect(components.some((c) => c.path === 'orphan')).toBe(true);

    const edges = body.edges as Array<Record<string, unknown>>;
    expect(edges.length).toBe(1);
    expect(edges[0].from).toBe('core');
    expect(edges[0].to).toBe('parser');
  });

  it('GET /api/v1/:project/perspectives/:id/nodes/:path returns a specific node payload', async () => {
    process.chdir(tmpDir);
    server = await startMcpHttpServer({
      host: '127.0.0.1',
      port: 0,
      installSignalHandlers: false,
    });

    const projectName = path.basename(tmpDir);
    const res = await fetch(
      `${server.apiUrl}/${encodeURIComponent(projectName)}/perspectives/overall-architecture/nodes/core%2Fast`,
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe('ast');
    expect(body.path).toBe('core/ast');
    expect(body.label).toBe('AST');
    expect(body.directory).toBe('src/core/ast');
  });

  it('GET /api/v1/:project/perspectives/:id/nodes/:path/impact returns normalized grounded impact for container coverage', async () => {
    await writeImpactTruth(tmpDir);
    process.chdir(tmpDir);
    server = await startMcpHttpServer({
      host: '127.0.0.1',
      port: 0,
      installSignalHandlers: false,
    });

    const projectName = path.basename(tmpDir);
    const res = await fetch(
      `${server.apiUrl}/${encodeURIComponent(projectName)}/perspectives/overall-architecture/nodes/core/impact`,
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.root).toBe('core');
    expect(body.status).toBe('grounded');
    expect(body.affected).toEqual([
      'src/features/build.ts#build',
      'src/features/introspect.ts#introspect',
    ]);
    expect(body.targetPaths).toEqual(['src/core']);
    expect((body.affected as string[]).some((value) => value.includes('Function:'))).toBe(false);
  });

  it('GET /api/v1/:project/perspectives/:id/nodes/:path/impact reports gap when no source coverage is available', async () => {
    process.chdir(tmpDir);
    server = await startMcpHttpServer({
      host: '127.0.0.1',
      port: 0,
      installSignalHandlers: false,
    });

    const projectName = path.basename(tmpDir);
    const res = await fetch(
      `${server.apiUrl}/${encodeURIComponent(projectName)}/perspectives/overall-architecture/nodes/orphan/impact`,
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('gap');
    expect(body.affected).toEqual([]);
    expect(body.statusReason).toBe('No architecture source coverage was available for this element.');
  });

  it('GET /api/v1/:project/perspectives/:id/nodes/:path/impact reports unknown when source coverage exists but storage-v2 truth is missing', async () => {
    process.chdir(tmpDir);
    server = await startMcpHttpServer({
      host: '127.0.0.1',
      port: 0,
      installSignalHandlers: false,
    });

    const projectName = path.basename(tmpDir);
    const res = await fetch(
      `${server.apiUrl}/${encodeURIComponent(projectName)}/perspectives/overall-architecture/nodes/parser/impact`,
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('unknown');
    expect(body.affected).toEqual([]);
    expect(body.targetPaths).toEqual(['src/core/parser', 'src/core/parser/index.ts']);
  });

  it('GET /api/v1/:project/perspectives/:id returns 404 for unknown perspective', async () => {
    process.chdir(tmpDir);
    server = await startMcpHttpServer({
      host: '127.0.0.1',
      port: 0,
      installSignalHandlers: false,
    });

    const projectName = path.basename(tmpDir);
    const res = await fetch(`${server.apiUrl}/${encodeURIComponent(projectName)}/perspectives/nonexistent`);
    expect(res.status).toBe(404);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty('error');
  });

  it('GET /api/v1/projects returns registered projects for the workbench home', async () => {
    server = await startMcpHttpServer({
      host: '127.0.0.1',
      port: 0,
      installSignalHandlers: false,
    });

    const res = await fetch(`${server.apiUrl}/projects`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');

    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body).toHaveLength(1);
    expect(body[0]?.name).toBe(path.basename(tmpDir));
    expect(body[0]?.workspaceLayout).toEqual({
      repoBoundaries: 1,
      packageBoundaries: 1,
      assetDirectories: 1,
      assetPaths: ['apps/web/public'],
    });
  });

  it('GET /workbench returns the built workbench index html for the app shell', async () => {
    server = await startMcpHttpServer({
      host: '127.0.0.1',
      port: 0,
      installSignalHandlers: false,
    });

    const res = await fetch(server.workbenchUrl);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');

    const body = await res.text();
    expect(body).toContain('/workbench/assets/main.js');
  });

  it('GET /workbench/:project/:perspective returns the built index html (SPA fallback)', async () => {
    server = await startMcpHttpServer({
      host: '127.0.0.1',
      port: 0,
      installSignalHandlers: false,
    });

    const projectName = path.basename(tmpDir);
    const res = await fetch(`${server.workbenchUrl}/${encodeURIComponent(projectName)}/overall-architecture`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');

    const body = await res.text();
    expect(body).toContain('/workbench/assets/main.js');
  });

  it('GET /workbench/assets/... serves built workbench assets', async () => {
    server = await startMcpHttpServer({
      host: '127.0.0.1',
      port: 0,
      installSignalHandlers: false,
    });

    const res = await fetch(`${server.workbenchUrl}/assets/main.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
    expect(await res.text()).toContain('__cotxWorkbenchLoaded');
  });

  it('legacy /map UI route is no longer served', async () => {
    const prevCwd = process.cwd();
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-wb-coexist-'));
    const cleanHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-wb-clean-home-'));
    const savedHome = process.env.HOME;

    try {
      // Use a clean HOME with no registry so /map returns the landing page
      process.env.HOME = cleanHome;
      process.chdir(emptyDir);
      server = await startMcpHttpServer({
        host: '127.0.0.1',
        port: 0,
        installSignalHandlers: false,
      });

      // /map should not be exposed anymore
      const mapRes = await fetch(`${server.baseUrl}/map`);
      expect(mapRes.status).toBe(404);

      // /workbench should also work
      const wbRes = await fetch(server.workbenchUrl);
      expect(wbRes.status).toBe(200);
      const wbBody = await wbRes.text();
      expect(wbBody).toContain('/workbench/assets/main.js');

      // /health should still work
      const healthRes = await fetch(`${server.baseUrl}/health`);
      expect(healthRes.status).toBe(200);
    } finally {
      process.env.HOME = savedHome;
      process.chdir(prevCwd);
      fs.rmSync(emptyDir, { recursive: true, force: true });
      fs.rmSync(cleanHome, { recursive: true, force: true });
    }
  });

  it('API responses include CORS headers', async () => {
    process.chdir(tmpDir);
    server = await startMcpHttpServer({
      host: '127.0.0.1',
      port: 0,
      installSignalHandlers: false,
    });

    const projectName = path.basename(tmpDir);
    const res = await fetch(`${server.apiUrl}/${encodeURIComponent(projectName)}/perspectives`);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});
