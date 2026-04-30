// test/viz/elk-renderer.test.ts
import { describe, it, expect } from 'vitest';
import { renderElkSvg, computeElkLayout } from '../../src/viz/elk-renderer.js';
import type { PerspectiveData } from '../../src/store/schema.js';

const simplePerspective: PerspectiveData = {
  id: 'test',
  label: 'Test',
  components: [
    {
      id: 'store',
      label: 'Store',
      kind: 'leaf',
      directory: 'src/store',
      files: ['store.ts'],
      stats: {
        file_count: 1,
        function_count: 5,
        total_cyclomatic: 10,
        max_cyclomatic: 3,
        max_nesting_depth: 1,
        risk_score: 10,
      },
    },
    {
      id: 'compiler',
      label: 'Compiler',
      kind: 'leaf',
      directory: 'src/compiler',
      files: ['module-compiler.ts'],
      stats: {
        file_count: 1,
        function_count: 8,
        total_cyclomatic: 20,
        max_cyclomatic: 5,
        max_nesting_depth: 2,
        risk_score: 25,
      },
    },
  ],
  edges: [{ from: 'compiler', to: 'store', label: 'writeModule', type: 'dependency', weight: 3 }],
};

describe('ELK Renderer', () => {
  it('renders a simple perspective to SVG', async () => {
    const svg = await renderElkSvg(simplePerspective);
    expect(svg).toContain('<svg');
    expect(svg).toContain('Store');
    expect(svg).toContain('Compiler');
    expect(svg).toContain('writeModule');
    expect(svg).toContain('</svg>');
  });

  it('handles empty perspective', async () => {
    const perspective: PerspectiveData = {
      id: 'empty',
      label: 'Empty',
      components: [],
      edges: [],
    };
    const svg = await renderElkSvg(perspective);
    expect(svg).toContain('<svg');
    expect(svg).toContain('No components');
  });

  it('renders group nodes', async () => {
    const perspective: PerspectiveData = {
      id: 'test',
      label: 'Test',
      components: [
        {
          id: 'core',
          label: 'Core',
          kind: 'group',
          directory: 'src/core',
          children: ['parser', 'graph'],
          stats: {
            file_count: 10,
            function_count: 30,
            total_cyclomatic: 60,
            max_cyclomatic: 8,
            max_nesting_depth: 3,
            risk_score: 30,
          },
        },
      ],
      edges: [],
    };
    const svg = await renderElkSvg(perspective);
    expect(svg).toContain('Core');
    expect(svg).toContain('<svg');
  });

  it('SVG contains arrowhead marker definition', async () => {
    const svg = await renderElkSvg(simplePerspective);
    expect(svg).toContain('arrowhead');
    expect(svg).toContain('<marker');
    expect(svg).toContain('marker-end');
  });

  it('SVG contains node data-id attributes', async () => {
    const svg = await renderElkSvg(simplePerspective);
    expect(svg).toContain('data-id="store"');
    expect(svg).toContain('data-id="compiler"');
  });

  it('applies dark theme background', async () => {
    const svg = await renderElkSvg(simplePerspective);
    expect(svg).toContain('#0d1117');
  });

  it('applies risk color — green for low-risk node (score=10)', async () => {
    const svg = await renderElkSvg(simplePerspective);
    // store has risk_score=10 which is <= 20 → green (#16c79a)
    expect(svg).toContain('#16c79a');
  });

  it('applies risk color — yellow for medium-risk node (score=25)', async () => {
    const svg = await renderElkSvg(simplePerspective);
    // compiler has risk_score=25 which is 21-50 → yellow (#f5a623)
    expect(svg).toContain('#f5a623');
  });

  it('renders stats text on nodes', async () => {
    const svg = await renderElkSvg(simplePerspective);
    expect(svg).toContain('1f 5fn'); // store: 1 file, 5 functions
    expect(svg).toContain('1f 8fn'); // compiler: 1 file, 8 functions
  });

  it('computeElkLayout returns positioned nodes', async () => {
    const layout = await computeElkLayout(simplePerspective);
    expect(layout.children).toBeDefined();
    expect(layout.children?.length).toBe(2);
    // Each child should have x/y position after layout
    for (const child of layout.children ?? []) {
      expect(typeof child.x).toBe('number');
      expect(typeof child.y).toBe('number');
    }
  });

  it('SVG has valid opening and closing tags', async () => {
    const svg = await renderElkSvg(simplePerspective);
    expect(svg.trimStart()).toMatch(/^<svg /);
    expect(svg.trimEnd()).toMatch(/<\/svg>$/);
  });

  it('escapes special characters in labels', async () => {
    const perspective: PerspectiveData = {
      id: 'test',
      label: 'Test',
      components: [
        {
          id: 'comp-1',
          label: 'A & B <Module>',
          kind: 'leaf',
          directory: 'src/a',
          files: ['a.ts'],
          stats: {
            file_count: 1,
            function_count: 1,
            total_cyclomatic: 1,
            max_cyclomatic: 1,
            max_nesting_depth: 1,
            risk_score: 5,
          },
        },
      ],
      edges: [],
    };
    const svg = await renderElkSvg(perspective);
    expect(svg).toContain('A &amp; B &lt;Module&gt;');
    expect(svg).not.toContain('A & B <Module>');
  });
});
