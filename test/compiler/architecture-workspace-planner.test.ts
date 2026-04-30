import { describe, it, expect } from 'vitest';
import { compileArchitecture } from '../../src/compiler/architecture-compiler.js';
import { buildArchitectureWorkspace, planArchitectureRecursion } from '../../src/compiler/architecture-workspace-planner.js';
import type { GraphEdge, GraphNode } from '../../src/core/export/json-exporter.js';
import type { WorkspaceLayoutScan } from '../../src/compiler/workspace-scan.js';

function makeNode(id: string, filePath: string, name: string): GraphNode {
  return {
    id,
    label: 'Function',
    properties: { name, filePath, startLine: 1, endLine: 5, isExported: true },
  };
}

function makeEdge(sourceId: string, targetId: string): GraphEdge {
  return { sourceId, targetId, type: 'CALLS', confidence: 1.0 };
}

describe('buildArchitectureWorkspace', () => {
  it('projects deterministic architecture components and edges into canonical workspace data', () => {
    const architecture = compileArchitecture(
      'test-project',
      [
        makeNode('api.run', 'src/api/index.ts', 'runApi'),
        makeNode('store.read', 'src/store/store.ts', 'readStore'),
      ],
      [makeEdge('api.run', 'store.read')],
      [],
      [],
    );
    const layout: WorkspaceLayoutScan = {
      project_root: '/tmp/test-project',
      generated_at: '2026-04-13T00:00:00Z',
      directories: [{ path: '.', kind: 'repo-root', depth: 0 }],
      candidates: [{ path: 'README.md', kind: 'readme', reason: 'README-like file', boundary: '.' }],
      summary: {
        directories: 1,
        candidates: 1,
        repo_boundaries: 1,
        packages: 0,
        docs_dirs: 0,
        example_dirs: 0,
        cotx_present: false,
        architecture_store_present: false,
      },
    };

    const workspace = buildArchitectureWorkspace('test-project', architecture, {
      workspaceLayout: layout,
      generatedAt: '2026-04-13T00:01:00Z',
      sourceGraphCompiledAt: '2026-04-13T00:00:00Z',
    });

    expect(workspace.schema_version).toBe('cotx.architecture.workspace.v1');
    expect(workspace.generated_at).toBe('2026-04-13T00:01:00Z');
    expect(workspace.elements.some((element) => element.id === 'system:test-project' && element.level === 'software_system')).toBe(true);
    expect(workspace.elements.some((element) => element.id === 'container:api' && element.parent_id === 'system:test-project')).toBe(true);
    expect(workspace.elements.some((element) => element.id === 'container:store')).toBe(true);
    expect(workspace.elements.find((element) => element.id === 'container:api')?.metadata?.exported_functions).toContain('runApi');
    expect(workspace.relationships.some((relationship) => relationship.source_id === 'container:api' && relationship.target_id === 'container:store')).toBe(true);
    expect(workspace.views[0].id).toBe('view:overall-architecture');
    expect(workspace.elements.find((element) => element.id === 'system:test-project')?.evidence[0]).toMatchObject({
      kind: 'file',
      id: 'README.md',
    });
  });

  it('plans recursive documentation boundaries from canonical workspace hierarchy', () => {
    const architecture = compileArchitecture(
      'test-project',
      [
        makeNode('api.run', 'src/api/index.ts', 'runApi'),
        makeNode('store.read', 'src/store/store.ts', 'readStore'),
      ],
      [makeEdge('api.run', 'store.read')],
      [],
      [],
    );
    const workspace = buildArchitectureWorkspace('test-project', architecture, {
      generatedAt: '2026-04-13T00:01:00Z',
    });
    const plan = planArchitectureRecursion(workspace, { generatedAt: '2026-04-13T00:02:00Z' });

    expect(plan.schema_version).toBe('cotx.architecture.recursion_plan.v1');
    expect(plan.source_workspace_generated_at).toBe('2026-04-13T00:01:00Z');
    const systemDecision = plan.decisions.find((decision) => decision.element_id === 'system:test-project');
    expect(systemDecision?.action).toBe('recurse');
    expect(systemDecision?.child_element_ids).toEqual(['container:api', 'container:store']);
    const apiDecision = plan.decisions.find((decision) => decision.element_id === 'container:api');
    expect(apiDecision?.action).toBe('leaf');
  });

  it('compacts repeated recursive path segments in canonical element ids', () => {
    const architecture = compileArchitecture(
      'test-project',
      [
        makeNode('tool-a', 'src/tools/tools/a.ts', 'toolA'),
        makeNode('tool-b', 'src/tools/tools/b.ts', 'toolB'),
        makeNode('tool-c', 'src/tools/tools/c.ts', 'toolC'),
        makeNode('tool-d', 'src/tools/tools/d.ts', 'toolD'),
        makeNode('tool-e', 'src/tools/tools/e.ts', 'toolE'),
        makeNode('tool-f', 'src/tools/tools/f.ts', 'toolF'),
        makeNode('tool-g', 'src/tools/tools/g.ts', 'toolG'),
        makeNode('tool-h', 'src/tools/tools/h.ts', 'toolH'),
        makeNode('tool-i', 'src/tools/tools/i.ts', 'toolI'),
        makeNode('tool-j', 'src/tools/tools/j.ts', 'toolJ'),
        makeNode('tool-k', 'src/tools/tools/k.ts', 'toolK'),
        makeNode('tool-l', 'src/tools/tools/l.ts', 'toolL'),
        makeNode('tool-m', 'src/tools/tools/m.ts', 'toolM'),
        makeNode('tool-n', 'src/tools/tools/n.ts', 'toolN'),
        makeNode('tool-o', 'src/tools/tools/o.ts', 'toolO'),
        makeNode('tool-p', 'src/tools/tools/p.ts', 'toolP'),
      ],
      [],
      [],
      [],
    );

    const workspace = buildArchitectureWorkspace('test-project', architecture);
    expect(workspace.elements.some((element) => element.id.includes('tools/tools'))).toBe(false);
  });
});
