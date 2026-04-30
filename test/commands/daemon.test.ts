import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { commandDaemonStop } from '../../src/commands/daemon.js';
import { writeConfig, configDir } from '../../src/config.js';

function pidFile(home: string): string {
  return path.join(configDir(home), 'daemon.pid');
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('commandDaemonStop', () => {
  let tmpHome: string;
  let child: ChildProcess | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-daemon-test-'));
    fs.mkdirSync(configDir(tmpHome), { recursive: true });
  });

  afterEach(() => {
    if (child?.pid && isAlive(child.pid)) {
      child.kill('SIGKILL');
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('does not kill an unrelated process referenced by a stale pid file', async () => {
    writeConfig({ host: '127.0.0.1', port: 45999 }, tmpHome);
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    fs.writeFileSync(pidFile(tmpHome), String(child.pid), 'utf-8');

    await commandDaemonStop(tmpHome);
    await wait(200);

    expect(child.pid).toBeDefined();
    expect(isAlive(child.pid!)).toBe(true);
    expect(fs.existsSync(pidFile(tmpHome))).toBe(false);
  });
});
