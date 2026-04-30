import type { WorkbenchState } from './workbench-state.js';

/**
 * Creates a valid default WorkbenchState with sensible initial values.
 */
export function createDefaultWorkbenchState(
  projectId: string,
  perspectiveId?: string,
): WorkbenchState {
  return {
    projectId,
    perspectiveId: perspectiveId ?? 'overall-architecture',
    focusedNodePath: null,
    graphSelection: {
      anchorNodePath: null,
      neighborhoodDepth: 1,
    },
    filters: {
      query: '',
      edgeTypes: [],
      riskRange: null,
      showEdgeLabels: 'focus',
      showNodeMeta: 'balanced',
    },
    tree: {
      collapsedPaths: [],
      navVisible: true,
      navWidth: 260,
    },
    inspector: {
      visible: true,
      tab: 'summary',
    },
    viewport: {
      zoom: 1,
      panX: 0,
      panY: 0,
      pinnedNodes: {},
    },
    savedViews: [],
  };
}

/**
 * Serializes a WorkbenchState to a JSON string.
 */
export function serializeWorkbenchState(state: WorkbenchState): string {
  return JSON.stringify(state);
}

/**
 * Deserializes a JSON string into a WorkbenchState, validating required fields.
 * Throws if the input is not valid JSON or is missing required fields.
 */
export function deserializeWorkbenchState(json: string): WorkbenchState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Invalid JSON input');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('WorkbenchState must be a JSON object');
  }

  const obj = parsed as Record<string, unknown>;

  // Validate top-level required fields
  if (typeof obj.projectId !== 'string') {
    throw new Error('Missing or invalid field: projectId');
  }
  if (typeof obj.perspectiveId !== 'string') {
    throw new Error('Missing or invalid field: perspectiveId');
  }
  if (obj.focusedNodePath !== null && typeof obj.focusedNodePath !== 'string') {
    throw new Error('Invalid field: focusedNodePath must be string or null');
  }

  // Validate graphSelection
  const gs = obj.graphSelection;
  if (typeof gs !== 'object' || gs === null || Array.isArray(gs)) {
    throw new Error('Missing or invalid field: graphSelection');
  }
  const gsObj = gs as Record<string, unknown>;
  if (gsObj.anchorNodePath !== null && typeof gsObj.anchorNodePath !== 'string') {
    throw new Error('Invalid field: graphSelection.anchorNodePath');
  }
  if (typeof gsObj.neighborhoodDepth !== 'number' || ![0, 1, 2].includes(gsObj.neighborhoodDepth)) {
    throw new Error('Invalid field: graphSelection.neighborhoodDepth must be 0, 1, or 2');
  }

  // Validate filters
  const f = obj.filters;
  if (typeof f !== 'object' || f === null || Array.isArray(f)) {
    throw new Error('Missing or invalid field: filters');
  }
  const fObj = f as Record<string, unknown>;
  if (typeof fObj.query !== 'string') {
    throw new Error('Invalid field: filters.query');
  }
  if (!Array.isArray(fObj.edgeTypes)) {
    throw new Error('Invalid field: filters.edgeTypes');
  }

  // Validate tree
  const t = obj.tree;
  if (typeof t !== 'object' || t === null || Array.isArray(t)) {
    throw new Error('Missing or invalid field: tree');
  }
  const tObj = t as Record<string, unknown>;
  if (!Array.isArray(tObj.collapsedPaths)) {
    throw new Error('Invalid field: tree.collapsedPaths');
  }
  if (typeof tObj.navVisible !== 'boolean') {
    throw new Error('Invalid field: tree.navVisible');
  }
  if (typeof tObj.navWidth !== 'number') {
    throw new Error('Invalid field: tree.navWidth');
  }

  // Validate inspector
  const i = obj.inspector;
  if (typeof i !== 'object' || i === null || Array.isArray(i)) {
    throw new Error('Missing or invalid field: inspector');
  }
  const iObj = i as Record<string, unknown>;
  if (typeof iObj.visible !== 'boolean') {
    throw new Error('Invalid field: inspector.visible');
  }
  if (typeof iObj.tab !== 'string') {
    throw new Error('Invalid field: inspector.tab');
  }

  // Validate viewport
  const v = obj.viewport;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Error('Missing or invalid field: viewport');
  }
  const vObj = v as Record<string, unknown>;
  if (typeof vObj.zoom !== 'number') {
    throw new Error('Invalid field: viewport.zoom');
  }
  if (typeof vObj.panX !== 'number') {
    throw new Error('Invalid field: viewport.panX');
  }
  if (typeof vObj.panY !== 'number') {
    throw new Error('Invalid field: viewport.panY');
  }
  if (typeof vObj.pinnedNodes !== 'object' || vObj.pinnedNodes === null || Array.isArray(vObj.pinnedNodes)) {
    throw new Error('Invalid field: viewport.pinnedNodes');
  }

  // Validate savedViews
  if (!Array.isArray(obj.savedViews)) {
    throw new Error('Missing or invalid field: savedViews');
  }

  return parsed as WorkbenchState;
}

