import { describe, it, expect } from 'vitest';
import {
  createDefaultWorkbenchState,
  serializeWorkbenchState,
  deserializeWorkbenchState,
  toUrlState,
  fromUrlState,
} from 'cotx-sdk-core';
import type { WorkbenchState } from 'cotx-sdk-core';

describe('createDefaultWorkbenchState', () => {
  it('produces a valid state with all required fields', () => {
    const state = createDefaultWorkbenchState('my-project');

    expect(state.projectId).toBe('my-project');
    expect(state.perspectiveId).toBe('overall-architecture');
    expect(state.focusedNodePath).toBeNull();

    // graphSelection
    expect(state.graphSelection.anchorNodePath).toBeNull();
    expect(state.graphSelection.neighborhoodDepth).toBe(1);

    // filters
    expect(state.filters.query).toBe('');
    expect(state.filters.edgeTypes).toEqual([]);
    expect(state.filters.riskRange).toBeNull();
    expect(state.filters.showEdgeLabels).toBe('focus');
    expect(state.filters.showNodeMeta).toBe('balanced');

    // tree
    expect(state.tree.collapsedPaths).toEqual([]);
    expect(state.tree.navVisible).toBe(true);
    expect(typeof state.tree.navWidth).toBe('number');

    // inspector
    expect(state.inspector.visible).toBe(true);
    expect(state.inspector.tab).toBe('summary');

    // viewport
    expect(state.viewport.zoom).toBe(1);
    expect(state.viewport.panX).toBe(0);
    expect(state.viewport.panY).toBe(0);
    expect(state.viewport.pinnedNodes).toEqual({});

    // savedViews
    expect(state.savedViews).toEqual([]);
  });

  it('accepts an optional perspectiveId', () => {
    const state = createDefaultWorkbenchState('proj', 'data-flow');
    expect(state.perspectiveId).toBe('data-flow');
  });
});

describe('serializeWorkbenchState / deserializeWorkbenchState', () => {
  it('round-trips collapsedPaths through JSON', () => {
    const state = createDefaultWorkbenchState('proj');
    state.tree.collapsedPaths = ['core/parser', 'compiler/module', 'store'];

    const json = serializeWorkbenchState(state);
    const restored = deserializeWorkbenchState(json);

    expect(restored.tree.collapsedPaths).toEqual(['core/parser', 'compiler/module', 'store']);
  });

  it('round-trips saved view refs through JSON', () => {
    const state = createDefaultWorkbenchState('proj');
    state.savedViews = [
      { id: 'v1', label: 'Core Focus', state: 'p=overall-architecture&f=core' },
    ];

    const json = serializeWorkbenchState(state);
    const restored = deserializeWorkbenchState(json);

    expect(restored.savedViews).toEqual([
      { id: 'v1', label: 'Core Focus', state: 'p=overall-architecture&f=core' },
    ]);
  });

  it('round-trips focusedNodePath through JSON', () => {
    const state = createDefaultWorkbenchState('proj');
    state.focusedNodePath = 'modules/core/parser';

    const json = serializeWorkbenchState(state);
    const restored = deserializeWorkbenchState(json);

    expect(restored.focusedNodePath).toBe('modules/core/parser');
  });

  it('round-trips filters through JSON', () => {
    const state = createDefaultWorkbenchState('proj');
    state.filters.query = 'parser';
    state.filters.edgeTypes = ['CALLS', 'IMPORTS'];
    state.filters.riskRange = [2, 8];
    state.filters.showEdgeLabels = 'all';
    state.filters.showNodeMeta = 'dense';

    const json = serializeWorkbenchState(state);
    const restored = deserializeWorkbenchState(json);

    expect(restored.filters).toEqual({
      query: 'parser',
      edgeTypes: ['CALLS', 'IMPORTS'],
      riskRange: [2, 8],
      showEdgeLabels: 'all',
      showNodeMeta: 'dense',
    });
  });

  it('round-trips viewport with pinnedNodes through JSON', () => {
    const state = createDefaultWorkbenchState('proj');
    state.viewport.zoom = 1.5;
    state.viewport.panX = 100;
    state.viewport.panY = -50;
    state.viewport.pinnedNodes = { 'mod/a': { x: 10, y: 20 }, 'mod/b': { x: 30, y: 40 } };

    const json = serializeWorkbenchState(state);
    const restored = deserializeWorkbenchState(json);

    expect(restored.viewport.zoom).toBe(1.5);
    expect(restored.viewport.panX).toBe(100);
    expect(restored.viewport.panY).toBe(-50);
    expect(restored.viewport.pinnedNodes).toEqual({
      'mod/a': { x: 10, y: 20 },
      'mod/b': { x: 30, y: 40 },
    });
  });

  it('throws on invalid JSON', () => {
    expect(() => deserializeWorkbenchState('not json')).toThrow('Invalid JSON');
  });

  it('throws on missing required fields', () => {
    expect(() => deserializeWorkbenchState('{}')).toThrow('projectId');
  });

  it('throws when graphSelection is missing', () => {
    const partial = { projectId: 'p', perspectiveId: 'a', focusedNodePath: null };
    expect(() => deserializeWorkbenchState(JSON.stringify(partial))).toThrow('graphSelection');
  });
});

