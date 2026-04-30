import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
  type FauxProviderRegistration,
} from '@mariozechner/pi-ai';
import {
  createPiAgentModel,
  runCotxLayerAnalysisAgent,
  runArchitectureBoundaryAgent,
} from '../../src/llm/agentic-architecture-enricher.js';
import { mentionsTruthCorrectionNeed } from '../../src/llm/agentic-runtime.js';
import { collectOnboardingContext } from '../../src/compiler/onboarding-context.js';
import type { ArchitectureRecursionPlan, ArchitectureWorkspaceData } from '../../src/store/schema.js';

describe('agentic architecture enricher', () => {
  let tmpDir: string | undefined;
  let registration: FauxProviderRegistration | undefined;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
    registration?.unregister();
    registration = undefined;
  });

  it('builds a LiteLLM OpenAI-compatible pi model from cotx LLM config', () => {
    const model = createPiAgentModel({
      base_url: 'http://100.101.242.26:4000/v1/',
      chat_model: 'vertex/gemini-2.5-flash',
      max_tokens: 300,
    });

    expect(model.api).toBe('openai-completions');
    expect(model.provider).toBe('litellm');
    expect(model.baseUrl).toBe('http://100.101.242.26:4000/v1');
    expect(model.id).toBe('vertex/gemini-2.5-flash');
    expect(model.maxTokens).toBeGreaterThanOrEqual(4096);
    expect(model.compat).toMatchObject({
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    });
  });

  it('builds a local OpenAI-compatible pi model for alternate providers', () => {
    const model = createPiAgentModel({
      base_url: 'http://localhost:11434/v1',
      chat_model: 'gpt-oss:20b',
    });

    expect(model.api).toBe('openai-completions');
    expect(model.provider).toBe('ollama');
    expect(model.id).toBe('gpt-oss:20b');
    expect(model.compat?.maxTokensField).toBe('max_tokens');
  });

  it('runs a pi-agent tool loop and returns a validated boundary review proposal', async () => {
    tmpDir = makeProject();
    registration = registerFauxProvider({
      provider: 'faux-boundary',
      models: [{ id: 'faux-boundary-model' }],
    });
    registration.setResponses([
      fauxAssistantMessage(
        fauxToolCall('workspace_scan', {}, { id: 'tool-1' }),
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage(
        fauxToolCall('grep', { pattern: 'runtime', path: '.', limit: 5, literal: true }, { id: 'tool-2' }),
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage(
        fauxToolCall('read', { path: 'README.md', limit: 40 }, { id: 'tool-3' }),
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage(
        fauxToolCall(
          'propose_boundary_patch',
          {
            decisions: [{
              element_id: 'container:docs',
              action: 'exclude_from_docs',
              reason: 'README is repository onboarding documentation, not a runtime container.',
              evidence_anchor_refs: ['file:README.md'],
            }],
          },
          { id: 'tool-4' },
        ),
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('Boundary patch submitted.'),
    ]);

    const result = await runArchitectureBoundaryAgent({
      projectRoot: tmpDir,
      workspace: makeWorkspace(),
      recursionPlan: makeRecursionPlan(),
      model: registration.getModel(),
    });

    expect(result.model.provider).toBe('faux-boundary');
    expect(result.tool_calls).toEqual([
      'workspace_scan',
      'grep',
      'read',
      'propose_boundary_patch',
    ]);
    expect(result.review.decisions).toEqual([{
      element_id: 'container:docs',
      action: 'exclude_from_docs',
      reason: 'README is repository onboarding documentation, not a runtime container.',
      evidence_anchor_refs: ['file:README.md'],
    }]);
  });

  it('runs the same agentic inspection runtime for non-architecture cotx layers', async () => {
    tmpDir = makeProject();
    registration = registerFauxProvider({
      provider: 'faux-module',
      models: [{ id: 'faux-module-model' }],
    });
    registration.setResponses([
      fauxAssistantMessage(
        fauxToolCall('ls', { path: 'src', limit: 20 }, { id: 'module-tool-1' }),
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage(
        fauxToolCall('grep', { pattern: 'runAgent', path: 'src', limit: 10, literal: true }, { id: 'module-tool-2' }),
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage(JSON.stringify({
        summary: 'The module layer should treat src/agent as a runtime agent package.',
        graph_gap_proposals: [],
        evidence_refs: ['src/agent/index.ts:1'],
      })),
    ]);

    const result = await runCotxLayerAnalysisAgent({
      projectRoot: tmpDir,
      layer: 'module',
      task: 'Analyze whether module enrichment should refine the src/agent package.',
      referenceContext: { deterministic_module: 'agent' },
      model: registration.getModel(),
    });

    expect(result.layer).toBe('module');
    expect(result.tool_calls).toEqual(['ls', 'grep']);
    expect(result.raw_output).toContain('src/agent');
    expect(result.model.provider).toBe('faux-module');
    expect(result.truth_correction_proposals).toEqual([]);
  });

  it('requires non-architecture layer agents to inspect repository tools by default', async () => {
    tmpDir = makeProject();
    registration = registerFauxProvider({
      provider: 'faux-layer-retry',
      models: [{ id: 'faux-layer-retry-model' }],
    });
    registration.setResponses([
      fauxAssistantMessage(JSON.stringify({ summary: 'No tools yet.' })),
      fauxAssistantMessage(
        fauxToolCall('workspace_scan', {}, { id: 'layer-retry-tool-1' }),
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage(
        fauxToolCall('grep', { pattern: 'runAgent', path: 'src', limit: 5, literal: true }, { id: 'layer-retry-tool-2' }),
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage(JSON.stringify({ summary: 'Inspected repository evidence.' })),
    ]);

    const result = await runCotxLayerAnalysisAgent({
      projectRoot: tmpDir,
      layer: 'module',
      task: 'Analyze module facts.',
      model: registration.getModel(),
    });

    expect(result.tool_calls).toEqual(['workspace_scan', 'grep']);
    expect(result.raw_output).toContain('Inspected repository evidence');
  });

  it('does not force proposal recording for negated graph-gap summaries', async () => {
    tmpDir = makeProject();
    registration = registerFauxProvider({
      provider: 'faux-no-gap',
      models: [{ id: 'faux-no-gap-model' }],
    });
    registration.setResponses([
      fauxAssistantMessage(
        fauxToolCall('workspace_scan', {}, { id: 'no-gap-tool-1' }),
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('No graph gaps were identified; no truth correction proposal is warranted.'),
    ]);

    const result = await runCotxLayerAnalysisAgent({
      projectRoot: tmpDir,
      layer: 'module',
      task: 'Analyze module facts.',
      model: registration.getModel(),
    });

    expect(result.truth_correction_proposals).toEqual([]);
    expect(result.truth_correction_events).toEqual([]);
    expect(result.raw_output).toContain('No graph gaps');
  });

  it('forces a final synthesis when a layer agent uses tools but returns empty text', async () => {
    tmpDir = makeProject();
    registration = registerFauxProvider({
      provider: 'faux-empty-final',
      models: [{ id: 'faux-empty-final-model' }],
    });
    registration.setResponses([
      fauxAssistantMessage(
        fauxToolCall('workspace_scan', {}, { id: 'empty-final-tool-1' }),
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage(''),
      fauxAssistantMessage('Final grounded synthesis after tool inspection.'),
    ]);

    const result = await runCotxLayerAnalysisAgent({
      projectRoot: tmpDir,
      layer: 'module',
      task: 'Analyze module facts.',
      model: registration.getModel(),
    });

    expect(result.tool_calls).toEqual(['workspace_scan']);
    expect(result.raw_output).toBe('Final grounded synthesis after tool inspection.');
  });

  it('fails when a layer agent still returns empty text after synthesis retry', async () => {
    tmpDir = makeProject();
    registration = registerFauxProvider({
      provider: 'faux-empty-final-fail',
      models: [{ id: 'faux-empty-final-fail-model' }],
    });
    registration.setResponses([
      fauxAssistantMessage(
        fauxToolCall('workspace_scan', {}, { id: 'empty-final-fail-tool-1' }),
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage(''),
      fauxAssistantMessage(''),
    ]);

    await expect(runCotxLayerAnalysisAgent({
      projectRoot: tmpDir,
      layer: 'module',
      task: 'Analyze module facts.',
      model: registration.getModel(),
    })).rejects.toThrow(/empty final answer.*tools=workspace_scan.*assistant_turns=.*stop=toolUse/s);
  });

  it('records truth correction proposals for deterministic engine improvement', async () => {
    tmpDir = makeProject();
    registration = registerFauxProvider({
      provider: 'faux-gap',
      models: [{ id: 'faux-gap-model' }],
    });
    registration.setResponses([
      fauxAssistantMessage(
        fauxToolCall(
          'propose_truth_correction',
          {
            kind: 'architecture-grouping-gap',
            title: 'Directory pseudo path should not become architecture component source',
            current_fact: 'agent/tools is treated like a source file',
            proposed_fact: 'Only real source files should participate in architecture grouping.',
            evidence_file_paths: ['src/agent/index.ts'],
            evidence_refs: ['file:src/agent/index.ts'],
            suggested_test: 'Add a compiler fixture with a directory pseudo-path and assert no repeated groups.',
            confidence: 'high',
          },
          { id: 'gap-tool-1' },
        ),
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage(JSON.stringify({ summary: 'Recorded graph gap.' })),
    ]);

    const result = await runCotxLayerAnalysisAgent({
      projectRoot: tmpDir,
      layer: 'architecture',
      task: 'Record a deterministic grouping gap.',
      model: registration.getModel(),
    });

    expect(result.tool_calls).toEqual(['propose_truth_correction']);
    expect(result.truth_correction_proposals).toHaveLength(1);
    expect(result.truth_correction_proposals[0]).toMatchObject({
      kind: 'architecture-grouping-gap',
      confidence: 'high',
    });
    const jsonl = fs.readFileSync(path.join(tmpDir, '.cotx', 'agent', 'truth-corrections.jsonl'), 'utf-8');
    expect(jsonl).toContain('cotx.truth_correction_proposal.v1');
    expect(jsonl).toContain('architecture-grouping-gap');
  });

  it('rejects non-file evidence as a proposal state and lets the agent retry with file evidence', async () => {
    tmpDir = makeProject();
    registration = registerFauxProvider({
      provider: 'faux-invalid-evidence-retry',
      models: [{ id: 'faux-invalid-evidence-retry-model' }],
    });
    registration.setResponses([
      fauxAssistantMessage(
        fauxToolCall(
          'propose_truth_correction',
          {
            kind: 'missing-node',
            title: 'Missing fixtures directory',
            current_fact: 'The onboarding context marks fixtures as a graph gap.',
            proposed_fact: 'The fixtures path should be indexed when it contains source fixtures.',
            evidence_file_paths: ['onboarding_context_response'],
            evidence_refs: ['onboarding_context.summary.consistency_counts.graph-gap'],
            confidence: 'high',
          },
          { id: 'invalid-evidence-tool-1' },
        ),
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('A graph gap was identified, but the truth correction proposal was rejected by validation.'),
      fauxAssistantMessage(
        fauxToolCall(
          'propose_truth_correction',
          {
            kind: 'missing-node',
            title: 'Missing fixtures directory',
            current_fact: 'The onboarding context marks fixtures as a graph gap.',
            proposed_fact: 'The fixtures path should be indexed when it contains source fixtures.',
            evidence_file_paths: ['src/agent'],
            evidence_refs: ['onboarding_context.summary.consistency_counts.graph-gap'],
            confidence: 'high',
          },
          { id: 'invalid-evidence-tool-2' },
        ),
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('Recorded the corrected truth correction proposal with real file evidence.'),
    ]);
    const onboarding = collectOnboardingContext(tmpDir, {
      budget: 'tiny',
      includeExcerpts: false,
    });

    const result = await runCotxLayerAnalysisAgent({
      projectRoot: tmpDir,
      layer: 'module',
      task: 'Analyze module graph gaps.',
      model: registration.getModel(),
      onboarding: {
        ...onboarding,
        summary: {
          ...onboarding.summary,
          graph_file_index_status: 'complete',
        },
      },
      requireTruthCorrectionProposals: true,
    });

    expect(result.truth_correction_events.map((event) => event.status)).toEqual(['rejected', 'recorded']);
    expect(result.truth_correction_events[0].errors?.[0]).toContain('Evidence path does not exist');
    expect(result.truth_correction_proposals).toHaveLength(1);
    expect(result.truth_correction_proposals[0].evidence_file_paths).toEqual(['src/agent']);
    const jsonl = fs.readFileSync(path.join(tmpDir, '.cotx', 'agent', 'truth-corrections.jsonl'), 'utf-8').trim().split('\n');
    expect(jsonl).toHaveLength(1);
    expect(jsonl[0]).not.toContain('onboarding_context_response');
  });

  it('rejects graph-gap proposals when onboarding reports a partial graph index', async () => {
    tmpDir = makeProject();
    registration = registerFauxProvider({
      provider: 'faux-partial-index',
      models: [{ id: 'faux-partial-index-model' }],
    });
    registration.setResponses([
      fauxAssistantMessage(
        fauxToolCall(
          'propose_truth_correction',
          {
            kind: 'missing-node',
            title: 'Missing src/agent index node',
            proposed_fact: 'src/agent/index.ts should be in graph',
            evidence_file_paths: ['src/agent/index.ts'],
            confidence: 'high',
          },
          { id: 'partial-index-tool-1' },
        ),
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('A graph gap was identified, but the graph file index is partial so no proposal is warranted yet.'),
    ]);
    const onboarding = collectOnboardingContext(tmpDir, {
      budget: 'tiny',
      includeExcerpts: false,
    });

    const result = await runCotxLayerAnalysisAgent({
      projectRoot: tmpDir,
      layer: 'module',
      task: 'Analyze module graph gaps.',
      model: registration.getModel(),
      onboarding: {
        ...onboarding,
        summary: {
          ...onboarding.summary,
          graph_file_index_status: 'partial',
        },
      },
      requireTruthCorrectionProposals: true,
    });

    expect(result.truth_correction_proposals).toEqual([]);
    expect(result.truth_correction_events[0]).toMatchObject({
      status: 'rejected',
      errors: [expect.stringContaining('GRAPH_FILE_INDEX_INCOMPLETE')],
    });
    expect(result.raw_output).toContain('partial');
    expect(fs.existsSync(path.join(tmpDir, '.cotx', 'agent', 'truth-corrections.jsonl'))).toBe(false);
  });

  it('accepts the strict no-proposal path after onboarding_context inspection', async () => {
    tmpDir = makeProject();
    registration = registerFauxProvider({
      provider: 'faux-partial-index-no-call',
      models: [{ id: 'faux-partial-index-no-call-model' }],
    });
    registration.setResponses([
      fauxAssistantMessage(
        fauxToolCall('onboarding_context', {}, { id: 'partial-index-no-call-tool-1' }),
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('The graph file index is partial, so this remains unknown evidence; no truth correction proposal is warranted until graph evidence is complete.'),
    ]);
    const onboarding = collectOnboardingContext(tmpDir, {
      budget: 'tiny',
      includeExcerpts: false,
    });

    const result = await runCotxLayerAnalysisAgent({
      projectRoot: tmpDir,
      layer: 'module',
      task: 'Analyze module graph gaps.',
      model: registration.getModel(),
      onboarding: {
        ...onboarding,
        summary: {
          ...onboarding.summary,
          graph_file_index_status: 'partial',
        },
      },
      requireToolUse: false,
      requireTruthCorrectionProposals: true,
    });

    expect(result.tool_calls).toEqual(['onboarding_context']);
    expect(result.truth_correction_proposals).toEqual([]);
    expect(result.truth_correction_events).toEqual([]);
    expect(result.raw_output).toContain('unknown evidence');
  });

  it('does not accept strict no-proposal wording after unrelated tool use without onboarding inspection or rejected attempts', async () => {
    tmpDir = makeProject();
    registration = registerFauxProvider({
      provider: 'faux-partial-index-wording-only',
      models: [{ id: 'faux-partial-index-wording-only-model' }],
    });
    registration.setResponses([
      fauxAssistantMessage(
        fauxToolCall('workspace_scan', {}, { id: 'partial-index-wording-only-tool-1' }),
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('A graph gap was identified, but the graph file index is partial, so this remains unknown evidence; no truth correction proposal is warranted until graph evidence is complete.'),
      fauxAssistantMessage('A graph gap was identified, but the graph file index is partial, so this remains unknown evidence; no truth correction proposal is warranted until graph evidence is complete.'),
    ]);

    await expect(runCotxLayerAnalysisAgent({
      projectRoot: tmpDir,
      layer: 'module',
      task: 'Analyze module graph gaps.',
      model: registration.getModel(),
      requireToolUse: false,
      requireTruthCorrectionProposals: true,
    })).rejects.toThrow('did not record a truth correction proposal');
  });

  it('forces proposal recording when final text mentions a graph gap', async () => {
    tmpDir = makeProject();
    registration = registerFauxProvider({
      provider: 'faux-gap-retry',
      models: [{ id: 'faux-gap-retry-model' }],
    });
    registration.setResponses([
      fauxAssistantMessage(
        fauxToolCall('workspace_scan', {}, { id: 'gap-retry-tool-1' }),
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('Correction Proposal: graph gap detected for source grouping.'),
      fauxAssistantMessage(
        fauxToolCall(
          'propose_truth_correction',
          {
            kind: 'compiler-gap',
            title: 'Source grouping gap',
            proposed_fact: 'The compiler should preserve this source grouping.',
            evidence_file_paths: ['src/agent/index.ts'],
            suggested_test: 'Add a deterministic source grouping fixture.',
            confidence: 'medium',
          },
          { id: 'gap-retry-tool-2' },
        ),
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('Recorded the truth correction proposal.'),
    ]);

    const result = await runCotxLayerAnalysisAgent({
      projectRoot: tmpDir,
      layer: 'module',
      task: 'Analyze module grouping.',
      model: registration.getModel(),
      requireTruthCorrectionProposals: true,
    });

    expect(result.tool_calls).toEqual(['workspace_scan', 'propose_truth_correction']);
    expect(result.truth_correction_proposals).toHaveLength(1);
    expect(result.raw_output).toContain('Recorded');
  });

  it('does not block core analysis when a layer agent mentions a graph gap without an optional proposal', async () => {
    tmpDir = makeProject();
    registration = registerFauxProvider({
      provider: 'faux-gap-no-record-optional',
      models: [{ id: 'faux-gap-no-record-optional-model' }],
    });
    registration.setResponses([
      fauxAssistantMessage(
        fauxToolCall('workspace_scan', {}, { id: 'gap-no-record-optional-tool-1' }),
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('Correction Proposal: graph gap detected for source grouping.'),
    ]);

    const result = await runCotxLayerAnalysisAgent({
      projectRoot: tmpDir,
      layer: 'module',
      task: 'Analyze module grouping.',
      model: registration.getModel(),
    });

    expect(result.raw_output).toContain('graph gap');
    expect(result.truth_correction_proposals).toEqual([]);
  });

  it('can enforce proposal recording in strict benchmark mode', async () => {
    tmpDir = makeProject();
    registration = registerFauxProvider({
      provider: 'faux-gap-no-record',
      models: [{ id: 'faux-gap-no-record-model' }],
    });
    registration.setResponses([
      fauxAssistantMessage(
        fauxToolCall('workspace_scan', {}, { id: 'gap-no-record-tool-1' }),
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('Correction Proposal: graph gap detected for source grouping.'),
      fauxAssistantMessage('Here are the truth correction proposals for the graph gap:'),
    ]);

    await expect(runCotxLayerAnalysisAgent({
      projectRoot: tmpDir,
      layer: 'module',
      task: 'Analyze module grouping.',
      model: registration.getModel(),
      requireTruthCorrectionProposals: true,
    })).rejects.toThrow('did not record a truth correction proposal');
  });

  it('deduplicates repeated truth correction proposals in one agent run', async () => {
    tmpDir = makeProject();
    registration = registerFauxProvider({
      provider: 'faux-gap-dedupe',
      models: [{ id: 'faux-gap-dedupe-model' }],
    });
    const proposal = {
      kind: 'compiler-gap',
      title: 'Source grouping gap',
      proposed_fact: 'The compiler should preserve this source grouping.',
      evidence_file_paths: ['src/agent/index.ts'],
      confidence: 'medium',
    };
    registration.setResponses([
      fauxAssistantMessage(fauxToolCall('propose_truth_correction', proposal, { id: 'dedupe-tool-1' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxToolCall('propose_truth_correction', proposal, { id: 'dedupe-tool-2' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('Recorded once.'),
    ]);

    const result = await runCotxLayerAnalysisAgent({
      projectRoot: tmpDir,
      layer: 'module',
      task: 'Analyze module grouping.',
      model: registration.getModel(),
    });

    expect(result.tool_calls).toEqual(['propose_truth_correction', 'propose_truth_correction']);
    expect(result.truth_correction_proposals).toHaveLength(1);
    const jsonl = fs.readFileSync(path.join(tmpDir, '.cotx', 'agent', 'truth-corrections.jsonl'), 'utf-8').trim().split('\n');
    expect(jsonl).toHaveLength(1);
  });

  it('treats repeated truth correction proposals across runs as duplicate queue state', async () => {
    tmpDir = makeProject();
    registration = registerFauxProvider({
      provider: 'faux-gap-existing-dedupe',
      models: [{ id: 'faux-gap-existing-dedupe-model' }],
    });
    const proposal = {
      kind: 'compiler-gap',
      title: 'Source grouping gap',
      proposed_fact: 'The compiler should preserve this source grouping.',
      evidence_file_paths: ['src/agent/index.ts'],
      confidence: 'medium',
    };

    registration.setResponses([
      fauxAssistantMessage(fauxToolCall('propose_truth_correction', proposal, { id: 'existing-dedupe-tool-1' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('Recorded once.'),
      fauxAssistantMessage(fauxToolCall('propose_truth_correction', proposal, { id: 'existing-dedupe-tool-2' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('Duplicate proposal already exists.'),
    ]);

    const first = await runCotxLayerAnalysisAgent({
      projectRoot: tmpDir,
      layer: 'module',
      task: 'Analyze module grouping.',
      model: registration.getModel(),
    });
    const second = await runCotxLayerAnalysisAgent({
      projectRoot: tmpDir,
      layer: 'module',
      task: 'Analyze module grouping again.',
      model: registration.getModel(),
    });

    expect(first.truth_correction_events.map((event) => event.status)).toEqual(['recorded']);
    expect(second.truth_correction_events.map((event) => event.status)).toEqual(['duplicate']);
    expect(second.truth_correction_proposals).toEqual([]);
    const jsonl = fs.readFileSync(path.join(tmpDir, '.cotx', 'agent', 'truth-corrections.jsonl'), 'utf-8').trim().split('\n');
    expect(jsonl).toHaveLength(1);
  });

  it('corrects final text that claims proposal failure after successful recording', async () => {
    tmpDir = makeProject();
    registration = registerFauxProvider({
      provider: 'faux-gap-contradiction',
      models: [{ id: 'faux-gap-contradiction-model' }],
    });
    registration.setResponses([
      fauxAssistantMessage(
        fauxToolCall(
          'propose_truth_correction',
          {
            kind: 'compiler-gap',
            title: 'Source grouping gap',
            proposed_fact: 'The compiler should preserve this source grouping.',
            evidence_file_paths: ['src/agent/index.ts'],
            confidence: 'medium',
          },
          { id: 'contradiction-tool-1' },
        ),
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('I was unable to successfully call propose_truth_correction due to a validation error.'),
      fauxAssistantMessage('Recorded the compiler-gap proposal successfully.'),
    ]);

    const result = await runCotxLayerAnalysisAgent({
      projectRoot: tmpDir,
      layer: 'module',
      task: 'Analyze module grouping.',
      model: registration.getModel(),
    });

    expect(result.truth_correction_proposals).toHaveLength(1);
    expect(result.raw_output).toBe('Recorded the compiler-gap proposal successfully.');
  });

  it('fails when final text still claims proposal failure after successful recording', async () => {
    tmpDir = makeProject();
    registration = registerFauxProvider({
      provider: 'faux-gap-still-contradicts',
      models: [{ id: 'faux-gap-still-contradicts-model' }],
    });
    registration.setResponses([
      fauxAssistantMessage(
        fauxToolCall(
          'propose_truth_correction',
          {
            kind: 'compiler-gap',
            title: 'Source grouping gap',
            proposed_fact: 'The compiler should preserve this source grouping.',
            evidence_file_paths: ['src/agent/index.ts'],
            confidence: 'medium',
          },
          { id: 'still-contradicts-tool-1' },
        ),
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('I was unable to successfully call propose_truth_correction due to a validation error.'),
      fauxAssistantMessage('I still could not record the proposal due to a validation error.'),
    ]);

    await expect(runCotxLayerAnalysisAgent({
      projectRoot: tmpDir,
      layer: 'module',
      task: 'Analyze module grouping.',
      model: registration.getModel(),
      requireTruthCorrectionProposals: true,
    })).rejects.toThrow('final answer still claims proposal recording failed');
  });

  it('accepts architecture description gap proposals for deterministic auto-description improvements', async () => {
    tmpDir = makeProject();
    registration = registerFauxProvider({
      provider: 'faux-description-gap',
      models: [{ id: 'faux-description-gap-model' }],
    });
    registration.setResponses([
      fauxAssistantMessage(
        fauxToolCall(
          'propose_truth_correction',
          {
            kind: 'architecture-description-gap',
            title: 'Generic architecture description',
            current_fact: 'Description says only owns code and exported count.',
            proposed_fact: 'Description should use deterministic function names and contracts to summarize runtime responsibility.',
            evidence_file_paths: ['src/agent/index.ts'],
            evidence_refs: ['file:src/agent/index.ts'],
            suggested_test: 'Assert deterministic architecture descriptions avoid exported-count summaries when metadata has function names.',
            confidence: 'high',
          },
          { id: 'description-gap-tool-1' },
        ),
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('Recorded architecture description gap.'),
    ]);

    const result = await runCotxLayerAnalysisAgent({
      projectRoot: tmpDir,
      layer: 'architecture',
      task: 'Record deterministic description gap.',
      model: registration.getModel(),
    });

    expect(result.truth_correction_proposals[0].kind).toBe('architecture-description-gap');
  });

  it('classifies positive and negated truth-correction language separately', () => {
    expect(mentionsTruthCorrectionNeed('No graph gaps were identified; no correction proposal is warranted.')).toBe(false);
    expect(mentionsTruthCorrectionNeed('A graph gap was identified for src/runtime and needs a truth correction proposal.')).toBe(true);
    expect(mentionsTruthCorrectionNeed('Correction Proposal: graph gap detected for source grouping.')).toBe(true);
  });

  it('can parse a final JSON boundary review when the model does not use the proposal tool', async () => {
    tmpDir = makeProject();
    registration = registerFauxProvider({
      provider: 'faux-json',
      models: [{ id: 'faux-json-model' }],
    });
    registration.setResponses([
      fauxAssistantMessage(JSON.stringify({
        decisions: [{
          element_id: 'container:agent',
          action: 'keep',
          reason: 'Agent source path is a runtime package boundary.',
          evidence_anchor_refs: ['file:src/agent/index.ts'],
        }],
      })),
    ]);

    const result = await runArchitectureBoundaryAgent({
      projectRoot: tmpDir,
      workspace: makeWorkspace(),
      recursionPlan: makeRecursionPlan(),
      model: registration.getModel(),
      requireToolUse: false,
    });

    expect(result.tool_calls).toEqual([]);
    expect(result.review.decisions[0]).toMatchObject({
      element_id: 'container:agent',
      action: 'keep',
    });
  });

  it('requires boundary agents to inspect repository tools before accepting a review by default', async () => {
    tmpDir = makeProject();
    registration = registerFauxProvider({
      provider: 'faux-retry',
      models: [{ id: 'faux-retry-model' }],
    });
    registration.setResponses([
      fauxAssistantMessage(JSON.stringify({ decisions: [] })),
      fauxAssistantMessage(
        fauxToolCall('workspace_scan', {}, { id: 'retry-tool-1' }),
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage(
        fauxToolCall('onboarding_context', {}, { id: 'retry-tool-2' }),
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage(
        fauxToolCall('propose_boundary_patch', { decisions: [] }, { id: 'retry-tool-3' }),
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('Inspected repository evidence; no boundary changes.'),
    ]);

    const result = await runArchitectureBoundaryAgent({
      projectRoot: tmpDir,
      workspace: makeWorkspace(),
      recursionPlan: makeRecursionPlan(),
      model: registration.getModel(),
    });

    expect(result.tool_calls).toEqual(['workspace_scan', 'onboarding_context', 'propose_boundary_patch']);
    expect(result.review.decisions).toEqual([]);
  });
});

function makeProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-agentic-arch-'));
  fs.mkdirSync(path.join(root, 'src', 'agent'), { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), 'This repository has a runtime AI agent under src/agent.\n', 'utf-8');
  fs.writeFileSync(path.join(root, 'src', 'agent', 'index.ts'), 'export function runAgent() { return true; }\n', 'utf-8');
  return root;
}

function makeWorkspace(): ArchitectureWorkspaceData {
  return {
    schema_version: 'cotx.architecture.workspace.v1',
    generated_at: '2026-04-13T00:00:00.000Z',
    source_graph_compiled_at: '2026-04-13T00:00:00.000Z',
    elements: [
      {
        id: 'system:test',
        name: 'test',
        level: 'software_system',
        evidence: [{ kind: 'file', id: 'README.md', filePath: 'README.md' }],
        review_status: 'draft',
      },
      {
        id: 'container:docs',
        name: 'Docs',
        level: 'container',
        parent_id: 'system:test',
        source_paths: ['README.md'],
        evidence: [{ kind: 'file', id: 'README.md', filePath: 'README.md' }],
        review_status: 'draft',
      },
      {
        id: 'container:agent',
        name: 'Agent',
        level: 'container',
        parent_id: 'system:test',
        source_paths: ['src/agent'],
        evidence: [{ kind: 'file', id: 'src/agent/index.ts', filePath: 'src/agent/index.ts' }],
        review_status: 'draft',
      },
    ],
    relationships: [],
    views: [],
  };
}

function makeRecursionPlan(): ArchitectureRecursionPlan {
  return {
    schema_version: 'cotx.architecture.recursion_plan.v1',
    generated_at: '2026-04-13T00:01:00.000Z',
    source_workspace_generated_at: '2026-04-13T00:00:00.000Z',
    decisions: [
      {
        element_id: 'system:test',
        action: 'recurse',
        reason: 'system has children',
        child_element_ids: ['container:docs', 'container:agent'],
        evidence: [{ kind: 'file', id: 'README.md', filePath: 'README.md' }],
      },
      {
        element_id: 'container:docs',
        action: 'leaf',
        reason: 'single doc file',
        child_element_ids: [],
        evidence: [{ kind: 'file', id: 'README.md', filePath: 'README.md' }],
      },
      {
        element_id: 'container:agent',
        action: 'leaf',
        reason: 'single source package',
        child_element_ids: [],
        evidence: [{ kind: 'file', id: 'src/agent/index.ts', filePath: 'src/agent/index.ts' }],
      },
    ],
  };
}
