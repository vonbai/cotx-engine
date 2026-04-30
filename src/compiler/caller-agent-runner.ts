import { spawn } from 'node:child_process';
import type {
  CallerAgentRunnerInvocation,
  CallerAgentRunnerRequest,
  CallerAgentRunnerResult,
  LlmEnrichmentEvalRecord,
  LlmEnrichmentRubricDimension,
} from './llm-enrichment-eval.js';

export const CALLER_AGENT_RUNNER_CONTRACT_VERSION = 'cotx.caller_agent_runner.v1';
export const CALLER_AGENT_RUNNER_RESULT_VERSION = 'cotx.caller_agent_runner_result.v1';
export const DEFAULT_CALLER_AGENT_RUNNER_TIMEOUT_MS = 120_000;
const MAX_RUNNER_OUTPUT_BYTES = 2 * 1024 * 1024;

export interface CallerAgentRunnerConfig {
  command?: string;
  args?: string[];
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string>;
}

export function buildCallerAgentRunnerRequest(record: LlmEnrichmentEvalRecord): CallerAgentRunnerRequest {
  return {
    schema_version: CALLER_AGENT_RUNNER_CONTRACT_VERSION,
    generated_at: record.generated_at,
    repo: record.repo,
    project_root: record.project_root,
    task: record.task,
    layer: record.layer,
    mode: 'cotx-caller-agent',
    product: 'cotx',
    read_only: true,
    constraints: [
      'Do not mutate .cotx truth graph facts or source files.',
      'When proving no truth graph mutation, compare logical graph facts such as counts or query results; do not rely on .lbug file hashes alone.',
      'Use deterministic cotx facts, onboarding context, source reads, and graph-backed validation together.',
      'Return blockers explicitly instead of inventing files, routes, tools, symbols, or relations.',
      'Do not create silent fallback behavior when cotx evidence is missing.',
    ],
    cotx: {
      present: record.cotx.present,
      compiled_at: record.cotx.compiled_at,
      truth_graph_present: record.cotx.truth_graph_present,
      architecture_present: record.architecture.present,
      architecture_generated_at: record.architecture.generated_at,
      architecture_mode: record.architecture.mode,
      architecture_perspectives: record.architecture.perspectives,
    },
    onboarding: {
      source_count: record.onboarding.source_count,
      graph_file_count: record.onboarding.graph_file_count,
      graph_file_index_status: record.onboarding.graph_file_index_status,
      consistency_counts: record.onboarding.consistency_counts,
      top_hypotheses: record.onboarding.top_hypotheses,
      warnings: record.onboarding.warnings,
    },
    truth_corrections: {
      total: record.truth_corrections.total,
      high_confidence: record.truth_corrections.high_confidence,
      latest_created_at: record.truth_corrections.latest_created_at,
      samples: record.truth_corrections.samples,
    },
    required_output: {
      schema_version: CALLER_AGENT_RUNNER_RESULT_VERSION,
      status_values: ['passed', 'failed', 'blocked'],
      notes: [
        'stdout must be exactly one JSON object matching this contract',
        'exit with code 0 for a valid benchmark result, including blocked rows',
      ],
    },
  };
}

