import { describe, expect, it } from 'vitest';
import { getExplorerClientJs } from '../../src/viz/explorer-client.js';

describe('Explorer Client', () => {
  it('includes nav filtering behavior', () => {
    const js = getExplorerClientJs();
    expect(js).toContain('function filterNav');
    expect(js).toContain("document.getElementById('nav-search')");
  });

  it('includes selection highlighting behavior for nodes and edges', () => {
    const js = getExplorerClientJs();
    expect(js).toContain('function applySelectionState');
    expect(js).toContain("querySelectorAll('#graph-canvas .node')");
    expect(js).toContain("querySelectorAll('#graph-canvas .edge')");
    expect(js).toContain("classList.toggle('selected'");
    expect(js).toContain("classList.toggle('related'");
  });

  it('renders sidebar relationship links as buttons', () => {
    const js = getExplorerClientJs();
    expect(js).toContain('relationship-link');
    expect(js).toContain('child-link');
  });

  it('normalizes escaped mermaid label newlines before rendering mini diagrams', () => {
    const js = getExplorerClientJs();
    expect(js).toContain("replace(/\\\\n/g, '\\n')");
    expect(js).toContain("normalizedLabel.split('\\n')[0]");
  });

  it('falls back to the top-level graph focus when selecting nested paths', () => {
    const js = getExplorerClientJs();
    expect(js).toContain('function graphFocusPath');
    expect(js).toContain("String(path).split('/').filter(Boolean)[0]");
    expect(js).toContain('renderedGraphIds[topLevel]');
  });

  it('aligns sidebar relationship scope with the graph focus for nested paths', () => {
    const js = getExplorerClientJs();
    expect(js).toContain('var focusPath = graphFocusPath(resolvedId) || resolvedId;');
    expect(js).toContain("var bare = bareId(focusPath);");
    expect(js).toContain('Graph Context');
  });
});
