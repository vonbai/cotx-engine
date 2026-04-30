import { describe, it, expect } from 'vitest';
import {
  exportWorkspaceToD2,
  exportWorkspaceToDrawioXml,
  exportWorkspaceToMermaid,
  exportWorkspaceToStructurizrDsl,
  exportWorkspaceToStructurizrJson,
} from '../../src/compiler/architecture-export.js';
import type { ArchitectureWorkspaceData } from '../../src/store/schema.js';

describe('architecture export adapters', () => {
  const workspace: ArchitectureWorkspaceData = {
    schema_version: 'cotx.architecture.workspace.v1',
    generated_at: '2026-04-13T00:00:00Z',
    elements: [
      {
        id: 'system:cotx-engine',
        name: 'cotx-engine',
        level: 'software_system',
        description: 'Semantic map compiler.',
        tags: ['cotx'],
        evidence: [{ kind: 'file', id: 'README.md', filePath: 'README.md' }],
        review_status: 'draft',
      },
      {
        id: 'container:compiler',
        name: 'Compiler',
        level: 'container',
        parent_id: 'system:cotx-engine',
        evidence: [{ kind: 'module', id: 'compiler' }],
        review_status: 'draft',
      },
      {
        id: 'component:compiler/parser',
        name: 'Parser',
        level: 'component',
        parent_id: 'container:compiler',
        evidence: [{ kind: 'file', id: 'src/core/parser/index.ts', filePath: 'src/core/parser/index.ts' }],
        review_status: 'draft',
      },
      {
        id: 'container:store',
        name: 'Store',
        level: 'container',
        parent_id: 'system:cotx-engine',
        evidence: [{ kind: 'module', id: 'store' }],
        review_status: 'draft',
      },
    ],
    relationships: [
      {
        id: 'rel:compiler-store',
        source_id: 'container:compiler',
        target_id: 'container:store',
        description: 'writes artifacts',
        tags: ['dependency'],
        evidence: [{ kind: 'relation', id: 'compiler->store' }],
        review_status: 'draft',
      },
    ],
    views: [
      {
        id: 'view:containers',
        name: 'Containers',
        type: 'container',
        element_ids: ['system:cotx-engine', 'container:compiler', 'container:store'],
        relationship_ids: ['rel:compiler-store'],
        review_status: 'draft',
      },
      {
        id: 'view:compiler-components',
        name: 'Compiler Components',
        type: 'component',
        element_ids: ['container:compiler', 'component:compiler/parser'],
        relationship_ids: [],
        review_status: 'draft',
      },
    ],
  };

  it('exports a selected workspace view to Mermaid', () => {
    const mermaid = exportWorkspaceToMermaid(workspace, 'view:containers');
    expect(mermaid).toContain('graph TD');
    expect(mermaid).toContain('container_compiler["Compiler\\ncontainer"]');
    expect(mermaid).toContain('container_compiler -->|"writes artifacts"| container_store');
    expect(mermaid).not.toContain('component_compiler_parser');
  });

  it('exports workspace model and views to Structurizr JSON shape', () => {
    const exported = exportWorkspaceToStructurizrJson(workspace);
    expect(exported.workspace.name).toBe('cotx-engine');
    expect(exported.workspace.model.softwareSystems[0].containers?.map((container) => container.id)).toEqual([
      'container:compiler',
      'container:store',
    ]);
    expect(exported.workspace.model.softwareSystems[0].containers?.[0].components?.[0].id).toBe('component:compiler/parser');
    expect(exported.workspace.model.relationships[0]).toMatchObject({
      id: 'rel:compiler-store',
      sourceId: 'container:compiler',
      destinationId: 'container:store',
    });
    expect(exported.workspace.views.containerViews[0].key).toBe('view:containers');
    expect(exported.workspace.views.componentViews[0].containerId).toBe('container:compiler');
  });

  it('exports workspace model to Structurizr DSL', () => {
    const dsl = exportWorkspaceToStructurizrDsl(workspace);
    expect(dsl).toContain('workspace {');
    expect(dsl).toContain('system_cotx_engine = softwareSystem "cotx-engine"');
    expect(dsl).toContain('container_compiler = container "Compiler"');
    expect(dsl).toContain('container_compiler -> container_store "writes artifacts"');
    expect(dsl).toContain('container view_containers {');
  });

  it('exports a selected workspace view to D2', () => {
    const d2 = exportWorkspaceToD2(workspace, 'view:containers');
    expect(d2).toContain('container_compiler: "Compiler\\ncontainer"');
    expect(d2).toContain('container_compiler -> container_store: "writes artifacts"');
    expect(d2).not.toContain('component_compiler_parser');
  });

  it('exports a selected workspace view to draw.io XML', () => {
    const xml = exportWorkspaceToDrawioXml(workspace, 'view:containers');
    expect(xml).toContain('<mxfile host="cotx">');
    expect(xml).toContain('value="Compiler\\ncontainer"');
    expect(xml).toContain('value="writes artifacts"');
    expect(xml).toContain('edge="1"');
    expect(xml).not.toContain('Parser\\ncomponent');
  });
});
