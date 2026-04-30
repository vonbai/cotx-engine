import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  hasConfiguredLlm,
  readConfig,
  readExistingConfig,
  writeConfig,
  randomPort,
  configPath,
  configDir,
} from '../src/config.js';

describe('CotxGlobalConfig', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-config-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('readConfig returns defaults when file does not exist', () => {
    const config = readConfig(tmpHome);
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBeGreaterThanOrEqual(30000);
    expect(config.port).toBeLessThan(60000);
  });

  it('persists generated defaults so repeated reads stay stable', () => {
    const first = readConfig(tmpHome);
    const second = readConfig(tmpHome);

    expect(first).toEqual(second);
    expect(fs.existsSync(configPath(tmpHome))).toBe(true);
  });

  it('writeConfig creates directory and file', () => {
    writeConfig({ port: 4567, host: '0.0.0.0' }, tmpHome);
    expect(fs.existsSync(configDir(tmpHome))).toBe(true);
    expect(fs.existsSync(configPath(tmpHome))).toBe(true);
  });

  it('readConfig reads written config', () => {
    writeConfig({ port: 4567, host: '0.0.0.0' }, tmpHome);
    const config = readConfig(tmpHome);
    expect(config.port).toBe(4567);
    expect(config.host).toBe('0.0.0.0');
  });

  it('readExistingConfig does not create defaults when config is absent', () => {
    expect(readExistingConfig(tmpHome)).toBeNull();
    expect(fs.existsSync(configPath(tmpHome))).toBe(false);
  });

  it('detects configured LLM from an existing config without exposing secrets', () => {
    writeConfig({
      port: 4567,
      host: '127.0.0.1',
      llm: {
        base_url: 'http://127.0.0.1:4000/v1',
        chat_model: 'local/model',
        api_key: 'secret-value',
      },
    }, tmpHome);

    expect(hasConfiguredLlm(tmpHome)).toBe(true);
  });

  it('does not treat missing or invalid LLM config as configured', () => {
    expect(hasConfiguredLlm(tmpHome)).toBe(false);

    fs.mkdirSync(configDir(tmpHome), { recursive: true });
    fs.writeFileSync(configPath(tmpHome), '{"port":"bad"}', 'utf-8');

    expect(hasConfiguredLlm(tmpHome)).toBe(false);
  });

  it('randomPort returns value in range 30000-59999', () => {
    for (let i = 0; i < 100; i++) {
      const port = randomPort();
      expect(port).toBeGreaterThanOrEqual(30000);
      expect(port).toBeLessThan(60000);
    }
  });

  it('writeConfig then readConfig roundtrip is consistent', () => {
    const original = { port: 31415, host: '192.168.1.1' };
    writeConfig(original, tmpHome);
    const loaded = readConfig(tmpHome);
    expect(loaded).toEqual(original);
  });

  it('throws when config file is malformed', () => {
    fs.mkdirSync(configDir(tmpHome), { recursive: true });
    fs.writeFileSync(configPath(tmpHome), '{"port":"bad"}', 'utf-8');

    expect(() => readConfig(tmpHome)).toThrow('Invalid cotx config');
  });
});
