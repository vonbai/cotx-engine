import { describe, it, expect } from 'vitest';
import { pageRank } from '../../src/query/pagerank.js';

describe('pageRank', () => {
  it('returns empty map for empty graph', () => {
    const result = pageRank([], new Map());
    expect(result.size).toBe(0);
  });

  it('assigns equal scores to disconnected nodes', () => {
    const result = pageRank(['a', 'b', 'c'], new Map());
    // All scores should be approximately equal (1/3)
    for (const [, score] of result) {
      expect(score).toBeCloseTo(1 / 3, 2);
    }
  });

  it('gives higher score to nodes with more incoming edges', () => {
    const outEdges = new Map<string, string[]>([
      ['a', ['c']],
      ['b', ['c']],
      ['c', []],
    ]);
    const result = pageRank(['a', 'b', 'c'], outEdges);

    // c has 2 incoming edges, a and b have 0
    expect(result.get('c')!).toBeGreaterThan(result.get('a')!);
    expect(result.get('c')!).toBeGreaterThan(result.get('b')!);
  });

  it('personalized PageRank biases toward focus nodes', () => {
    const outEdges = new Map<string, string[]>([
      ['a', ['b']],
      ['b', ['c']],
      ['c', ['a']],
    ]);

    const uniform = pageRank(['a', 'b', 'c'], outEdges);
    const focused = pageRank(['a', 'b', 'c'], outEdges, ['a']);

    // With focus on 'a', nodes near 'a' should score higher relative to uniform
    expect(focused.get('a')!).toBeGreaterThan(uniform.get('a')!);
  });

  it('scores sum to approximately 1.0', () => {
    const outEdges = new Map<string, string[]>([
      ['a', ['b', 'c']],
      ['b', ['c']],
      ['c', ['a']],
    ]);
    const result = pageRank(['a', 'b', 'c'], outEdges);
    const sum = [...result.values()].reduce((s, v) => s + v, 0);
    expect(sum).toBeCloseTo(1.0, 2);
  });

  it('falls back to uniform personalization when focus nodes are invalid', () => {
    const outEdges = new Map<string, string[]>([
      ['a', ['b']],
      ['b', ['c']],
      ['c', ['a']],
    ]);

    const uniform = pageRank(['a', 'b', 'c'], outEdges);
    const invalidFocus = pageRank(['a', 'b', 'c'], outEdges, ['missing']);
    const sum = [...invalidFocus.values()].reduce((s, v) => s + v, 0);

    expect(sum).toBeCloseTo(1.0, 2);
    expect(invalidFocus.get('a')!).toBeCloseTo(uniform.get('a')!, 4);
    expect(invalidFocus.get('b')!).toBeCloseTo(uniform.get('b')!, 4);
    expect(invalidFocus.get('c')!).toBeCloseTo(uniform.get('c')!, 4);
  });

  it('handles single-node graph', () => {
    const result = pageRank(['a'], new Map());
    expect(result.get('a')).toBeCloseTo(1.0, 4);
  });
});
