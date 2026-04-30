import type {
  ArchitectureWorkspaceData,
  ArchitectureWorkspaceElement,
  ArchitectureWorkspaceRelationship,
  ArchitectureWorkspaceView,
} from '../store/schema.js';

export interface StructurizrJsonWorkspace {
  workspace: {
    name: string;
    description?: string;
    model: {
      softwareSystems: Array<{
        id: string;
        name: string;
        description?: string;
        containers?: Array<{
          id: string;
          name: string;
          description?: string;
          components?: Array<{
            id: string;
            name: string;
            description?: string;
            tags?: string;
          }>;
          tags?: string;
        }>;
        tags?: string;
      }>;
      relationships: Array<{
        id: string;
        sourceId: string;
        destinationId: string;
        description: string;
        technology?: string;
        tags?: string;
      }>;
    };
    views: {
      systemContextViews: Array<{ key: string; softwareSystemId?: string; title: string; description?: string }>;
      containerViews: Array<{ key: string; softwareSystemId?: string; title: string; description?: string }>;
      componentViews: Array<{ key: string; containerId?: string; title: string; description?: string }>;
    };
  };
}

export function exportWorkspaceToMermaid(workspace: ArchitectureWorkspaceData, viewId?: string): string {
  const view = viewId ? workspace.views.find((item) => item.id === viewId) : workspace.views[0];
  const elementIds = new Set(view?.element_ids ?? workspace.elements.map((element) => element.id));
  const relationshipIds = new Set(view?.relationship_ids ?? workspace.relationships.map((relationship) => relationship.id));
  const elements = workspace.elements.filter((element) => elementIds.has(element.id));
  const relationships = workspace.relationships.filter((relationship) => relationshipIds.has(relationship.id));
  const lines = ['graph TD'];
  for (const element of elements) {
    lines.push(`  ${mermaidId(element.id)}["${escapeMermaidLabel(`${element.name}\\n${element.level}`)}"]`);
  }
  for (const relationship of relationships) {
    if (!elementIds.has(relationship.source_id) || !elementIds.has(relationship.target_id)) continue;
    const label = relationship.description ? `|"${escapeMermaidLabel(relationship.description)}"|` : '';
    lines.push(`  ${mermaidId(relationship.source_id)} -->${label} ${mermaidId(relationship.target_id)}`);
  }
  return lines.join('\n');
}

export function exportWorkspaceToStructurizrJson(workspace: ArchitectureWorkspaceData): StructurizrJsonWorkspace {
  const elementsById = new Map(workspace.elements.map((element) => [element.id, element]));
  const systems = workspace.elements
    .filter((element) => element.level === 'software_system')
    .map((system) => ({
      id: system.id,
      name: system.name,
      description: system.description,
      tags: tags(system),
      containers: workspace.elements
        .filter((element) => element.level === 'container' && element.parent_id === system.id)
        .map((container) => ({
          id: container.id,
          name: container.name,
          description: container.description,
          tags: tags(container),
          components: workspace.elements
            .filter((element) => element.level === 'component' && element.parent_id === container.id)
            .map((component) => ({
              id: component.id,
              name: component.name,
              description: component.description,
              tags: tags(component),
            })),
        })),
    }));

  return {
    workspace: {
      name: systems[0]?.name ?? 'Architecture Workspace',
      description: systems[0]?.description,
      model: {
        softwareSystems: systems,
        relationships: workspace.relationships.map((relationship) => relationshipToStructurizr(relationship)),
      },
      views: {
        systemContextViews: workspace.views
          .filter((view) => view.type === 'system_context')
          .map((view) => viewToStructurizr(view, elementsById)),
        containerViews: workspace.views
          .filter((view) => view.type === 'container')
          .map((view) => viewToStructurizr(view, elementsById)),
        componentViews: workspace.views
          .filter((view) => view.type === 'component')
          .map((view) => viewToStructurizr(view, elementsById)),
      },
    },
  };
}

export function exportWorkspaceToStructurizrDsl(workspace: ArchitectureWorkspaceData): string {
  const system = workspace.elements.find((element) => element.level === 'software_system');
  const lines: string[] = ['workspace {', '  model {'];
  if (system) {
    lines.push(`    ${dslIdentifier(system.id)} = softwareSystem "${escapeDsl(system.name)}"${system.description ? ` "${escapeDsl(system.description)}"` : ''} {`);
    for (const container of workspace.elements.filter((element) => element.level === 'container' && element.parent_id === system.id)) {
      lines.push(`      ${dslIdentifier(container.id)} = container "${escapeDsl(container.name)}"${container.description ? ` "${escapeDsl(container.description)}"` : ''}`);
    }
    lines.push('    }');
  }
  for (const relationship of workspace.relationships) {
    lines.push(`    ${dslIdentifier(relationship.source_id)} -> ${dslIdentifier(relationship.target_id)} "${escapeDsl(relationship.description)}"`);
  }
  lines.push('  }', '  views {');
  for (const view of workspace.views) {
    lines.push(`    ${view.type === 'component' ? 'component' : view.type === 'system_context' ? 'systemContext' : 'container'} ${dslIdentifier(view.id)} {`);
    lines.push('      include *');
    lines.push('      autoLayout');
    lines.push('    }');
  }
  lines.push('  }', '}');
  return lines.join('\n');
}

