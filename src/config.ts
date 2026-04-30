import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface LlmConfig {
  base_url: string;
  api_key?: string;
  api_key_env?: string;
  chat_model: string;
  embedding_model?: string;
  max_tokens?: number;
  concurrent?: number;
}

export interface CotxGlobalConfig {
  port: number;
  host: string;
  llm?: LlmConfig;
}

function defaultConfig(): CotxGlobalConfig {
  return { port: randomPort(), host: '127.0.0.1' };
}

function isValidLlmConfig(value: unknown): value is LlmConfig {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.base_url === 'string' && r.base_url.length > 0 &&
    typeof r.chat_model === 'string' && r.chat_model.length > 0
  );
}

function isValidConfig(value: unknown): value is CotxGlobalConfig {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (
    typeof record.host !== 'string' || record.host.length === 0 ||
    typeof record.port !== 'number' || !Number.isInteger(record.port) ||
    record.port <= 0 || record.port > 65535
  ) return false;
  if (record.llm !== undefined && !isValidLlmConfig(record.llm)) return false;
  return true;
}

export function configDir(home?: string): string {
  return path.join(home ?? os.homedir(), '.cotx');
}

export function configPath(home?: string): string {
  return path.join(configDir(home), 'config.json');
}

export function randomPort(): number {
  return 30000 + Math.floor(Math.random() * 30000);
}

export function readConfig(home?: string): CotxGlobalConfig {
  const file = configPath(home);
  if (!fs.existsSync(file)) {
    const config = defaultConfig();
    writeConfig(config, home);
    return config;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    throw new Error(`Invalid cotx config at ${file}`);
  }

  if (!isValidConfig(parsed)) {
    throw new Error(`Invalid cotx config at ${file}`);
  }

  return parsed;
}

export function readExistingConfig(home?: string): CotxGlobalConfig | null {
  const file = configPath(home);
  if (!fs.existsSync(file)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    throw new Error(`Invalid cotx config at ${file}`);
  }

  if (!isValidConfig(parsed)) {
    throw new Error(`Invalid cotx config at ${file}`);
  }

  return parsed;
}

export function hasConfiguredLlm(home?: string): boolean {
  try {
    return Boolean(readExistingConfig(home)?.llm?.chat_model);
  } catch {
    return false;
  }
}

export function writeConfig(config: CotxGlobalConfig, home?: string): void {
  const dir = configDir(home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath(home), JSON.stringify(config, null, 2), 'utf-8');
}
