import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import type {
  CotxDataAdapter,
  ExplorerPerspective,
  ImpactData,
  PerspectiveSummary,
  WorkbenchIntents,
  WorkbenchState,
} from 'cotx-sdk-core';
import { createHttpCotxAdapter, fromUrlState, toUrlState } from 'cotx-sdk-core';
import {
  CotxProvider,
  FilterBar,
  ArchitectureTree,
  ArchitectureCanvas,
  ArchitectureInspector,
  LayerOverview,
  SavedViewsPanel,
  useCotxWorkbench,
} from 'cotx-sdk-react';

interface WorkbenchRouteProps {
  adapter?: CotxDataAdapter;
}

function WorkbenchContent({
  adapter,
  project,
  perspective,
}: {
  adapter: CotxDataAdapter;
  project: string;
  perspective: string;
}) {
  const { state, actions } = useCotxWorkbench();
  const navigate = useNavigate();
  const location = useLocation();
  const [perspectiveData, setPerspectiveData] = useState<ExplorerPerspective | null>(null);
  const [perspectives, setPerspectives] = useState<PerspectiveSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [urlReady, setUrlReady] = useState(false);
  const [savedViewsReady, setSavedViewsReady] = useState(false);
  const [impactData, setImpactData] = useState<ImpactData | null>(null);
  const [impactLoading, setImpactLoading] = useState(false);
  const [impactError, setImpactError] = useState<string | null>(null);
  const [viewportCommand, setViewportCommand] = useState<{
    kind: 'fit' | 'reset';
    token: number;
  } | null>(null);
  const saveCounterRef = useRef(0);
  const savedViewsKey = useMemo(
    () => `cotx-workbench:saved-views:${project}`,
    [project],
  );

  useEffect(() => {
    let cancelled = false;
    void adapter.listPerspectives(project)
      .then((result) => {
        if (!cancelled) setPerspectives(result);
      })
      .catch(() => {
        if (!cancelled) setPerspectives([]);
      });

    return () => {
      cancelled = true;
    };
  }, [adapter, project]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setImpactData(null);
    setImpactLoading(false);
    setImpactError(null);
    actions.setPerspective(perspective);
    actions.setFocusedNode(null);
    actions.setInspectorVisible(false);

    void adapter.getPerspective(project, perspective)
      .then((data) => {
        if (cancelled) return;
        setPerspectiveData(data);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [adapter, project, perspective, actions]);

  useEffect(() => {
    setImpactData(null);
    setImpactLoading(false);
    setImpactError(null);
  }, [state.focusedNodePath]);

  useEffect(() => {
    const stored = window.localStorage.getItem(savedViewsKey);
    if (!stored) {
      actions.setSavedViews([]);
      saveCounterRef.current = 0;
      setSavedViewsReady(true);
      return;
    }

    try {
      const parsed = JSON.parse(stored) as WorkbenchState['savedViews'];
      const views = Array.isArray(parsed) ? parsed : [];
      actions.setSavedViews(views);
      saveCounterRef.current = views.length;
    } catch {
      actions.setSavedViews([]);
      saveCounterRef.current = 0;
    }
    setSavedViewsReady(true);
  }, [actions, savedViewsKey]);

  useEffect(() => {
    const partial = fromUrlState(location.search.slice(1));
    actions.hydrateState(partial);
    setUrlReady(true);
  }, [actions, location.search]);

  useEffect(() => {
    if (!urlReady) return;
    const nextQuery = toUrlState(state);
    const currentQuery = location.search.startsWith('?')
      ? location.search.slice(1)
      : location.search;
    if (nextQuery === currentQuery) return;

    navigate(
      `${location.pathname}${nextQuery ? `?${nextQuery}` : ''}`,
      { replace: true },
    );
  }, [location.pathname, location.search, navigate, state, urlReady]);

  useEffect(() => {
    if (!savedViewsReady) return;
    window.localStorage.setItem(savedViewsKey, JSON.stringify(state.savedViews));
  }, [savedViewsKey, savedViewsReady, state.savedViews]);

  const visibleNodes = useMemo(() => {
    if (!perspectiveData) return [];
    const q = state.filters.query.trim().toLowerCase();
    if (!q) return perspectiveData.nodes;
    return perspectiveData.nodes.filter((node) =>
      [node.label, node.path, node.directory].join(' ').toLowerCase().includes(q),
    );
  }, [perspectiveData, state.filters.query]);

  const visibleNodePaths = useMemo(
    () => new Set(visibleNodes.map((node) => node.path)),
    [visibleNodes],
  );

  const visibleEdges = useMemo(() => {
    if (!perspectiveData) return [];
    return perspectiveData.edges.filter((edge) =>
      visibleNodePaths.has(edge.from) && visibleNodePaths.has(edge.to),
    );
  }, [perspectiveData, visibleNodePaths]);

  const focusedNode = useMemo(
    () => visibleNodes.find((node) => node.path === state.focusedNodePath)
      ?? perspectiveData?.nodes.find((node) => node.path === state.focusedNodePath)
      ?? null,
    [visibleNodes, perspectiveData, state.focusedNodePath],
  );

  const handleSelectSavedView = useCallback((view: WorkbenchState['savedViews'][number]) => {
    const restored = fromUrlState(view.state);
    const nextPerspective = restored.perspectiveId ?? perspective;
    navigate(
      `/workbench/${encodeURIComponent(project)}/${encodeURIComponent(nextPerspective)}${view.state ? `?${view.state}` : ''}`,
    );
  }, [navigate, perspective, project]);

  const handleSaveView = useCallback(() => {
    saveCounterRef.current += 1;
    const label = `View ${saveCounterRef.current}`;
    const stateQuery = toUrlState(state);
    actions.setSavedViews([
      ...state.savedViews,
      {
        id: `view-${Date.now()}-${saveCounterRef.current}`,
        label,
        state: stateQuery,
      },
    ]);
  }, [actions, state]);

  const workbenchIntents = useMemo<WorkbenchIntents>(() => ({
    onRefactorIntent: async (intent) => {
      if (intent.action !== 'impact') return;

      actions.setInspectorVisible(true);
      actions.setInspectorTab('summary');

      if (!adapter.getImpact) {
        setImpactData(null);
        setImpactLoading(false);
        setImpactError('This workbench server does not publish grounded change impact yet.');
        return;
      }

      setImpactLoading(true);
      setImpactError(null);
      try {
        const result = await adapter.getImpact(project, perspective, intent.nodePath);
        setImpactData(result);
      } catch (err) {
        setImpactData(null);
        setImpactError(err instanceof Error ? err.message : String(err));
      } finally {
        setImpactLoading(false);
      }
    },
  }), [actions, adapter, perspective, project]);

  if (loading) {
    return <div data-testid="workbench-loading">Loading workbench...</div>;
  }

  if (error) {
    return (
      <div data-testid="workbench-error">
        Failed to load workbench data: {error}
      </div>
    );
  }

  return (
    <div className="cotx-workbench">
      <header className="cotx-workbench-topbar">
        <div className="cotx-workbench-topbar-primary">
          <button
            type="button"
            className="cotx-workbench-ghost"
            aria-label={state.tree.navVisible ? 'Hide navigation' : 'Show navigation'}
            onClick={() => actions.setNavVisible(!state.tree.navVisible)}
          >
            {state.tree.navVisible ? 'Hide navigation' : 'Show navigation'}
          </button>
          <div className="cotx-workbench-project-block">
            <span className="cotx-workbench-eyebrow">Project</span>
            <div className="cotx-workbench-project">{project}</div>
          </div>
        </div>
        <div className="cotx-workbench-topbar-secondary">
          <div className="cotx-perspective-tabs" role="tablist" aria-label="Perspectives">
            {perspectives.map((item) => (
              <button
                key={item.id}
                role="tab"
                aria-selected={item.id === perspective}
                onClick={() => navigate(`/workbench/${encodeURIComponent(project)}/${encodeURIComponent(item.id)}`)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="cotx-workbench-controls">
            <label className="cotx-filter-field">
              <span className="cotx-filter-label">Neighborhood</span>
              <select
                aria-label="Neighborhood depth"
                value={String(state.graphSelection.neighborhoodDepth)}
                onChange={(event) =>
                  actions.setNeighborhoodDepth(Number(event.target.value) as 0 | 1 | 2)
                }
              >
                <option value="0">0</option>
                <option value="1">1</option>
                <option value="2">2</option>
              </select>
            </label>
            <button
              type="button"
              className="cotx-workbench-ghost"
              aria-label="Fit view"
              onClick={() => setViewportCommand({ kind: 'fit', token: Date.now() })}
            >
              Fit view
            </button>
            <button
              type="button"
              className="cotx-workbench-ghost"
              aria-label="Reset view"
              onClick={() => setViewportCommand({ kind: 'reset', token: Date.now() })}
            >
              Reset view
            </button>
            <button
              type="button"
              className="cotx-workbench-primary"
              aria-label="Save view"
              onClick={handleSaveView}
            >
              Save view
            </button>
          </div>
        </div>
        <LayerOverview
          perspectives={perspectives}
          activePerspectiveId={perspective}
          activePerspective={perspectiveData}
          onSelectPerspective={(nextPerspective) =>
            navigate(`/workbench/${encodeURIComponent(project)}/${encodeURIComponent(nextPerspective)}`)
          }
        />
        <FilterBar className="cotx-workbench-filterbar" />
      </header>
      <main className="cotx-workbench-content">
        <section className="cotx-workbench-sidepane" data-testid="workbench-tree-shell" data-nav-visible={state.tree.navVisible ? 'true' : 'false'}>
          <ArchitectureTree nodes={visibleNodes} searchQuery={state.filters.query} />
          <SavedViewsPanel views={state.savedViews} onSelectView={handleSelectSavedView} />
        </section>
        <section className="cotx-workbench-canvas-shell">
          <ArchitectureCanvas
            nodes={visibleNodes}
            edges={visibleEdges}
            focusedNodePath={state.focusedNodePath}
            neighborhoodDepth={state.graphSelection.neighborhoodDepth}
            viewportCommand={viewportCommand}
          />
        </section>
        <section className="cotx-workbench-inspector-shell">
          <ArchitectureInspector
            node={focusedNode}
            intents={workbenchIntents}
            impact={focusedNode?.path === impactData?.root ? impactData : null}
            impactLoading={impactLoading}
            impactError={impactError}
          />
        </section>
      </main>
    </div>
  );
}

export function WorkbenchRoute({ adapter: providedAdapter }: WorkbenchRouteProps = {}) {
  const { project = 'default', perspective = 'overall-architecture' } = useParams<{
    project: string;
    perspective: string;
  }>();
  const location = useLocation();

  const adapter = useMemo(
    () => providedAdapter ?? createHttpCotxAdapter(window.location.origin),
    [providedAdapter],
  );

  const initialState = useMemo(
    () => fromUrlState(location.search.slice(1)),
    [location.search],
  );

  return (
    <CotxProvider
      key={`${project}:${perspective}`}
      adapter={adapter}
      projectId={project}
      perspectiveId={perspective}
      initialState={initialState}
    >
      <WorkbenchContent adapter={adapter} project={project} perspective={perspective} />
    </CotxProvider>
  );
}
