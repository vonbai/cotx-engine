import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { CotxDataAdapter, ExplorerPerspective } from 'cotx-sdk-core';
import { WorkbenchRoute } from '../src/routes/WorkbenchRoute.js';
import { WorkbenchHomeRoute } from '../src/routes/WorkbenchHomeRoute.js';

afterEach(cleanup);

function createPerspective(id = 'overall-architecture', label = 'Overall Architecture'): ExplorerPerspective {
  return {
    id,
    label,
    layer: id === 'overall-architecture' ? 'architecture' : 'flows',
    evidenceStatus: 'grounded',
    summary: 'test perspective',
    stats: {
      nodeCount: 2,
      edgeCount: 1,
      maxRiskScore: 12,
    },
    nodes: [
      {
        path: 'core',
        id: 'core',
        label: 'Core',
        shortLabel: 'core',
        breadcrumb: ['core'],
        directory: 'src/core',
        kind: 'group',
        layer: 'architecture',
        evidenceStatus: 'grounded',
        evidence: [{ kind: 'file', ref: 'src/core/index.ts', filePath: 'src/core/index.ts' }],
        stats: {
          fileCount: 2,
          functionCount: 8,
          totalCyclomatic: 8,
          maxCyclomatic: 3,
          maxNestingDepth: 2,
          riskScore: 12,
        },
        description: 'Core services',
        children: ['core/parser'],
      },
      {
        path: 'parser',
        id: 'parser',
        label: 'Parser',
        shortLabel: 'parser',
        breadcrumb: ['parser'],
        directory: 'src/parser',
        kind: 'leaf',
        layer: 'architecture',
        evidenceStatus: 'grounded',
        evidence: [{ kind: 'file', ref: 'src/parser/index.ts', filePath: 'src/parser/index.ts' }],
        stats: {
          fileCount: 1,
          functionCount: 3,
          totalCyclomatic: 3,
          maxCyclomatic: 2,
          maxNestingDepth: 1,
          riskScore: 5,
        },
        files: ['src/parser/index.ts'],
        description: 'Parser implementation',
      },
    ],
    edges: [
      {
        id: 'e-core-parser-0',
        from: 'core',
        to: 'parser',
        type: 'dependency',
        label: 'calls',
        weight: 1,
      },
    ],
  };
}

function createStubAdapter(): CotxDataAdapter {
  return {
    listProjects: vi.fn().mockResolvedValue([
      {
        id: 'demo',
        name: 'demo',
        path: '/tmp/demo',
        compiledAt: '2026-04-09T00:00:00Z',
        workspaceLayout: {
          repoBoundaries: 1,
          packageBoundaries: 2,
          assetDirectories: 2,
          assetPaths: ['apps/web/public', 'packages/ui/icons'],
        },
        stats: { modules: 2, concepts: 0, contracts: 0, flows: 1, concerns: 0 },
        defaultPerspective: 'overall-architecture',
      },
    ]),
    getProjectMeta: vi.fn().mockResolvedValue({ id: 'demo', compiledAt: '2026-04-09T00:00:00Z' }),
    listPerspectives: vi.fn().mockResolvedValue([
      { id: 'overall-architecture', label: 'Overall Architecture', layer: 'architecture', status: 'grounded', nodeCount: 2, edgeCount: 1 },
      { id: 'data-flow', label: 'Data Flow', layer: 'flows', status: 'unknown', nodeCount: 2, edgeCount: 1 },
    ]),
    getPerspective: vi.fn(async (_projectId, perspectiveId) => createPerspective(perspectiveId, perspectiveId)),
    getNode: vi.fn(async (_projectId, perspectiveId, nodePath) => {
      const perspective = createPerspective(perspectiveId, perspectiveId);
      const node = perspective.nodes.find((n) => n.path === nodePath);
      if (!node) throw new Error('node not found');
      return node;
    }),
    getImpact: vi.fn(async (_projectId, _perspectiveId, nodePath) => ({
      root: nodePath,
      affected: ['src/compiler/module-compiler.ts#compileModule', 'src/compiler/index.ts#compile'],
      status: 'grounded',
      statusReason: null,
      risk: 'MEDIUM',
      targetPaths: ['src/core'],
    })),
  };
}

function createAssetHeavyAdapter(): CotxDataAdapter {
  return {
    ...createStubAdapter(),
    listProjects: vi.fn().mockResolvedValue([
      {
        id: 'demo',
        name: 'demo',
        path: '/tmp/demo',
        compiledAt: '2026-04-09T00:00:00Z',
        workspaceLayout: {
          repoBoundaries: 1,
          packageBoundaries: 2,
          assetDirectories: 20,
          assetPaths: [
            'apps/web/public',
            'packages/ui/icons',
            'ignored/by-preview',
          ],
        },
        stats: { modules: 2, concepts: 0, contracts: 0, flows: 1, concerns: 0 },
        defaultPerspective: 'overall-architecture',
      },
    ]),
  };
}

function renderWorkbenchHome(route: string, adapter: CotxDataAdapter) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <Routes>
        <Route path="/workbench" element={<WorkbenchHomeRoute adapter={adapter} />} />
      </Routes>
    </MemoryRouter>,
  );
}

