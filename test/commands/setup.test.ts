import { describe, expect, it } from 'vitest';
import { resolveSetupConfig, upsertCodexMcpServer } from '../../src/commands/setup.js';
import type { CotxGlobalConfig } from '../../src/config.js';

describe('resolveSetupConfig', () => {
  it('preserves existing llm config when setup is run without overrides', () => {
    const existing: CotxGlobalConfig = {
      port: 3000,
      host: '0.0.0.0',
      llm: {
        base_url: 'http://127.0.0.1:4000/v1',
        chat_model: 'vertex/gemini-2.5-flash',
        api_key: 'secret',
      },
    };

    expect(resolveSetupConfig(existing, {})).toEqual(existing);
  });

  it('updates host and port while preserving existing llm config', () => {
    const existing: CotxGlobalConfig = {
      port: 3000,
      host: '0.0.0.0',
      llm: {
        base_url: 'http://127.0.0.1:4000/v1',
        chat_model: 'vertex/gemini-2.5-flash',
      },
    };

    expect(resolveSetupConfig(existing, { port: 4567, host: '127.0.0.1' })).toEqual({
      port: 4567,
      host: '127.0.0.1',
      llm: existing.llm,
    });
  });
});

describe('upsertCodexMcpServer', () => {
  it('adds a new cotx server block when missing', () => {
    const result = upsertCodexMcpServer('', 'cotx', 'cotx', ['serve']);
    expect(result.status).toBe('added');
    expect(result.content).toContain('[mcp_servers.cotx]');
    expect(result.content).toContain('command = "cotx"');
    expect(result.content).toContain('args = ["serve"]');
  });

  it('updates an existing cotx server block when command or args differ', () => {
    const original = `
[mcp_servers.cotx]
command = "old-cotx"
args = ["http"]

[mcp_servers.context7]
command = "npx"
args = ["-y", "context7"]
`;
    const result = upsertCodexMcpServer(original, 'cotx', 'cotx', ['serve']);
    expect(result.status).toBe('updated');
    expect(result.content).toContain('[mcp_servers.cotx]');
    expect(result.content).toContain('command = "cotx"');
    expect(result.content).toContain('args = ["serve"]');
    expect(result.content).toContain('[mcp_servers.context7]');
  });

  it('leaves an already-matching cotx block unchanged', () => {
    const original = `
[mcp_servers.cotx]
command = "cotx"
args = ["serve"]
`;
    const result = upsertCodexMcpServer(original, 'cotx', 'cotx', ['serve']);
    expect(result.status).toBe('unchanged');
    expect(result.content).toBe(original.replace(/\r\n/g, '\n'));
  });
});
