import type {
  ArchitectureElement,
  ArchitectureEvidenceAnchor,
  ArchitectureWorkspaceData,
  ArchitectureWorkspaceElement,
  ArchitectureWorkspaceLevel,
  ArchitectureWorkspaceRelationship,
  ArchitectureRecursionPlan,
} from '../store/schema.js';
import type { WorkspaceLayoutScan } from './workspace-scan.js';
import type { ArchitectureCompileResult } from './architecture-compiler.js';
import { toKebabCase } from '../lib/naming.js';

export function buildArchitectureWorkspace(
  projectName: string,
  architecture: ArchitectureCompileResult,
  options: {
    workspaceLayout?: WorkspaceLayoutScan | null;
    generatedAt?: string;
    sourceGraphCompiledAt?: string;
  } = {},
): ArchitectureWorkspaceData {
  const systemId = `system:${toKebabCase(projectName)}`;
  const overall = architecture.perspectives.find((perspective) => perspective.id === 'overall-architecture') ?? architecture.perspectives[0];
  const elements = new Map<string, ArchitectureWorkspaceElement>();
  const relationships = new Map<string, ArchitectureWorkspaceRelationship>();

  elements.set(systemId, {
    id: systemId,
    name: projectName,
    level: 'software_system',
    description: architecture.descriptionsByPath.get('overall-architecture'),
    source_paths: ['.'],
    evidence: systemEvidence(options.workspaceLayout),
    metadata: {},
    review_status: 'draft',
  });

  const topLevelIds = new Set((overall?.components ?? []).map((component) => component.id));
  for (const component of overall?.components ?? []) {
    const id = containerId(component.id);
    elements.set(id, {
      id,
      name: component.label,
      level: 'container',
      parent_id: systemId,
      description: architecture.descriptionsByPath.get(`overall-architecture/${component.id}`),
      source_paths: sourcePathsForElement(component),
      metadata: metadataForElement(component),
      evidence: evidenceForElement(component),
      review_status: 'draft',
    });
  }

  for (const doc of architecture.elementDocs) {
    if (doc.perspectiveId !== 'overall-architecture') continue;
    if (!doc.elementPath.includes('/') && topLevelIds.has(doc.elementPath)) continue;
    const id = workspaceElementId(doc.elementPath, doc.data);
    elements.set(id, {
      id,
      name: doc.data.label,
      level: workspaceLevelForElement(doc.data),
      parent_id: parentWorkspaceElementId(doc.elementPath),
      description: architecture.descriptionsByPath.get(`overall-architecture/${doc.elementPath}`),
      source_paths: sourcePathsForElement(doc.data),
      metadata: metadataForElement(doc.data),
      evidence: evidenceForElement(doc.data),
      review_status: 'draft',
    });
  }

  for (const edge of overall?.edges ?? []) {
    const id = `rel:${edge.from}->${edge.to}`;
    relationships.set(id, {
      id,
      source_id: containerId(edge.from),
      target_id: containerId(edge.to),
      description: edge.label || edge.type,
      tags: [edge.type],
      evidence: [{ kind: 'module', id: `${edge.from}->${edge.to}`, detail: `weight:${edge.weight}` }],
      review_status: 'draft',
    });
  }

  return {
    schema_version: 'cotx.architecture.workspace.v1',
    generated_at: options.generatedAt ?? new Date().toISOString(),
    source_graph_compiled_at: options.sourceGraphCompiledAt,
    elements: [...elements.values()].sort((a, b) => a.id.localeCompare(b.id)),
    relationships: [...relationships.values()].sort((a, b) => a.id.localeCompare(b.id)),
    views: overall
      ? [{
          id: 'view:overall-architecture',
          name: overall.label,
          type: 'container',
          element_ids: [...elements.keys()].sort(),
          relationship_ids: [...relationships.keys()].sort(),
          description: architecture.descriptionsByPath.get('overall-architecture'),
          review_status: 'draft',
        }]
      : [],
  };
}

