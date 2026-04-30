import type { CotxLayerId } from './explorer.js';

export interface CotxLayerDefinition {
  id: CotxLayerId;
  label: string;
  defaultPerspectiveId: string;
}

export const COTX_LAYER_CATALOG: readonly CotxLayerDefinition[] = [
  { id: 'code-graph', label: 'Code graph', defaultPerspectiveId: 'code-graph' },
  { id: 'modules', label: 'Modules', defaultPerspectiveId: 'modules' },
  { id: 'concepts', label: 'Concepts', defaultPerspectiveId: 'concepts' },
  { id: 'contracts', label: 'Contracts', defaultPerspectiveId: 'contracts' },
  { id: 'flows', label: 'Flows', defaultPerspectiveId: 'flows' },
  { id: 'routes', label: 'Routes', defaultPerspectiveId: 'routes' },
  { id: 'tools', label: 'Tools', defaultPerspectiveId: 'tools' },
  { id: 'processes', label: 'Processes', defaultPerspectiveId: 'processes' },
  { id: 'decision-facts', label: 'Decision facts', defaultPerspectiveId: 'decision-facts' },
  { id: 'architecture', label: 'Architecture', defaultPerspectiveId: 'overall-architecture' },
  { id: 'change-impact', label: 'Change impact', defaultPerspectiveId: 'change-impact' },
] as const;

const PERSPECTIVE_LAYER_ALIASES: Record<string, CotxLayerId> = {
  architecture: 'architecture',
  'overall-architecture': 'architecture',
  'c4-architecture': 'architecture',
  'code-graph': 'code-graph',
  graph: 'code-graph',
  modules: 'modules',
  module: 'modules',
  concepts: 'concepts',
  concept: 'concepts',
  contracts: 'contracts',
  contract: 'contracts',
  flows: 'flows',
  flow: 'flows',
  'data-flow': 'flows',
  routes: 'routes',
  route: 'routes',
  tools: 'tools',
  tool: 'tools',
  processes: 'processes',
  process: 'processes',
  decisions: 'decision-facts',
  decision: 'decision-facts',
  doctrine: 'decision-facts',
  'decision-facts': 'decision-facts',
  'change-impact': 'change-impact',
  impact: 'change-impact',
  'review-change': 'change-impact',
  'plan-change': 'change-impact',
};

export function isCotxLayerId(value: string): value is CotxLayerId {
  return COTX_LAYER_CATALOG.some((layer) => layer.id === value);
}

export function layerForPerspectiveId(perspectiveId: string): CotxLayerId | undefined {
  return PERSPECTIVE_LAYER_ALIASES[perspectiveId];
}

export function labelForLayer(layerId: CotxLayerId): string {
  return COTX_LAYER_CATALOG.find((layer) => layer.id === layerId)?.label ?? layerId;
}
