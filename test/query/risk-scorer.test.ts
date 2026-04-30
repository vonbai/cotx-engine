import { describe, it, expect } from 'vitest';
import { computeRiskScore } from '../../src/query/risk-scorer.js';
import type { ModuleNode } from '../../src/store/schema.js';

function makeModule(overrides: Partial<ModuleNode> = {}): ModuleNode {
  return {
    id: 'test',
    canonical_entry: '',
    files: [],
    depends_on: [],
    depended_by: [],
    struct_hash: 'h1',
    ...overrides,
  };
}

describe('computeRiskScore', () => {
  it('returns LOW for simple, stable, well-tested module', () => {
    const mod = makeModule({
      complexity: {
        total_functions: 3,
        max_nesting_depth: 1,
        avg_nesting_depth: 0.5,
        max_cyclomatic: 2,
        avg_cyclomatic: 1.5,
        max_function_loc: 10,
        hotspot_functions: [],
      },
      churn: { change_count: 1, last_changed: '2026-01-01', stability: 'stable' },
    });

    const result = computeRiskScore(mod, 0, 1.0, 10);
    expect(result.label).toBe('LOW');
    expect(result.score).toBeLessThanOrEqual(25);
  });

  it('returns HIGH for complex, volatile, untested module with many dependents', () => {
    const mod = makeModule({
      complexity: {
        total_functions: 20,
        max_nesting_depth: 5,
        avg_nesting_depth: 3,
        max_cyclomatic: 15,
        avg_cyclomatic: 8,
        max_function_loc: 200,
        hotspot_functions: ['badFn'],
      },
      churn: { change_count: 10, last_changed: '2026-04-01', stability: 'volatile' },
    });

    const result = computeRiskScore(mod, 8, 0.0, 10);
    expect(result.score).toBeGreaterThan(50);
    expect(['HIGH', 'CRITICAL']).toContain(result.label);
  });

  it('scores 0-25 per factor', () => {
    const mod = makeModule();
    const result = computeRiskScore(mod, 0, undefined, 10);
    expect(result.factors.complexity).toBeGreaterThanOrEqual(0);
    expect(result.factors.complexity).toBeLessThanOrEqual(25);
    expect(result.factors.churn).toBeGreaterThanOrEqual(0);
    expect(result.factors.churn).toBeLessThanOrEqual(25);
    expect(result.factors.coupling).toBeGreaterThanOrEqual(0);
    expect(result.factors.coupling).toBeLessThanOrEqual(25);
    expect(result.factors.coverage).toBeGreaterThanOrEqual(0);
    expect(result.factors.coverage).toBeLessThanOrEqual(25);
  });

  it('handles module with no complexity or churn data', () => {
    const mod = makeModule();
    const result = computeRiskScore(mod, 0, undefined, 10);
    // Only coverage (default 12) contributes
    expect(result.score).toBeLessThanOrEqual(25);
    expect(result.label).toBe('LOW');
  });
});
