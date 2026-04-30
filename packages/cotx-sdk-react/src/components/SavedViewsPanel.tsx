import { useCallback, type KeyboardEvent } from 'react';
import type { SavedViewRef } from 'cotx-sdk-core';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface SavedViewsPanelProps {
  views: SavedViewRef[];
  /** Called when a view is selected by click or keyboard activation */
  onSelectView: (view: SavedViewRef) => void;
  /** Additional CSS class name */
  className?: string;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function SavedViewsPanel({
  views,
  onSelectView,
  className,
}: SavedViewsPanelProps) {
  const handleKeyDown = useCallback(
    (view: SavedViewRef) => (e: KeyboardEvent<HTMLLIElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onSelectView(view);
      }
    },
    [onSelectView],
  );

  if (views.length === 0) {
    return (
      <div
        className={['cotx-saved-views', className].filter(Boolean).join(' ')}
        data-testid="saved-views-panel"
      >
        <p className="cotx-saved-views-empty">No saved views.</p>
      </div>
    );
  }

  return (
    <div
      className={['cotx-saved-views', className].filter(Boolean).join(' ')}
      data-testid="saved-views-panel"
    >
      <ul role="listbox" aria-label="Saved views">
        {views.map((view) => (
          <li
            key={view.id}
            role="option"
            aria-selected={false}
            tabIndex={0}
            className="cotx-saved-view-item"
            onClick={() => onSelectView(view)}
            onKeyDown={handleKeyDown(view)}
          >
            {view.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
