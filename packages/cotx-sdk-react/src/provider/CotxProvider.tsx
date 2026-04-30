import {
  createContext,
  useCallback,
  useMemo,
  useReducer,
  type ReactNode,
} from 'react';
import type {
  CotxDataAdapter,
  WorkbenchIntents,
  WorkbenchState,
} from 'cotx-sdk-core';

/* ------------------------------------------------------------------ */
/*  Default state factory                                              */
/* ------------------------------------------------------------------ */

function defaultState(
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
      visible: false,
      tab: 'summary',
    },
    viewport: {
      zoom: 1,
      panX: 0,
      panY: 0,
      pinnedNodes: {},
    },
    savedViews: [],
    compare: null,
  };
}

function mergeState(
  base: WorkbenchState,
  partial?: Partial<WorkbenchState>,
): WorkbenchState {
  if (!partial) return base;

  return {
    ...base,
    ...partial,
    graphSelection: partial.graphSelection
      ? {
          ...base.graphSelection,
          ...partial.graphSelection,
        }
      : base.graphSelection,
    filters: partial.filters
      ? {
          ...base.filters,
          ...partial.filters,
        }
      : base.filters,
    tree: partial.tree
      ? {
          ...base.tree,
          ...partial.tree,
        }
      : base.tree,
    inspector: partial.inspector
      ? {
          ...base.inspector,
          ...partial.inspector,
        }
      : base.inspector,
    viewport: partial.viewport
      ? {
          ...base.viewport,
          ...partial.viewport,
          pinnedNodes: partial.viewport.pinnedNodes
            ? {
                ...base.viewport.pinnedNodes,
                ...partial.viewport.pinnedNodes,
              }
            : base.viewport.pinnedNodes,
        }
      : base.viewport,
    savedViews: partial.savedViews ?? base.savedViews,
    compare: partial.compare ?? base.compare ?? null,
  };
}

/* ------------------------------------------------------------------ */
/*  Reducer actions                                                    */
/* ------------------------------------------------------------------ */

type Action =
  | { type: 'SET_FOCUSED_NODE'; path: string | null }
  | { type: 'SET_PERSPECTIVE'; id: string }
  | { type: 'SET_FILTER'; partial: Partial<WorkbenchState['filters']> }
  | { type: 'TOGGLE_TREE_PATH'; path: string }
  | { type: 'SET_INSPECTOR_TAB'; tab: WorkbenchState['inspector']['tab'] }
  | { type: 'SET_INSPECTOR_VISIBLE'; visible: boolean }
  | { type: 'SET_NAV_VISIBLE'; visible: boolean }
  | { type: 'SET_NEIGHBORHOOD_DEPTH'; depth: 0 | 1 | 2 }
  | { type: 'HYDRATE_STATE'; partial: Partial<WorkbenchState> }
  | { type: 'SET_SAVED_VIEWS'; views: WorkbenchState['savedViews'] };

function reducer(state: WorkbenchState, action: Action): WorkbenchState {
  switch (action.type) {
    case 'SET_FOCUSED_NODE':
      return {
        ...state,
        focusedNodePath: action.path,
        graphSelection: {
          ...state.graphSelection,
          anchorNodePath: action.path,
        },
      };
    case 'SET_PERSPECTIVE':
      return { ...state, perspectiveId: action.id };
    case 'SET_FILTER':
      return {
        ...state,
        filters: { ...state.filters, ...action.partial },
      };
    case 'TOGGLE_TREE_PATH': {
      const collapsed = state.tree.collapsedPaths;
      const next = collapsed.includes(action.path)
        ? collapsed.filter((p) => p !== action.path)
        : [...collapsed, action.path];
      return { ...state, tree: { ...state.tree, collapsedPaths: next } };
    }
    case 'SET_INSPECTOR_TAB':
      return {
        ...state,
        inspector: { ...state.inspector, tab: action.tab },
      };
    case 'SET_INSPECTOR_VISIBLE':
      return {
        ...state,
        inspector: { ...state.inspector, visible: action.visible },
      };
    case 'SET_NAV_VISIBLE':
      return {
        ...state,
        tree: { ...state.tree, navVisible: action.visible },
      };
    case 'SET_NEIGHBORHOOD_DEPTH':
      return {
        ...state,
        graphSelection: {
          ...state.graphSelection,
          neighborhoodDepth: action.depth,
        },
      };
    case 'HYDRATE_STATE':
      return mergeState(state, action.partial);
    case 'SET_SAVED_VIEWS':
      return {
        ...state,
        savedViews: action.views,
      };
  }
}

