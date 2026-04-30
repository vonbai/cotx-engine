import { describe, it, expect, vi } from 'vitest';
import {
  createHttpCotxAdapter,
  CotxHttpError,
  normalizePerspective,
  normalizeNode,
  normalizeEdge,
  normalizeNodeStats,
} from 'cotx-sdk-core';
import projectMeta from './fixtures/project-meta.json';
import perspectives from './fixtures/perspectives.json';
import overallArch from './fixtures/overall-architecture.json';

// ── Helper: mock fetch ──────────────────────────────────────────────────

type RouteMap = Record<string, { status: number; body: unknown }>;

function mockFetch(routes: RouteMap): typeof globalThis.fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const entry = routes[url];
    if (!entry) {
      return new Response('Not Found', { status: 404 });
    }
    return new Response(JSON.stringify(entry.body), {
      status: entry.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof globalThis.fetch;
}

// ── Normalization unit tests ────────────────────────────────────────────

describe('normalizeNodeStats', () => {
  it('converts snake_case to camelCase', () => {
    const result = normalizeNodeStats({
      file_count: 10,
      function_count: 25,
      total_cyclomatic: 40,
      max_cyclomatic: 8,
      max_nesting_depth: 3,
      risk_score: 22,
    });
    expect(result).toEqual({
      fileCount: 10,
      functionCount: 25,
      totalCyclomatic: 40,
      maxCyclomatic: 8,
      maxNestingDepth: 3,
      riskScore: 22,
    });
  });
});

describe('normalizeNode', () => {
  it('normalizes a top-level leaf node with all fields', () => {
    const raw = {
      ...overallArch.components[1],
      layer: 'architecture',
      evidence_status: 'grounded',
      evidence: [
        { kind: 'file', id: 'src/core/parser/index.ts', filePath: 'src/core/parser/index.ts' },
      ],
    }; // parser
    const node = normalizeNode(raw);
    expect(node.path).toBe('parser');
    expect(node.id).toBe('parser');
    expect(node.label).toBe('Tree-sitter Parser');
    expect(node.shortLabel).toBe('parser');
    expect(node.breadcrumb).toEqual(['parser']);
    expect(node.directory).toBe('src/core/parser');
    expect(node.kind).toBe('leaf');
    expect(node.stats.fileCount).toBe(14);
    expect(node.stats.riskScore).toBe(52);
    expect(node.files).toEqual([
      'src/core/parser/index.ts',
      'src/core/parser/type-env.ts',
      'src/core/parser/call-processor.ts',
    ]);
    expect(node.exportedFunctions).toEqual(['parseProject', 'createTypeEnv', 'resolveCallTargets']);
    expect(node.contractsProvided).toEqual(['parse-output']);
    expect(node.contractsConsumed).toEqual([]);
    expect(node.relatedFlows).toEqual(['compile-flow']);
    expect(node.layer).toBe('architecture');
    expect(node.evidenceStatus).toBe('grounded');
    expect(node.evidence?.[0]).toMatchObject({
      kind: 'file',
      ref: 'src/core/parser/index.ts',
    });
    expect(node.description).toBe('Multi-language source code parser using Tree-sitter grammars.');
  });

  it('normalizes a group node with children paths', () => {
    const raw = overallArch.components[0]; // compiler
    const node = normalizeNode(raw);
    expect(node.path).toBe('compiler');
    expect(node.kind).toBe('group');
    expect(node.children).toEqual([
      'compiler/module-compiler',
      'compiler/concept-compiler',
    ]);
    expect(node.description).toBe('Transforms parsed AST data into semantic map layers.');
    expect(node.diagram).toBe('graph TD\nA["Parser"]\nB["Module Compiler"]\nA --> B');
  });

  it('normalizes a nested node with parent path', () => {
    const raw = {
      id: 'module-compiler',
      label: 'Module Compiler',
      kind: 'leaf' as const,
      directory: 'src/compiler',
      files: ['src/compiler/module-compiler.ts'],
      stats: {
        file_count: 1,
        function_count: 5,
        total_cyclomatic: 10,
        max_cyclomatic: 4,
        max_nesting_depth: 2,
        risk_score: 8,
      },
    };
    const node = normalizeNode(raw, 'compiler');
    expect(node.path).toBe('compiler/module-compiler');
    expect(node.id).toBe('module-compiler');
    expect(node.shortLabel).toBe('module-compiler');
    expect(node.breadcrumb).toEqual(['compiler', 'module-compiler']);
  });

  it('omits optional fields when absent', () => {
    const raw = overallArch.components[2]; // store - no diagram, no children
    const node = normalizeNode(raw);
    expect(node.diagram).toBeUndefined();
    expect(node.children).toBeUndefined();
  });
});

describe('normalizeEdge', () => {
  it('converts raw edge to ExplorerEdge with generated id', () => {
    const raw = overallArch.edges[0];
    const edge = normalizeEdge(raw, 0);
    expect(edge.id).toBe('e-compiler-parser-0');
    expect(edge.from).toBe('compiler');
    expect(edge.to).toBe('parser');
    expect(edge.type).toBe('dependency');
    expect(edge.label).toBe('reads AST');
    expect(edge.weight).toBe(5);
  });

  it('omits label when empty string', () => {
    const raw = overallArch.edges[3]; // parser -> store, label ""
    const edge = normalizeEdge(raw, 3);
    expect(edge.label).toBeUndefined();
  });
});

describe('normalizePerspective', () => {
  it('maps cotx HTTP payloads into ExplorerPerspective', () => {
    const perspective = normalizePerspective(overallArch);
    expect(perspective.id).toBe('overall-architecture');
    expect(perspective.label).toBe('Overall Architecture');
    expect(perspective.layer).toBe('architecture');
    expect(perspective.summary).toBe(
      'High-level view of the cotx-engine codebase showing major subsystems.',
    );
    expect(perspective.nodes).toHaveLength(4);
    expect(perspective.edges).toHaveLength(4);
    expect(perspective.stats).toEqual({
      nodeCount: 4,
      edgeCount: 4,
      maxRiskScore: 52,
    });
  });

  it('normalizes top-level and nested node paths', () => {
    const perspective = normalizePerspective(overallArch);
    const paths = perspective.nodes.map((n) => n.path);
    expect(paths).toEqual(['compiler', 'parser', 'store', 'mcp']);

    // Group children should have fully qualified paths
    const compiler = perspective.nodes.find((n) => n.id === 'compiler')!;
    expect(compiler.children).toEqual([
      'compiler/module-compiler',
      'compiler/concept-compiler',
    ]);
  });

  it('preserves description, diagram, contracts, flows, and stats', () => {
    const perspective = normalizePerspective(overallArch);

    const compiler = perspective.nodes.find((n) => n.id === 'compiler')!;
    expect(compiler.description).toBe('Transforms parsed AST data into semantic map layers.');
    expect(compiler.diagram).toContain('graph TD');

    const parser = perspective.nodes.find((n) => n.id === 'parser')!;
    expect(parser.contractsProvided).toEqual(['parse-output']);
    expect(parser.relatedFlows).toEqual(['compile-flow']);
    expect(parser.stats.maxCyclomatic).toBe(18);

    const store = perspective.nodes.find((n) => n.id === 'store')!;
    expect(store.contractsConsumed).toEqual(['parse-output']);
  });

  it('fails clearly on malformed responses', () => {
    expect(() => normalizePerspective(null)).toThrow('expected an object');
    expect(() => normalizePerspective(42)).toThrow('expected an object');
    expect(() => normalizePerspective({})).toThrow('missing id or label');
    expect(() => normalizePerspective({ id: 'x', label: 'X' })).toThrow(
      'missing components array',
    );
    expect(() =>
      normalizePerspective({ id: 'x', label: 'X', components: [] }),
    ).toThrow('missing edges array');
  });

  it('handles perspective with no summary', () => {
    const raw = { ...overallArch, summary: undefined };
    const perspective = normalizePerspective(raw);
    expect(perspective.summary).toBeNull();
  });
});

// ── HTTP adapter tests ──────────────────────────────────────────────────

describe('createHttpCotxAdapter', () => {
  const BASE = 'http://localhost:3000';
  const PROJECT = 'cotx-engine';

  it('adapter methods call correct URLs', async () => {
    const fetch = mockFetch({
      [`${BASE}/api/v1/${PROJECT}/meta`]: {
        status: 200,
        body: projectMeta,
      },
      [`${BASE}/api/v1/${PROJECT}/perspectives`]: {
        status: 200,
        body: perspectives,
      },
      [`${BASE}/api/v1/${PROJECT}/perspectives/overall-architecture`]: {
        status: 200,
        body: overallArch,
      },
      [`${BASE}/api/v1/${PROJECT}/perspectives/overall-architecture/nodes/parser`]: {
        status: 200,
        body: overallArch.components[1],
      },
      [`${BASE}/api/v1/${PROJECT}/perspectives/overall-architecture/nodes/parser/impact`]: {
        status: 200,
        body: { root: 'parser', affected: ['src/compiler/module-compiler.ts#compileModule'], status: 'grounded', risk: 'MEDIUM' },
      },
    });

    const adapter = createHttpCotxAdapter(BASE, { fetch });

    await adapter.getProjectMeta(PROJECT);
    expect(fetch).toHaveBeenCalledWith(
      `${BASE}/api/v1/${PROJECT}/meta`,
      expect.objectContaining({ headers: { accept: 'application/json' } }),
    );

    await adapter.listPerspectives(PROJECT);
    expect(fetch).toHaveBeenCalledWith(
      `${BASE}/api/v1/${PROJECT}/perspectives`,
      expect.any(Object),
    );

    await adapter.getPerspective(PROJECT, 'overall-architecture');
    expect(fetch).toHaveBeenCalledWith(
      `${BASE}/api/v1/${PROJECT}/perspectives/overall-architecture`,
      expect.any(Object),
    );

    await adapter.getNode(PROJECT, 'overall-architecture', 'parser');
    expect(fetch).toHaveBeenCalledWith(
      `${BASE}/api/v1/${PROJECT}/perspectives/overall-architecture/nodes/parser`,
      expect.any(Object),
    );

    await adapter.getImpact!(PROJECT, 'overall-architecture', 'parser');
    expect(fetch).toHaveBeenCalledWith(
      `${BASE}/api/v1/${PROJECT}/perspectives/overall-architecture/nodes/parser/impact`,
      expect.any(Object),
    );
  });

  it('getProjectMeta normalizes response', async () => {
    const fetch = mockFetch({
      [`${BASE}/api/v1/${PROJECT}/meta`]: { status: 200, body: projectMeta },
    });
    const adapter = createHttpCotxAdapter(BASE, { fetch });
    const meta = await adapter.getProjectMeta(PROJECT);
    expect(meta.id).toBe('cotx-engine');
    expect(meta.compiledAt).toBe('2026-04-09T10:30:00.000Z');
    expect(meta.workspaceLayout).toEqual({
      repoBoundaries: 1,
      packageBoundaries: 2,
      assetDirectories: 2,
      assetPaths: ['apps/web/public', 'packages/ui/icons'],
    });
  });

  it('listProjects normalizes workspace layout summary facts', async () => {
    const fetch = mockFetch({
      [`${BASE}/api/v1/projects`]: {
        status: 200,
        body: [
          {
            id: PROJECT,
            name: PROJECT,
            path: '/tmp/cotx-engine',
            compiled_at: '2026-04-09T10:30:00.000Z',
            workspaceLayout: {
              repoBoundaries: 1,
              packageBoundaries: 2,
              assetDirectories: 2,
              assetPaths: ['apps/web/public', 'packages/ui/icons'],
            },
            stats: {
              modules: 12,
              concepts: 34,
              contracts: 8,
              flows: 5,
              concerns: 0,
            },
            defaultPerspective: 'overall-architecture',
          },
        ],
      },
    });
    const adapter = createHttpCotxAdapter(BASE, { fetch });
    const projects = await adapter.listProjects!();
    expect(projects).toEqual([
      {
        id: PROJECT,
        name: PROJECT,
        path: '/tmp/cotx-engine',
        compiledAt: '2026-04-09T10:30:00.000Z',
        workspaceLayout: {
          repoBoundaries: 1,
          packageBoundaries: 2,
          assetDirectories: 2,
          assetPaths: ['apps/web/public', 'packages/ui/icons'],
        },
        stats: {
          modules: 12,
          concepts: 34,
          contracts: 8,
          flows: 5,
          concerns: 0,
        },
        defaultPerspective: 'overall-architecture',
      },
    ]);
  });

  it('listPerspectives normalizes response', async () => {
    const fetch = mockFetch({
      [`${BASE}/api/v1/${PROJECT}/perspectives`]: {
        status: 200,
        body: [
          {
            id: 'overall-architecture',
            label: 'Overall Architecture',
            componentCount: 8,
            edgeCount: 6,
          },
          {
            id: 'data-flow',
            label: 'Data Flow',
            componentCount: 5,
            edgeCount: 4,
          },
        ],
      },
    });
    const adapter = createHttpCotxAdapter(BASE, { fetch });
    const result = await adapter.listPerspectives(PROJECT);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      id: 'overall-architecture',
      label: 'Overall Architecture',
      layer: 'architecture',
      status: undefined,
      summary: undefined,
      nodeCount: 8,
      edgeCount: 6,
    });
  });

  it('getPerspective respects explicit path fields for nested components', async () => {
    const fetch = mockFetch({
      [`${BASE}/api/v1/${PROJECT}/perspectives/overall-architecture`]: {
        status: 200,
        body: {
          ...overallArch,
          components: [
            ...overallArch.components,
            {
              id: 'ast',
              path: 'compiler/ast',
              label: 'AST',
              kind: 'leaf',
              directory: 'src/compiler/ast',
              files: ['src/compiler/ast.ts'],
              stats: {
                file_count: 1,
                function_count: 1,
                total_cyclomatic: 1,
                max_cyclomatic: 1,
                max_nesting_depth: 1,
                risk_score: 2,
              },
            },
          ],
        },
      },
    });

    const adapter = createHttpCotxAdapter(BASE, { fetch });
    const perspective = await adapter.getPerspective(PROJECT, 'overall-architecture');
    expect(perspective.nodes.some((node) => node.path === 'compiler/ast')).toBe(true);
  });

  it('getPerspective returns normalized ExplorerPerspective', async () => {
    const fetch = mockFetch({
      [`${BASE}/api/v1/${PROJECT}/perspectives/overall-architecture`]: {
        status: 200,
        body: overallArch,
      },
    });
    const adapter = createHttpCotxAdapter(BASE, { fetch });
    const perspective = await adapter.getPerspective(PROJECT, 'overall-architecture');
    expect(perspective.id).toBe('overall-architecture');
    expect(perspective.nodes).toHaveLength(4);
    expect(perspective.edges).toHaveLength(4);
    expect(perspective.stats.maxRiskScore).toBe(52);
  });

  it('getNode returns normalized ExplorerNode', async () => {
    const fetch = mockFetch({
      [`${BASE}/api/v1/${PROJECT}/perspectives/overall-architecture/nodes/parser`]: {
        status: 200,
        body: overallArch.components[1],
      },
    });
    const adapter = createHttpCotxAdapter(BASE, { fetch });
    const node = await adapter.getNode(PROJECT, 'overall-architecture', 'parser');
    expect(node.path).toBe('parser');
    expect(node.id).toBe('parser');
    expect(node.stats.fileCount).toBe(14);
  });

  it('getNode builds correct path for nested nodes', async () => {
    const nestedRaw = {
      id: 'module-compiler',
      label: 'Module Compiler',
      kind: 'leaf',
      directory: 'src/compiler',
      files: ['src/compiler/module-compiler.ts'],
      stats: {
        file_count: 1,
        function_count: 5,
        total_cyclomatic: 10,
        max_cyclomatic: 4,
        max_nesting_depth: 2,
        risk_score: 8,
      },
    };
    const fetch = mockFetch({
      [`${BASE}/api/v1/${PROJECT}/perspectives/overall-architecture/nodes/compiler%2Fmodule-compiler`]:
        { status: 200, body: nestedRaw },
    });
    const adapter = createHttpCotxAdapter(BASE, { fetch });
    const node = await adapter.getNode(
      PROJECT,
      'overall-architecture',
      'compiler/module-compiler',
    );
    expect(node.path).toBe('compiler/module-compiler');
    expect(node.breadcrumb).toEqual(['compiler', 'module-compiler']);
  });

  it('throws CotxHttpError on non-OK responses', async () => {
    const fetch = mockFetch({
      [`${BASE}/api/v1/${PROJECT}/meta`]: {
        status: 500,
        body: { error: 'Internal Server Error' },
      },
    });
    const adapter = createHttpCotxAdapter(BASE, { fetch });

    await expect(adapter.getProjectMeta(PROJECT)).rejects.toThrow(CotxHttpError);
    await expect(adapter.getProjectMeta(PROJECT)).rejects.toThrow('HTTP 500');
  });

  it('throws CotxHttpError on 404', async () => {
    const fetch = mockFetch({});
    const adapter = createHttpCotxAdapter(BASE, { fetch });

    await expect(adapter.listPerspectives(PROJECT)).rejects.toThrow(CotxHttpError);
    try {
      await adapter.listPerspectives(PROJECT);
    } catch (err) {
      expect(err).toBeInstanceOf(CotxHttpError);
      expect((err as CotxHttpError).status).toBe(404);
    }
  });

  it('strips trailing slashes from base URL', async () => {
    const fetch = mockFetch({
      [`${BASE}/api/v1/${PROJECT}/meta`]: { status: 200, body: projectMeta },
    });
    const adapter = createHttpCotxAdapter(`${BASE}///`, { fetch });
    const meta = await adapter.getProjectMeta(PROJECT);
    expect(meta.id).toBe('cotx-engine');
  });

  it('search appends query parameter', async () => {
    const fetch = mockFetch({
      [`${BASE}/api/v1/${PROJECT}/search?q=parser`]: {
        status: 200,
        body: { matches: ['parser', 'compiler'] },
      },
    });
    const adapter = createHttpCotxAdapter(BASE, { fetch });
    const result = await adapter.search!(PROJECT, 'parser');
    expect(result.matches).toEqual(['parser', 'compiler']);
    expect(fetch).toHaveBeenCalledWith(
      `${BASE}/api/v1/${PROJECT}/search?q=parser`,
      expect.any(Object),
    );
  });

  it('getImpact returns grounded impact data for a perspective node', async () => {
    const fetch = mockFetch({
      [`${BASE}/api/v1/${PROJECT}/perspectives/overall-architecture/nodes/parser/impact`]: {
        status: 200,
        body: {
          root: 'parser',
          affected: ['src/compiler/module-compiler.ts#compileModule', 'src/compiler/index.ts#compile'],
          status: 'grounded',
          statusReason: null,
          risk: 'MEDIUM',
          targetPaths: ['src/parser'],
        },
      },
    });
    const adapter = createHttpCotxAdapter(BASE, { fetch });
    const result = await adapter.getImpact!(PROJECT, 'overall-architecture', 'parser');
    expect(result).toEqual({
      root: 'parser',
      affected: ['src/compiler/module-compiler.ts#compileModule', 'src/compiler/index.ts#compile'],
      status: 'grounded',
      statusReason: null,
      risk: 'MEDIUM',
      targetPaths: ['src/parser'],
    });
  });
});
