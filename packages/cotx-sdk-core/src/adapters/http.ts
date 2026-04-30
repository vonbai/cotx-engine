/**
 * HTTP adapter for the cotx data API.
 *
 * Fetches perspective data from a cotx HTTP server and normalizes it
 * into the SDK's ExplorerPerspective/ExplorerNode types.
 *
 * API routes assumed:
 *   GET /api/v1/:project/meta                                   -> ProjectMeta-shaped JSON
 *   GET /api/v1/:project/perspectives                           -> PerspectiveSummary[]-shaped JSON
 *   GET /api/v1/:project/perspectives/:perspectiveId            -> RawPerspectiveData JSON
 *   GET /api/v1/:project/perspectives/:perspectiveId/nodes/:path -> RawArchitectureElement JSON
 *   GET /api/v1/:project/search?q=:query                        -> SearchResults JSON
 *   GET /api/v1/:project/perspectives/:perspectiveId/nodes/:path/impact -> ImpactData JSON
 */

import type {
  CotxDataAdapter,
  ImpactData,
  ProjectMeta,
  ProjectSummary,
  PerspectiveSummary,
  SearchResults,
  WorkspaceLayoutSummary,
} from '../types/adapter.js';
import type { ExplorerPerspective, ExplorerNode } from '../types/explorer.js';
import { isCotxLayerId, layerForPerspectiveId } from '../types/layers.js';
import { normalizePerspective, normalizeNode } from './normalize.js';
import type { RawArchitectureElement } from './normalize.js';

export class CotxHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    message: string,
  ) {
    super(message);
    this.name = 'CotxHttpError';
  }
}

export interface HttpAdapterOptions {
  /** Custom fetch implementation (defaults to globalThis.fetch). */
  fetch?: typeof globalThis.fetch;
}

/**
 * Create a CotxDataAdapter backed by the cotx HTTP API.
 *
 * @param baseUrl - The base URL of the cotx HTTP server (e.g. "http://localhost:3000")
 * @param options - Optional configuration
 */
export function createHttpCotxAdapter(
  baseUrl: string,
  options?: HttpAdapterOptions,
): CotxDataAdapter {
  const fetchFn = options?.fetch ?? globalThis.fetch;
  const base = baseUrl.replace(/\/+$/, '');

  async function fetchJson<T>(url: string): Promise<T> {
    const res = await fetchFn(url, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new CotxHttpError(
        res.status,
        url,
        `HTTP ${res.status} from ${url}: ${body}`,
      );
    }
    return (await res.json()) as T;
  }

  function apiUrl(projectId: string, ...segments: string[]): string {
    const encoded = [encodeURIComponent(projectId), ...segments.map(encodeURIComponent)];
    return `${base}/api/v1/${encoded.join('/')}`;
  }

  function normalizeWorkspaceLayout(raw: unknown): WorkspaceLayoutSummary | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const source = raw as Record<string, unknown>;
    const assetPaths = source.assetPaths ?? source.asset_paths;
    return {
      repoBoundaries: Number(source.repoBoundaries ?? source.repo_boundaries ?? 0),
      packageBoundaries: Number(source.packageBoundaries ?? source.package_boundaries ?? 0),
      assetDirectories: Number(source.assetDirectories ?? source.asset_directories ?? 0),
      assetPaths: Array.isArray(assetPaths) ? assetPaths.map((value) => String(value)) : [],
    };
  }

  const adapter: CotxDataAdapter = {
    async listProjects(): Promise<ProjectSummary[]> {
      const url = `${base}/api/v1/projects`;
      const raw = await fetchJson<Array<Record<string, unknown>>>(url);
      return raw.map((project) => ({
        id: String(project.id ?? project.name),
        name: String(project.name ?? project.id),
        path: String(project.path ?? ''),
        compiledAt: String(project.compiled_at ?? project.compiledAt ?? ''),
        workspaceLayout: normalizeWorkspaceLayout(project.workspaceLayout ?? project.workspace_layout),
        stats: {
          modules: Number((project.stats as Record<string, unknown> | undefined)?.modules ?? 0),
          concepts: Number((project.stats as Record<string, unknown> | undefined)?.concepts ?? 0),
          contracts: Number((project.stats as Record<string, unknown> | undefined)?.contracts ?? 0),
          flows: Number((project.stats as Record<string, unknown> | undefined)?.flows ?? 0),
          concerns: Number((project.stats as Record<string, unknown> | undefined)?.concerns ?? 0),
        },
        defaultPerspective: String(project.defaultPerspective ?? 'overall-architecture'),
      }));
    },

    async getProjectMeta(projectId: string): Promise<ProjectMeta> {
      const url = apiUrl(projectId, 'meta');
      const raw = await fetchJson<Record<string, unknown>>(url);
      return {
        id: String(raw.id ?? raw.project ?? projectId),
        compiledAt: String(raw.compiled_at ?? raw.compiledAt ?? ''),
        workspaceLayout: normalizeWorkspaceLayout(raw.workspaceLayout ?? raw.workspace_layout),
      };
    },

    async listPerspectives(projectId: string): Promise<PerspectiveSummary[]> {
      const url = apiUrl(projectId, 'perspectives');
      const raw = await fetchJson<Array<Record<string, unknown>>>(url);
      return raw.map((p) => ({
        id: String(p.id),
        label: String(p.label),
        layer: typeof p.layer === 'string' && isCotxLayerId(p.layer)
          ? p.layer
          : layerForPerspectiveId(String(p.id)),
        status: p.status === 'grounded' || p.status === 'stale' || p.status === 'gap' || p.status === 'unknown'
          ? p.status
          : p.evidence_status === 'grounded' || p.evidence_status === 'stale' || p.evidence_status === 'gap' || p.evidence_status === 'unknown'
            ? p.evidence_status
            : undefined,
        summary: typeof p.summary === 'string' ? p.summary : undefined,
        nodeCount: Number(p.node_count ?? p.nodeCount ?? p.componentCount ?? 0),
        edgeCount: Number(p.edge_count ?? p.edgeCount ?? 0),
      }));
    },

    async getPerspective(
      projectId: string,
      perspectiveId: string,
    ): Promise<ExplorerPerspective> {
      const url = apiUrl(projectId, 'perspectives', perspectiveId);
      const raw = await fetchJson<unknown>(url);
      return normalizePerspective(raw);
    },

    async getNode(
      projectId: string,
      perspectiveId: string,
      nodePath: string,
    ): Promise<ExplorerNode> {
      const url = apiUrl(projectId, 'perspectives', perspectiveId, 'nodes', nodePath);
      const raw = await fetchJson<RawArchitectureElement>(url);
      // Extract parent path: everything up to the last `/` in nodePath
      const lastSlash = nodePath.lastIndexOf('/');
      const parentPath = lastSlash > 0 ? nodePath.slice(0, lastSlash) : undefined;
      return normalizeNode(raw, parentPath);
    },

    async getImpact(
      projectId: string,
      perspectiveId: string,
      nodePath: string,
    ): Promise<ImpactData> {
      const url = `${apiUrl(projectId, 'perspectives', perspectiveId, 'nodes')}/${encodeURIComponent(nodePath)}/impact`;
      return fetchJson<ImpactData>(url);
    },

    async search(projectId: string, query: string): Promise<SearchResults> {
      const url = `${apiUrl(projectId, 'search')}?q=${encodeURIComponent(query)}`;
      return fetchJson<SearchResults>(url);
    },
  };

  return adapter;
}
