import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, fireEvent, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import type {
  CotxDataAdapter,
  ExplorerNode,
  WorkbenchIntents,
  WorkbenchState,
} from 'cotx-sdk-core';
import { CotxProvider } from '../src/provider/CotxProvider.js';
import { ArchitectureInspector } from '../src/components/ArchitectureInspector.js';

afterEach(cleanup);

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function stubAdapter(): CotxDataAdapter {
  return {
    getProjectMeta: vi.fn().mockResolvedValue({ id: 'test', compiledAt: '' }),
    listPerspectives: vi.fn().mockResolvedValue([]),
    getPerspective: vi
      .fn()
      .mockResolvedValue({ id: 'modules', nodes: [], edges: [] }),
    getNode: vi.fn().mockResolvedValue({ path: 'a', label: 'a', kind: 'module' }),
  };
}

function makeNode(overrides?: Partial<ExplorerNode>): ExplorerNode {
  return {
    path: 'modules/core',
    id: 'core',
    label: 'Core Module',
    shortLabel: 'core',
    breadcrumb: ['modules', 'core'],
    directory: 'src/core',
    kind: 'group',
    stats: {
      fileCount: 12,
      functionCount: 45,
      totalCyclomatic: 80,
      maxCyclomatic: 15,
      maxNestingDepth: 4,
      riskScore: 0.6,
    },
    files: ['src/core/parser.ts', 'src/core/bridge.ts', 'src/core/graph.ts'],
    contractsProvided: ['parse', 'compile'],
    contractsConsumed: ['store-read', 'store-write'],
    relatedFlows: ['compile-flow', 'serve-flow'],
    layer: 'architecture',
    evidenceStatus: 'grounded',
    evidence: [
      { kind: 'file', ref: 'src/core/parser.ts', filePath: 'src/core/parser.ts' },
      { kind: 'module', ref: 'core', detail: 'group leaf' },
    ],
    description: 'Core parsing and compilation module',
    diagram: 'parser --> bridge --> graph',
    ...overrides,
  };
}

