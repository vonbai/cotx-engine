import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { readExistingConfig, writeConfig, randomPort, configDir, type CotxGlobalConfig } from '../config.js';
import { commandDaemonStop } from './daemon.js';

export function resolveSetupConfig(
  existing: CotxGlobalConfig | null,
  options: { port?: number; host?: string },
): CotxGlobalConfig {
  return {
    port: options.port ?? existing?.port ?? randomPort(),
    host: options.host ?? existing?.host ?? '127.0.0.1',
    ...(existing?.llm ? { llm: existing.llm } : {}),
  };
}

export function resolveCliEntrypoint(): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [fs.realpathSync(process.argv[1])],
  };
}

export async function commandSetup(options: { port?: number; host?: string }): Promise<void> {
  const existing = readExistingConfig();
  const config = resolveSetupConfig(existing, options);
  const cliEntrypoint = resolveCliEntrypoint();

  // 1. Write global config
  writeConfig(config);
  console.log(`Config written to ${configDir()}/config.json`);
  console.log(`  HTTP port: ${config.port}`);
  console.log(`  HTTP host: ${config.host}`);
  if (existing?.llm) {
    console.log(`  LLM config: preserved (${existing.llm.chat_model})`);
  }
  console.log('');

  // 2. Configure Claude Code (stdio MCP)
  setupClaudeCode(cliEntrypoint);

  // 3. Configure Codex (stdio MCP)
  setupCodex(cliEntrypoint);

  // 4. Install platform service
  installService(config, cliEntrypoint);

  console.log('');
  console.log('Setup complete. Next steps:');
  console.log('  1. cd <your-project> && cotx compile');
  console.log('  2. cotx daemon start');
  console.log(`  3. Open http://${config.host}:${config.port}/`);
}

export async function commandUninstall(): Promise<void> {
  console.log('Uninstalling cotx...\n');

  // 1. Stop daemon
  await commandDaemonStop();

  // 2. Remove platform service
  removeService();

  // 3. Remove Claude Code MCP
  unsetupClaudeCode();

  // 4. Remove Codex MCP
  unsetupCodex();

  // 5. Remove config (preserve registry)
  const cfgPath = path.join(configDir(), 'config.json');
  if (fs.existsSync(cfgPath)) {
    fs.unlinkSync(cfgPath);
    console.log('Removed config.json');
  }

  const pidPath = path.join(configDir(), 'daemon.pid');
  if (fs.existsSync(pidPath)) {
    fs.unlinkSync(pidPath);
  }

  console.log('\nUninstall complete. Registry preserved at ~/.cotx/registry.json');
}

// ── Claude Code ──────────────────────────────────────────────

function setupClaudeCode(cliEntrypoint: { command: string; args: string[] }): void {
  const desiredArgs = [...cliEntrypoint.args, 'serve'];
  try {
    const existing = execFileSync('claude', ['mcp', 'get', 'cotx'], {
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    if (matchesClaudeMcpConfig(existing, cliEntrypoint.command, desiredArgs)) {
      console.log('Claude Code: already configured');
      return;
    }
    execFileSync('claude', ['mcp', 'remove', 'cotx', '--scope', 'user'], { stdio: 'pipe' });
    execFileSync('claude', ['mcp', 'add', 'cotx', '--scope', 'user', '--', cliEntrypoint.command, ...desiredArgs], { stdio: 'pipe' });
    console.log('Claude Code: updated (stdio MCP)');
  } catch {
    try {
      execFileSync('claude', ['mcp', 'add', 'cotx', '--scope', 'user', '--', cliEntrypoint.command, ...desiredArgs], { stdio: 'pipe' });
      console.log('Claude Code: configured (stdio MCP)');
    } catch {
      console.log('Claude Code: skipped (claude CLI not found)');
    }
  }
}

function unsetupClaudeCode(): void {
  try {
    execFileSync('claude', ['mcp', 'remove', 'cotx', '--scope', 'user'], { stdio: 'pipe' });
    console.log('Claude Code: removed MCP config');
  } catch {
    console.log('Claude Code: skipped');
  }
}

// ── Codex ────────────────────────────────────────────────────

export function upsertCodexMcpServer(
  content: string,
  serverName: string,
  command: string,
  args: string[],
): { content: string; status: 'added' | 'updated' | 'unchanged' } {
  const sectionHeader = `[mcp_servers.${serverName}]`;
  const desiredLines = [
    sectionHeader,
    `command = ${JSON.stringify(command)}`,
    `args = [${args.map((arg) => JSON.stringify(arg)).join(', ')}]`,
  ];
  const desired = desiredLines.join('\n');

  const normalized = content.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const start = lines.findIndex((line) => line.trim() === sectionHeader);
  if (start === -1) {
    const prefix = normalized.length > 0 && !normalized.endsWith('\n') ? '\n' : '';
    const body = `${normalized}${prefix}${desired}\n`;
    return { content: body, status: 'added' };
  }

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith('[')) {
      end = index;
      break;
    }
  }

  const current = lines.slice(start, end).join('\n').trim();
  if (current === desired) {
    return { content: normalized, status: 'unchanged' };
  }

  const nextLines = [
    ...lines.slice(0, start),
    ...desiredLines,
    ...lines.slice(end),
  ];
  return { content: nextLines.join('\n'), status: 'updated' };
}

