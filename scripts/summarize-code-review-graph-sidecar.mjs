#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(usage());
  process.exit(0);
}

if (args.inputs.length === 0) {
  console.error('At least one --input artifact is required.');
  console.error('');
  console.error(usage());
  process.exit(1);
}

const summaries = args.inputs.map((input) => summarizeArtifact(input));
const result = {
  schema_version: 1,
  generated_at: args.generatedAt ?? new Date().toISOString(),
  comparator: 'code-review-graph',
  evidence_kind: 'external-pr-change-sidecar',
  integration_boundary: {
    deterministic_matrix_runner_dependency: false,
    deterministic_matrix_scoring: false,
    truth_graph_mutation: false,
  },
  rollup: buildRollup(summaries),
  summaries,
};

const serialized = `${JSON.stringify(result, null, 2)}\n`;
if (args.out) {
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, serialized, 'utf8');
} else {
  process.stdout.write(serialized);
}

function parseArgs(argv) {
  const parsed = {
    inputs: [],
    out: undefined,
    generatedAt: undefined,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }
    if (arg === '--input') {
      const value = readValue(argv, index, arg);
      parsed.inputs.push(parseInput(value));
      index += 1;
      continue;
    }
    if (arg === '--out') {
      parsed.out = path.resolve(readValue(argv, index, arg));
      index += 1;
      continue;
    }
    if (arg === '--generated-at') {
      parsed.generatedAt = readValue(argv, index, arg);
      index += 1;
      continue;
    }
    throw new Error(`Unsupported argument: ${arg}`);
  }

  return parsed;
}

function readValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
  return value;
}

function parseInput(value) {
  const equalsIndex = value.indexOf('=');
  if (equalsIndex > 0) {
    const fixture = value.slice(0, equalsIndex).trim();
    const artifactPath = value.slice(equalsIndex + 1).trim();
    if (!fixture || !artifactPath) throw new Error(`Invalid --input value: ${value}`);
    return { fixture, artifactPath: path.resolve(artifactPath) };
  }
  const artifactPath = path.resolve(value);
  return { fixture: inferFixtureName(artifactPath), artifactPath };
}

function summarizeArtifact(input) {
  const artifact = readJsonObject(input.artifactPath);
  requireType(artifact.summary, 'string', `${input.fixture}.summary`);
  requireType(artifact.risk_score, 'number', `${input.fixture}.risk_score`);
  requireArray(artifact.changed_functions, `${input.fixture}.changed_functions`);
  requireArray(artifact.affected_flows, `${input.fixture}.affected_flows`);
  requireArray(artifact.test_gaps, `${input.fixture}.test_gaps`);
  requireArray(artifact.review_priorities, `${input.fixture}.review_priorities`);

  const summaryMetrics = parseSummaryMetrics(artifact.summary, input.fixture);
  assertEqual(
    summaryMetrics.changed_symbols,
    artifact.changed_functions.length,
    `${input.fixture}.summary changed function/class count`,
  );
  assertEqual(
    summaryMetrics.affected_flows,
    artifact.affected_flows.length,
    `${input.fixture}.summary affected flow count`,
  );
  assertEqual(
    summaryMetrics.test_gaps,
    artifact.test_gaps.length,
    `${input.fixture}.summary test gap count`,
  );
  assertEqual(summaryMetrics.risk_score, artifact.risk_score, `${input.fixture}.summary risk score`);

  return {
    fixture: input.fixture,
    status: 'ok',
    artifact_path: input.artifactPath,
    summary: artifact.summary,
    metrics: {
      changed_files_analyzed: summaryMetrics.changed_files_analyzed,
      changed_symbols: artifact.changed_functions.length,
      changed_files_with_symbols: uniqueChangedFiles(artifact.changed_functions).length,
      affected_flows: artifact.affected_flows.length,
      test_gaps: artifact.test_gaps.length,
      review_priorities: artifact.review_priorities.length,
      risk_score: artifact.risk_score,
      untested: summaryMetrics.untested,
    },
    changed_files_with_symbols: uniqueChangedFiles(artifact.changed_functions),
    changed_symbols: artifact.changed_functions.map(toSymbolSummary),
    test_gaps: artifact.test_gaps.map(toGapSummary),
    review_priorities: artifact.review_priorities.map(toSymbolSummary),
  };
}

