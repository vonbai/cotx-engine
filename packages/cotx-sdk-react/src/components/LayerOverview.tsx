import type {
  CotxLayerId,
  EvidenceStatus,
  ExplorerPerspective,
  LayerSummary,
  PerspectiveSummary,
} from 'cotx-sdk-core';
import {
  COTX_LAYER_CATALOG,
  labelForLayer,
  layerForPerspectiveId,
} from 'cotx-sdk-core';

interface ResolvedLayerSummary {
  layer: CotxLayerId;
  label: string;
  perspectiveId: string | null;
  nodeCount: number | null;
  edgeCount: number | null;
  status: EvidenceStatus | 'not-published';
  active: boolean;
}

export interface LayerOverviewProps {
  perspectives: PerspectiveSummary[];
  activePerspectiveId: string;
  activePerspective?: ExplorerPerspective | null;
  onSelectPerspective?: (perspectiveId: string) => void;
}

function statusForSummary(summary: LayerSummary | PerspectiveSummary | undefined): EvidenceStatus | undefined {
  return summary?.status;
}

function buildLayerRows({
  perspectives,
  activePerspectiveId,
  activePerspective,
}: {
  perspectives: PerspectiveSummary[];
  activePerspectiveId: string;
  activePerspective?: ExplorerPerspective | null;
}): ResolvedLayerSummary[] {
  const explicitSummaries = new Map<CotxLayerId, LayerSummary>();
  for (const summary of activePerspective?.layerSummary ?? []) {
    explicitSummaries.set(summary.layer, summary);
  }

  const perspectiveByLayer = new Map<CotxLayerId, PerspectiveSummary>();
  for (const perspective of perspectives) {
    const layer = perspective.layer ?? layerForPerspectiveId(perspective.id);
    if (layer && !perspectiveByLayer.has(layer)) {
      perspectiveByLayer.set(layer, perspective);
    }
  }

  if (activePerspective?.layer && !perspectiveByLayer.has(activePerspective.layer)) {
    perspectiveByLayer.set(activePerspective.layer, {
      id: activePerspective.id,
      label: activePerspective.label,
      layer: activePerspective.layer,
      status: activePerspective.evidenceStatus,
      summary: activePerspective.summary ?? undefined,
      nodeCount: activePerspective.stats.nodeCount,
      edgeCount: activePerspective.stats.edgeCount,
    });
  }

  return COTX_LAYER_CATALOG.map((definition) => {
    const explicit = explicitSummaries.get(definition.id);
    const perspective = perspectiveByLayer.get(definition.id);
    const perspectiveId = explicit?.perspectiveId ?? perspective?.id ?? null;
    const nodeCount = explicit?.nodeCount ?? perspective?.nodeCount ?? null;
    const edgeCount = explicit?.edgeCount ?? perspective?.edgeCount ?? null;
    const status = statusForSummary(explicit) ?? statusForSummary(perspective) ?? (perspectiveId ? 'unknown' : 'not-published');
    return {
      layer: definition.id,
      label: explicit?.label ?? perspective?.label ?? definition.label,
      perspectiveId,
      nodeCount,
      edgeCount,
      status,
      active: perspectiveId === activePerspectiveId,
    };
  });
}

function statusLabel(status: ResolvedLayerSummary['status']): string {
  switch (status) {
    case 'grounded':
      return 'grounded';
    case 'stale':
      return 'stale';
    case 'gap':
      return 'gap';
    case 'unknown':
      return 'unknown';
    case 'not-published':
      return 'not published';
  }
  return 'unknown';
}

export function LayerOverview({
  perspectives,
  activePerspectiveId,
  activePerspective,
  onSelectPerspective,
}: LayerOverviewProps) {
  const rows = buildLayerRows({ perspectives, activePerspectiveId, activePerspective });

  return (
    <section className="cotx-layer-overview" aria-label="cotx layers" data-testid="layer-overview">
      <div className="cotx-layer-overview-head">
        <span>Layer map</span>
        <small>{perspectives.length} published</small>
      </div>
      <div className="cotx-layer-grid">
        {rows.map((row) => {
          const disabled = !row.perspectiveId || !onSelectPerspective;
          const label = labelForLayer(row.layer);
          return (
            <button
              key={row.layer}
              type="button"
              className="cotx-layer-chip"
              data-layer={row.layer}
              data-status={row.status}
              data-active={row.active ? 'true' : 'false'}
              disabled={disabled}
              onClick={row.perspectiveId ? () => onSelectPerspective?.(row.perspectiveId!) : undefined}
              aria-pressed={row.active}
              aria-label={`${label}: ${statusLabel(row.status)}`}
            >
              <span className="cotx-layer-chip-label">{label}</span>
              <span className="cotx-layer-chip-status">{statusLabel(row.status)}</span>
              {row.nodeCount !== null && (
                <span className="cotx-layer-chip-count">
                  {row.nodeCount} nodes{row.edgeCount !== null ? `, ${row.edgeCount} edges` : ''}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}