export function planArchitectureRecursion(
  workspace: ArchitectureWorkspaceData,
  options: { generatedAt?: string } = {},
): ArchitectureRecursionPlan {
  const childrenByParent = new Map<string, ArchitectureWorkspaceElement[]>();
  for (const element of workspace.elements) {
    if (!element.parent_id) continue;
    const existing = childrenByParent.get(element.parent_id) ?? [];
    existing.push(element);
    childrenByParent.set(element.parent_id, existing);
  }

  return {
    schema_version: 'cotx.architecture.recursion_plan.v1',
    generated_at: options.generatedAt ?? new Date().toISOString(),
    source_workspace_generated_at: workspace.generated_at,
    decisions: workspace.elements.map((element) => {
      const children = (childrenByParent.get(element.id) ?? []).sort((a, b) => a.id.localeCompare(b.id));
      if (element.level === 'code_element') {
        return {
          element_id: element.id,
          action: 'leaf' as const,
          reason: 'Code elements are terminal architecture anchors.',
          child_element_ids: [],
          evidence: element.evidence,
        };
      }
      if (children.length >= 2) {
        return {
          element_id: element.id,
          action: 'recurse' as const,
          reason: `Element has ${children.length} child architecture elements.`,
          child_element_ids: children.map((child) => child.id),
          evidence: element.evidence,
        };
      }
      if ((element.source_paths?.length ?? 0) <= 1 && children.length === 0) {
        return {
          element_id: element.id,
          action: 'leaf' as const,
          reason: 'Element has no child architecture elements and one or fewer source paths.',
          child_element_ids: [],
          evidence: element.evidence,
        };
      }
      return {
        element_id: element.id,
        action: children.length === 1 ? 'recurse' as const : 'leaf' as const,
        reason: children.length === 1
          ? 'Element has one child architecture element worth preserving for navigation.'
          : 'Element has no child architecture elements.',
        child_element_ids: children.map((child) => child.id),
        evidence: element.evidence,
      };
    }).sort((a, b) => a.element_id.localeCompare(b.element_id)),
  };
}

function systemEvidence(workspaceLayout: WorkspaceLayoutScan | null | undefined): ArchitectureEvidenceAnchor[] {
  const readme = workspaceLayout?.candidates.find((candidate) => candidate.kind === 'readme');
  return readme
    ? [{ kind: 'file', id: readme.path, filePath: readme.path, detail: 'workspace-readme' }]
    : [{ kind: 'file', id: '.', filePath: '.', detail: 'workspace-root' }];
}

function workspaceElementId(elementPath: string, element: ArchitectureElement): string {
  return `${workspaceLevelForElement(element)}:${compactRepeatedSegments(elementPath)}`;
}

function workspaceLevelForElement(element: ArchitectureElement): ArchitectureWorkspaceLevel {
  return element.kind === 'leaf' && (element.files?.length ?? 0) <= 1 ? 'code_element' : 'component';
}

function parentWorkspaceElementId(elementPath: string): string {
  const compact = compactRepeatedSegments(elementPath);
  const parts = compact.split('/');
  if (parts.length <= 1) return containerId(parts[0]);
  const parent = parts.slice(0, -1).join('/');
  return parts.length === 2 ? containerId(parent) : `component:${parent}`;
}

function containerId(componentId: string): string {
  return `container:${componentId}`;
}

function sourcePathsForElement(element: ArchitectureElement): string[] {
  return [...new Set([element.directory, ...(element.files ?? [])].filter(Boolean))].sort();
}

function metadataForElement(element: ArchitectureElement): ArchitectureWorkspaceElement['metadata'] {
  return {
    stats: element.stats,
    ...(element.exported_functions?.length ? { exported_functions: element.exported_functions.slice(0, 40) } : {}),
    ...(element.contracts_provided?.length ? { contracts_provided: element.contracts_provided.slice(0, 40) } : {}),
    ...(element.contracts_consumed?.length ? { contracts_consumed: element.contracts_consumed.slice(0, 40) } : {}),
    ...(element.related_flows?.length ? { related_flows: element.related_flows.slice(0, 40) } : {}),
  };
}

function evidenceForElement(element: ArchitectureElement): ArchitectureEvidenceAnchor[] {
  const details = [
    element.kind,
    element.exported_functions?.length ? `exports:${element.exported_functions.slice(0, 12).join(',')}` : '',
    element.contracts_provided?.length ? `provides:${element.contracts_provided.slice(0, 8).join(',')}` : '',
    element.contracts_consumed?.length ? `consumes:${element.contracts_consumed.slice(0, 8).join(',')}` : '',
  ].filter(Boolean).join(' ');
  const evidence: ArchitectureEvidenceAnchor[] = [{ kind: 'module', id: element.id, detail: details }];
  for (const filePath of element.files?.slice(0, 8) ?? []) {
    evidence.push({ kind: 'file', id: filePath, filePath });
  }
  return evidence;
}

function compactRepeatedSegments(value: string): string {
  const result: string[] = [];
  for (const part of value.split('/')) {
    if (result[result.length - 1] !== part) result.push(part);
  }
  return result.join('/');
}
