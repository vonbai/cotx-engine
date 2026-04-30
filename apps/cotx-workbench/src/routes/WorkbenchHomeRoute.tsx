import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { CotxDataAdapter, ProjectSummary } from 'cotx-sdk-core';
import { createHttpCotxAdapter } from 'cotx-sdk-core';

interface WorkbenchHomeRouteProps {
  adapter?: CotxDataAdapter;
}

export function WorkbenchHomeRoute({ adapter: providedAdapter }: WorkbenchHomeRouteProps = {}) {
  const adapter = useMemo(
    () => providedAdapter ?? createHttpCotxAdapter(window.location.origin),
    [providedAdapter],
  );
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (!adapter.listProjects) {
      setError('Project listing is not supported by this adapter.');
      setLoading(false);
      return;
    }

    void adapter.listProjects()
      .then((items) => {
        if (cancelled) return;
        setProjects(items);
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
  }, [adapter]);

  if (loading) {
    return <div data-testid="workbench-home-loading">Loading projects...</div>;
  }

  if (error) {
    return <div data-testid="workbench-home-error">Failed to load projects: {error}</div>;
  }

  const formatAssetPreview = (assetPaths: string[], assetDirectories: number): string => {
    const preview = assetPaths.slice(0, 2);
    if (preview.length === 0) return '';
    return assetDirectories > preview.length
      ? `${preview.join(', ')} +${assetDirectories - preview.length} more`
      : preview.join(', ');
  };

  return (
    <main className="cotx-workbench-home" data-testid="workbench-home">
      <header className="cotx-workbench-home-header">
        <span className="cotx-workbench-eyebrow">Observability</span>
        <h1>cotx workbench</h1>
        <p>Inspect architecture, flows, and code risk across compiled projects from one human-readable workspace.</p>
      </header>

      {projects.length === 0 ? (
        <div data-testid="workbench-home-empty">No projects registered.</div>
      ) : (
        <ul className="cotx-workbench-project-list" data-testid="workbench-project-list">
          {projects.map((project) => (
            <li key={project.id} className="cotx-project-card">
              <Link
                className="cotx-project-link"
                to={`/workbench/${encodeURIComponent(project.name)}/${encodeURIComponent(project.defaultPerspective)}`}
              >
                <div className="cotx-project-card-head">
                  <strong>{project.name}</strong>
                  <span className="cotx-project-card-route">{project.defaultPerspective}</span>
                </div>
                <span className="cotx-project-card-path">{project.path}</span>
                {project.workspaceLayout && project.workspaceLayout.assetDirectories > 0 ? (
                  <span className="cotx-project-card-path">
                    Assets: {formatAssetPreview(
                      project.workspaceLayout.assetPaths,
                      project.workspaceLayout.assetDirectories,
                    )}
                  </span>
                ) : null}
                <div className="cotx-project-card-stats">
                  <span>{project.stats.modules} modules</span>
                  <span>{project.stats.flows} flows</span>
                  <span>{project.stats.contracts} contracts</span>
                  {project.workspaceLayout ? (
                    <span>{project.workspaceLayout.assetDirectories} asset dirs</span>
                  ) : null}
                </div>
                <div className="cotx-project-card-footer">
                  <span>Open workbench</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