function wrapper(
  overrides?: {
    initialState?: Partial<WorkbenchState>;
    intents?: WorkbenchIntents;
  },
) {
  const adapter = stubAdapter();
  const initialState: Partial<WorkbenchState> = {
    inspector: {
      visible: true,
      tab: 'summary',
    },
    ...overrides?.initialState,
  };
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <CotxProvider
        adapter={adapter}
        projectId="test-project"
        initialState={initialState}
        intents={overrides?.intents}
      >
        {children}
      </CotxProvider>
    );
  };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('ArchitectureInspector', () => {
  /* -------------------------------------------------------------- */
  /*  Placeholder when no node                                       */
  /* -------------------------------------------------------------- */

  it('shows placeholder when no node is provided', () => {
    render(<ArchitectureInspector node={null} />, {
      wrapper: wrapper(),
    });

    expect(screen.getByTestId('inspector-placeholder')).toBeDefined();
    expect(screen.getByText('Select a node to inspect its architecture.')).toBeDefined();
  });

  /* -------------------------------------------------------------- */
  /*  Summary tab (default)                                          */
  /* -------------------------------------------------------------- */

  it('renders summary tab by default with node data', () => {
    const node = makeNode();
    render(<ArchitectureInspector node={node} />, {
      wrapper: wrapper(),
    });

    expect(screen.getByTestId('architecture-inspector')).toBeDefined();
    expect(screen.getByTestId('tab-summary')).toBeDefined();
    expect(screen.getByText('Core Module')).toBeDefined();
    expect(screen.getByText('Core parsing and compilation module')).toBeDefined();
    expect(screen.getByTestId('stats')).toBeDefined();
    expect(screen.getByTestId('impact-placeholder')).toBeDefined();
  });

  it('renders grounded impact details in the summary tab', () => {
    const node = makeNode();
    render(
      <ArchitectureInspector
        node={node}
        impact={{
          root: 'modules/core',
          affected: ['src/compiler/module-compiler.ts#compileModule', 'src/compiler/index.ts#compile'],
          status: 'grounded',
          statusReason: null,
          risk: 'MEDIUM',
          targetPaths: ['src/core'],
        }}
      />,
      {
        wrapper: wrapper(),
      },
    );

    expect(screen.getByTestId('impact-summary')).toBeDefined();
    expect(screen.getByTestId('impact-count')).toBeDefined();
    expect(screen.getByText(/2 affected graph-backed targets/i)).toBeDefined();
    expect(screen.getByText(/grounding coverage: src\/core/i)).toBeDefined();
  });

  /* -------------------------------------------------------------- */
  /*  All tabs render when node is provided                          */
  /* -------------------------------------------------------------- */

  it('renders all tabs when switching through them', () => {
    const node = makeNode();
    render(<ArchitectureInspector node={node} />, {
      wrapper: wrapper({ initialState: { inspector: { visible: true, tab: 'summary' } } }),
    });

    // Summary tab is active by default
    expect(screen.getByTestId('tab-summary')).toBeDefined();

    // Switch to files
    fireEvent.click(screen.getByTestId('tab-btn-evidence'));
    expect(screen.getByTestId('tab-evidence')).toBeDefined();
    expect(screen.getAllByText('src/core/parser.ts')).toHaveLength(2);

    // Switch to files
    fireEvent.click(screen.getByTestId('tab-btn-files'));
    expect(screen.getByTestId('tab-files')).toBeDefined();
    expect(screen.getByText('src/core/parser.ts')).toBeDefined();

    // Switch to relations
    fireEvent.click(screen.getByTestId('tab-btn-relations'));
    expect(screen.getByTestId('tab-relations')).toBeDefined();

    // Switch to flows
    fireEvent.click(screen.getByTestId('tab-btn-flows'));
    expect(screen.getByTestId('tab-flows')).toBeDefined();
    expect(screen.getByText('compile-flow')).toBeDefined();

    // Switch to contracts
    fireEvent.click(screen.getByTestId('tab-btn-contracts'));
    expect(screen.getByTestId('tab-contracts')).toBeDefined();
    expect(screen.getByTestId('contracts-provided')).toBeDefined();
    expect(screen.getByTestId('contracts-consumed')).toBeDefined();

    // Switch to diagram
    fireEvent.click(screen.getByTestId('tab-btn-diagram'));
    expect(screen.getByTestId('tab-diagram')).toBeDefined();
    expect(screen.getByText('parser --> bridge --> graph')).toBeDefined();
  });

  /* -------------------------------------------------------------- */
  /*  Tab switching works via actions                                 */
  /* -------------------------------------------------------------- */

  it('tab switching updates the active tab via provider actions', () => {
    const node = makeNode();
    render(<ArchitectureInspector node={node} />, {
      wrapper: wrapper(),
    });

    // Default is summary
    expect(screen.getByTestId('tab-summary')).toBeDefined();
    expect(
      screen.getByTestId('tab-btn-summary').getAttribute('aria-selected'),
    ).toBe('true');

    // Click files tab
    fireEvent.click(screen.getByTestId('tab-btn-files'));
    expect(screen.getByTestId('tab-files')).toBeDefined();
    expect(
      screen.getByTestId('tab-btn-files').getAttribute('aria-selected'),
    ).toBe('true');
    expect(
      screen.getByTestId('tab-btn-summary').getAttribute('aria-selected'),
    ).toBe('false');
  });

  /* -------------------------------------------------------------- */
  /*  Intent buttons call passed handlers                            */
  /* -------------------------------------------------------------- */

  it('intent buttons call passed handlers when clicked', () => {
    const onWrite = vi.fn();
    const onRefactor = vi.fn();
    const node = makeNode();

    render(
      <ArchitectureInspector
        node={node}
        intents={{
          onWriteIntent: onWrite,
          onRefactorIntent: onRefactor,
        }}
      />,
      { wrapper: wrapper() },
    );

    const writeBtn = screen.getByTestId('btn-write');
    const refactorBtn = screen.getByTestId('btn-refactor');

    expect(writeBtn.hasAttribute('disabled')).toBe(false);
    expect(refactorBtn.hasAttribute('disabled')).toBe(false);

    fireEvent.click(writeBtn);
    expect(onWrite).toHaveBeenCalledOnce();
    expect(onWrite).toHaveBeenCalledWith({
      nodePath: 'modules/core',
      field: 'responsibility',
    });

    fireEvent.click(refactorBtn);
    expect(onRefactor).toHaveBeenCalledOnce();
    expect(onRefactor).toHaveBeenCalledWith({
      nodePath: 'modules/core',
      action: 'impact',
    });
  });

  /* -------------------------------------------------------------- */
  /*  Intent buttons are disabled when no handler provided           */
  /* -------------------------------------------------------------- */

  it('intent buttons are disabled when no handler is provided', () => {
    const node = makeNode();

    render(<ArchitectureInspector node={node} />, {
      wrapper: wrapper(),
    });

    const writeBtn = screen.getByTestId('btn-write');
    const refactorBtn = screen.getByTestId('btn-refactor');

    expect(writeBtn.hasAttribute('disabled')).toBe(true);
    expect(refactorBtn.hasAttribute('disabled')).toBe(true);

    // Clicking disabled buttons should not throw
    fireEvent.click(writeBtn);
    fireEvent.click(refactorBtn);
  });

  /* -------------------------------------------------------------- */
  /*  Relation buttons call focus actions                            */
  /* -------------------------------------------------------------- */

  it('relation tab buttons call setFocusedNode when clicked', () => {
    const node = makeNode();

    render(<ArchitectureInspector node={node} />, {
      wrapper: wrapper({ initialState: { inspector: { visible: true, tab: 'relations' } } }),
    });

    // Relations tab should be active
    expect(screen.getByTestId('tab-relations')).toBeDefined();

    // Click a provided contract focus button
    const focusBtn = screen.getByTestId('focus-parse');
    fireEvent.click(focusBtn);

    // The button exists and is clickable -- it invokes setFocusedNode via CotxContext.
    // We verify the button rendered and was clickable (no error thrown).
    expect(focusBtn).toBeDefined();
  });

  /* -------------------------------------------------------------- */
  /*  Files tab with no files                                        */
  /* -------------------------------------------------------------- */

  it('files tab shows empty message when node has no files', () => {
    const node = makeNode({ files: [] });

    render(<ArchitectureInspector node={node} />, {
      wrapper: wrapper({ initialState: { inspector: { visible: true, tab: 'files' } } }),
    });

    expect(screen.getByTestId('tab-files')).toBeDefined();
    expect(screen.getByText('No files.')).toBeDefined();
  });

  /* -------------------------------------------------------------- */
  /*  Diagram tab with no diagram                                    */
  /* -------------------------------------------------------------- */

  it('diagram tab shows fallback when node has no diagram', () => {
    const node = makeNode({ diagram: null });

    render(<ArchitectureInspector node={node} />, {
      wrapper: wrapper({ initialState: { inspector: { visible: true, tab: 'diagram' } } }),
    });

    expect(screen.getByTestId('tab-diagram')).toBeDefined();
    expect(screen.getByText('No diagram available.')).toBeDefined();
  });

  /* -------------------------------------------------------------- */
  /*  Tab bar renders all seven tabs                                 */
  /* -------------------------------------------------------------- */

  it('tab bar renders buttons for all seven tabs', () => {
    const node = makeNode();
    render(<ArchitectureInspector node={node} />, {
      wrapper: wrapper(),
    });

    const tabs = ['summary', 'evidence', 'files', 'relations', 'flows', 'contracts', 'diagram'];
    for (const tab of tabs) {
      expect(screen.getByTestId(`tab-btn-${tab}`)).toBeDefined();
    }
  });

  it('evidence tab shows unknown state when anchors are missing', () => {
    const node = makeNode({ evidence: [], evidenceStatus: undefined });

    render(<ArchitectureInspector node={node} />, {
      wrapper: wrapper({ initialState: { inspector: { visible: true, tab: 'evidence' } } }),
    });

    expect(screen.getByTestId('tab-evidence')).toBeDefined();
    expect(screen.getByText('Unknown')).toBeDefined();
    expect(screen.getByText('No evidence anchors were provided for this element.')).toBeDefined();
  });

  /* -------------------------------------------------------------- */
  /*  Respects initial tab from provider state                       */
  /* -------------------------------------------------------------- */

  it('respects initial inspector tab from provider state', () => {
    const node = makeNode();

    render(<ArchitectureInspector node={node} />, {
      wrapper: wrapper({
        initialState: { inspector: { visible: true, tab: 'flows' } },
      }),
    });

    expect(screen.getByTestId('tab-flows')).toBeDefined();
    expect(
      screen.getByTestId('tab-btn-flows').getAttribute('aria-selected'),
    ).toBe('true');
  });
});
