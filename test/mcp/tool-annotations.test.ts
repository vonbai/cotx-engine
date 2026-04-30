import { describe, it, expect } from 'vitest';
import { COTX_TOOLS } from '../../src/mcp/tools.js';

describe('COTX_TOOLS annotations', () => {
  it('every tool has an annotations block', () => {
    for (const tool of COTX_TOOLS) {
      expect(tool.annotations, `missing annotations on ${tool.name}`).toBeDefined();
    }
  });

  it('every tool description carries a role prefix tag', () => {
    const allowedPrefixes = /^\[(INDEX|BOOTSTRAP|READ|GRAPH|PLAN|REVIEW|WRITE)\]/;
    for (const tool of COTX_TOOLS) {
      expect(tool.description, `${tool.name} description missing role prefix`).toMatch(allowedPrefixes);
    }
  });

  it('read-only tools are marked readOnlyHint=true', () => {
    const readOnly = new Set([
      'cotx_query',
      'cotx_context',
      'cotx_impact',
      'cotx_map',
      'cotx_lint',
      'cotx_diff',
      'cotx_doctrine',
      'cotx_cypher',
      'cotx_decision_query',
      'cotx_canonical_paths',
      'cotx_route_map',
      'cotx_shape_check',
      'cotx_api_impact',
      'cotx_tool_map',
      'cotx_detect_changes',
      'cotx_plan_change',
      'cotx_review_change',
      'cotx_onboarding_context',
      'cotx_minimal_context',
    ]);
    for (const tool of COTX_TOOLS) {
      if (readOnly.has(tool.name)) {
        expect(tool.annotations?.readOnlyHint, `${tool.name} should be readOnly`).toBe(true);
      }
    }
  });

  it('cotx_compile and cotx_write are idempotent but not readOnly', () => {
    const compile = COTX_TOOLS.find((t) => t.name === 'cotx_compile');
    const write = COTX_TOOLS.find((t) => t.name === 'cotx_write');
    expect(compile?.annotations?.idempotentHint).toBe(true);
    expect(compile?.annotations?.readOnlyHint).toBeUndefined();
    expect(write?.annotations?.idempotentHint).toBe(true);
    expect(write?.annotations?.readOnlyHint).toBeUndefined();
  });

  it('cotx_prepare_task is marked idempotent (may auto-refresh)', () => {
    const prepare = COTX_TOOLS.find((t) => t.name === 'cotx_prepare_task');
    expect(prepare?.annotations?.idempotentHint).toBe(true);
    expect(prepare?.annotations?.readOnlyHint).toBeUndefined();
  });
});
