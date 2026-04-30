import { useContext, type ReactNode } from 'react';
import type {
  EvidenceStatus,
  ExplorerNode,
  ImpactData,
  WorkbenchIntents,
} from 'cotx-sdk-core';
import { CotxContext } from '../provider/CotxProvider.js';

/* ------------------------------------------------------------------ */
/*  Tab type                                                           */
/* ------------------------------------------------------------------ */

export type InspectorTab =
  | 'summary'
  | 'evidence'
  | 'files'
  | 'relations'
  | 'flows'
  | 'contracts'
  | 'diagram';

const ALL_TABS: InspectorTab[] = [
  'summary',
  'evidence',
  'files',
  'relations',
  'flows',
  'contracts',
  'diagram',
];

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

export interface ArchitectureInspectorProps {
  node: ExplorerNode | null;
  intents?: WorkbenchIntents;
  impact?: ImpactData | null;
  impactLoading?: boolean;
  impactError?: string | null;
}

/* ------------------------------------------------------------------ */
/*  Internal tab renderers                                             */
/* ------------------------------------------------------------------ */

function SummaryTab({
  node,
  impact,
  impactLoading,
  impactError,
}: {
  node: ExplorerNode;
  impact?: ImpactData | null;
  impactLoading?: boolean;
  impactError?: string | null;
}) {
  return (
    <div data-testid="tab-summary">
      <h3>{node.label}</h3>
      <div className="cotx-inspector-status-row">
        <span
          className="cotx-evidence-status"
          data-status={node.evidenceStatus ?? 'unknown'}
        >
          {evidenceStatusLabel(node.evidenceStatus)}
        </span>
        {node.layer && <span className="cotx-inspector-layer">{node.layer}</span>}
      </div>
      {node.statusReason && <p data-testid="status-reason">{node.statusReason}</p>}
      {node.description && <p data-testid="description">{node.description}</p>}
      <dl data-testid="stats">
        <dt>Files</dt>
        <dd>{node.stats.fileCount}</dd>
        <dt>Functions</dt>
        <dd>{node.stats.functionCount}</dd>
        <dt>Max cyclomatic</dt>
        <dd>{node.stats.maxCyclomatic}</dd>
        <dt>Risk score</dt>
        <dd>{node.stats.riskScore}</dd>
      </dl>
      <section className="cotx-impact-summary" data-testid="impact-summary">
        <h4>Change impact</h4>
        {impactLoading ? (
          <p data-testid="impact-loading">Computing grounded impact from typed graph evidence...</p>
        ) : impactError ? (
          <p data-testid="impact-error">{impactError}</p>
        ) : impact ? (
          <>
            <div className="cotx-inspector-status-row">
              <span
                className="cotx-evidence-status"
                data-status={impact.status ?? 'unknown'}
              >
                {evidenceStatusLabel(impact.status)}
              </span>
              <span className="cotx-inspector-layer">Risk {impact.risk ?? 'LOW'}</span>
            </div>
            {impact.statusReason && <p>{impact.statusReason}</p>}
            <p data-testid="impact-count">
              {impact.affected.length} affected graph-backed target{impact.affected.length === 1 ? '' : 's'}.
            </p>
            {impact.targetPaths && impact.targetPaths.length > 0 && (
              <p data-testid="impact-targets">
                Grounding coverage: {impact.targetPaths.join(', ')}
              </p>
            )}
            {impact.affected.length > 0 && (
              <ul className="cotx-evidence-list" data-testid="impact-affected-list">
                {impact.affected.slice(0, 6).map((affectedPath) => (
                  <li key={affectedPath}>
                    <strong>{affectedPath}</strong>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <p data-testid="impact-placeholder">
            Run impact to inspect grounded blast radius for this selected node.
          </p>
        )}
      </section>
    </div>
  );
}

function evidenceStatusLabel(status: EvidenceStatus | undefined): string {
  switch (status) {
    case 'grounded':
      return 'Grounded';
    case 'stale':
      return 'Stale';
    case 'gap':
      return 'Gap';
    case 'unknown':
    case undefined:
      return 'Unknown';
  }
  return 'Unknown';
}

function EvidenceTab({ node }: { node: ExplorerNode }) {
  const evidence = node.evidence ?? [];
  return (
    <div data-testid="tab-evidence">
      <div className="cotx-evidence-summary">
        <span
          className="cotx-evidence-status"
          data-status={node.evidenceStatus ?? 'unknown'}
        >
          {evidenceStatusLabel(node.evidenceStatus)}
        </span>
        {node.statusReason && <p>{node.statusReason}</p>}
      </div>
      {evidence.length === 0 ? (
        <p>No evidence anchors were provided for this element.</p>
      ) : (
        <ul className="cotx-evidence-list">
          {evidence.map((anchor, index) => (
            <li key={`${anchor.kind}:${anchor.ref}:${index}`}>
              <strong>{anchor.kind}</strong>
              <span>{anchor.ref}</span>
              {anchor.filePath && <small>{anchor.filePath}{anchor.line ? `:${anchor.line}` : ''}</small>}
              {anchor.detail && <small>{anchor.detail}</small>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FilesTab({ node }: { node: ExplorerNode }) {
  const files = node.files ?? [];
  return (
    <div data-testid="tab-files">
      {files.length === 0 ? (
        <p>No files.</p>
      ) : (
        <ul>
          {files.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RelationsTab({
  node,
  onFocusNode,
}: {
  node: ExplorerNode;
  onFocusNode?: (path: string) => void;
}) {
  const provided = node.contractsProvided ?? [];
  const consumed = node.contractsConsumed ?? [];
  return (
    <div data-testid="tab-relations">
      <section>
        <h4>Provides</h4>
        {provided.length === 0 ? (
          <p>None.</p>
        ) : (
          <ul>
            {provided.map((c) => (
              <li key={c}>
                {onFocusNode ? (
                  <button
                    data-testid={`focus-${c}`}
                    onClick={() => onFocusNode(c)}
                  >
                    {c}
                  </button>
                ) : (
                  c
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h4>Consumes</h4>
        {consumed.length === 0 ? (
          <p>None.</p>
        ) : (
          <ul>
            {consumed.map((c) => (
              <li key={c}>
                {onFocusNode ? (
                  <button
                    data-testid={`focus-${c}`}
                    onClick={() => onFocusNode(c)}
                  >
                    {c}
                  </button>
                ) : (
                  c
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function FlowsTab({ node }: { node: ExplorerNode }) {
  const flows = node.relatedFlows ?? [];
  return (
    <div data-testid="tab-flows">
      {flows.length === 0 ? (
        <p>No related flows.</p>
      ) : (
        <ul>
          {flows.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ContractsTab({ node }: { node: ExplorerNode }) {
  const provided = node.contractsProvided ?? [];
  const consumed = node.contractsConsumed ?? [];
  return (
    <div data-testid="tab-contracts">
      <section data-testid="contracts-provided">
        <h4>Provided</h4>
        {provided.length === 0 ? (
          <p>None.</p>
        ) : (
          <ul>
            {provided.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        )}
      </section>
      <section data-testid="contracts-consumed">
        <h4>Consumed</h4>
        {consumed.length === 0 ? (
          <p>None.</p>
        ) : (
          <ul>
            {consumed.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function DiagramTab({ node }: { node: ExplorerNode }) {
  return (
    <div data-testid="tab-diagram">
      {node.diagram ? (
        <pre>{node.diagram}</pre>
      ) : (
        <p>No diagram available.</p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Intent buttons                                                     */
/* ------------------------------------------------------------------ */

function IntentButtons({
  node,
  intents,
}: {
  node: ExplorerNode;
  intents?: WorkbenchIntents;
}) {
  const hasWrite = typeof intents?.onWriteIntent === 'function';
  const hasRefactor = typeof intents?.onRefactorIntent === 'function';

  return (
    <div data-testid="intent-buttons">
      <button
        data-testid="btn-write"
        disabled={!hasWrite}
        onClick={
          hasWrite
            ? () =>
                intents!.onWriteIntent!({
                  nodePath: node.path,
                  field: 'responsibility',
                })
            : undefined
        }
      >
        Write
      </button>
      <button
        data-testid="btn-refactor"
        disabled={!hasRefactor}
        onClick={
          hasRefactor
            ? () =>
                intents!.onRefactorIntent!({
                  nodePath: node.path,
                  action: 'impact',
                })
            : undefined
        }
      >
        Impact
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Tab content switcher                                               */
/* ------------------------------------------------------------------ */

function TabContent({
  tab,
  node,
  impact,
  impactLoading,
  impactError,
  onFocusNode,
}: {
  tab: InspectorTab;
  node: ExplorerNode;
  impact?: ImpactData | null;
  impactLoading?: boolean;
  impactError?: string | null;
  onFocusNode?: (path: string) => void;
}): ReactNode {
  switch (tab) {
    case 'summary':
      return (
        <SummaryTab
          node={node}
          impact={impact}
          impactLoading={impactLoading}
          impactError={impactError}
        />
      );
    case 'evidence':
      return <EvidenceTab node={node} />;
    case 'files':
      return <FilesTab node={node} />;
    case 'relations':
      return <RelationsTab node={node} onFocusNode={onFocusNode} />;
    case 'flows':
      return <FlowsTab node={node} />;
    case 'contracts':
      return <ContractsTab node={node} />;
    case 'diagram':
      return <DiagramTab node={node} />;
  }
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export function ArchitectureInspector({
  node,
  intents,
  impact,
  impactLoading,
  impactError,
}: ArchitectureInspectorProps) {
  const ctx = useContext(CotxContext);
  const resolvedIntents = intents ?? ctx?.intents;

  // Read inspector state from provider when available, otherwise default
  const activeTab: InspectorTab = ctx?.state.inspector.tab ?? 'summary';
  const inspectorVisible = ctx?.state.inspector.visible ?? false;
  const setTab = ctx?.actions.setInspectorTab;
  const setFocusedNode = ctx?.actions.setFocusedNode;

  if (!node || !inspectorVisible) {
    return (
      <div className="cotx-inspector-placeholder" data-testid="inspector-placeholder">
        <p>Select a node to inspect its architecture.</p>
      </div>
    );
  }

  return (
    <div className="cotx-architecture-inspector" data-testid="architecture-inspector">
      {/* Tab bar */}
      <nav className="cotx-inspector-tabbar" data-testid="tab-bar">
        {ALL_TABS.map((tab) => (
          <button
            key={tab}
            className="cotx-inspector-tab"
            data-testid={`tab-btn-${tab}`}
            aria-selected={tab === activeTab}
            onClick={setTab ? () => setTab(tab) : undefined}
          >
            {tab}
          </button>
        ))}
      </nav>

      {/* Active tab content */}
      <TabContent
        tab={activeTab}
        node={node}
        impact={impact}
        impactLoading={impactLoading}
        impactError={impactError}
        onFocusNode={setFocusedNode}
      />

      {/* Intent buttons */}
      <IntentButtons node={node} intents={resolvedIntents} />
    </div>
  );
}