export function exportWorkspaceToD2(workspace: ArchitectureWorkspaceData, viewId?: string): string {
  const view = viewId ? workspace.views.find((item) => item.id === viewId) : workspace.views[0];
  const elementIds = new Set(view?.element_ids ?? workspace.elements.map((element) => element.id));
  const relationshipIds = new Set(view?.relationship_ids ?? workspace.relationships.map((relationship) => relationship.id));
  const elements = workspace.elements.filter((element) => elementIds.has(element.id));
  const relationships = workspace.relationships.filter((relationship) => relationshipIds.has(relationship.id));
  const lines: string[] = [];
  for (const element of elements) {
    lines.push(`${d2Id(element.id)}: "${escapeD2(`${element.name}\\n${element.level}`)}"`);
  }
  for (const relationship of relationships) {
    if (!elementIds.has(relationship.source_id) || !elementIds.has(relationship.target_id)) continue;
    lines.push(`${d2Id(relationship.source_id)} -> ${d2Id(relationship.target_id)}: "${escapeD2(relationship.description)}"`);
  }
  return lines.join('\n');
}

export function exportWorkspaceToDrawioXml(workspace: ArchitectureWorkspaceData, viewId?: string): string {
  const view = viewId ? workspace.views.find((item) => item.id === viewId) : workspace.views[0];
  const elementIds = new Set(view?.element_ids ?? workspace.elements.map((element) => element.id));
  const relationshipIds = new Set(view?.relationship_ids ?? workspace.relationships.map((relationship) => relationship.id));
  const elements = workspace.elements.filter((element) => elementIds.has(element.id));
  const relationships = workspace.relationships.filter((relationship) => relationshipIds.has(relationship.id));
  const cellIds = new Map(elements.map((element, index) => [element.id, `node-${index + 1}`]));
  const lines = [
    '<mxfile host="cotx">',
    `  <diagram name="${xml(view?.name ?? 'Architecture')}">`,
    '    <mxGraphModel>',
    '      <root>',
    '        <mxCell id="0"/>',
    '        <mxCell id="1" parent="0"/>',
  ];
  for (const [index, element] of elements.entries()) {
    const x = 80 + (index % 4) * 220;
    const y = 80 + Math.floor(index / 4) * 140;
    lines.push(
      `        <mxCell id="${xml(cellIds.get(element.id)!)}" value="${xml(`${element.name}\\n${element.level}`)}" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1">`,
      `          <mxGeometry x="${x}" y="${y}" width="160" height="80" as="geometry"/>`,
      '        </mxCell>',
    );
  }
  for (const [index, relationship] of relationships.entries()) {
    const source = cellIds.get(relationship.source_id);
    const target = cellIds.get(relationship.target_id);
    if (!source || !target) continue;
    lines.push(
      `        <mxCell id="edge-${index + 1}" value="${xml(relationship.description)}" style="endArrow=block;html=1;rounded=0;" edge="1" parent="1" source="${xml(source)}" target="${xml(target)}">`,
      '          <mxGeometry relative="1" as="geometry"/>',
      '        </mxCell>',
    );
  }
  lines.push(
    '      </root>',
    '    </mxGraphModel>',
    '  </diagram>',
    '</mxfile>',
  );
  return lines.join('\n');
}

function relationshipToStructurizr(relationship: ArchitectureWorkspaceRelationship): StructurizrJsonWorkspace['workspace']['model']['relationships'][number] {
  return {
    id: relationship.id,
    sourceId: relationship.source_id,
    destinationId: relationship.target_id,
    description: relationship.description,
    technology: relationship.technology,
    tags: tags(relationship),
  };
}

function viewToStructurizr(
  view: ArchitectureWorkspaceView,
  elementsById: Map<string, ArchitectureWorkspaceElement>,
): { key: string; softwareSystemId?: string; containerId?: string; title: string; description?: string } {
  const firstSystem = view.element_ids.map((id) => elementsById.get(id)).find((element) => element?.level === 'software_system');
  const firstContainer = view.element_ids.map((id) => elementsById.get(id)).find((element) => element?.level === 'container');
  return {
    key: view.id,
    title: view.name,
    description: view.description,
    ...(firstSystem ? { softwareSystemId: firstSystem.id } : {}),
    ...(firstContainer ? { containerId: firstContainer.id } : {}),
  };
}

function tags(item: { tags?: string[]; level?: string }): string | undefined {
  const values = [...new Set([item.level, ...(item.tags ?? [])].filter(Boolean))];
  return values.length > 0 ? values.join(',') : undefined;
}

function mermaidId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]/g, '_');
}

function escapeMermaidLabel(value: string): string {
  return value.replace(/"/g, '\\"');
}

function dslIdentifier(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]/g, '_');
}

function escapeDsl(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function d2Id(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]/g, '_');
}

function escapeD2(value: string): string {
  return value.replace(/"/g, '\\"');
}

function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
