// Types — explorer domain
export type {
  CotxLayerId,
  EvidenceStatus,
  EvidenceAnchor,
  LayerSummary,
  ExplorerPerspectiveId,
  ExplorerNodePath,
  ExplorerEdgeId,
  PerspectiveStats,
  NodeStats,
  ExplorerPerspective,
  ExplorerNode,
  ExplorerEdge,
} from './types/explorer.js';
export {
  COTX_LAYER_CATALOG,
  isCotxLayerId,
  labelForLayer,
  layerForPerspectiveId,
} from './types/layers.js';
export type { CotxLayerDefinition } from './types/layers.js';

// Types — intents
export type {
  WriteIntent,
  RefactorIntent,
  AgentIntent,
  ToolIntent,
  PersistViewIntent,
  CompareIntent,
  WorkbenchIntents,
} from './types/intents.js';

// Types — adapter
export type {
  ProjectMeta,
  ProjectSummary,
  WorkspaceLayoutSummary,
  PerspectiveSummary,
  ImpactData,
  DiffData,
  SearchResults,
  CotxDataAdapter,
} from './types/adapter.js';

// Types — state
export type {
  SavedViewRef,
  CompareState,
  WorkbenchState,
} from './state/workbench-state.js';

// State — serialization helpers
export {
  createDefaultWorkbenchState,
  serializeWorkbenchState,
  deserializeWorkbenchState,
  toUrlState,
  fromUrlState,
} from './state/serialization.js';

// Adapters
export { createHttpCotxAdapter, CotxHttpError } from './adapters/http.js';
export type { HttpAdapterOptions } from './adapters/http.js';

// Normalization (also re-exported for direct use)
export {
  normalizePerspective,
  normalizeNode,
  normalizeEdge,
  normalizeNodeStats,
} from './adapters/normalize.js';
export type {
  RawArchitectureStats,
  RawArchitectureElement,
  RawArchitectureEdge,
  RawPerspectiveData,
} from './adapters/normalize.js';