function matchesClaudeMcpConfig(output: string, command: string, args: string[]): boolean {
  const commandMatch = output.match(/^\s*Command:\s*(.+)$/m);
  const argsMatch = output.match(/^\s*Args:\s*(.*)$/m);
  if (!commandMatch) return false;
  const parsedCommand = commandMatch[1].trim();
  const parsedArgs = argsMatch
    ? argsMatch[1]
        .trim()
        .split(/\s+/)
        .filter(Boolean)
    : [];
  return parsedCommand === command && parsedArgs.join(' ') === args.join(' ');
}

function setupCodex(cliEntrypoint: { command: string; args: string[] }): void {
  const codexDir = path.join(os.homedir(), '.codex');
  const codexConfig = path.join(codexDir, 'config.toml');
  const desiredArgs = [...cliEntrypoint.args, 'serve'];

  try {
    let content = '';
    if (fs.existsSync(codexConfig)) {
      content = fs.readFileSync(codexConfig, 'utf-8');
    }

    const next = upsertCodexMcpServer(content, 'cotx', cliEntrypoint.command, desiredArgs);
    if (next.status === 'unchanged') {
      console.log('Codex: already configured');
      return;
    }
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(codexConfig, next.content, 'utf-8');
    console.log(next.status === 'added' ? 'Codex: configured (stdio MCP)' : 'Codex: updated (stdio MCP)');
  } catch {
    console.log('Codex: skipped (could not write config)');
  }
}

function unsetupCodex(): void {
  const codexConfig = path.join(os.homedir(), '.codex', 'config.toml');
  try {
    if (!fs.existsSync(codexConfig)) return;
    let content = fs.readFileSync(codexConfig, 'utf-8');
    // Remove the [mcp_servers.cotx] section
    content = content.replace(/\n?\[mcp_servers\.cotx\]\n(?:.+\n)*(?=\[|$)/g, '');
    fs.writeFileSync(codexConfig, content, 'utf-8');
    console.log('Codex: removed MCP config');
  } catch {
    console.log('Codex: skipped');
  }
}

// ── Platform service ─────────────────────────────────────────

function installService(
  config: CotxGlobalConfig,
  cliEntrypoint: { command: string; args: string[] },
): void {
  if (process.platform === 'linux') {
    installSystemdService(config, cliEntrypoint);
  } else if (process.platform === 'darwin') {
    installLaunchdService(config, cliEntrypoint);
  } else {
    console.log('Service: manual mode (run `cotx daemon start` to start)');
  }
}

function removeService(): void {
  if (process.platform === 'linux') {
    removeSystemdService();
  } else if (process.platform === 'darwin') {
    removeLaunchdService();
  }
}

function installSystemdService(
  config: CotxGlobalConfig,
  cliEntrypoint: { command: string; args: string[] },
): void {
  const serviceDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  const servicePath = path.join(serviceDir, 'cotx.service');
  const [scriptPath] = cliEntrypoint.args;
  const nodeExec = cliEntrypoint.command;

  const unit = `[Unit]
Description=cotx semantic map server
After=network.target

[Service]
ExecStart=${nodeExec} ${scriptPath} serve --http --host ${config.host} --port ${config.port}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;

  try {
    fs.mkdirSync(serviceDir, { recursive: true });
    fs.writeFileSync(servicePath, unit, 'utf-8');
    execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'pipe' });
    execFileSync('systemctl', ['--user', 'enable', 'cotx'], { stdio: 'pipe' });
    execFileSync('systemctl', ['--user', 'start', 'cotx'], { stdio: 'pipe' });
    console.log('Service: installed and started (systemd user service)');
  } catch {
    console.log('Service: could not install systemd service, use `cotx daemon start` instead');
  }
}

function removeSystemdService(): void {
  const servicePath = path.join(os.homedir(), '.config', 'systemd', 'user', 'cotx.service');
  try {
    execFileSync('systemctl', ['--user', 'stop', 'cotx'], { stdio: 'pipe' });
    execFileSync('systemctl', ['--user', 'disable', 'cotx'], { stdio: 'pipe' });
    if (fs.existsSync(servicePath)) fs.unlinkSync(servicePath);
    execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'pipe' });
    console.log('Service: removed (systemd)');
  } catch {
    console.log('Service: skipped systemd cleanup');
  }
}

function installLaunchdService(
  config: CotxGlobalConfig,
  cliEntrypoint: { command: string; args: string[] },
): void {
  const plistDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const plistPath = path.join(plistDir, 'com.cotx.serve.plist');
  const [scriptPath] = cliEntrypoint.args;
  const nodeExec = cliEntrypoint.command;

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.cotx.serve</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeExec}</string>
    <string>${scriptPath}</string>
    <string>serve</string>
    <string>--http</string>
    <string>--host</string>
    <string>${config.host}</string>
    <string>--port</string>
    <string>${String(config.port)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`;

  try {
    fs.mkdirSync(plistDir, { recursive: true });
    fs.writeFileSync(plistPath, plist, 'utf-8');
    execFileSync('launchctl', ['load', plistPath], { stdio: 'pipe' });
    console.log('Service: installed and started (launchd)');
  } catch {
    console.log('Service: could not install launchd service, use `cotx daemon start` instead');
  }
}

function removeLaunchdService(): void {
  const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.cotx.serve.plist');
  try {
    execFileSync('launchctl', ['unload', plistPath], { stdio: 'pipe' });
    if (fs.existsSync(plistPath)) fs.unlinkSync(plistPath);
    console.log('Service: removed (launchd)');
  } catch {
    console.log('Service: skipped launchd cleanup');
  }
}
