export type StdioShutdownReason =
  | 'startup-timeout'
  | 'idle-timeout'
  | 'parent-exited';

export interface StdioLifecycleConfig {
  enabled: boolean;
  startupTimeoutMs: number;
  idleTimeoutMs: number;
  checkIntervalMs: number;
}

export interface StdioLifecycleOptions extends StdioLifecycleConfig {
  getNow?: () => number;
  getParentPid?: () => number;
  onShutdown: (reason: StdioShutdownReason) => void;
}

export interface StdioLifecycleSnapshot {
  enabled: boolean;
  startedAt: number;
  lastActivityAt: number;
  firstActivityAt: number | null;
  initialParentPid: number;
}

export interface StdioLifecycleHandle {
  start(): void;
  stop(): void;
  tick(): void;
  markActivity(source?: string): void;
  snapshot(): StdioLifecycleSnapshot;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
const DEFAULT_IDLE_TIMEOUT_MS = 0;
const DEFAULT_CHECK_INTERVAL_MS = 15_000;

export function resolveStdioLifecycleConfig(env: NodeJS.ProcessEnv = process.env): StdioLifecycleConfig {
  if (env.COTX_STDIO_WATCHDOG_DISABLED === '1') {
    return {
      enabled: false,
      startupTimeoutMs: 0,
      idleTimeoutMs: 0,
      checkIntervalMs: 0,
    };
  }

  const startupTimeoutMs = positiveIntOrDefault(env.COTX_STDIO_STARTUP_TIMEOUT_MS, DEFAULT_STARTUP_TIMEOUT_MS);
  const idleTimeoutMs = positiveIntOrDefault(env.COTX_STDIO_IDLE_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS);
  const checkIntervalMs = positiveIntOrDefault(env.COTX_STDIO_WATCHDOG_INTERVAL_MS, DEFAULT_CHECK_INTERVAL_MS);
  const enabled = startupTimeoutMs > 0 || idleTimeoutMs > 0;
  return {
    enabled,
    startupTimeoutMs,
    idleTimeoutMs,
    checkIntervalMs,
  };
}

export function createStdioLifecycleMonitor(options: StdioLifecycleOptions): StdioLifecycleHandle {
  const getNow = options.getNow ?? (() => Date.now());
  const getParentPid = options.getParentPid ?? (() => process.ppid);
  const startedAt = getNow();
  const initialParentPid = getParentPid();
  let firstActivityAt: number | null = null;
  let lastActivityAt = startedAt;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const snapshot = (): StdioLifecycleSnapshot => ({
    enabled: options.enabled,
    startedAt,
    lastActivityAt,
    firstActivityAt,
    initialParentPid,
  });

  const stop = (): void => {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  const shutdown = (reason: StdioShutdownReason): void => {
    if (stopped) return;
    stop();
    options.onShutdown(reason);
  };

  const tick = (): void => {
    if (!options.enabled || stopped) return;
    const now = getNow();
    const currentParentPid = getParentPid();
    // Parent-PID reparenting is common under MCP wrappers that spawn a
    // short-lived launcher process and then hand stdio off to a longer-lived
    // host. Once we've seen real activity, rely on stdin end/error and the
    // idle timeout for orphan cleanup instead of killing an active session
    // just because PPID changed.
    if (firstActivityAt === null && (currentParentPid <= 1 || currentParentPid !== initialParentPid)) {
      shutdown('parent-exited');
      return;
    }

    if (firstActivityAt === null) {
      if (options.startupTimeoutMs > 0 && now - startedAt >= options.startupTimeoutMs) {
        shutdown('startup-timeout');
      }
      return;
    }

    if (options.idleTimeoutMs > 0 && now - lastActivityAt >= options.idleTimeoutMs) {
      shutdown('idle-timeout');
    }
  };

  return {
    start(): void {
      if (!options.enabled || stopped || timer) return;
      timer = setInterval(tick, options.checkIntervalMs);
      timer.unref?.();
    },
    stop,
    tick,
    markActivity(): void {
      if (!options.enabled || stopped) return;
      const now = getNow();
      lastActivityAt = now;
      if (firstActivityAt === null) firstActivityAt = now;
    },
    snapshot,
  };
}

function positiveIntOrDefault(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}
