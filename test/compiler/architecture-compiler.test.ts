// test/compiler/architecture-compiler.test.ts
import { describe, it, expect } from 'vitest';
import { compileArchitecture, detectSourceRoots, collectSourceRootInventory } from '../../src/compiler/architecture-compiler.js';
import type { GraphNode, GraphEdge, CommunityData, ProcessData } from '../../src/core/export/json-exporter.js';
import type { WorkspaceLayoutScan } from '../../src/compiler/workspace-scan.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeNode(id: string, filePath: string, name: string, label = 'Function'): GraphNode {
  return {
    id,
    label,
    properties: { name, filePath, startLine: 1, endLine: 10, isExported: true },
  };
}

function makeEdge(sourceId: string, targetId: string, type = 'CALLS'): GraphEdge {
  return { sourceId, targetId, type, confidence: 1.0 };
}

// ── Source Root Detection ──────────────────────────────────────────────────

describe('detectSourceRoots', () => {
  it('detects src/ as root for flat TypeScript projects', () => {
    const files = ['src/store/store.ts', 'src/compiler/module.ts', 'src/index.ts'];
    const roots = detectSourceRoots(files);
    expect(roots).toContain('src');
  });

  it('detects monorepo package roots', () => {
    const files = [
      'packages/core/src/index.ts',
      'packages/core/src/utils.ts',
      'packages/cli/src/main.ts',
    ];
    const roots = detectSourceRoots(files);
    expect(roots).toContain('packages/core/src');
    expect(roots).toContain('packages/cli/src');
  });

  it('detects mixed repo roots without dropping src when apps/packages roots also exist', () => {
    const files = [
      'src/compiler/architecture.ts',
      'src/mcp/tools.ts',
      'packages/core/src/index.ts',
      'apps/workbench/src/main.tsx',
    ];
    const roots = detectSourceRoots(files);
    expect(roots).toContain('src');
    expect(roots).toContain('packages/core/src');
    expect(roots).toContain('apps/workbench/src');
  });

  it('detects Java source roots', () => {
    const files = [
      'src/main/java/com/acme/web/Controller.java',
      'src/main/java/com/acme/db/Repository.java',
    ];
    const roots = detectSourceRoots(files);
    expect(roots.some(r => r.includes('src/main/java'))).toBe(true);
  });

  it('detects Go source roots', () => {
    const files = [
      'cmd/server/main.go',
      'internal/store/db.go',
      'pkg/utils/hash.go',
    ];
    const roots = detectSourceRoots(files);
    expect(roots).toContain('cmd/server');
    expect(roots).toContain('internal');
    expect(roots).toContain('pkg');
  });

  it('detects Rust crate roots', () => {
    const files = [
      'crates/parser/src/lib.rs',
      'crates/parser/src/lexer.rs',
      'crates/compiler/src/main.rs',
    ];
    const roots = detectSourceRoots(files);
    expect(roots).toContain('crates/parser/src');
    expect(roots).toContain('crates/compiler/src');
  });

  it('falls back to common prefix for flat projects', () => {
    const files = ['lib/utils.ts', 'lib/config.ts', 'lib/main.ts'];
    const roots = detectSourceRoots(files);
    expect(roots).toContain('lib');
  });

  it('detects root-level Python package roots without treating tests or docs as source roots', () => {
    const files = [
      'README.md',
      'pyproject.toml',
      'agent/server.py',
      'tests/__init__.py',
      'tests/test_server.py',
      'scripts/__init__.py',
      'scripts/export.py',
    ];
    const roots = detectSourceRoots(files);
    expect(roots).toContain('agent');
    expect(roots).not.toContain('tests');
    expect(roots).not.toContain('scripts');
    expect(roots).not.toContain('README.md');
  });

  it('returns empty for empty file list', () => {
    const roots = detectSourceRoots([]);
    expect(roots).toHaveLength(0);
  });

  it('marks nested example repo roots as excluded when workspace boundaries identify them', () => {
    const layout: WorkspaceLayoutScan = {
      project_root: '/repo',
      generated_at: '2026-04-20T00:00:00.000Z',
      directories: [
        { path: '.', kind: 'repo-root', depth: 0 },
        { path: 'example/demo', kind: 'nested-repo', depth: 2 },
      ],
      candidates: [],
      summary: {
        directories: 2,
        candidates: 0,
        repo_boundaries: 2,
        packages: 0,
        docs_dirs: 0,
        example_dirs: 1,
        cotx_present: false,
        architecture_store_present: false,
      },
    };

    const inventory = collectSourceRootInventory([
      'src/compiler/architecture.ts',
      'example/demo/src/main.ts',
    ], { workspaceLayout: layout });

    expect(inventory.selected_paths).toContain('src');
    expect(inventory.selected_paths).not.toContain('example/demo/src');
    expect(inventory.excluded.find((root) => root.path === 'example/demo/src')?.role).toBe('example');
  });
});

