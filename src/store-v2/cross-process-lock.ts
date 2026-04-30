import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// proper-lockfile has no shipped types; the real module exports {lock, unlock, check}.
// We load it via createRequire because this file is compiled to ESM and the
// package only ships CJS.
const require_ = createRequire(import.meta.url);
const lockfile = require_('proper-lockfile') as {
  lock: (
    file: string,
    options: { retries: { retries: number; minTimeout: number; maxTimeout: number; factor: number }; stale: number },
  ) => Promise<() => Promise<void>>;
};

/**
 * Acquire a cross-process advisory lock before running `fn`. Protects
 * LadybugDB's exclusive file lock from inter-process collisions (e.g.
 * `cotx compile` + `cotx serve` running in two terminals both writing
 * truth.lbug simultaneously). Intra-process serialization is handled by
 * the write queue in graph-truth-store.ts; this sits one level below.
 *
 * The lock file lives at `<target>.lock` directory (proper-lockfile
 * convention). We create the target's parent dir if needed so the lock
 * can be acquired even on a fresh `.cotx/`.
 */
export async function withCrossProcessLock<T>(
  target: string,
  fn: () => T | Promise<T>,
  opts?: { retries?: number; retryWait?: number; stale?: number },
): Promise<T> {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // proper-lockfile requires the target to exist. Touch it if missing.
  if (!fs.existsSync(target)) {
    fs.writeFileSync(target, '', { flag: 'a' });
  }
  const release = await lockfile.lock(target, {
    retries: {
      retries: opts?.retries ?? 30,
      minTimeout: opts?.retryWait ?? 50,
      maxTimeout: 500,
      factor: 1.3,
    },
    // Stale lock auto-released after this many ms. Real writes finish in
    // hundreds of ms; default 15s guards against crashed holders.
    stale: opts?.stale ?? 15_000,
  });
  try {
    return await fn();
  } finally {
    try {
      await release();
    } catch {
      // Release failure is non-fatal; the stale timeout will clean up.
    }
  }
}
