import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

describe('run-agentic-llm-smoke script', () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it('keeps failed agent-analyze rows failed while reporting stdout and stderr tails', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-agentic-smoke-test-'));
    const projectRoot = path.join(tmpDir, 'fixture');
    const outDir = path.join(tmpDir, 'out');
    const fakeCotxBin = path.join(tmpDir, 'fake-cotx.mjs');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(
      fakeCotxBin,
      [
        "const [command] = process.argv.slice(2);",
        "if (command !== 'agent-analyze') {",
        "  console.error(`unexpected command: ${command}`);",
        '  process.exit(2);',
        '}',
        "console.log('Running fake cotx decision analysis');",
        "console.log('  [retry] decision agent used tools but returned an empty final answer; requiring synthesis');",
        "console.error('decision agent used tools but returned an empty final answer after synthesis retry.');",
        'process.exit(1);',
      ].join('\n'),
      'utf-8',
    );

    execFileSync(process.execPath, [
      path.join(process.cwd(), 'scripts', 'run-agentic-llm-smoke.mjs'),
      '--project-root',
      projectRoot,
      '--cotx-bin',
      fakeCotxBin,
      '--layers',
      'decision',
      '--out-dir',
      outDir,
      '--timeout-ms',
      '10000',
    ], { cwd: process.cwd(), encoding: 'utf-8' });

    const markdown = fs.readFileSync(path.join(outDir, 'agentic-llm-smoke.md'), 'utf-8');
    const [record] = fs.readFileSync(path.join(outDir, 'agentic-llm-smoke.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

    expect(record.status).toBe('failed');
    expect(record.agent.stdout_tail).toContain('[retry] decision agent used tools');
    expect(record.agent.stderr_tail).toContain('empty final answer after synthesis retry');
    expect(markdown).toContain('| fixture | decision | failed |');
    expect(markdown).toContain('Agent diagnostics:');
    expect(markdown).toContain('tool_context: agent reported tool use before JSON result; inspect stdout/stderr tails below');
    expect(markdown).toContain('stdout tail:');
    expect(markdown).toContain('[retry] decision agent used tools');
    expect(markdown).toContain('stderr tail:');
    expect(markdown).toContain('empty final answer after synthesis retry');
  });

  it('records stable logical truth graph facts for passed rows', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-agentic-smoke-test-'));
    const projectRoot = path.join(tmpDir, 'fixture');
    const outDir = path.join(tmpDir, 'out');
    const fakeCotxBin = path.join(tmpDir, 'fake-cotx.mjs');
    fs.mkdirSync(path.join(projectRoot, '.cotx', 'v2'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.cotx', 'v2', 'truth.lbug'), 'metadata may move\n', 'utf-8');
    fs.writeFileSync(
      fakeCotxBin,
      [
        'const [command, ...args] = process.argv.slice(2);',
        "if (command === 'cypher') {",
        "  const query = args.join(' ');",
        "  const count = query.includes('CodeRelation') ? 7 : query.includes('CodeNode') ? 5 : query.includes('[r]') ? 11 : 13;",
        "  console.log(JSON.stringify({ query, row_count: 1, rows: [{ count }] }));",
        '  process.exit(0);',
        '}',
        "if (command === 'agent-analyze') {",
        "  console.log(JSON.stringify({ raw_output: 'stable analysis', tool_calls: ['onboarding_context'], truth_correction_proposals: [] }));",
        '  process.exit(0);',
        '}',
        "if (command === 'truth-corrections' && args.includes('--json')) {",
        "  console.log(JSON.stringify({ total: 0, high_confidence: 0, samples: [] }));",
        '  process.exit(0);',
        '}',
        "if (command === 'truth-corrections' && args.includes('--validate')) {",
        "  console.log(JSON.stringify({ ok: true, findings: [] }));",
        '  process.exit(0);',
        '}',
        "console.error(`unexpected command: ${command}`);",
        'process.exit(2);',
      ].join('\n'),
      'utf-8',
    );

    execFileSync(process.execPath, [
      path.join(process.cwd(), 'scripts', 'run-agentic-llm-smoke.mjs'),
      '--project-root',
      projectRoot,
      '--cotx-bin',
      fakeCotxBin,
      '--layers',
      'module',
      '--out-dir',
      outDir,
      '--timeout-ms',
      '10000',
    ], { cwd: process.cwd(), encoding: 'utf-8' });

    const markdown = fs.readFileSync(path.join(outDir, 'agentic-llm-smoke.md'), 'utf-8');
    const [record] = fs.readFileSync(path.join(outDir, 'agentic-llm-smoke.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

    expect(record.status).toBe('passed');
    expect(record.truth_graph_fact_check.stable).toBe(true);
    expect(record.truth_graph_fact_check.standard).toContain('logical graph facts');
    expect(record.truth_graph_fact_check.compared_phases).toEqual(['before-agent', 'after-agent', 'after-validation']);
    expect(record.truth_graph_fact_check.snapshots[0].facts).toEqual({
      nodes: 13,
      relations: 11,
      code_nodes: 5,
      code_relations: 7,
    });
    expect(markdown).toContain('Truth graph fact check: stable');
    expect(markdown).toContain('not .lbug file hash alone');
  });

  it('can fail the process after writing artifacts when non-passing rows are recorded', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-agentic-smoke-test-'));
    const projectRoot = path.join(tmpDir, 'fixture');
    const outDir = path.join(tmpDir, 'out');
    const fakeCotxBin = path.join(tmpDir, 'fake-cotx.mjs');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(
      fakeCotxBin,
      [
        "const [command] = process.argv.slice(2);",
        "if (command !== 'agent-analyze') {",
        "  console.error(`unexpected command: ${command}`);",
        '  process.exit(2);',
        '}',
        "console.error('agent analyze failed on purpose');",
        'process.exit(1);',
      ].join('\n'),
      'utf-8',
    );

    const result = spawnSync(process.execPath, [
      path.join(process.cwd(), 'scripts', 'run-agentic-llm-smoke.mjs'),
      '--project-root',
      projectRoot,
      '--cotx-bin',
      fakeCotxBin,
      '--layers',
      'decision',
      '--out-dir',
      outDir,
      '--timeout-ms',
      '10000',
      '--fail-on-non-passing',
    ], { cwd: process.cwd(), encoding: 'utf-8' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('FAIL_ON_NON_PASSING=1');

    const markdown = fs.readFileSync(path.join(outDir, 'agentic-llm-smoke.md'), 'utf-8');
    const [record] = fs.readFileSync(path.join(outDir, 'agentic-llm-smoke.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

    expect(record.status).toBe('failed');
    expect(markdown).toContain('| fixture | decision | failed |');
  });
});