export async function runCallerAgentRunner(
  record: LlmEnrichmentEvalRecord,
  config: CallerAgentRunnerConfig,
): Promise<CallerAgentRunnerInvocation> {
  const timeoutMs = positiveInteger(config.timeoutMs, DEFAULT_CALLER_AGENT_RUNNER_TIMEOUT_MS);
  const request = buildCallerAgentRunnerRequest(record);

  if (!config.command) {
    return {
      schema_version: CALLER_AGENT_RUNNER_CONTRACT_VERSION,
      configured: false,
      status: 'not-configured',
      timeout_ms: timeoutMs,
      request,
      errors: ['caller-agent runner command not configured; set --caller-agent-runner or COTX_CALLER_AGENT_RUNNER'],
    };
  }

  const started = Date.now();
  const args = config.args ?? [];
  const env = {
    ...process.env,
    ...config.env,
    COTX_CALLER_AGENT_CONTRACT_VERSION: CALLER_AGENT_RUNNER_CONTRACT_VERSION,
    COTX_CALLER_AGENT_RESULT_VERSION: CALLER_AGENT_RUNNER_RESULT_VERSION,
    COTX_CALLER_AGENT_READ_ONLY: '1',
    COTX_CALLER_AGENT_PROJECT_ROOT: record.project_root,
    COTX_CALLER_AGENT_REPO: record.repo,
    COTX_CALLER_AGENT_LAYER: record.layer,
    COTX_CALLER_AGENT_MODE: record.mode,
  };
  try {
    const child = await runProcessWithJsonStdin(config.command, args, `${JSON.stringify(request)}\n`, {
      cwd: config.cwd ?? record.project_root,
      env,
      timeoutMs,
      maxBuffer: MAX_RUNNER_OUTPUT_BYTES,
    });
    if (child.timedOut || child.exitCode !== 0) {
      return {
        schema_version: CALLER_AGENT_RUNNER_CONTRACT_VERSION,
        configured: true,
        command: config.command,
        args,
        timeout_ms: timeoutMs,
        duration_ms: Date.now() - started,
        exit_code: child.exitCode,
        signal: child.signal,
        status: child.timedOut ? 'timed-out' : 'error',
        request,
        stdout_tail: tail(child.stdout, 4000),
        stderr_tail: tail(child.stderr, 4000),
        errors: [child.timedOut
          ? `caller-agent runner timed out after ${timeoutMs}ms`
          : `caller-agent runner exited with code ${child.exitCode ?? 'null'}${child.signal ? ` and signal ${child.signal}` : ''}`],
      };
    }
    const result = parseCallerAgentRunnerResult(child.stdout);
    return {
      schema_version: CALLER_AGENT_RUNNER_CONTRACT_VERSION,
      configured: true,
      command: config.command,
      args,
      timeout_ms: timeoutMs,
      duration_ms: Date.now() - started,
      exit_code: 0,
      status: result.status,
      request,
      result,
      stdout_tail: tail(child.stdout, 4000),
      stderr_tail: tail(child.stderr, 4000),
      errors: [],
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      code?: number | string;
      signal?: NodeJS.Signals;
      killed?: boolean;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    const stdout = bufferToString(err.stdout);
    const stderr = bufferToString(err.stderr);
    const timedOut = err.killed === true || String(err.message).toLowerCase().includes('timed out');
    return {
      schema_version: CALLER_AGENT_RUNNER_CONTRACT_VERSION,
      configured: true,
      command: config.command,
      args,
      timeout_ms: timeoutMs,
      duration_ms: Date.now() - started,
      exit_code: typeof err.code === 'number' ? err.code : null,
      signal: err.signal ?? null,
      status: timedOut ? 'timed-out' : 'error',
      request,
      stdout_tail: tail(stdout, 4000),
      stderr_tail: tail(stderr, 4000),
      errors: [err.message],
    };
  }
}

function runProcessWithJsonStdin(
  command: string,
  args: string[],
  input: string,
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    maxBuffer: number;
  },
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, options.timeoutMs);

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk);
      stdout += chunk;
      if (outputBytes > options.maxBuffer) {
        child.kill('SIGTERM');
      }
    });
    child.stderr.on('data', (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk);
      stderr += chunk;
      if (outputBytes > options.maxBuffer) {
        child.kill('SIGTERM');
      }
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode, signal, timedOut });
    });
    child.stdin.end(input);
  });
}