// --- URL state encoding/decoding ---

// Keys used in URL query params (compact abbreviations)
const URL_KEYS = {
  perspective: 'p',
  focus: 'f',
  query: 'q',
  edgeTypes: 'et',
  riskRange: 'rr',
  showEdgeLabels: 'el',
  showNodeMeta: 'nm',
  inspectorVisible: 'iv',
  inspectorTab: 'it',
  navVisible: 'nv',
  anchorNodePath: 'an',
  neighborhoodDepth: 'nd',
} as const;

/**
 * Encodes key WorkbenchState fields into a compact URL query string.
 * Only includes fields that differ from "empty" defaults to keep URLs short.
 */
export function toUrlState(state: WorkbenchState): string {
  const params = new URLSearchParams();

  params.set(URL_KEYS.perspective, state.perspectiveId);

  if (state.focusedNodePath !== null) {
    params.set(URL_KEYS.focus, state.focusedNodePath);
  }

  if (state.graphSelection.anchorNodePath !== null) {
    params.set(URL_KEYS.anchorNodePath, state.graphSelection.anchorNodePath);
  }
  if (state.graphSelection.neighborhoodDepth !== 1) {
    params.set(URL_KEYS.neighborhoodDepth, String(state.graphSelection.neighborhoodDepth));
  }

  if (state.filters.query) {
    params.set(URL_KEYS.query, state.filters.query);
  }
  if (state.filters.edgeTypes.length > 0) {
    params.set(URL_KEYS.edgeTypes, state.filters.edgeTypes.join(','));
  }
  if (state.filters.riskRange !== null) {
    params.set(URL_KEYS.riskRange, state.filters.riskRange.join(','));
  }
  if (state.filters.showEdgeLabels !== 'focus') {
    params.set(URL_KEYS.showEdgeLabels, state.filters.showEdgeLabels);
  }
  if (state.filters.showNodeMeta !== 'balanced') {
    params.set(URL_KEYS.showNodeMeta, state.filters.showNodeMeta);
  }

  if (!state.inspector.visible) {
    params.set(URL_KEYS.inspectorVisible, '0');
  }
  if (state.inspector.tab !== 'summary') {
    params.set(URL_KEYS.inspectorTab, state.inspector.tab);
  }

  if (!state.tree.navVisible) {
    params.set(URL_KEYS.navVisible, '0');
  }

  return params.toString();
}

/**
 * Decodes a URL query string back into a partial WorkbenchState.
 * Missing params are omitted from the result (not set to defaults).
 * An optional `defaults` partial can be merged as a base.
 */
export function fromUrlState(
  params: string,
  defaults?: Partial<WorkbenchState>,
): Partial<WorkbenchState> {
  const search = new URLSearchParams(params);
  const result: Partial<WorkbenchState> = { ...defaults };

  const perspective = search.get(URL_KEYS.perspective);
  if (perspective !== null) {
    result.perspectiveId = perspective;
  }

  const focus = search.get(URL_KEYS.focus);
  if (focus !== null) {
    result.focusedNodePath = focus;
  }

  // graphSelection
  const anchor = search.get(URL_KEYS.anchorNodePath);
  const depth = search.get(URL_KEYS.neighborhoodDepth);
  if (anchor !== null || depth !== null) {
    result.graphSelection = {
      anchorNodePath: anchor,
      neighborhoodDepth: depth !== null ? (Number(depth) as 0 | 1 | 2) : 1,
    };
  }

  // filters — build only if at least one filter param is present
  const q = search.get(URL_KEYS.query);
  const et = search.get(URL_KEYS.edgeTypes);
  const rr = search.get(URL_KEYS.riskRange);
  const el = search.get(URL_KEYS.showEdgeLabels);
  const nm = search.get(URL_KEYS.showNodeMeta);
  if (q !== null || et !== null || rr !== null || el !== null || nm !== null) {
    result.filters = {
      query: q ?? '',
      edgeTypes: et ? et.split(',') : [],
      riskRange: rr ? (rr.split(',').map(Number) as [number, number]) : null,
      showEdgeLabels: (el ?? 'focus') as 'none' | 'focus' | 'all',
      showNodeMeta: (nm ?? 'balanced') as 'minimal' | 'balanced' | 'dense',
    };
  }

  // inspector
  const iv = search.get(URL_KEYS.inspectorVisible);
  const it = search.get(URL_KEYS.inspectorTab);
  if (iv !== null || it !== null) {
    result.inspector = {
      visible: iv !== '0',
      tab: (it ?? 'summary') as WorkbenchState['inspector']['tab'],
    };
  }

  // tree (nav visibility)
  const nv = search.get(URL_KEYS.navVisible);
  if (nv !== null) {
    result.tree = {
      collapsedPaths: [],
      navVisible: nv !== '0',
      navWidth: 260,
    };
  }

  return result;
}
