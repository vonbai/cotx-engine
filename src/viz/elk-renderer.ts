// src/viz/elk-renderer.ts
import ELKConstructor from 'elkjs/lib/elk.bundled.js';
import type { ElkNode, ElkExtendedEdge, ElkEdgeSection } from 'elkjs/lib/elk-api.js';
import type { PerspectiveData } from '../store/schema.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const elk = new (ELKConstructor as any)();

// ── Risk color scale ──────────────────────────────────────────────────────

function riskColor(score: number): string {
  if (score <= 20) return '#16c79a'; // green
  if (score <= 50) return '#f5a623'; // yellow
  return '#e94560'; // red
}

function riskBorderColor(score: number): string {
  if (score <= 20) return '#0d8e6e';
  if (score <= 50) return '#c78500';
  return '#b8263d';
}

// ── ELK Layout ────────────────────────────────────────────────────────────

function buildElkGraph(perspective: PerspectiveData): ElkNode {
  const children: ElkNode[] = perspective.components.map((comp) => {
    const node: ElkNode = {
      id: comp.id,
      labels: [{ text: comp.label }],
      width: Math.max(120, comp.label.length * 9 + 40),
      height: 60,
    };

    if (comp.kind === 'group' && comp.children && comp.children.length > 0) {
      node.layoutOptions = { 'elk.padding': '[top=30,left=10,bottom=10,right=10]' };
      node.height = 100;
      node.width = Math.max(200, node.width ?? 120);
    }

    return node;
  });

  const edges: ElkExtendedEdge[] = perspective.edges.map((edge, i) => ({
    id: `e${i}`,
    sources: [edge.from],
    targets: [edge.to],
    labels: edge.label ? [{ text: edge.label }] : undefined,
  }));

  return {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'org.eclipse.elk.layered',
      'elk.direction': 'DOWN',
      'elk.spacing.nodeNode': '40',
      'elk.spacing.edgeNode': '20',
      'elk.layered.spacing.nodeNodeBetweenLayers': '60',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.edgeLabels.placement': 'CENTER',
    },
    children,
    edges,
  };
}

// ── SVG Generation ────────────────────────────────────────────────────────

function escSvg(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function generateSvg(layout: ElkNode, perspective: PerspectiveData): string {
  const width = (layout.width ?? 800) + 40;
  const height = (layout.height ?? 600) + 40;
  const componentMap = new Map(perspective.components.map((c) => [c.id, c]));

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`,
  );
  parts.push('<defs>');
  parts.push(
    '<marker id="arrowhead" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto">' +
      '<polygon points="0 0, 10 3.5, 0 7" fill="#8b949e"/>' +
      '</marker>',
  );
  parts.push('</defs>');
  parts.push(`<rect width="${width}" height="${height}" fill="#0d1117"/>`);
  parts.push('<g transform="translate(20,20)">');

  // Render nodes
  for (const node of layout.children ?? []) {
    const comp = componentMap.get(node.id);
    const risk = comp?.stats.risk_score ?? 0;
    const fill = riskColor(risk);
    const border = riskBorderColor(risk);
    const isGroup = comp?.kind === 'group';
    const rx = isGroup ? 4 : 8;
    const x = node.x ?? 0;
    const y = node.y ?? 0;
    const w = node.width ?? 120;
    const h = node.height ?? 60;

    parts.push(`<g class="node" data-id="${escSvg(node.id)}">`);
    parts.push(
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}22" stroke="${border}" stroke-width="2"/>`,
    );

    // Primary label
    const labelX = x + w / 2;
    const labelY = y + (isGroup ? 18 : h / 2 + 4);
    parts.push(
      `<text x="${labelX}" y="${labelY}" text-anchor="middle" fill="#e0e0e0" font-size="13" font-family="Inter,system-ui,sans-serif" font-weight="600">${escSvg(comp?.label ?? node.id)}</text>`,
    );

    // Stats line
    if (comp) {
      const statsText = `${comp.stats.file_count}f ${comp.stats.function_count}fn`;
      parts.push(
        `<text x="${labelX}" y="${labelY + 16}" text-anchor="middle" fill="#8b949e" font-size="10" font-family="Inter,system-ui,sans-serif">${statsText}</text>`,
      );
    }

    parts.push('</g>');
  }

  // Render edges
  for (const edge of (layout.edges as ElkExtendedEdge[] | undefined) ?? []) {
    const fromId = edge.sources?.[0] ?? '';
    const toId = edge.targets?.[0] ?? '';
    parts.push(`<g class="edge" data-from="${escSvg(fromId)}" data-to="${escSvg(toId)}">`);
    for (const section of (edge.sections as ElkEdgeSection[] | undefined) ?? []) {
      const points: string[] = [];
      points.push(`${section.startPoint.x},${section.startPoint.y}`);
      for (const bp of section.bendPoints ?? []) {
        points.push(`${bp.x},${bp.y}`);
      }
      points.push(`${section.endPoint.x},${section.endPoint.y}`);
      parts.push(
        `<polyline points="${points.join(' ')}" fill="none" stroke="#8b949e" stroke-width="1.5" marker-end="url(#arrowhead)"/>`,
      );
    }

    // Edge labels
    for (const label of edge.labels ?? []) {
      if (label.text && label.x !== undefined && label.y !== undefined) {
        const lw = (label.text.length * 6 + 8);
        const lh = 14;
        parts.push(
          `<rect x="${label.x - 4}" y="${label.y - 10}" width="${lw}" height="${lh}" rx="2" fill="#0d1117" fill-opacity="0.85"/>`,
        );
        parts.push(
          `<text x="${label.x}" y="${label.y}" fill="#8b949e" font-size="10" font-family="Inter,system-ui,sans-serif">${escSvg(label.text)}</text>`,
        );
      }
    }
    parts.push('</g>');
  }

  parts.push('</g>');
  parts.push('</svg>');
  return parts.join('\n');
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Render a PerspectiveData graph to an SVG string using ELK layout.
 * Returns a self-contained SVG suitable for embedding in HTML.
 */
export async function renderElkSvg(perspective: PerspectiveData): Promise<string> {
  if (perspective.components.length === 0) {
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" width="200" height="100">' +
      '<rect width="200" height="100" fill="#0d1117"/>' +
      '<text x="100" y="55" text-anchor="middle" fill="#8b949e" font-size="13" font-family="Inter,system-ui,sans-serif">No components</text>' +
      '</svg>'
    );
  }

  const elkGraph = buildElkGraph(perspective);
  const layout = await elk.layout(elkGraph);
  return generateSvg(layout, perspective);
}

/**
 * Lower-level: compute ELK layout positions without rendering to SVG.
 * Useful for testing and for callers that want to post-process the layout.
 */
export async function computeElkLayout(perspective: PerspectiveData): Promise<ElkNode> {
  const elkGraph = buildElkGraph(perspective);
  return elk.layout(elkGraph);
}
