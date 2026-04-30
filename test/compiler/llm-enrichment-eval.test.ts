import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import {
  buildLlmEnrichmentEvalRecord,
  writeLlmEnrichmentEvalReport,
} from '../../src/compiler/llm-enrichment-eval.js';
import {
  buildCallerAgentRunnerRequest,
  CALLER_AGENT_RUNNER_CONTRACT_VERSION,
  CALLER_AGENT_RUNNER_RESULT_VERSION,
  runCallerAgentRunner,
} from '../../src/compiler/caller-agent-runner.js';

describe('LLM enrichment eval harness', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-llm-eval-'));
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.cotx', 'agent'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.cotx', 'architecture', 'overall-architecture'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.cotx', 'v2'), { recursive: true });

    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Eval Fixture\n\nEntry: src/index.ts.\n', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'export const entry = true;\n', 'utf-8');
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'eval-fixture', scripts: { build: 'tsc', test: 'vitest' } }, null, 2),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(tmpDir, '.cotx', 'meta.yaml'),
      yaml.dump({
        version: '0.1',
        project: 'eval-fixture',
        compiled_at: '2026-04-13T00:00:00.000Z',
        stats: { modules: 1, concepts: 0, contracts: 0, flows: 0, concerns: 0 },
      }),
      'utf-8',
    );
    fs.writeFileSync(path.join(tmpDir, '.cotx', 'v2', 'truth.lbug'), '', 'utf-8');
    fs.writeFileSync(
      path.join(tmpDir, '.cotx', 'index.json'),
      JSON.stringify({
        graph: {
          nodes: [{ id: 'src/index.ts', layer: 'file', file: 'src/index.ts' }],
          edges: [],
        },
      }),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(tmpDir, '.cotx', 'architecture', 'meta.yaml'),
      yaml.dump({
        perspectives: ['overall-architecture'],
        generated_at: '2026-04-13T00:01:00.000Z',
        mode: 'auto',
        struct_hash: 'abc',
      }),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(tmpDir, '.cotx', 'architecture', 'overall-architecture', 'description.md'),
      '# Overall Architecture\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(tmpDir, '.cotx', 'agent', 'truth-corrections.jsonl'),
      `${JSON.stringify({
        schema_version: 'cotx.truth_correction_proposal.v1',
        created_at: '2026-04-13T01:02:00.000Z',
        layer: 'architecture',
        kind: 'architecture-description-gap',
        title: 'Improve generic architecture description',
        current_fact: 'owns code',
        proposed_fact: 'describe runtime responsibility from deterministic metadata',
        evidence_file_paths: ['src/index.ts'],
        confidence: 'high',
        suggested_test: 'Assert deterministic architecture descriptions use metadata before counts.',
      })}\n`,
      'utf-8',
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('builds a read-only deterministic rubric skeleton from onboarding and cotx sidecars', () => {
    const record = buildLlmEnrichmentEvalRecord({
      projectRoot: tmpDir,
      repo: 'fixture',
      task: 'explain architecture',
      generatedAt: '2026-04-13T01:00:00.000Z',
    });

    expect(record.schema_version).toBe('llm-enrichment-eval.v1');
    expect(record.layer).toBe('architecture');
    expect(record.read_only).toBe(true);
    expect(record.llm_calls).toBe(0);
    expect(record.execution.status).toBe('ready');
    expect(record.onboarding.source_count).toBeGreaterThan(0);
    expect(record.onboarding.has_storage_v2_truth).toBe(true);
    expect(record.onboarding.workspace_candidates).toBeGreaterThan(0);
    expect(record.observations[0]).toContain('workspace scan found');
    expect(record.cotx.compiled_at).toBe('2026-04-13T00:00:00.000Z');
    expect(record.architecture.perspectives).toEqual(['overall-architecture']);
    expect(record.truth_corrections.total).toBe(1);
    expect(record.truth_corrections.high_confidence).toBe(1);
    expect(record.truth_corrections.samples[0]).toMatchObject({
      kind: 'architecture-description-gap',
      layer: 'architecture',
      title: 'Improve generic architecture description',
    });
    expect(record.next_actions).toContain('promote high-confidence truth correction proposals into deterministic parser/compiler tests');
    expect(record.rubric.map((entry) => entry.dimension)).toEqual([
      'groundedness',
      'coverage',
      'architecture_usefulness',
      'agent_actionability',
      'brevity',
      'staleness_handling',
      'recursion_quality',
      'cost_latency',
    ]);
    expect(record.rubric.every((entry) => entry.score === null)).toBe(true);
  });

  it('writes markdown by default and JSONL only when requested', () => {
    const record = buildLlmEnrichmentEvalRecord({
      projectRoot: tmpDir,
      repo: 'fixture',
      generatedAt: '2026-04-13T01:00:00.000Z',
    });
    const outDir = path.join(tmpDir, 'out');

    const markdownOnly = writeLlmEnrichmentEvalReport([record], { outDir });
    expect(fs.existsSync(markdownOnly.markdown_path)).toBe(true);
    expect(markdownOnly.jsonl_path).toBeNull();
    const markdown = fs.readFileSync(markdownOnly.markdown_path, 'utf-8');
    expect(markdown).toContain('# LLM Enrichment Eval Baseline');
    expect(markdown).toContain('| fixture | architecture | cotx-deterministic | cotx | ready |');
    expect(markdown).toContain('Truth correction proposals');
    expect(markdown).toContain('Improve generic architecture description');

    const withJsonl = writeLlmEnrichmentEvalReport([record], { outDir, writeJsonl: true });
    expect(withJsonl.jsonl_path).not.toBeNull();
    expect(fs.readFileSync(withJsonl.jsonl_path!, 'utf-8')).toContain('"schema_version":"llm-enrichment-eval.v1"');
  });

  it('rejects invalid modes instead of silently falling back', () => {
    expect(() => buildLlmEnrichmentEvalRecord({
      projectRoot: tmpDir,
      mode: 'experimental' as any,
    })).toThrow('Invalid eval mode');
  });

  it('rejects invalid layers instead of silently falling back', () => {
    expect(() => buildLlmEnrichmentEvalRecord({
      projectRoot: tmpDir,
      layer: 'runtime' as any,
    })).toThrow('Invalid eval layer');
  });

  it('accepts oh-my-mermaid as external comparator mode without special core parsing', () => {
    const record = buildLlmEnrichmentEvalRecord({
      projectRoot: tmpDir,
      mode: 'oh-my-mermaid',
      generatedAt: '2026-04-13T01:00:00.000Z',
    });
    expect(record.product).toBe('oh-my-mermaid');
    expect(record.execution.status).toBe('not-run');
    expect(record.execution.blockers[0]).toContain('external comparator runner');
    expect(record.onboarding.source_count).toBeGreaterThan(0);
  });

  it('marks non-architecture built-in LLM rows ready without requiring architecture sidecars', () => {
    fs.rmSync(path.join(tmpDir, '.cotx', 'architecture'), { recursive: true, force: true });
    const record = buildLlmEnrichmentEvalRecord({
      projectRoot: tmpDir,
      mode: 'cotx-built-in-llm',
      layer: 'module',
      llmConfigured: true,
      generatedAt: '2026-04-13T01:00:00.000Z',
    });
    expect(record.execution.status).toBe('ready');
  });

  it('marks built-in LLM mode blocked when no LLM config is available', () => {
    const record = buildLlmEnrichmentEvalRecord({
      projectRoot: tmpDir,
      mode: 'cotx-built-in-llm',
      generatedAt: '2026-04-13T01:00:00.000Z',
    });
    expect(record.execution.status).toBe('blocked');
    expect(record.execution.blockers).toContain('no LLM config available for built-in LLM mode');
  });

  it('keeps caller-agent mode blocked until an explicit runner is configured', () => {
    const blocked = buildLlmEnrichmentEvalRecord({
      projectRoot: tmpDir,
      mode: 'cotx-caller-agent',
      generatedAt: '2026-04-13T01:00:00.000Z',
    });
    expect(blocked.execution.status).toBe('blocked');
    expect(blocked.execution.blockers).toContain('caller-agent runner is external and was not provided to this read-only harness');

    const ready = buildLlmEnrichmentEvalRecord({
      projectRoot: tmpDir,
      mode: 'cotx-caller-agent',
      runnerAvailable: true,
      generatedAt: '2026-04-13T01:00:00.000Z',
    });
    expect(ready.execution.status).toBe('ready');
  });

  it('builds a read-only caller-agent runner request from deterministic evidence', () => {
    const record = buildLlmEnrichmentEvalRecord({
      projectRoot: tmpDir,
      mode: 'cotx-caller-agent',
      runnerAvailable: true,
      generatedAt: '2026-04-13T01:00:00.000Z',
    });
    const request = buildCallerAgentRunnerRequest(record);
    expect(request.schema_version).toBe(CALLER_AGENT_RUNNER_CONTRACT_VERSION);
    expect(request.mode).toBe('cotx-caller-agent');
    expect(request.read_only).toBe(true);
    expect(request.constraints.join(' ')).toContain('Do not mutate .cotx truth graph facts');
    expect(request.constraints.join(' ')).toContain('do not rely on .lbug file hashes alone');
    expect(request.cotx.truth_graph_present).toBe(true);
    expect(request.required_output.schema_version).toBe(CALLER_AGENT_RUNNER_RESULT_VERSION);
  });

  it('runs configured caller-agent runners with JSON stdin and validates JSON stdout', async () => {
    const record = buildLlmEnrichmentEvalRecord({
      projectRoot: tmpDir,
      mode: 'cotx-caller-agent',
      runnerAvailable: true,
      generatedAt: '2026-04-13T01:00:00.000Z',
    });
    const runnerPath = path.join(tmpDir, 'fake-caller-agent-runner.mjs');
    fs.writeFileSync(
      runnerPath,
      [
        "let input = '';",
        'for await (const chunk of process.stdin) input += chunk;',
        'const request = JSON.parse(input);',
        `if (request.schema_version !== '${CALLER_AGENT_RUNNER_CONTRACT_VERSION}') process.exit(2);`,
        "if (request.read_only !== true) process.exit(3);",
        "if (process.env.COTX_CALLER_AGENT_READ_ONLY !== '1') process.exit(4);",
        'console.log(JSON.stringify({',
        `  schema_version: '${CALLER_AGENT_RUNNER_RESULT_VERSION}',`,
        "  status: 'passed',",
        "  summary: `inspected ${request.repo}/${request.layer} without mutating truth`,",
        "  evidence: [{ kind: 'file', ref: 'README.md' }],",
        "  observations: [`top hypotheses: ${request.onboarding.top_hypotheses.length}`],",
        '  llm_calls: 1,',
        '  token_estimate: 128,',
        '}));',
      ].join('\n'),
      'utf-8',
    );

    const invocation = await runCallerAgentRunner(record, {
      command: process.execPath,
      args: [runnerPath],
      timeoutMs: 10_000,
    });

    expect(invocation.configured).toBe(true);
    expect(invocation.status).toBe('passed');
    expect(invocation.exit_code).toBe(0);
    expect(invocation.result?.summary).toContain('without mutating truth');
    expect(invocation.result?.evidence?.[0]).toEqual({ kind: 'file', ref: 'README.md' });
    expect(invocation.errors).toEqual([]);
  });

  it('returns a not-configured caller-agent invocation instead of falling back', async () => {
    const record = buildLlmEnrichmentEvalRecord({
      projectRoot: tmpDir,
      mode: 'cotx-caller-agent',
      runnerAvailable: true,
      generatedAt: '2026-04-13T01:00:00.000Z',
    });
    const invocation = await runCallerAgentRunner(record, { timeoutMs: 10_000 });
    expect(invocation.configured).toBe(false);
    expect(invocation.status).toBe('not-configured');
    expect(invocation.errors[0]).toContain('caller-agent runner command not configured');
  });
});
