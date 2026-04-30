import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { CotxGlobalConfig } from '../config.js';
import { configDir, readConfig } from '../config.js';

interface DaemonPidRecord {
  pid: number;
  token?: string;
}

function pidPath(home?: string): string {
  return path.join(configDir(home), 'daemon.pid');
}

function clearPid(home?: string): void {
  try {
    fs.unlinkSync(pidPath(home));
  } catch {
    // ignore cleanup failures
  }
}

function readPidFile(home?: string): DaemonPidRecord | null {
  try {
    const raw = fs.readFileSync(pidPath(home), 'utf-8').trim();
    if (raw.startsWith('{')) {
      const parsed = JSON.parse(raw) as Partial<DaemonPidRecord>;
      if (typeof parsed.pid === 'number' && Number.isInteger(parsed.pid)) {
        return {
          pid: parsed.pid,
          token: typeof parsed.token === 'string' ? parsed.token : undefined,
        };
      }
      clearPid(home);
      return null;
    }

    const pid = parseInt(raw, 10);
    if (isNaN(pid)) {
      clearPid(home);
      return null;
    }
    return { pid };
  } catch {
    return null;
  }
}

async function isCotxDaemonHealthy(
  config: CotxGlobalConfig,
  expectedToken?: string,
): Promise<boolean> {
  try {
    const res = await fetch(`http://${config.host}:${config.port}/health`, {
      signal: AbortSignal.timeout(750),
    });
    if (!res.ok) return false;
    const body = await res.json() as { ok?: boolean; service?: string; token?: string };
    if (body.ok !== true || body.service !== 'cotx-engine') return false;
    if (expectedToken !== undefined) {
      return body.token === expectedToken;
    }
    return true;
  } catch {
    return false;
  }
}

async function waitForHealthy(
  config: CotxGlobalConfig,
  timeoutMs: number,
  expectedToken?: string,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isCotxDaemonHealthy(config, expectedToken)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function readManagedPid(home?: string): Promise<number | null> {
  const record = readPidFile(home);
  if (!record) return null;

  try {
    process.kill(record.pid, 0);
  } catch {
    clearPid(home);
    return null;
  }

  const config = readConfig(home);
  if (!record.token || !(await isCotxDaemonHealthy(config, record.token))) {
    clearPid(home);
    return null;
  }

  return record.pid;
}

function daemonUrl(config: CotxGlobalConfig): string {
  return `http://${config.host}:${config.port}`;
}

function reportConfigError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.log(message);
  process.exitCode = 1;
}

export async function commandDaemonStart(home?: string): Promise<void> {
  let config: CotxGlobalConfig;
  try {
    config = readConfig(home);
  } catch (err) {
    reportConfigError(err);
    return;
  }

  const existing = await readManagedPid(home);
  if (existing) {
    console.log(`cotx daemon already running (PID ${existing}) on ${daemonUrl(config)}`);
    return;
  }

  if (await isCotxDaemonHealthy(config)) {
    console.log(`cotx daemon already running on ${daemonUrl(config)} (managed externally)`);
    return;
  }

  const cotxBin = process.argv[1]; // path to the cotx CLI entry point
  const token = randomUUID();

  const child = spawn(process.execPath, [cotxBin, 'serve', '--http', '--host', config.host, '--port', String(config.port)], {
    detached: true,
    env: { ...process.env, COTX_DAEMON_TOKEN: token },
    stdio: 'ignore',
  });

  if (child.pid) {
    const healthy = await waitForHealthy(config, 5_000, token);
    if (!healthy) {
      try {
        process.kill(child.pid, 'SIGTERM');
      } catch {
        // ignore failed cleanup
      }
      console.log('Failed to start daemon');
      process.exitCode = 1;
      return;
    }

    child.unref();
    fs.mkdirSync(configDir(home), { recursive: true });
    fs.writeFileSync(pidPath(home), JSON.stringify({ pid: child.pid, token }), 'utf-8');
    console.log(`cotx daemon started (PID ${child.pid})`);
    console.log(`  ${daemonUrl(config)}/`);
    console.log(`  ${daemonUrl(config)}/workbench`);
  } else {
    console.log('Failed to start daemon');
    process.exitCode = 1;
  }
}

export async function commandDaemonStop(home?: string): Promise<void> {
  let config: CotxGlobalConfig;
  try {
    config = readConfig(home);
  } catch (err) {
    reportConfigError(err);
    return;
  }

  const pid = await readManagedPid(home);
  if (!pid) {
    if (await isCotxDaemonHealthy(config)) {
      console.log(`cotx daemon is running on ${daemonUrl(config)} but is managed externally`);
    } else {
      console.log('cotx daemon is not running');
    }
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Already dead
  }

  clearPid(home);

  console.log(`cotx daemon stopped (PID ${pid})`);
}

export async function commandDaemonStatus(home?: string): Promise<void> {
  let config: CotxGlobalConfig;
  try {
    config = readConfig(home);
  } catch (err) {
    reportConfigError(err);
    return;
  }

  const pid = await readManagedPid(home);
  if (pid) {
    console.log(`cotx daemon is running (PID ${pid})`);
    console.log(`  ${daemonUrl(config)}/`);
  } else if (await isCotxDaemonHealthy(config)) {
    console.log('cotx daemon is running (managed externally)');
    console.log(`  ${daemonUrl(config)}/`);
  } else {
    console.log('cotx daemon is not running');
  }
}
