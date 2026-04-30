import { describe, it, expect, vi } from 'vitest';
import {
  createStdioLifecycleMonitor,
  resolveStdioLifecycleConfig,
  type StdioShutdownReason,
} from '../../src/mcp/stdio-lifecycle.js';

describe('resolveStdioLifecycleConfig', () => {
  it('returns safe defaults', () => {
    const config = resolveStdioLifecycleConfig({});
    expect(config.enabled).toBe(true);
    expect(config.startupTimeoutMs).toBe(60_000);
    expect(config.idleTimeoutMs).toBe(0);
    expect(config.checkIntervalMs).toBe(15_000);
  });

  it('supports disabling the watchdog', () => {
    const config = resolveStdioLifecycleConfig({ COTX_STDIO_WATCHDOG_DISABLED: '1' });
    expect(config.enabled).toBe(false);
    expect(config.startupTimeoutMs).toBe(0);
    expect(config.idleTimeoutMs).toBe(0);
  });

  it('supports explicit timeout overrides', () => {
    const config = resolveStdioLifecycleConfig({
      COTX_STDIO_STARTUP_TIMEOUT_MS: '1500',
      COTX_STDIO_IDLE_TIMEOUT_MS: '9000',
      COTX_STDIO_WATCHDOG_INTERVAL_MS: '250',
    });
    expect(config.startupTimeoutMs).toBe(1500);
    expect(config.idleTimeoutMs).toBe(9000);
    expect(config.checkIntervalMs).toBe(250);
  });
});

describe('createStdioLifecycleMonitor', () => {
  function createHarness(options: Partial<Parameters<typeof createStdioLifecycleMonitor>[0]> = {}) {
    let now = 0;
    let parentPid = 1234;
    const reasons: StdioShutdownReason[] = [];
    const monitor = createStdioLifecycleMonitor({
      enabled: true,
      startupTimeoutMs: 100,
      idleTimeoutMs: 200,
      checkIntervalMs: 50,
      getNow: () => now,
      getParentPid: () => parentPid,
      onShutdown: (reason) => {
        reasons.push(reason);
      },
      ...options,
    });
    return {
      monitor,
      reasons,
      advance(ms: number) {
        now += ms;
      },
      setParentPid(pid: number) {
        parentPid = pid;
      },
    };
  }

  it('shuts down on startup timeout before first activity', () => {
    const h = createHarness();
    h.advance(100);
    h.monitor.tick();
    expect(h.reasons).toEqual(['startup-timeout']);
  });

  it('shuts down on idle timeout after activity', () => {
    const h = createHarness();
    h.monitor.markActivity();
    h.advance(199);
    h.monitor.tick();
    expect(h.reasons).toEqual([]);
    h.advance(1);
    h.monitor.tick();
    expect(h.reasons).toEqual(['idle-timeout']);
  });

  it('resets the idle timer when new activity arrives', () => {
    const h = createHarness();
    h.monitor.markActivity();
    h.advance(150);
    h.monitor.markActivity();
    h.advance(150);
    h.monitor.tick();
    expect(h.reasons).toEqual([]);
    h.advance(50);
    h.monitor.tick();
    expect(h.reasons).toEqual(['idle-timeout']);
  });

  it('shuts down when parent exits or is reparented before first activity', () => {
    const h = createHarness();
    h.setParentPid(1);
    h.monitor.tick();
    expect(h.reasons).toEqual(['parent-exited']);
  });

  it('does not shut down an active session just because the parent changes', () => {
    const h = createHarness();
    h.monitor.markActivity();
    h.setParentPid(1);
    h.monitor.tick();
    expect(h.reasons).toEqual([]);
    h.advance(200);
    h.monitor.tick();
    expect(h.reasons).toEqual(['idle-timeout']);
  });

  it('does nothing when disabled', () => {
    const onShutdown = vi.fn();
    const monitor = createStdioLifecycleMonitor({
      enabled: false,
      startupTimeoutMs: 0,
      idleTimeoutMs: 0,
      checkIntervalMs: 0,
      getNow: () => 10_000,
      getParentPid: () => 1,
      onShutdown,
    });
    monitor.markActivity();
    monitor.tick();
    expect(onShutdown).not.toHaveBeenCalled();
  });
});
