import { describe, it, expect } from 'vitest';
import { COTX_PROMPTS, getCotxPrompt } from '../../src/mcp/prompts.js';

describe('cotx MCP prompts', () => {
  it('declares bounded prompt workflows', () => {
    expect(COTX_PROMPTS.map((prompt) => prompt.name)).toEqual([
      'cotx_onboard_agent',
      'cotx_architecture_scan',
      'cotx_enrich_architecture',
      'cotx_pre_merge_check',
      'cotx_review_changes',
      'cotx_codrive_workflow',
    ]);
  });

  it('builds architecture scan prompt text around cotx tools', () => {
    const prompt = getCotxPrompt('cotx_architecture_scan', {
      project_root: '/repo',
      focus: 'compiler',
    });
    expect(prompt?.messages[0].content.text).toContain('cotx_prepare_task');
    expect(prompt?.messages[0].content.text).toContain('cotx_map');
    expect(prompt?.messages[0].content.text).toContain('Project root: /repo');
  });

  it('returns null for unknown prompts', () => {
    expect(getCotxPrompt('missing', {})).toBeNull();
  });

  it('builds co-driving workflow prompt through planning and review', () => {
    const prompt = getCotxPrompt('cotx_codrive_workflow', {
      project_root: '/repo',
      task: 'change API response',
      files: 'src/api.ts',
    });
    const text = prompt?.messages[0].content.text ?? '';
    expect(text).toContain('cotx_prepare_task');
    expect(text).toContain('cotx_plan_change');
    expect(text).toContain('cotx_detect_changes');
    expect(text).toContain('typed-graph-unavailable');
    expect(text).toContain('storage-v2 truth');
    expect(text).toContain('stale-doc');
    expect(text).toContain('Project root: /repo');
  });
});