function readJsonObject(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read CRG sidecar JSON artifact at ${filePath}: ${errorMessage(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Unsupported CRG sidecar artifact at ${filePath}: expected a JSON object`);
  }
  return parsed;
}

function parseSummaryMetrics(summary, fixture) {
  return {
    changed_files_analyzed: parseRequiredNumber(summary, /Analyzed\s+(\d+)\s+changed file\(s\)/, fixture, 'changed files'),
    changed_symbols: parseRequiredNumber(summary, /-\s+(\d+)\s+changed function\(s\)\/class\(es\)/, fixture, 'changed symbols'),
    affected_flows: parseRequiredNumber(summary, /-\s+(\d+)\s+affected flow\(s\)/, fixture, 'affected flows'),
    test_gaps: parseRequiredNumber(summary, /-\s+(\d+)\s+test gap\(s\)/, fixture, 'test gaps'),
    risk_score: parseRequiredNumber(summary, /-\s+Overall risk score:\s+([0-9.]+)/, fixture, 'risk score'),
    untested: parseUntested(summary),
  };
}

function parseRequiredNumber(summary, regex, fixture, label) {
  const match = summary.match(regex);
  if (!match) throw new Error(`Unsupported CRG summary for ${fixture}: missing ${label}`);
  return Number(match[1]);
}

function parseUntested(summary) {
  const match = summary.match(/-\s+Untested:\s+(.+)$/m);
  if (!match) return [];
  return match[1].split(',').map((item) => item.trim()).filter(Boolean);
}

function uniqueChangedFiles(changedFunctions) {
  return [...new Set(changedFunctions.map((item, index) => {
    requireType(item.file_path, 'string', `changed_functions[${index}].file_path`);
    return item.file_path;
  }))].sort();
}

function toSymbolSummary(item, index) {
  requireType(item.name, 'string', `symbol[${index}].name`);
  requireType(item.kind, 'string', `symbol[${index}].kind`);
  requireType(item.qualified_name, 'string', `symbol[${index}].qualified_name`);
  requireType(item.file_path, 'string', `symbol[${index}].file_path`);
  requireType(item.risk_score, 'number', `symbol[${index}].risk_score`);
  return {
    name: item.name,
    kind: item.kind,
    qualified_name: item.qualified_name,
    file_path: item.file_path,
    line_start: item.line_start,
    line_end: item.line_end,
    language: item.language,
    parent_name: item.parent_name,
    is_test: Boolean(item.is_test),
    risk_score: item.risk_score,
  };
}

function toGapSummary(item, index) {
  requireType(item.name, 'string', `test_gaps[${index}].name`);
  requireType(item.qualified_name, 'string', `test_gaps[${index}].qualified_name`);
  requireType(item.file, 'string', `test_gaps[${index}].file`);
  return {
    name: item.name,
    qualified_name: item.qualified_name,
    file: item.file,
    line_start: item.line_start,
    line_end: item.line_end,
  };
}

function buildRollup(summaries) {
  return {
    fixture_count: summaries.length,
    status_counts: summaries.reduce((counts, summary) => {
      counts[summary.status] = (counts[summary.status] ?? 0) + 1;
      return counts;
    }, {}),
    changed_files_analyzed: sumMetric(summaries, 'changed_files_analyzed'),
    changed_symbols: sumMetric(summaries, 'changed_symbols'),
    affected_flows: sumMetric(summaries, 'affected_flows'),
    test_gaps: sumMetric(summaries, 'test_gaps'),
    review_priorities: sumMetric(summaries, 'review_priorities'),
    max_risk_score: Math.max(...summaries.map((summary) => summary.metrics.risk_score)),
  };
}

function sumMetric(summaries, metric) {
  return summaries.reduce((total, summary) => total + summary.metrics[metric], 0);
}

function inferFixtureName(artifactPath) {
  const basename = path.basename(artifactPath, path.extname(artifactPath));
  return basename === 'detect-changes' ? path.basename(path.dirname(artifactPath)) : basename;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`Unsupported CRG sidecar artifact: ${label} must be an array`);
}

function requireType(value, type, label) {
  if (typeof value !== type) throw new Error(`Unsupported CRG sidecar artifact: ${label} must be a ${type}`);
}

function assertEqual(left, right, label) {
  if (left !== right) throw new Error(`Unsupported CRG sidecar artifact: ${label} mismatch (${left} !== ${right})`);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function usage() {
  return [
    'Usage: node scripts/summarize-code-review-graph-sidecar.mjs --input fixture=/abs/detect-changes.json [--input fixture=/abs/detect-changes.json] [--out /abs/summary.json]',
    '',
    'Summarizes explicit code-review-graph PR/change-fixture sidecar artifacts into a compact JSON contract.',
    'This script does not run code-review-graph and is not used by the deterministic layer matrix runner.',
    '',
    'Options:',
    '  --input fixture=/abs/path   CRG detect-changes JSON artifact; repeatable',
    '  --out /abs/path             Write the summary JSON to this path; defaults to stdout',
    '  --generated-at ISO          Optional deterministic timestamp for reproducible tests',
  ].join('\n');
}
