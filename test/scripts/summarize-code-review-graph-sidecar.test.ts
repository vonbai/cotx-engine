import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

describe('summarize-code-review-graph-sidecar script', () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it('writes an explicit external comparator summary without matrix-scoring semantics', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-crg-sidecar-summary-'));
    const inputPath = path.join(tmpDir, 'detect-changes.json');
    const outputPath = path.join(tmpDir, 'summary.json');
    fs.writeFileSync(inputPath, JSON.stringify({
      summary: [
        'Analyzed 2 changed file(s):',
        '  - 2 changed function(s)/class(es)',
        '  - 0 affected flow(s)',
        '  - 1 test gap(s)',
        '  - Overall risk score: 0.70',
        '  - Untested: load_app',
      ].join('\n'),
      risk_score: 0.7,
      changed_functions: [
        {
          id: 1,
          kind: 'Function',
          name: 'load_app',
          qualified_name: '/repo/src/flask/cli.py::ScriptInfo.load_app',
          file_path: '/repo/src/flask/cli.py',
          line_start: 339,
          line_end: 383,
          language: 'python',
          parent_name: 'ScriptInfo',
          is_test: false,
          risk_score: 0.7,
        },
        {
          id: 2,
          kind: 'Test',
          name: 'test_loading_error',
          qualified_name: '/repo/tests/test_cli.py::test_loading_error',
          file_path: '/repo/tests/test_cli.py',
          line_start: 420,
          line_end: 431,
          language: 'python',
          parent_name: null,
          is_test: true,
          risk_score: 0.3,
        },
      ],
      affected_flows: [],
      test_gaps: [
        {
          name: 'load_app',
          qualified_name: '/repo/src/flask/cli.py::ScriptInfo.load_app',
          file: '/repo/src/flask/cli.py',
          line_start: 339,
          line_end: 383,
        },
      ],
      review_priorities: [
        {
          id: 1,
          kind: 'Function',
          name: 'load_app',
          qualified_name: '/repo/src/flask/cli.py::ScriptInfo.load_app',
          file_path: '/repo/src/flask/cli.py',
          line_start: 339,
          line_end: 383,
          language: 'python',
          parent_name: 'ScriptInfo',
          is_test: false,
          risk_score: 0.7,
        },
      ],
    }), 'utf8');

    execFileSync(process.execPath, [
      path.join(process.cwd(), 'scripts', 'summarize-code-review-graph-sidecar.mjs'),
      '--input',
      `flask=${inputPath}`,
      '--out',
      outputPath,
      '--generated-at',
      '2026-04-14T00:00:00.000Z',
    ], { cwd: process.cwd(), encoding: 'utf8' });

    const summary = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    expect(summary.comparator).toBe('code-review-graph');
    expect(summary.evidence_kind).toBe('external-pr-change-sidecar');
    expect(summary.integration_boundary).toEqual({
      deterministic_matrix_runner_dependency: false,
      deterministic_matrix_scoring: false,
      truth_graph_mutation: false,
    });
    expect(summary.rollup).toMatchObject({
      fixture_count: 1,
      changed_files_analyzed: 2,
      changed_symbols: 2,
      affected_flows: 0,
      test_gaps: 1,
      max_risk_score: 0.7,
    });
    expect(summary.summaries[0].fixture).toBe('flask');
    expect(summary.summaries[0].metrics.untested).toEqual(['load_app']);
    expect(summary.summaries[0].changed_files_with_symbols).toEqual([
      '/repo/src/flask/cli.py',
      '/repo/tests/test_cli.py',
    ]);
  });

  it('fails loudly when summary counts do not match the JSON payload', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-crg-sidecar-summary-'));
    const inputPath = path.join(tmpDir, 'detect-changes.json');
    fs.writeFileSync(inputPath, JSON.stringify({
      summary: [
        'Analyzed 1 changed file(s):',
        '  - 3 changed function(s)/class(es)',
        '  - 0 affected flow(s)',
        '  - 0 test gap(s)',
        '  - Overall risk score: 0.10',
      ].join('\n'),
      risk_score: 0.1,
      changed_functions: [],
      affected_flows: [],
      test_gaps: [],
      review_priorities: [],
    }), 'utf8');

    expect(() => execFileSync(process.execPath, [
      path.join(process.cwd(), 'scripts', 'summarize-code-review-graph-sidecar.mjs'),
      '--input',
      `bad=${inputPath}`,
    ], { cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe' })).toThrow(/changed function\/class count/);
  });
});
