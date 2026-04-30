import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { CotxDataAdapter } from 'cotx-sdk-core';
import {
  CotxProvider,
  FilterBar,
  ArchitectureTree,
  ArchitectureCanvas,
  ArchitectureInspector,
} from 'cotx-sdk-react';

afterEach(cleanup);

function stubAdapter(): CotxDataAdapter {
  return {
    getProjectMeta: async () => ({ id: 'test', compiledAt: '' }),
    listPerspectives: async () => [],
    getPerspective: async () => ({
      id: 'modules', label: 'Modules', nodes: [], edges: [],
      stats: { nodeCount: 0, edgeCount: 0, maxRiskScore: 0 },
    }),
    getNode: async () => ({
      path: 'a', id: 'a', label: 'a', shortLabel: 'a',
      breadcrumb: [], directory: '', kind: 'leaf' as const,
      stats: { fileCount: 0, functionCount: 0, totalCyclomatic: 0, maxCyclomatic: 0, maxNestingDepth: 0, riskScore: 0 },
    }),
  };
}

function renderShell() {
  function Shell() {
    return createElement(
      CotxProvider,
      { adapter: stubAdapter(), projectId: 'test' },
      createElement('div', { className: 'cotx-workbench' },
        createElement('header', null, createElement(FilterBar)),
        createElement('main', null,
          createElement(ArchitectureTree, { nodes: [] }),
          createElement(ArchitectureCanvas, { nodes: [], edges: [] }),
          createElement(ArchitectureInspector, { node: null }),
        ),
      ),
    );
  }
  return render(createElement(Shell));
}

describe('accessibility baseline', () => {
  it('filter bar search input is keyboard reachable', () => {
    renderShell();
    const input = screen.getByLabelText('Query filter');
    expect(input).toBeTruthy();
    expect(input.tagName).toBe('INPUT');
    expect(input.getAttribute('type')).toBe('search');
  });

  it('tree has role="tree" for screen readers', () => {
    renderShell();
    expect(screen.getByRole('tree')).toBeTruthy();
  });

  it('inspector placeholder is accessible', () => {
    renderShell();
    expect(screen.getByTestId('inspector-placeholder')).toBeTruthy();
  });

  it('filter selects have accessible labels', () => {
    renderShell();
    expect(screen.getByLabelText('Edge label density')).toBeTruthy();
    expect(screen.getByLabelText('Node meta density')).toBeTruthy();
  });

  it('canvas has identifiable container', () => {
    renderShell();
    expect(screen.getByTestId('architecture-canvas')).toBeTruthy();
  });
});