function renderWorkbench(route: string, adapter: CotxDataAdapter) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <Routes>
        <Route
          path="/workbench/:project/:perspective"
          element={<WorkbenchRoute adapter={adapter} />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('cotx-workbench route', () => {
  it('loads the workbench home and lists registered projects', async () => {
    const adapter = createStubAdapter();
    renderWorkbenchHome('/workbench', adapter);

    await screen.findByTestId('workbench-home');
    expect(screen.getByText('demo')).toBeTruthy();
    expect(screen.getByText('/tmp/demo')).toBeTruthy();
    expect(screen.getByText('Assets: apps/web/public, packages/ui/icons')).toBeTruthy();
    expect(screen.getByText(/2 modules/i)).toBeTruthy();
    expect(screen.getByText(/2 asset dirs/i)).toBeTruthy();
    expect(screen.getByText(/overall-architecture/i)).toBeTruthy();
  });

  it('uses total asset directory count for truncated asset preview copy', async () => {
    const adapter = createAssetHeavyAdapter();
    renderWorkbenchHome('/workbench', adapter);

    await screen.findByTestId('workbench-home');
    expect(screen.getByText('Assets: apps/web/public, packages/ui/icons +18 more')).toBeTruthy();
    expect(screen.getByText(/20 asset dirs/i)).toBeTruthy();
  });

  it('loads perspective data and renders the three-panel shell', async () => {
    const adapter = createStubAdapter();
    renderWorkbench('/workbench/demo/overall-architecture', adapter);

    await screen.findByRole('search');
    expect(screen.getByLabelText('Filter architecture tree')).toBeTruthy();
    expect(screen.getByTestId('architecture-canvas')).toBeTruthy();
    await screen.findByText('Core');
    await screen.findByText('Parser');
    expect(screen.getByTestId('layer-overview')).toBeTruthy();
    expect(screen.getByRole('button', { name: /architecture: grounded/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /routes: not published/i })).toBeTruthy();

    expect(adapter.getPerspective).toHaveBeenCalledWith('demo', 'overall-architecture');
  });

  it('reads project and perspective from route params', async () => {
    const adapter = createStubAdapter();
    renderWorkbench('/workbench/acme/data-flow', adapter);

    await waitFor(() => {
      expect(adapter.getPerspective).toHaveBeenCalledWith('acme', 'data-flow');
    });
  });

  it('clicking a tree node populates the inspector with node details', async () => {
    const adapter = createStubAdapter();
    renderWorkbench('/workbench/demo/overall-architecture', adapter);

    await screen.findByText('Core');

    fireEvent.click(screen.getByText('Core'));

    await screen.findByTestId('architecture-inspector');
    expect(screen.getByText('Core services')).toBeTruthy();
  });

  it('loads perspective tabs and switches route-driven perspective', async () => {
    const adapter = createStubAdapter();
    renderWorkbench('/workbench/demo/overall-architecture', adapter);

    await screen.findByRole('tablist');
    expect(screen.getByRole('tab', { name: 'Overall Architecture' })).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Data Flow' }));

    await waitFor(() => {
      expect(adapter.getPerspective).toHaveBeenCalledWith('demo', 'data-flow');
    });
  });

  it('toggles the navigation rail from the topbar control', async () => {
    const adapter = createStubAdapter();
    renderWorkbench('/workbench/demo/overall-architecture', adapter);

    await screen.findByRole('button', { name: 'Hide navigation' });
    const tree = screen.getByTestId('workbench-tree-shell');
    expect(tree.getAttribute('data-nav-visible')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Hide navigation' }));
    expect(tree.getAttribute('data-nav-visible')).toBe('false');
  });

  it('restores filter and nav state from URL query', async () => {
    const adapter = createStubAdapter();
    renderWorkbench('/workbench/demo/overall-architecture?q=parser&nv=0&nd=2', adapter);

    await screen.findByDisplayValue('parser');
    expect(screen.getByTestId('workbench-tree-shell').getAttribute('data-nav-visible')).toBe('false');
    expect((screen.getByLabelText('Neighborhood depth') as HTMLSelectElement).value).toBe('2');
  });

  it('saves a view and renders it in the saved views panel', async () => {
    const adapter = createStubAdapter();
    renderWorkbench('/workbench/demo/overall-architecture?f=core', adapter);

    await screen.findByText('Core');
    fireEvent.click(screen.getByRole('button', { name: 'Save view' }));

    await screen.findByRole('option', { name: 'View 1' });
  });

  it('runs grounded impact for the selected node from the inspector', async () => {
    const adapter = createStubAdapter();
    renderWorkbench('/workbench/demo/overall-architecture', adapter);

    await screen.findByText('Core');
    fireEvent.click(screen.getByText('Core'));

    await screen.findByTestId('architecture-inspector');
    fireEvent.click(screen.getByTestId('btn-refactor'));

    await screen.findByTestId('impact-count');
    expect(screen.getByText(/2 affected graph-backed targets/i)).toBeTruthy();
    expect(screen.getByText(/grounding coverage: src\/core/i)).toBeTruthy();
    expect(adapter.getImpact).toHaveBeenCalledWith('demo', 'overall-architecture', 'core');
  });
});