describe('toUrlState / fromUrlState', () => {
  it('preserves perspective and focus', () => {
    const state = createDefaultWorkbenchState('proj', 'data-flow');
    state.focusedNodePath = 'modules/core/parser';

    const url = toUrlState(state);
    const partial = fromUrlState(url);

    expect(partial.perspectiveId).toBe('data-flow');
    expect(partial.focusedNodePath).toBe('modules/core/parser');
  });

  it('preserves filter fields', () => {
    const state = createDefaultWorkbenchState('proj');
    state.filters.query = 'bridge';
    state.filters.edgeTypes = ['CALLS', 'IMPORTS'];
    state.filters.riskRange = [1, 9];
    state.filters.showEdgeLabels = 'all';
    state.filters.showNodeMeta = 'dense';

    const url = toUrlState(state);
    const partial = fromUrlState(url);

    expect(partial.filters).toBeDefined();
    expect(partial.filters!.query).toBe('bridge');
    expect(partial.filters!.edgeTypes).toEqual(['CALLS', 'IMPORTS']);
    expect(partial.filters!.riskRange).toEqual([1, 9]);
    expect(partial.filters!.showEdgeLabels).toBe('all');
    expect(partial.filters!.showNodeMeta).toBe('dense');
  });

  it('preserves panel state (inspector and nav)', () => {
    const state = createDefaultWorkbenchState('proj');
    state.inspector.visible = false;
    state.inspector.tab = 'flows';
    state.tree.navVisible = false;

    const url = toUrlState(state);
    const partial = fromUrlState(url);

    expect(partial.inspector).toBeDefined();
    expect(partial.inspector!.visible).toBe(false);
    expect(partial.inspector!.tab).toBe('flows');
    expect(partial.tree).toBeDefined();
    expect(partial.tree!.navVisible).toBe(false);
  });

  it('returns partial state when params are missing', () => {
    // Only perspective in the URL
    const url = 'p=data-flow';
    const partial = fromUrlState(url);

    expect(partial.perspectiveId).toBe('data-flow');
    expect(partial.focusedNodePath).toBeUndefined();
    expect(partial.filters).toBeUndefined();
    expect(partial.inspector).toBeUndefined();
    expect(partial.tree).toBeUndefined();
  });

  it('merges with provided defaults', () => {
    const url = 'p=data-flow&f=mod/a';
    const defaults: Partial<WorkbenchState> = {
      projectId: 'my-proj',
    };
    const partial = fromUrlState(url, defaults);

    expect(partial.projectId).toBe('my-proj');
    expect(partial.perspectiveId).toBe('data-flow');
    expect(partial.focusedNodePath).toBe('mod/a');
  });

  it('omits default-valued fields from URL to keep it compact', () => {
    const state = createDefaultWorkbenchState('proj');
    // All defaults — should produce a minimal URL
    const url = toUrlState(state);

    // Only perspective should be present (always included)
    expect(url).toContain('p=overall-architecture');
    // Focus is null, so should not appear
    expect(url).not.toContain('f=');
    // Inspector is visible with tab=summary (defaults), so no iv/it
    expect(url).not.toContain('iv=');
    expect(url).not.toContain('it=');
  });

  it('preserves graphSelection anchor and depth', () => {
    const state = createDefaultWorkbenchState('proj');
    state.graphSelection.anchorNodePath = 'modules/core';
    state.graphSelection.neighborhoodDepth = 2;

    const url = toUrlState(state);
    const partial = fromUrlState(url);

    expect(partial.graphSelection).toBeDefined();
    expect(partial.graphSelection!.anchorNodePath).toBe('modules/core');
    expect(partial.graphSelection!.neighborhoodDepth).toBe(2);
  });
});
