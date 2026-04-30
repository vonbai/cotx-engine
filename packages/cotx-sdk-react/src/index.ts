// cotx-sdk-react — React components and hooks for cotx frontend

// Provider
export { CotxProvider } from './provider/CotxProvider.js';
export { CotxContext } from './provider/CotxProvider.js';
export type {
  CotxProviderProps,
  CotxContextValue,
  CotxWorkbenchActions,
} from './provider/CotxProvider.js';

// Hooks
export { useCotxWorkbench } from './hooks/useCotxWorkbench.js';

// Components
export { ArchitectureTree } from './components/ArchitectureTree.js';
export type { ArchitectureTreeProps } from './components/ArchitectureTree.js';
export { FilterBar } from './components/FilterBar.js';
export type { FilterBarProps } from './components/FilterBar.js';
export { SavedViewsPanel } from './components/SavedViewsPanel.js';
export type { SavedViewsPanelProps } from './components/SavedViewsPanel.js';
export { LayerOverview } from './components/LayerOverview.js';
export type { LayerOverviewProps } from './components/LayerOverview.js';
export { ArchitectureInspector } from './components/ArchitectureInspector.js';
export type {
  ArchitectureInspectorProps,
  InspectorTab,
} from './components/ArchitectureInspector.js';
export { ArchitectureCanvas } from './components/ArchitectureCanvas.js';
export type { ArchitectureCanvasProps } from './components/ArchitectureCanvas.js';

// Canvas data adapter and label policy
export { toG6Spec } from './components/canvas/g6-adapter.js';
export type {
  G6NodeSpec,
  G6EdgeSpec,
  G6ComboSpec,
  G6GraphSpec,
} from './components/canvas/g6-adapter.js';
export {
  getNodeLabel,
  shouldShowEdgeLabel,
} from './components/canvas/label-policy.js';
export type {
  NodeLabelDensity,
  EdgeLabelDensity,
} from './components/canvas/label-policy.js';