/* ------------------------------------------------------------------ */
/*  Context value shape                                                */
/* ------------------------------------------------------------------ */

export interface CotxWorkbenchActions {
  setFocusedNode(path: string | null): void;
  setPerspective(id: string): void;
  setFilter(partial: Partial<WorkbenchState['filters']>): void;
  toggleTreePath(path: string): void;
  setInspectorTab(tab: WorkbenchState['inspector']['tab']): void;
  setInspectorVisible(visible: boolean): void;
  setNavVisible(visible: boolean): void;
  setNeighborhoodDepth(depth: 0 | 1 | 2): void;
  hydrateState(partial: Partial<WorkbenchState>): void;
  setSavedViews(views: WorkbenchState['savedViews']): void;
}

export interface CotxContextValue {
  state: WorkbenchState;
  actions: CotxWorkbenchActions;
  adapter: CotxDataAdapter;
  intents: WorkbenchIntents;
}

export const CotxContext = createContext<CotxContextValue | null>(null);

/* ------------------------------------------------------------------ */
/*  Provider component                                                 */
/* ------------------------------------------------------------------ */

export interface CotxProviderProps {
  adapter: CotxDataAdapter;
  projectId: string;
  perspectiveId?: string;
  initialState?: Partial<WorkbenchState>;
  intents?: WorkbenchIntents;
  children: ReactNode;
}

export function CotxProvider({
  adapter,
  projectId,
  perspectiveId,
  initialState,
  intents,
  children,
}: CotxProviderProps) {
  const merged = mergeState(defaultState(projectId, perspectiveId), initialState);

  const [state, dispatch] = useReducer(reducer, merged);

  const setFocusedNode = useCallback(
    (path: string | null) => dispatch({ type: 'SET_FOCUSED_NODE', path }),
    [],
  );
  const setPerspective = useCallback(
    (id: string) => dispatch({ type: 'SET_PERSPECTIVE', id }),
    [],
  );
  const setFilter = useCallback(
    (partial: Partial<WorkbenchState['filters']>) =>
      dispatch({ type: 'SET_FILTER', partial }),
    [],
  );
  const toggleTreePath = useCallback(
    (path: string) => dispatch({ type: 'TOGGLE_TREE_PATH', path }),
    [],
  );
  const setInspectorTab = useCallback(
    (tab: WorkbenchState['inspector']['tab']) =>
      dispatch({ type: 'SET_INSPECTOR_TAB', tab }),
    [],
  );
  const setInspectorVisible = useCallback(
    (visible: boolean) => dispatch({ type: 'SET_INSPECTOR_VISIBLE', visible }),
    [],
  );
  const setNavVisible = useCallback(
    (visible: boolean) => dispatch({ type: 'SET_NAV_VISIBLE', visible }),
    [],
  );
  const setNeighborhoodDepth = useCallback(
    (depth: 0 | 1 | 2) => dispatch({ type: 'SET_NEIGHBORHOOD_DEPTH', depth }),
    [],
  );
  const hydrateState = useCallback(
    (partial: Partial<WorkbenchState>) =>
      dispatch({ type: 'HYDRATE_STATE', partial }),
    [],
  );
  const setSavedViews = useCallback(
    (views: WorkbenchState['savedViews']) =>
      dispatch({ type: 'SET_SAVED_VIEWS', views }),
    [],
  );

  const actions: CotxWorkbenchActions = useMemo(
    () => ({
      setFocusedNode,
      setPerspective,
      setFilter,
      toggleTreePath,
      setInspectorTab,
      setInspectorVisible,
      setNavVisible,
      setNeighborhoodDepth,
      hydrateState,
      setSavedViews,
    }),
    [
      setFocusedNode,
      setPerspective,
      setFilter,
      toggleTreePath,
      setInspectorTab,
      setInspectorVisible,
      setNavVisible,
      setNeighborhoodDepth,
      hydrateState,
      setSavedViews,
    ],
  );

  const value: CotxContextValue = useMemo(
    () => ({ state, actions, adapter, intents: intents ?? {} }),
    [state, actions, adapter, intents],
  );

  return <CotxContext.Provider value={value}>{children}</CotxContext.Provider>;
}