export function parseCallerAgentRunnerResult(stdout: string): CallerAgentRunnerResult {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error('caller-agent runner stdout was empty; expected one JSON result object');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`caller-agent runner stdout was not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateCallerAgentRunnerResult(parsed);
}

export function validateCallerAgentRunnerResult(value: unknown): CallerAgentRunnerResult {
  if (!isRecord(value)) throw new Error('caller-agent runner result must be an object');
  if (value.schema_version !== CALLER_AGENT_RUNNER_RESULT_VERSION) {
    throw new Error(`caller-agent runner result schema_version must be ${CALLER_AGENT_RUNNER_RESULT_VERSION}`);
  }
  if (value.status !== 'passed' && value.status !== 'failed' && value.status !== 'blocked') {
    throw new Error('caller-agent runner result status must be passed, failed, or blocked');
  }
  if (typeof value.summary !== 'string' || value.summary.trim().length === 0) {
    throw new Error('caller-agent runner result summary must be a non-empty string');
  }

  const result: CallerAgentRunnerResult = {
    schema_version: CALLER_AGENT_RUNNER_RESULT_VERSION,
    status: value.status,
    summary: value.summary,
  };

  if (value.blockers !== undefined) result.blockers = stringArray(value.blockers, 'blockers');
  if (value.observations !== undefined) result.observations = stringArray(value.observations, 'observations');
  if (value.llm_calls !== undefined) result.llm_calls = nonNegativeInteger(value.llm_calls, 'llm_calls');
  if (value.token_estimate !== undefined) result.token_estimate = nonNegativeInteger(value.token_estimate, 'token_estimate');
  if (value.duration_ms !== undefined) result.duration_ms = nonNegativeInteger(value.duration_ms, 'duration_ms');
  if (value.evidence !== undefined) result.evidence = evidenceArray(value.evidence);
  if (value.scores !== undefined) result.scores = scoreRecord(value.scores);
  return result;
}

function evidenceArray(value: unknown): CallerAgentRunnerResult['evidence'] {
  if (!Array.isArray(value)) throw new Error('caller-agent runner result evidence must be an array');
  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`caller-agent runner result evidence[${index}] must be an object`);
    if (typeof item.kind !== 'string' || item.kind.trim() === '') {
      throw new Error(`caller-agent runner result evidence[${index}].kind must be a non-empty string`);
    }
    if (typeof item.ref !== 'string' || item.ref.trim() === '') {
      throw new Error(`caller-agent runner result evidence[${index}].ref must be a non-empty string`);
    }
    const evidence: NonNullable<CallerAgentRunnerResult['evidence']>[number] = {
      kind: item.kind,
      ref: item.ref,
    };
    if (item.detail !== undefined) {
      if (typeof item.detail !== 'string') throw new Error(`caller-agent runner result evidence[${index}].detail must be a string`);
      evidence.detail = item.detail;
    }
    return evidence;
  });
}

function scoreRecord(value: unknown): Partial<Record<LlmEnrichmentRubricDimension, number>> {
  if (!isRecord(value)) throw new Error('caller-agent runner result scores must be an object');
  const scores: Partial<Record<LlmEnrichmentRubricDimension, number>> = {};
  for (const [key, score] of Object.entries(value)) {
    if (!RUBRIC_DIMENSIONS.has(key as LlmEnrichmentRubricDimension)) {
      throw new Error(`caller-agent runner result score has unknown dimension: ${key}`);
    }
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 5) {
      throw new Error(`caller-agent runner result score for ${key} must be a finite number from 0 to 5`);
    }
    scores[key as LlmEnrichmentRubricDimension] = score;
  }
  return scores;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`caller-agent runner result ${field} must be an array of strings`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`caller-agent runner result ${field} must be a non-negative integer`);
  }
  return value;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function bufferToString(value: string | Buffer | undefined): string {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf-8');
  return '';
}

function tail(value: string | undefined, max: number): string {
  if (!value) return '';
  return value.length > max ? value.slice(-max) : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const RUBRIC_DIMENSIONS = new Set<LlmEnrichmentRubricDimension>([
  'groundedness',
  'coverage',
  'architecture_usefulness',
  'agent_actionability',
  'brevity',
  'staleness_handling',
  'recursion_quality',
  'cost_latency',
]);
