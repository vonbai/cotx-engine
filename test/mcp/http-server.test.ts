import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMcpHttpServer, type HttpServerHandle } from '../../src/mcp/server.js';
import { ArchitectureStore } from '../../src/store/architecture-store.js';

function parseToolJson(result: {
  content: Array<{ type: string; text?: string }>;
}): unknown {
  const first = result.content[0];
  if (!first || first.type !== 'text' || typeof first.text !== 'string') {
    throw new Error(`Unexpected tool result: ${JSON.stringify(result)}`);
  }
  return JSON.parse(first.text);
}

describe('HTTP MCP server', () => {
  let tmpDir: string;
  let tmpHome: string;
  let server: HttpServerHandle;
  let previousHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-http-mcp-'));
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-http-home-'));
    previousHome = process.env.HOME;
    process.env.HOME = tmpHome;
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'main.ts'),
      [
        'export function mainEntry() {',
        '  return 1;',
        '}',
        '',
      ].join('\n'),
    );
  });

  afterEach(async () => {
    if (server) {
      await server.close();
    }
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it(
    'serves tools over Streamable HTTP',
    async () => {
      server = await startMcpHttpServer({
        host: '127.0.0.1',
        port: 0,
        installSignalHandlers: false,
      });

      const client = new Client({ name: 'http-streamable-test', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(server.mcpUrl));

      await client.connect(transport);

      const tools = await client.listTools();
      expect(tools.tools.some((tool) => tool.name === 'cotx_compile')).toBe(true);

      const prompts = await client.listPrompts();
      expect(prompts.prompts.some((prompt) => prompt.name === 'cotx_architecture_scan')).toBe(true);
      const prompt = await client.getPrompt({
        name: 'cotx_architecture_scan',
        arguments: { project_root: tmpDir, focus: 'mainEntry' },
      });
      expect(prompt.messages[0].content.type).toBe('text');
      if (prompt.messages[0].content.type === 'text') {
        // cotx_architecture_scan opens with the common prep-task step —
        // the prompt evolved from referencing cotx_minimal_context to
        // cotx_prepare_task + cotx_map + cotx_query(layer=architecture).
        expect(prompt.messages[0].content.text).toContain('cotx_prepare_task');
        expect(prompt.messages[0].content.text).toContain('layer=architecture');
      }

      const compile = parseToolJson(
        await client.callTool({
          name: 'cotx_compile',
          arguments: { project_root: tmpDir },
        }),
      ) as { status: string };
      expect(compile.status).toBe('compiled');

      const context = parseToolJson(
        await client.callTool({
          name: 'cotx_context',
          arguments: { project_root: tmpDir, node_id: 'Function:src/main.ts:mainEntry' },
        }),
      ) as { id: string };
      expect(context.id).toBe('Function:src/main.ts:mainEntry');

      await transport.close();
    },
    30_000,
  );

  it(
    'serves tools over legacy SSE transport',
    async () => {
      server = await startMcpHttpServer({
        host: '127.0.0.1',
        port: 0,
        installSignalHandlers: false,
      });

      const bootstrapClient = new Client({ name: 'http-bootstrap-test', version: '1.0.0' });
      const bootstrapTransport = new StreamableHTTPClientTransport(new URL(server.mcpUrl));
      await bootstrapClient.connect(bootstrapTransport);
      parseToolJson(
        await bootstrapClient.callTool({
          name: 'cotx_compile',
          arguments: { project_root: tmpDir },
        }),
      );
      await bootstrapTransport.close();

      const client = new Client({ name: 'http-sse-test', version: '1.0.0' });
      const transport = new SSEClientTransport(new URL(server.sseUrl));

      await client.connect(transport);

      const tools = await client.listTools();
      expect(tools.tools.some((tool) => tool.name === 'cotx_context')).toBe(true);

      const context = parseToolJson(
        await client.callTool({
          name: 'cotx_context',
          arguments: { project_root: tmpDir, node_id: 'Function:src/main.ts:mainEntry' },
        }),
      ) as { id: string };

      expect(context.id).toBe('Function:src/main.ts:mainEntry');

      await transport.close();
    },
    30_000,
  );

  it('serves the landing page instead of 500 at / when no current project is selected', async () => {
    const prevCwd = process.cwd();
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-http-empty-'));

    try {
      process.chdir(emptyDir);
      server = await startMcpHttpServer({
        host: '127.0.0.1',
        port: 0,
        installSignalHandlers: false,
      });

      const res = await fetch(server.landingUrl);
      const body = await res.text();

      expect(res.status).toBe(200);
      expect(body).toContain('cotx projects');
      expect(body).toContain('No projects registered.');
    } finally {
      process.chdir(prevCwd);
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('does not serve the removed legacy /map explorer UI routes', async () => {
    const prevCwd = process.cwd();

    try {
      process.chdir(tmpDir);

      const archStore = new ArchitectureStore(tmpDir);
      archStore.init({
        perspectives: ['overall-architecture'],
        generated_at: '2026-04-09T00:00:00Z',
        mode: 'auto',
        struct_hash: 'abc',
      });
      archStore.writePerspective({
        id: 'overall-architecture',
        label: 'Overall Architecture',
        components: [
          {
            id: 'compiler',
            label: 'Compiler',
            kind: 'group',
            directory: 'src/compiler',
            children: ['module-compiler'],
            stats: { file_count: 2, function_count: 3, total_cyclomatic: 3, max_cyclomatic: 2, max_nesting_depth: 1, risk_score: 8 },
          },
        ],
        edges: [],
      });
      archStore.writeElement('overall-architecture', 'compiler', {
        id: 'compiler',
        label: 'Compiler',
        kind: 'group',
        directory: 'src/compiler',
        children: ['module-compiler'],
        stats: { file_count: 2, function_count: 3, total_cyclomatic: 3, max_cyclomatic: 2, max_nesting_depth: 1, risk_score: 8 },
      });
      archStore.writeElement('overall-architecture', 'compiler/module-compiler', {
        id: 'module-compiler',
        label: 'Module Compiler',
        kind: 'leaf',
        directory: 'src/compiler/module-compiler.ts',
        files: ['src/compiler/module-compiler.ts'],
        stats: { file_count: 1, function_count: 1, total_cyclomatic: 1, max_cyclomatic: 1, max_nesting_depth: 1, risk_score: 5 },
      });

      server = await startMcpHttpServer({
        host: '127.0.0.1',
        port: 0,
        installSignalHandlers: false,
      });

      const projectName = path.basename(tmpDir);
      const res = await fetch(`${server.baseUrl}/map/${encodeURIComponent(projectName)}/overall-architecture/compiler/module-compiler`);
      expect(res.status).toBe(404);
    } finally {
      process.chdir(prevCwd);
    }
  });
});