// ── Full Compilation ──────────────────────────────────────────────────────

describe('compileArchitecture', () => {
  it('groups files into directory-based components', () => {
    const nodes: GraphNode[] = [
      makeNode('fn1', 'src/store/store.ts', 'writeModule'),
      makeNode('fn2', 'src/store/schema.ts', 'ModuleNode', 'Class'),
      makeNode('fn3', 'src/compiler/module-compiler.ts', 'compileModules'),
      makeNode('fn4', 'src/compiler/concept-compiler.ts', 'compileConcepts'),
      makeNode('fn5', 'src/mcp/tools.ts', 'handleToolCall'),
    ];
    const edges: GraphEdge[] = [
      makeEdge('fn3', 'fn1'),  // compiler -> store
      makeEdge('fn5', 'fn3'),  // mcp -> compiler
    ];

    const result = compileArchitecture('test-project', nodes, edges, [], []);
    const overall = result.perspectives.find(p => p.id === 'overall-architecture');
    expect(overall).toBeDefined();

    // Should have store, compiler, mcp as components
    const componentIds = overall!.components.map(c => c.id);
    expect(componentIds).toContain('store');
    expect(componentIds).toContain('compiler');
    expect(componentIds).toContain('mcp');
  });

  it('filters out non-source artifacts outside detected source roots', () => {
    const nodes: GraphNode[] = [
      makeNode('fn1', 'src/store/store.ts', 'writeModule'),
      makeNode('fn2', 'package.json', 'pkgFn'),
      makeNode('fn3', 'README.md', 'readmeFn'),
      makeNode('fn4', 'vitest.config.ts', 'vitestFn'),
    ];

    const result = compileArchitecture('test-project', nodes, [], [], []);
    const overall = result.perspectives.find(p => p.id === 'overall-architecture')!;
    const componentIds = overall.components.map(c => c.id);

    expect(componentIds).toContain('store');
    expect(componentIds).not.toContain('package');
    expect(componentIds).not.toContain('readme');
    expect(componentIds).not.toContain('vitest');
  });

  it('filters docs/config/tests around a root-level Python package', () => {
    const nodes: GraphNode[] = [
      makeNode('fn1', 'agent/server.py', 'runServer'),
      makeNode('fn2', 'agent/utils.py', 'loadConfig'),
      makeNode('fn3', 'tests/test_server.py', 'testServer'),
      makeNode('fn4', 'README.md', 'readmeFn'),
      makeNode('fn5', 'Makefile', 'makeFn'),
      makeNode('fn6', 'pyproject.toml', 'projectFn'),
      makeNode('init', 'agent/__init__.py', 'init'),
    ];

    const result = compileArchitecture('python-project', nodes, [], [], []);
    const overall = result.perspectives.find(p => p.id === 'overall-architecture')!;
    const componentIds = overall.components.map(c => c.id);

    expect(componentIds).toContain('server');
    expect(componentIds).toContain('utils');
    expect(componentIds).not.toContain('tests');
    expect(componentIds).not.toContain('readme');
    expect(componentIds).not.toContain('makefile');
    expect(componentIds).not.toContain('pyproject');
  });

  it('generates cross-component edges with labels', () => {
    const nodes: GraphNode[] = [
      makeNode('fn1', 'src/store/store.ts', 'writeModule'),
      makeNode('fn2', 'src/compiler/module-compiler.ts', 'compileModules'),
    ];
    const edges: GraphEdge[] = [makeEdge('fn2', 'fn1')];

    const result = compileArchitecture('test-project', nodes, edges, [], []);
    const overall = result.perspectives.find(p => p.id === 'overall-architecture')!;

    expect(overall.edges.length).toBeGreaterThan(0);
    const edge = overall.edges.find(e => e.from === 'compiler' && e.to === 'store');
    expect(edge).toBeDefined();
    expect(edge!.label).toContain('writeModule');
  });

  it('marks small components as leaf', () => {
    // 5 files in one directory = leaf
    const nodes: GraphNode[] = Array.from({ length: 5 }, (_, i) =>
      makeNode(`fn${i}`, `src/utils/util${i}.ts`, `util${i}`),
    );

    const result = compileArchitecture('test-project', nodes, [], [], []);
    const overall = result.perspectives.find(p => p.id === 'overall-architecture')!;
    const utils = overall.components.find(c => c.id === 'utils');
    expect(utils).toBeDefined();
    expect(utils!.kind).toBe('leaf');
    expect(utils!.files).toBeDefined();
  });

  it('computes stats for components', () => {
    const nodes: GraphNode[] = [
      makeNode('fn1', 'src/store/store.ts', 'writeModule'),
      makeNode('fn2', 'src/store/store.ts', 'readModule'),
    ];

    const result = compileArchitecture('test-project', nodes, [], [], [], {
      'src/store/store.ts:writeModule': { cyclomatic: 5, nestingDepth: 2, loc: 20, filePath: 'src/store/store.ts', name: 'writeModule' },
      'src/store/store.ts:readModule': { cyclomatic: 3, nestingDepth: 1, loc: 10, filePath: 'src/store/store.ts', name: 'readModule' },
    });
    const overall = result.perspectives.find(p => p.id === 'overall-architecture')!;
    const store = overall.components.find(c => c.id === 'store')!;

    expect(store.stats.function_count).toBe(2);
    expect(store.stats.max_cyclomatic).toBe(5);
    expect(store.stats.max_nesting_depth).toBe(2);
  });

  it('generates data-flow perspective when processes exist', () => {
    const nodes: GraphNode[] = [
      makeNode('fn1', 'src/api/handler.ts', 'handleRequest'),
      makeNode('fn2', 'src/store/store.ts', 'writeModule'),
    ];
    const processes: ProcessData[] = [{
      id: 'p1',
      label: 'compile-flow',
      processType: 'process',
      stepCount: 2,
      communities: [],
      entryPointId: 'fn1',
      terminalId: 'fn2',
      steps: [{ nodeId: 'fn1', step: 0 }, { nodeId: 'fn2', step: 1 }],
    }];

    const result = compileArchitecture('test-project', nodes, [], [], processes);
    expect(result.perspectives.some(p => p.id === 'data-flow')).toBe(true);
  });

  it('handles empty graph gracefully', () => {
    const result = compileArchitecture('test-project', [], [], [], []);
    expect(result.perspectives.length).toBeGreaterThanOrEqual(1);
    const overall = result.perspectives.find(p => p.id === 'overall-architecture')!;
    expect(overall.components).toHaveLength(0);
  });

  it('generates Mermaid diagram for overall architecture', () => {
    const nodes: GraphNode[] = [
      makeNode('fn1', 'src/store/store.ts', 'writeModule'),
      makeNode('fn2', 'src/compiler/module-compiler.ts', 'compileModules'),
    ];
    const edges: GraphEdge[] = [makeEdge('fn2', 'fn1')];

    const result = compileArchitecture('test-project', nodes, edges, [], []);
    const mermaid = result.mermaidByPath.get('overall-architecture');
    expect(mermaid).toBeDefined();
    expect(mermaid).toContain('graph TD');
    expect(mermaid).toContain('store');
    expect(mermaid).toContain('compiler');
  });

  it('generates default descriptions for perspectives and elements', () => {
    const nodes: GraphNode[] = [
      makeNode('fn1', 'src/store/store.ts', 'writeModule'),
      makeNode('fn2', 'src/compiler/module-compiler.ts', 'compileModules'),
    ];

    const result = compileArchitecture('test-project', nodes, [makeEdge('fn2', 'fn1')], [], []);
    expect(result.descriptionsByPath.get('overall-architecture')).toBeTruthy();
    expect(result.descriptionsByPath.get('overall-architecture/store')).toBeTruthy();
    expect(result.descriptionsByPath.get('overall-architecture/compiler')).toBeTruthy();
  });

  it('uses deterministic function and contract facts in element descriptions instead of count summaries', () => {
    const nodes: GraphNode[] = [
      makeNode('webapp.webhook', 'agent/webapp.py', 'github_webhook'),
      makeNode('webapp.issue', 'agent/webapp.py', 'process_github_issue'),
      makeNode('tools.search', 'agent/tools/web_search.py', 'web_search'),
      makeNode('tools.pr', 'agent/tools/commit_and_open_pr.py', 'commit_and_open_pr'),
    ];
    const edges: GraphEdge[] = [
      makeEdge('webapp.webhook', 'tools.search'),
      makeEdge('webapp.issue', 'tools.pr'),
    ];

    const result = compileArchitecture('python-project', nodes, edges, [], []);
    const webappDescription = result.descriptionsByPath.get('overall-architecture/webapp') ?? '';
    const toolsDescription = result.descriptionsByPath.get('overall-architecture/tools') ?? '';

    expect(webappDescription).toContain('github_webhook');
    expect(webappDescription).toContain('process_github_issue');
    expect(webappDescription).not.toContain('owns code');
    expect(webappDescription).not.toContain('exposes 2 exported functions');
    expect(toolsDescription).toContain('web_search');
    expect(toolsDescription).toContain('commit_and_open_pr');
  });

  it('uses LR direction for data-flow Mermaid diagram', () => {
    const nodes: GraphNode[] = [
      makeNode('fn1', 'src/api/handler.ts', 'handleRequest'),
      makeNode('fn2', 'src/store/store.ts', 'writeModule'),
    ];
    const processes: ProcessData[] = [{
      id: 'p1',
      label: 'compile-flow',
      processType: 'process',
      stepCount: 2,
      communities: [],
      entryPointId: 'fn1',
      terminalId: 'fn2',
      steps: [{ nodeId: 'fn1', step: 0 }, { nodeId: 'fn2', step: 1 }],
    }];

    const result = compileArchitecture('test-project', nodes, [], [], processes);
    const mermaid = result.mermaidByPath.get('data-flow');
    expect(mermaid).toBeDefined();
    expect(mermaid).toContain('graph LR');
  });

  it('emits element docs for each component', () => {
    const nodes: GraphNode[] = [
      makeNode('fn1', 'src/store/store.ts', 'writeModule'),
      makeNode('fn2', 'src/compiler/module-compiler.ts', 'compileModules'),
    ];

    const result = compileArchitecture('test-project', nodes, [], [], []);
    expect(result.elementDocs.length).toBeGreaterThan(0);

    const storeDoc = result.elementDocs.find(d => d.elementPath === 'store');
    expect(storeDoc).toBeDefined();
    expect(storeDoc!.perspectiveId).toBe('overall-architecture');
  });

  it('populates exported_functions for leaf components', () => {
    const nodes: GraphNode[] = [
      makeNode('fn1', 'src/store/store.ts', 'writeModule'),
      { id: 'fn2', label: 'Function', properties: { name: 'helperFn', filePath: 'src/store/helpers.ts', isExported: false, startLine: 1, endLine: 10 } },
    ];

    const result = compileArchitecture('test-project', nodes, [], [], []);
    const overall = result.perspectives.find(p => p.id === 'overall-architecture')!;
    const store = overall.components.find(c => c.id === 'store')!;
    expect(store.exported_functions).toContain('writeModule');
    expect(store.exported_functions).not.toContain('helperFn');
  });

  it('computes risk score based on complexity and file count', () => {
    const nodes: GraphNode[] = [
      makeNode('fn1', 'src/store/store.ts', 'writeModule'),
    ];

    const result = compileArchitecture('test-project', nodes, [], [], [], {
      'src/store/store.ts:writeModule': { cyclomatic: 10, nestingDepth: 4, loc: 50, filePath: 'src/store/store.ts', name: 'writeModule' },
    });
    const overall = result.perspectives.find(p => p.id === 'overall-architecture')!;
    const store = overall.components.find(c => c.id === 'store')!;
    expect(store.stats.risk_score).toBeGreaterThan(0);
  });

  it('generates meta with struct hash and perspective list', () => {
    const nodes: GraphNode[] = [
      makeNode('fn1', 'src/store/store.ts', 'writeModule'),
    ];

    const result = compileArchitecture('test-project', nodes, [], [], []);
    expect(result.meta.perspectives).toContain('overall-architecture');
    expect(result.meta.mode).toBe('auto');
    expect(result.meta.struct_hash).toBeTruthy();
    expect(result.meta.generated_at).toBeTruthy();
  });

  it('edge labels contain top target function names', () => {
    const nodes: GraphNode[] = [
      makeNode('fn1', 'src/compiler/module-compiler.ts', 'compileModules'),
      makeNode('fn2', 'src/store/store.ts', 'writeModule'),
      makeNode('fn3', 'src/store/store.ts', 'readModule'),
      makeNode('fn4', 'src/store/store.ts', 'listModules'),
      makeNode('fn5', 'src/store/store.ts', 'deleteModule'),
    ];
    const edges: GraphEdge[] = [
      makeEdge('fn1', 'fn2'),
      makeEdge('fn1', 'fn3'),
      makeEdge('fn1', 'fn4'),
      makeEdge('fn1', 'fn5'),
    ];

    const result = compileArchitecture('test-project', nodes, edges, [], []);
    const overall = result.perspectives.find(p => p.id === 'overall-architecture')!;
    const edge = overall.edges.find(e => e.from === 'compiler' && e.to === 'store');
    expect(edge).toBeDefined();
    // Should have at most 3 function names
    const names = edge!.label.split(', ');
    expect(names.length).toBeLessThanOrEqual(3);
    expect(names.length).toBeGreaterThanOrEqual(1);
  });

  it('ignores root-level files (no directory)', () => {
    const nodes: GraphNode[] = [
      makeNode('fn1', 'src/index.ts', 'main'),
      makeNode('fn2', 'src/store/store.ts', 'writeModule'),
    ];

    const result = compileArchitecture('test-project', nodes, [], [], []);
    const overall = result.perspectives.find(p => p.id === 'overall-architecture')!;
    // index.ts is at root of src/, should be excluded (no directory)
    const rootComp = overall.components.find(c => c.id === '_root');
    expect(rootComp).toBeUndefined();
    // store should exist
    expect(overall.components.find(c => c.id === 'store')).toBeDefined();
  });

  it('handles flat single-directory project', () => {
    // All files in a single top-level directory (like oh-my-mermaid with lib/)
    const nodes: GraphNode[] = [
      makeNode('fn1', 'lib/parser.ts', 'parse'),
      makeNode('fn2', 'lib/renderer.ts', 'render'),
      makeNode('fn3', 'lib/utils.ts', 'format'),
    ];

    const result = compileArchitecture('test-project', nodes, [], [], []);
    const overall = result.perspectives.find(p => p.id === 'overall-architecture')!;
    const componentIds = overall.components.map(c => c.id);
    expect(componentIds).toContain('parser');
    expect(componentIds).toContain('renderer');
    expect(componentIds).toContain('utils');
  });

  it('handles Java-style source root with nested packages', () => {
    const nodes: GraphNode[] = [
      makeNode('fn1', 'src/main/java/com/acme/web/Controller.java', 'handleRequest'),
      makeNode('fn2', 'src/main/java/com/acme/db/Repository.java', 'findAll'),
      makeNode('fn3', 'src/main/java/com/acme/service/UserService.java', 'createUser'),
    ];
    const edges: GraphEdge[] = [
      makeEdge('fn1', 'fn3'),
      makeEdge('fn3', 'fn2'),
    ];

    const result = compileArchitecture('test-project', nodes, edges, [], []);
    const overall = result.perspectives.find(p => p.id === 'overall-architecture')!;

    const componentIds = overall.components.map(c => c.id);
    expect(componentIds).toContain('web');
    expect(componentIds).toContain('db');
    expect(componentIds).toContain('service');
  });

  it('handles monorepo with packages/*/src structure', () => {
    const nodes: GraphNode[] = [
      makeNode('fn1', 'packages/core/src/utils/hash.ts', 'computeHash'),
      makeNode('fn2', 'packages/core/src/store/db.ts', 'queryDB'),
      makeNode('fn3', 'packages/cli/src/commands/run.ts', 'runCommand'),
    ];
    const edges: GraphEdge[] = [makeEdge('fn3', 'fn1')];

    const result = compileArchitecture('test-project', nodes, edges, [], []);
    const overall = result.perspectives.find(p => p.id === 'overall-architecture')!;

    const componentIds = overall.components.map(c => c.id);
    // Monorepo components include package name: core/utils, core/store, cli/commands
    expect(componentIds).toContain('core/utils');
    expect(componentIds).toContain('core/store');
    expect(componentIds).toContain('cli/commands');
  });

  it('handles mixed repo with repo core plus apps/packages source roots', () => {
    const nodes: GraphNode[] = [
      makeNode('compiler.main', 'src/compiler/architecture-compiler.ts', 'compileArchitecture'),
      makeNode('mcp.main', 'src/mcp/tools.ts', 'handleToolCall'),
      makeNode('sdk.types', 'packages/cotx-sdk-core/src/types/layers.ts', 'layerForPerspectiveId'),
      makeNode('workbench.route', 'apps/cotx-workbench/src/routes/WorkbenchRoute.tsx', 'WorkbenchRoute'),
    ];
    const edges: GraphEdge[] = [
      makeEdge('workbench.route', 'sdk.types'),
      makeEdge('mcp.main', 'compiler.main'),
    ];

    const result = compileArchitecture('cotx-engine', nodes, edges, [], []);
    const overall = result.perspectives.find((p) => p.id === 'overall-architecture')!;
    const componentIds = overall.components.map((c) => c.id);

    expect(result.sourceRootInventory.selected_paths).toContain('src');
    expect(result.sourceRootInventory.selected_paths).toContain('packages/cotx-sdk-core/src');
    expect(result.sourceRootInventory.selected_paths).toContain('apps/cotx-workbench/src');
    expect(componentIds).toContain('compiler');
    expect(componentIds).toContain('mcp');
    expect(componentIds).toContain('cotx-sdk-core/types');
    expect(componentIds).toContain('cotx-workbench/routes');
  });

  it('data-flow perspective only includes process-touched components', () => {
    const nodes: GraphNode[] = [
      makeNode('fn1', 'src/api/handler.ts', 'handleRequest'),
      makeNode('fn2', 'src/store/store.ts', 'writeModule'),
      makeNode('fn3', 'src/utils/helper.ts', 'formatOutput'),
    ];
    const processes: ProcessData[] = [{
      id: 'p1',
      label: 'request-flow',
      processType: 'process',
      stepCount: 2,
      communities: [],
      entryPointId: 'fn1',
      terminalId: 'fn2',
      steps: [{ nodeId: 'fn1', step: 0 }, { nodeId: 'fn2', step: 1 }],
    }];

    const result = compileArchitecture('test-project', nodes, [], [], processes);
    const dataFlow = result.perspectives.find(p => p.id === 'data-flow')!;

    const componentIds = dataFlow.components.map(c => c.id);
    expect(componentIds).toContain('api');
    expect(componentIds).toContain('store');
    // utils is not in any process step, should not appear
    expect(componentIds).not.toContain('utils');
  });

  it('data-flow edges reflect process step order', () => {
    const nodes: GraphNode[] = [
      makeNode('fn1', 'src/api/handler.ts', 'handleRequest'),
      makeNode('fn2', 'src/service/logic.ts', 'processData'),
      makeNode('fn3', 'src/store/store.ts', 'writeModule'),
    ];
    const processes: ProcessData[] = [{
      id: 'p1',
      label: 'compile-flow',
      processType: 'process',
      stepCount: 3,
      communities: [],
      entryPointId: 'fn1',
      terminalId: 'fn3',
      steps: [
        { nodeId: 'fn1', step: 0 },
        { nodeId: 'fn2', step: 1 },
        { nodeId: 'fn3', step: 2 },
      ],
    }];

    const result = compileArchitecture('test-project', nodes, [], [], processes);
    const dataFlow = result.perspectives.find(p => p.id === 'data-flow')!;

    expect(dataFlow.edges.some(e => e.from === 'api' && e.to === 'service')).toBe(true);
    expect(dataFlow.edges.some(e => e.from === 'service' && e.to === 'store')).toBe(true);
  });

  it('deduplicates files in component file lists', () => {
    // Two functions in the same file should not duplicate the file
    const nodes: GraphNode[] = [
      makeNode('fn1', 'src/store/store.ts', 'writeModule'),
      makeNode('fn2', 'src/store/store.ts', 'readModule'),
    ];

    const result = compileArchitecture('test-project', nodes, [], [], []);
    const overall = result.perspectives.find(p => p.id === 'overall-architecture')!;
    const store = overall.components.find(c => c.id === 'store')!;
    expect(store.files!.length).toBe(1);
    expect(store.files).toContain('src/store/store.ts');
  });

  it('does not create data-flow perspective when no processes exist', () => {
    const nodes: GraphNode[] = [
      makeNode('fn1', 'src/store/store.ts', 'writeModule'),
    ];

    const result = compileArchitecture('test-project', nodes, [], [], []);
    expect(result.perspectives).toHaveLength(1);
    expect(result.perspectives[0].id).toBe('overall-architecture');
    expect(result.mermaidByPath.has('data-flow')).toBe(false);
  });

  it('only counts CALLS edges for cross-component edges', () => {
    const nodes: GraphNode[] = [
      makeNode('fn1', 'src/compiler/module-compiler.ts', 'compileModules'),
      makeNode('fn2', 'src/store/store.ts', 'writeModule'),
    ];
    const edges: GraphEdge[] = [
      makeEdge('fn1', 'fn2', 'IMPORTS'),  // not a CALLS edge
    ];

    const result = compileArchitecture('test-project', nodes, edges, [], []);
    const overall = result.perspectives.find(p => p.id === 'overall-architecture')!;
    // IMPORTS edges should not create architecture edges
    expect(overall.edges).toHaveLength(0);
  });

  it('handles nodes without filePath gracefully', () => {
    const nodes: GraphNode[] = [
      makeNode('fn1', 'src/store/store.ts', 'writeModule'),
      { id: 'fn2', label: 'Function', properties: { name: 'orphan' } },
    ];

    const result = compileArchitecture('test-project', nodes, [], [], []);
    const overall = result.perspectives.find(p => p.id === 'overall-architecture')!;
    expect(overall.components.length).toBe(1);
    expect(overall.components[0].id).toBe('store');
  });

  it('stats default to zero when no complexity data provided', () => {
    const nodes: GraphNode[] = [
      makeNode('fn1', 'src/store/store.ts', 'writeModule'),
    ];

    const result = compileArchitecture('test-project', nodes, [], [], []);
    const overall = result.perspectives.find(p => p.id === 'overall-architecture')!;
    const store = overall.components.find(c => c.id === 'store')!;
    expect(store.stats.max_cyclomatic).toBe(0);
    expect(store.stats.max_nesting_depth).toBe(0);
    expect(store.stats.total_cyclomatic).toBe(0);
  });

  it('populates contracts and related flows for leaf components', () => {
    const nodes: GraphNode[] = [
      makeNode('fn1', 'src/compiler/module-compiler.ts', 'compileModules'),
      makeNode('fn2', 'src/store/store.ts', 'writeModule'),
      makeNode('fn3', 'src/store/store.ts', 'readModule'),
    ];
    const edges: GraphEdge[] = [
      makeEdge('fn1', 'fn2'),
      makeEdge('fn1', 'fn3'),
    ];
    const processes: ProcessData[] = [{
      id: 'p1',
      label: 'compile-flow',
      processType: 'process',
      stepCount: 2,
      communities: [],
      entryPointId: 'fn1',
      terminalId: 'fn2',
      steps: [{ nodeId: 'fn1', step: 0 }, { nodeId: 'fn2', step: 1 }],
    }];

    const result = compileArchitecture('test-project', nodes, edges, [], processes);
    const overall = result.perspectives.find(p => p.id === 'overall-architecture')!;
    const compiler = overall.components.find(c => c.id === 'compiler')!;
    const store = overall.components.find(c => c.id === 'store')!;

    expect(compiler.contracts_consumed).toContain('writeModule');
    expect(compiler.related_flows).toContain('compile-flow');
    expect(store.contracts_provided).toContain('writeModule');
    expect(store.contracts_provided).toContain('readModule');
    expect(store.related_flows).toContain('compile-flow');
  });

  it('recursively emits nested element docs beyond one level', () => {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];

    for (let i = 0; i < 8; i++) {
      nodes.push(makeNode(`lex${i}`, `src/engine/parser/lexer/lex${i}.ts`, `lex${i}`));
      nodes.push(makeNode(`tok${i}`, `src/engine/parser/token/tok${i}.ts`, `tok${i}`));
    }
    nodes.push(makeNode('store', 'src/store/store.ts', 'writeModule'));

    for (let i = 0; i < 8; i++) {
      edges.push(makeEdge(`lex${i}`, 'store'));
      edges.push(makeEdge(`tok${i}`, 'store'));
    }

    const result = compileArchitecture('test-project', nodes, edges, [], []);
    const paths = result.elementDocs.map(d => d.elementPath);

    expect(paths).toContain('engine');
    expect(paths).toContain('engine/parser');
    expect(paths).toContain('engine/parser/lexer');
    expect(paths).toContain('engine/parser/token');
  });

  it('ignores directory pseudo-paths when computing recursive architecture groups', () => {
    const nodes: GraphNode[] = [
      makeNode('tools-dir', 'agent/tools', 'toolsDir'),
      makeNode('server', 'agent/server.py', 'runServer'),
    ];
    const edges: GraphEdge[] = [];

    for (let i = 0; i < 16; i++) {
      nodes.push(makeNode(`tool${i}`, `agent/tools/tool${i}.py`, `runTool${i}`));
      edges.push(makeEdge(`tool${i}`, 'server'));
    }

    const result = compileArchitecture('python-project', nodes, edges, [], []);
    const paths = result.elementDocs.map(d => d.elementPath);

    expect(paths).toContain('tools');
    expect(paths.some((entry) => entry.startsWith('tools/tools'))).toBe(false);
  });

  it('generates nested group Mermaid diagrams for drill-down', () => {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    for (let i = 0; i < 8; i++) {
      nodes.push(makeNode(`lex${i}`, `src/engine/parser/lexer/lex${i}.ts`, `lex${i}`));
      nodes.push(makeNode(`tok${i}`, `src/engine/parser/token/tok${i}.ts`, `tok${i}`));
      nodes.push(makeNode(`sink${i}`, `src/store/store.ts`, `write${i}`));
      edges.push(makeEdge(`lex${i}`, `tok${i}`));
      edges.push(makeEdge(`lex${i}`, `sink${i}`));
      edges.push(makeEdge(`tok${i}`, `sink${i}`));
    }

    const result = compileArchitecture('test-project', nodes, edges, [], []);
    const mermaid = result.mermaidByPath.get('overall-architecture/engine/parser');
    expect(mermaid).toBeTruthy();
    expect(mermaid).toContain('lexer');
    expect(mermaid).toContain('tok');
  });
});
