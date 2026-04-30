/**
 * Phase D step 2c: subprocess-based retry wrapper for compile.
 *
 * The in-process pipeline has an intermittent native tree-sitter Napi abort
 * when parse cache reads are active. The abort kills the Node process before
 * any JS catch can run. Wrapping the real compile in a child process lets us
 * detect SIGABRT / exit code 134 and retry once with parse cache reads
 * disabled. To the user the retry is transparent: compile either succeeds or
 * surfaces the real error from the retry.
 *
 * When invoked as the child (`COTX_COMPILE_CHILD=1`), we skip the wrapper
 * and run the pipeline directly.
 */

import { spawn } from 'node:child_process';

export interface CompileRetryOptions {
  /** argv forwarded to the child compile run. */
  args: string[];
  /** Fail-safe cap — retry at most this many times. */
  maxRetries?: number;
}

/**
 * Fork a child `cotx compile` run. On native abort (exit 134 or SIGABRT),
 * retry with COTX_PARSE_CACHE unset and --force-full. Returns the final
 * child exit code.
 */
export async function runCompileInChildWithRetry(opts: CompileRetryOptions): Promise<number> {
  const maxRetries = opts.maxRetries ?? 1;
  let attempt = 0;
  let lastExit = 0;
  let extraEnv: NodeJS.ProcessEnv = {};
  let extraArgs: string[] = [];

  while (attempt <= maxRetries) {
    const result = await spawnChildCompile(opts.args.concat(extraArgs), {
      ...process.env,
      ...extraEnv,
      COTX_COMPILE_CHILD: '1',
    });
    lastExit = result.exitCode;
    const nativeAbort = result.signal === 'SIGABRT' || result.exitCode === 134 || result.exitCode === 139;
    if (!nativeAbort) return result.exitCode;

    if (attempt === maxRetries) return result.exitCode;

    // Retry with cache reads disabled + force-full. Drops speed but guarantees
    // completion.
    process.stderr.write(
      `[compile] child aborted (signal=${result.signal ?? 'none'} exit=${result.exitCode}); retrying with --force-full\n`,
    );
    extraEnv = { COTX_PARSE_CACHE: '' };
    extraArgs = ['--force-full'];
    attempt += 1;
  }

  return lastExit;
}

function spawnChildCompile(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ exitCode: number; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    // process.execPath = the node binary; process.argv[1] = dist/index.js
    const child = spawn(process.execPath, [process.argv[1], 'compile', ...args], {
      stdio: 'inherit',
      env,
    });
    child.on('exit', (code, signal) => {
      resolve({ exitCode: code ?? 0, signal });
    });
    child.on('error', (err) => {
      process.stderr.write(`[compile] spawn error: ${err.message}\n`);
      resolve({ exitCode: 1, signal: null });
    });
  });
}

export function isCompileChild(): boolean {
  return process.env.COTX_COMPILE_CHILD === '1';
}
