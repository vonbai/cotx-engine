/**
 * MCP Server
 *
 * Supports stdio for embedded agent sessions and HTTP transports for
 * standalone multi-client use.
 *
 * Uses the low-level Server API so tool schemas are plain JSON Schema
 * objects — no zod dependency required.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as NodeHttpServer,
  type ServerResponse,
} from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { COTX_TOOLS, handleToolCall } from './tools.js';
import { COTX_PROMPTS, getCotxPrompt } from './prompts.js';
import { ArchitectureStore } from '../store/architecture-store.js';
import { ArchitectureIndex } from '../store/architecture-index.js';
import { CotxStore } from '../store/store.js';
import { collectFileBackedImpact } from '../commands/impact.js';
import { listProjects, findProject } from '../registry.js';
import type { RegistryEntry } from '../registry.js';
import path from 'node:path';
import { format } from 'node:util';
import type {
  ArchitectureElement,
  ArchitectureWorkspaceElement,
  PerspectiveData,
} from '../store/schema.js';
import {
  createStdioLifecycleMonitor,
  resolveStdioLifecycleConfig,
} from './stdio-lifecycle.js';

type ShutdownFn = (exitCode?: number) => Promise<void>;

type HttpSessionEntry =
  | {
      kind: 'streamable';
      server: Server;
      transport: StreamableHTTPServerTransport;
    }
  | {
      kind: 'sse';
      server: Server;
      transport: SSEServerTransport;
    };

export interface HttpServerHandle {
  close(): Promise<void>;
  host: string;
  port: number;
  baseUrl: string;
  landingUrl: string;
  mcpUrl: string;
  workbenchUrl: string;
  apiUrl: string;
  sseUrl: string;
  messagesUrl: string;
  server: NodeHttpServer;
}

function workbenchDistDir(): string {
  return process.env.COTX_WORKBENCH_DIST
    ? path.resolve(process.env.COTX_WORKBENCH_DIST)
    : path.resolve(process.cwd(), 'apps', 'cotx-workbench', 'dist');
}

function contentTypeFor(filename: string): string {
  if (filename.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (filename.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filename.endsWith('.json')) return 'application/json; charset=utf-8';
  if (filename.endsWith('.svg')) return 'image/svg+xml';
  if (filename.endsWith('.html')) return 'text/html; charset=utf-8';
  return 'application/octet-stream';
}

function readWorkbenchAsset(assetPathname: string): { body: Buffer; contentType: string } | null {
  const distDir = workbenchDistDir();
  const relPath = assetPathname.replace(/^\/workbench\//, '');
  const absolutePath = path.resolve(distDir, relPath);
  if (!absolutePath.startsWith(distDir)) return null;
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) return null;
  return {
    body: fs.readFileSync(absolutePath),
    contentType: contentTypeFor(absolutePath),
  };
}

const COTX_SERVER_INSTRUCTIONS = `cotx-engine compiles a codebase into a queryable semantic map at .cotx/.
Use it when tasks span multiple files or need structural understanding
(who calls what, blast radius, module responsibilities) — not for
single-file reads (use Read) or known-path searches (use Grep).

Lifecycle:
- BOOTSTRAP any task: call cotx_prepare_task first. It detects missing
  or stale indexes and refreshes them automatically (up to 500 files of drift).
- READ:   cotx_query (BM25/PageRank) → cotx_context → cotx_impact / cotx_map
- UPDATE: after file edits, cotx_compile mode=delta files=[...]
- REVIEW: cotx_review_change before commit
- WRITE:  cotx_write to persist enrichments

The index reflects the current working tree (uncommitted edits included,
branch HEAD included). Switching branches invalidates it — cotx_prepare_task
will detect and refresh. Never commit .cotx/ to git; it is a local build
artifact like dist/.

Every read-tool response may include {stale_against_head: true, stale_hint: ...}.
When you see it, call cotx_prepare_task (preferred) or cotx_compile mode=delta
with the reported drifted files before trusting subsequent results.

Enrichment semantics (two-tier, async):
- STRUCTURAL phase (synchronous, done when cotx_compile returns): parse + graph
  + deterministic auto_description on every node (modules, concepts, contracts,
  flows, architecture). Full query functionality is available immediately.
- LLM phase (asynchronous, detached worker): by default enriches only MODULE
  (responsibility) and ARCHITECTURE (description / diagram). Other layers keep
  their auto_description until you explicitly ask.
- Poll cotx_enrichment_status for progress.
- Never block on enrichment: auto_description + structural edges already
  support navigation, search, impact analysis, and most understanding tasks.

On-demand LLM enrichment — measured ROI per layer (90-node samples across
agent / framework / build-tool repos):
- CONCEPT → LLM adds HIGH value. Agent self-skips test-only fixtures (~50%
  of concepts on agent/framework repos) and writes grounded, file-cited
  definitions when it commits. Call cotx_query filter=stale layer=concept
  auto_enrich=true when the user asks about domain terminology
  ("what does X mean here?", "how is Y organized?").
- FLOW → LLM adds HIGH value when source has a clear exception class
  hierarchy (pydantic-ai: specific UserError / ModelRetry / AgentRunError
  citations). Enrich before answering "what can fail in flow X?" or when
  cotx_impact shows a flow the user cares about.
- CONTRACT → LOW measured ROI. auto_description already shows
  provider→consumer via [fn1, fn2, fn3] — LLM tends to paraphrase it as
  "module consumes X". Prefer Read on the provider file for invariants;
  only call auto_enrich for contracts if the user explicitly asks.

All on-demand calls take a layer + optional nodeIds and a limit (5-30 is
usually right). The agent running enrichment reads source via Read/Grep,
so expect a few seconds per node.`;

let stdioConsoleRedirectInstalled = false;

function installStdioConsoleRedirect(): void {
  if (stdioConsoleRedirectInstalled) return;
  stdioConsoleRedirectInstalled = true;
  const writeToStderr = (...args: unknown[]): void => {
    process.stderr.write(`${format(...args)}\n`);
  };
  console.log = writeToStderr;
  console.info = writeToStderr;
  console.debug = writeToStderr;
}

function createConfiguredServer(onActivity?: () => void): Server {
  const server = new Server(
    { name: 'cotx-engine', version: '0.1.0' },
    {
      capabilities: { tools: {}, prompts: {} },
      instructions: COTX_SERVER_INSTRUCTIONS,
    },
  );

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    onActivity?.();
    return {
      tools: COTX_TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        ...(t.annotations ? { annotations: t.annotations } : {}),
      })),
    };
  });

  // Dispatch tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    onActivity?.();
    const { name, arguments: rawArgs } = request.params;
    const known = COTX_TOOLS.find((t) => t.name === name);
    if (!known) {
      return {
        content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    try {
      const result = await handleToolCall(name, args);
      return {
        content: result.content.map((c) => ({ ...c, type: 'text' as const })),
        isError: result.isError,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`cotx MCP tool dispatch error (${name}): ${message}\n`);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
        isError: true,
      };
    }
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    onActivity?.();
    return { prompts: COTX_PROMPTS };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    onActivity?.();
    const prompt = getCotxPrompt(request.params.name, request.params.arguments ?? {});
    if (!prompt) throw new Error(`Unknown prompt: ${request.params.name}`);
    return prompt;
  });

  return server;
}

function installProcessShutdownHandlers(shutdown: ShutdownFn, options?: { stdio?: boolean }): () => void {
  const onSigInt = (): void => { void shutdown(); };
  const onSigTerm = (): void => { void shutdown(); };
  const onUncaughtException = (err: unknown): void => {
    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
    process.stderr.write(`cotx MCP uncaughtException: ${msg}\n`);
    void shutdown(1);
  };
  const onUnhandledRejection = (reason: unknown): void => {
    const msg = reason instanceof Error ? reason.stack : String(reason);
    process.stderr.write(`cotx MCP unhandledRejection: ${msg}\n`);
  };

  process.on('SIGINT', onSigInt);
  process.on('SIGTERM', onSigTerm);
  process.on('uncaughtException', onUncaughtException);
  process.on('unhandledRejection', onUnhandledRejection);

  let onStdinEnd: (() => void) | undefined;
  let onStdinError: (() => void) | undefined;
  let onStdoutError: (() => void) | undefined;

  if (options?.stdio) {
    onStdinEnd = (): void => { void shutdown(); };
    onStdinError = (): void => { void shutdown(); };
    onStdoutError = (): void => { void shutdown(); };
    process.stdin.on('end', onStdinEnd);
    process.stdin.on('error', onStdinError);
    process.stdout.on('error', onStdoutError);
  }

  return (): void => {
    process.off('SIGINT', onSigInt);
    process.off('SIGTERM', onSigTerm);
    process.off('uncaughtException', onUncaughtException);
    process.off('unhandledRejection', onUnhandledRejection);
    if (onStdinEnd) process.stdin.off('end', onStdinEnd);
    if (onStdinError) process.stdin.off('error', onStdinError);
    if (onStdoutError) process.stdout.off('error', onStdoutError);
  };
}

export async function startMcpServer(): Promise<void> {
  installStdioConsoleRedirect();
  let markActivity = (): void => {};
  const server = createConfiguredServer(() => {
    markActivity();
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Graceful shutdown
  let shuttingDown = false;
  let removeShutdownHandlers = (): void => {};
  let removeStdinActivityListener = (): void => {};
  const shutdown = async (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    lifecycle.stop();
    removeShutdownHandlers();
    removeStdinActivityListener();
    try {
      await server.close();
    } catch {}
    process.exit(exitCode);
  };
  const lifecycleConfig = resolveStdioLifecycleConfig();
  const lifecycle = createStdioLifecycleMonitor({
    ...lifecycleConfig,
    getParentPid: () => process.ppid,
    onShutdown: (reason) => {
      process.stderr.write(`cotx MCP stdio watchdog shutdown: ${reason}\n`);
      void shutdown(0);
    },
  });
  markActivity = (): void => lifecycle.markActivity();
  const onStdinData = (): void => lifecycle.markActivity();
  process.stdin.on('data', onStdinData);
  removeStdinActivityListener = (): void => {
    process.stdin.off('data', onStdinData);
  };
  lifecycle.start();
  removeShutdownHandlers = installProcessShutdownHandlers(shutdown, { stdio: true });
}

function getHeaderValue(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  return raw.length > 0 ? JSON.parse(raw) : undefined;
}

function writeJsonRpcError(
  res: ServerResponse,
  statusCode: number,
  message: string,
): void {
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message,
      },
      id: null,
    }),
  );
}

export async function startMcpHttpServer(options?: {
  host?: string;
  port?: number;
  installSignalHandlers?: boolean;
}): Promise<HttpServerHandle> {
  const host = options?.host ?? '127.0.0.1';
  const requestedPort = options?.port ?? 3000;
  const sessions = new Map<string, HttpSessionEntry>();

  const closeSession = async (sessionId: string): Promise<void> => {
    const entry = sessions.get(sessionId);
    if (!entry) return;
    sessions.delete(sessionId);
    entry.transport.onclose = undefined;
    try {
      await entry.transport.close();
    } catch {}
    try {
      await entry.server.close();
    } catch {}
  };

  const closeAllSessions = async (): Promise<void> => {
    for (const sessionId of [...sessions.keys()]) {
      await closeSession(sessionId);
    }
  };

  const httpServer = createHttpServer(async (req, res) => {
    const requestUrl = new URL(
      req.url ?? '/',
      `http://${req.headers.host ?? `${host}:${requestedPort}`}`,
    );

    if (requestUrl.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        service: 'cotx-engine',
        token: process.env.COTX_DAEMON_TOKEN,
      }));
      return;
    }

    if (requestUrl.pathname === '/' && req.method === 'GET') {
      try {
        const projects = listProjects();
        const html = generateLandingHtml(projects);
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-cache',
        });
        res.end(html);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(`Failed to generate landing page: ${msg}`);
      }
      return;
    }

    // --- Workbench API routes ---

    if (requestUrl.pathname === '/api/v1/projects' && req.method === 'GET') {
      try {
        const projects = listProjects().map((project) => ({
          id: project.name,
          name: project.name,
          path: project.path,
          compiledAt: project.compiled_at,
          workspaceLayout: readWorkspaceLayoutSummary(project.path),
          stats: project.stats,
          defaultPerspective: 'overall-architecture',
        }));
        writeJsonResponse(res, 200, projects);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        writeJsonResponse(res, 500, { error: msg });
      }
      return;
    }

    const apiMetaMatch = requestUrl.pathname.match(/^\/api\/v1\/([^/]+)\/meta$/);
    if (apiMetaMatch && req.method === 'GET') {
      try {
        const projectName = decodeURIComponent(apiMetaMatch[1]);
        const project = resolveProject(projectName);
        if (!project) {
          writeJsonResponse(res, 404, { error: `Project "${projectName}" not found` });
          return;
        }
        const meta = getProjectMeta(project.path);
        writeJsonResponse(res, 200, meta);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        writeJsonResponse(res, 500, { error: msg });
      }
      return;
    }

    const apiPerspectiveNodeImpactMatch = requestUrl.pathname.match(/^\/api\/v1\/([^/]+)\/perspectives\/([^/]+)\/nodes\/(.+)\/impact$/);
    if (apiPerspectiveNodeImpactMatch && req.method === 'GET') {
      try {
        const projectName = decodeURIComponent(apiPerspectiveNodeImpactMatch[1]);
        const perspectiveId = decodeURIComponent(apiPerspectiveNodeImpactMatch[2]);
        const nodePath = decodeURIComponent(apiPerspectiveNodeImpactMatch[3]);
        const direction = requestUrl.searchParams.get('direction') === 'downstream' ? 'downstream' : 'upstream';
        const project = resolveProject(projectName);
        if (!project) {
          writeJsonResponse(res, 404, { error: `Project "${projectName}" not found` });
          return;
        }
        const archStore = new ArchitectureStore(project.path);
        if (!archStore.exists()) {
          writeJsonResponse(res, 404, { error: 'No architecture data found' });
          return;
        }
        const element = readApiElement(archStore, perspectiveId, nodePath);
        if (!element) {
          writeJsonResponse(res, 404, { error: `Node "${nodePath}" not found` });
          return;
        }

        const impact = await collectFileBackedImpact(
          project.path,
          nodePath,
          sourcePathsForImpact(archStore, nodePath, element),
          direction,
        );
        writeJsonResponse(res, 200, impact);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        writeJsonResponse(res, 500, { error: msg });
      }
      return;
    }

    const apiPerspectiveNodeMatch = requestUrl.pathname.match(/^\/api\/v1\/([^/]+)\/perspectives\/([^/]+)\/nodes\/(.+)$/);
    if (apiPerspectiveNodeMatch && req.method === 'GET') {
      try {
        const projectName = decodeURIComponent(apiPerspectiveNodeMatch[1]);
        const perspectiveId = decodeURIComponent(apiPerspectiveNodeMatch[2]);
        const nodePath = decodeURIComponent(apiPerspectiveNodeMatch[3]);
        const project = resolveProject(projectName);
        if (!project) {
          writeJsonResponse(res, 404, { error: `Project "${projectName}" not found` });
          return;
        }
        const archStore = new ArchitectureStore(project.path);
        if (!archStore.exists()) {
          writeJsonResponse(res, 404, { error: 'No architecture data found' });
          return;
        }
        const element = readApiElement(archStore, perspectiveId, nodePath);
        if (!element) {
          writeJsonResponse(res, 404, { error: `Node "${nodePath}" not found` });
          return;
        }
        writeJsonResponse(res, 200, element);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        writeJsonResponse(res, 500, { error: msg });
      }
      return;
    }

    const apiPerspectiveMatch = requestUrl.pathname.match(/^\/api\/v1\/([^/]+)\/perspectives\/([^/]+)$/);
    if (apiPerspectiveMatch && req.method === 'GET') {
      try {
        const projectName = decodeURIComponent(apiPerspectiveMatch[1]);
        const perspectiveId = decodeURIComponent(apiPerspectiveMatch[2]);
        const project = resolveProject(projectName);
        if (!project) {
          writeJsonResponse(res, 404, { error: `Project "${projectName}" not found` });
          return;
        }
        const archStore = new ArchitectureStore(project.path);
        if (!archStore.exists()) {
          writeJsonResponse(res, 404, { error: 'No architecture data found' });
          return;
        }
        const perspectiveIds = archStore.listPerspectives();
        if (!perspectiveIds.includes(perspectiveId)) {
          writeJsonResponse(res, 404, { error: `Perspective "${perspectiveId}" not found` });
          return;
        }
        writeJsonResponse(res, 200, buildApiPerspective(archStore, perspectiveId));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        writeJsonResponse(res, 500, { error: msg });
      }
      return;
    }

    const apiPerspectivesMatch = requestUrl.pathname.match(/^\/api\/v1\/([^/]+)\/perspectives$/);
    if (apiPerspectivesMatch && req.method === 'GET') {
      try {
        const projectName = decodeURIComponent(apiPerspectivesMatch[1]);
        const project = resolveProject(projectName);
        if (!project) {
          writeJsonResponse(res, 404, { error: `Project "${projectName}" not found` });
          return;
        }
        const archStore = new ArchitectureStore(project.path);
        if (!archStore.exists()) {
          writeJsonResponse(res, 200, []);
          return;
        }
        const perspectiveIds = archStore.listPerspectives();
        const summaries = perspectiveIds.map((id) => {
          try {
            const perspective = buildApiPerspective(archStore, id);
            return {
              id: perspective.id,
              label: perspective.label,
              layer: 'architecture',
              status: 'grounded',
              nodeCount: perspective.components.length,
              edgeCount: perspective.edges.length,
            };
          } catch {
            return { id, label: id, layer: 'architecture', status: 'unknown', nodeCount: 0, edgeCount: 0 };
          }
        });
        writeJsonResponse(res, 200, summaries);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        writeJsonResponse(res, 500, { error: msg });
      }
      return;
    }

    const apiSearchMatch = requestUrl.pathname.match(/^\/api\/v1\/([^/]+)\/search$/);
    if (apiSearchMatch && req.method === 'GET') {
      try {
        const projectName = decodeURIComponent(apiSearchMatch[1]);
        const project = resolveProject(projectName);
        if (!project) {
          writeJsonResponse(res, 404, { error: `Project "${projectName}" not found` });
          return;
        }
        const query = requestUrl.searchParams.get('q')?.trim() ?? '';
        if (!query) {
          writeJsonResponse(res, 200, { matches: [] });
          return;
        }
        const archStore = new ArchitectureStore(project.path);
        if (!archStore.exists()) {
          writeJsonResponse(res, 200, { matches: [] });
          return;
        }
        const index = ArchitectureIndex.fromStore(archStore);
        const matches = index.search(query, 20)
          .map((result) => result.id.split('/').slice(2).join('/'))
          .filter(Boolean);
        writeJsonResponse(res, 200, { matches });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        writeJsonResponse(res, 500, { error: msg });
      }
      return;
    }

    if (requestUrl.pathname.startsWith('/workbench/assets/') && req.method === 'GET') {
      const asset = readWorkbenchAsset(requestUrl.pathname);
      if (!asset) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Workbench asset not found');
        return;
      }
      res.writeHead(200, {
        'content-type': asset.contentType,
        'cache-control': 'no-cache',
      });
      res.end(asset.body);
      return;
    }

    if (requestUrl.pathname === '/workbench' || requestUrl.pathname.startsWith('/workbench/')) {
      if (req.method === 'GET') {
        const asset = readWorkbenchAsset('/workbench/index.html');
        if (asset) {
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-cache',
          });
          res.end(asset.body);
          return;
        }
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-cache',
        });
        res.end(generateWorkbenchHtml());
        return;
      }
    }

    // --- End workbench routes ---

    try {
      if (requestUrl.pathname === '/mcp') {
        const sessionId = getHeaderValue(req.headers['mcp-session-id']);

        if (sessionId) {
          const entry = sessions.get(sessionId);
          if (!entry || entry.kind !== 'streamable') {
            writeJsonRpcError(res, 404, 'Session not found');
            return;
          }
          await entry.transport.handleRequest(req, res);
          return;
        }

        if (req.method === 'GET') {
          res.writeHead(405).end('Method Not Allowed');
          return;
        }

        if (req.method === 'POST') {
          const parsedBody = await readJsonBody(req);
          if (!isInitializeRequest(parsedBody)) {
            writeJsonRpcError(res, 400, 'Bad Request: No valid session ID provided');
            return;
          }

          const mcpServer = createConfiguredServer();
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (newSessionId) => {
              sessions.set(newSessionId, {
                kind: 'streamable',
                server: mcpServer,
                transport,
              });
            },
            onsessionclosed: async (closedSessionId) => {
              await closeSession(closedSessionId);
            },
          });

          transport.onclose = () => {
            const activeSessionId = transport.sessionId;
            if (activeSessionId) {
              void closeSession(activeSessionId);
            }
          };

          await mcpServer.connect(transport);
          await transport.handleRequest(req, res, parsedBody);
          return;
        }

        writeJsonRpcError(res, 400, 'Bad Request: No valid session ID provided');
        return;
      }

      if (requestUrl.pathname === '/sse' && req.method === 'GET') {
        const mcpServer = createConfiguredServer();
        const transport = new SSEServerTransport('/messages', res);
        sessions.set(transport.sessionId, {
          kind: 'sse',
          server: mcpServer,
          transport,
        });
        transport.onclose = () => {
          void closeSession(transport.sessionId);
        };
        await mcpServer.connect(transport);
        return;
      }

      if (requestUrl.pathname === '/messages' && req.method === 'POST') {
        const sessionId = requestUrl.searchParams.get('sessionId');
        if (!sessionId) {
          res.writeHead(400).end('Missing sessionId parameter');
          return;
        }

        const entry = sessions.get(sessionId);
        if (!entry || entry.kind !== 'sse') {
          res.writeHead(404).end('Session not found');
          return;
        }

        await entry.transport.handlePostMessage(req, res);
        return;
      }

      res.writeHead(404).end('Not Found');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) {
        if (requestUrl.pathname === '/mcp') {
          writeJsonRpcError(res, 500, message);
        } else {
          res.writeHead(500).end(message);
        }
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(requestedPort, host, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  const address = httpServer.address();
  const port =
    address && typeof address === 'object' ? address.port : requestedPort;
  const baseUrl = `http://${host}:${port}`;

  const handle: HttpServerHandle = {
    host,
    port,
    baseUrl,
    landingUrl: baseUrl,
    mcpUrl: `${baseUrl}/mcp`,
    workbenchUrl: `${baseUrl}/workbench`,
    apiUrl: `${baseUrl}/api/v1`,
    sseUrl: `${baseUrl}/sse`,
    messagesUrl: `${baseUrl}/messages`,
    server: httpServer,
    close: async () => {
      await closeAllSessions();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };

  if (options?.installSignalHandlers !== false) {
    let shuttingDown = false;
    const shutdown = async (exitCode = 0) => {
      if (shuttingDown) return;
      shuttingDown = true;
      try {
        await handle.close();
      } catch {}
      process.exit(exitCode);
    };
    installProcessShutdownHandlers(shutdown);
  }

  return handle;
}

function generateLandingHtml(projects: RegistryEntry[]): string {
  const cards = projects.map((p) => {
    const s = p.stats;
    const statsText = `${s.modules} modules, ${s.concepts} concepts, ${s.contracts} contracts, ${s.flows} flows`;
    const timeText = formatRelativeTime(p.compiled_at);
    return `<a href="/workbench/${encodeURIComponent(p.name)}/overall-architecture" class="card">
      <div class="card-name">${escLanding(p.name)}</div>
      <div class="card-path">${escLanding(p.path)}</div>
      <div class="card-stats">${statsText}</div>
      <div class="card-time">compiled ${timeText}</div>
    </a>`;
  }).join('\n');

  const empty = projects.length === 0
    ? '<div class="empty">No projects registered.<br>Run <code>cotx compile</code> in a project directory.</div>'
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>cotx — projects</title>
<style>
:root {
  --bg: #0d1117;
  --surface: #161b22;
  --surface-raised: #1c2128;
  --border: #30363d;
  --text-primary: #e0e0e0;
  --text-secondary: #8b949e;
  --accent: #58a6ff;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  background: var(--bg);
  color: var(--text-primary);
  font-family: Inter, system-ui, -apple-system, sans-serif;
  min-height: 100vh;
  padding: 40px 20px;
}
h1 {
  font-size: 20px;
  font-weight: 700;
  color: var(--accent);
  margin-bottom: 24px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 16px;
  max-width: 1200px;
}
.card {
  display: block;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px 20px;
  text-decoration: none;
  color: inherit;
  transition: border-color 0.15s, transform 0.1s;
}
.card:hover { border-color: var(--accent); transform: translateY(-2px); }
.card:active { transform: scale(0.99); }
.card-name { font-size: 16px; font-weight: 600; color: var(--accent); margin-bottom: 4px; }
.card-path { font-size: 12px; color: var(--text-secondary); margin-bottom: 8px; word-break: break-all; }
.card-stats { font-size: 13px; color: var(--text-primary); margin-bottom: 4px; }
.card-time { font-size: 11px; color: var(--text-secondary); }
.empty {
  text-align: center;
  color: var(--text-secondary);
  font-size: 14px;
  line-height: 1.8;
  margin-top: 80px;
}
.empty code {
  background: var(--surface);
  padding: 2px 8px;
  border-radius: 4px;
}
</style>
</head>
<body>
<h1>cotx projects</h1>
<div class="grid">
${cards}
</div>
${empty}
</body>
</html>`;
}

function escLanding(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatRelativeTime(iso: string): string {
  try {
    const d = new Date(iso);
    const now = Date.now();
    const diff = now - d.getTime();
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    if (diff < 604800000) return Math.floor(diff / 86400000) + 'd ago';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return iso;
  }
}

function writeJsonResponse(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-cache',
    'access-control-allow-origin': '*',
  });
  res.end(JSON.stringify(body));
}

function resolveProject(projectName: string): { name: string; path: string } | undefined {
  const found = findProject(projectName);
  if (found) return found;
  const cwd = process.cwd();
  const cwdArch = new ArchitectureStore(cwd);
  if (cwdArch.exists() && path.basename(cwd) === projectName) {
    return { name: projectName, path: cwd };
  }
  return undefined;
}

function hasCotxMeta(projectPath: string): boolean {
  return fs.existsSync(path.join(projectPath, '.cotx', 'meta.yaml'));
}

function getProjectMeta(projectPath: string): {
  id: string;
  compiledAt: string;
  version: string;
  stats: Record<string, number>;
  hasCotx: boolean;
  hasArchitecture: boolean;
  workspaceLayout?: {
    repoBoundaries: number;
    packageBoundaries: number;
    assetDirectories: number;
    assetPaths: string[];
  };
} {
  const store = new CotxStore(projectPath);
  const archStore = new ArchitectureStore(projectPath);
  const hasCotx = hasCotxMeta(projectPath);
  const hasArchitecture = archStore.exists();
  const workspaceLayout = readWorkspaceLayoutSummary(projectPath);

  if (hasCotx) {
    const meta = store.readMeta();
    return {
      id: meta.project,
      compiledAt: meta.compiled_at,
      version: meta.version,
      stats: meta.stats,
      hasCotx,
      hasArchitecture,
      workspaceLayout,
    };
  }

  if (hasArchitecture) {
    const archMeta = archStore.readMeta();
    return {
      id: path.basename(projectPath),
      compiledAt: archMeta.generated_at,
      version: '0.0.0',
      stats: {},
      hasCotx,
      hasArchitecture,
      workspaceLayout,
    };
  }

  return {
    id: path.basename(projectPath),
    compiledAt: '',
    version: '0.0.0',
    stats: {},
    hasCotx,
    hasArchitecture,
    workspaceLayout,
  };
}

function readWorkspaceLayoutSummary(projectPath: string): {
  repoBoundaries: number;
  packageBoundaries: number;
  assetDirectories: number;
  assetPaths: string[];
} | undefined {
  const workspaceLayout = new CotxStore(projectPath).readWorkspaceLayout();
  if (!workspaceLayout) return undefined;
  return {
    repoBoundaries: workspaceLayout.summary.repo_boundaries,
    packageBoundaries: workspaceLayout.summary.packages,
    assetDirectories: workspaceLayout.summary.asset_dirs ?? 0,
    assetPaths: workspaceLayout.directories
      .filter((entry) => entry.kind === 'asset')
      .map((entry) => entry.path)
      .slice(0, 8),
  };
}

function buildApiPerspective(
  archStore: ArchitectureStore,
  perspectiveId: string,
): PerspectiveData & { layer?: 'architecture'; summary?: string | null } {
  const perspective = archStore.readPerspective(perspectiveId);
  const elementPaths = [
    ...perspective.components.map((component) => component.id),
    ...archStore.listElementPaths(perspectiveId),
  ];
  const uniquePaths = [...new Set(elementPaths)].sort();

  const components = uniquePaths
    .map((elementPath) => readApiElement(archStore, perspectiveId, elementPath))
    .filter((value): value is ApiElement => Boolean(value));

  return {
    ...perspective,
    layer: 'architecture',
    summary: archStore.readDescription(perspectiveId),
    components,
  };
}

type ApiElement = ArchitectureElement & {
  path: string;
  description?: string | null;
  diagram?: string | null;
  layer?: 'architecture';
  evidence_status?: 'grounded' | 'stale' | 'unknown';
  status_reason?: string | null;
  evidence?: Array<{
    kind: string;
    ref: string;
    filePath?: string;
    line?: number;
    detail?: string;
  }>;
};

function readApiElement(
  archStore: ArchitectureStore,
  perspectiveId: string,
  elementPath: string,
): ApiElement | null {
  let element: ArchitectureElement | undefined;
  try {
    element = archStore.readElement(perspectiveId, elementPath);
  } catch {
    const perspective = archStore.readPerspective(perspectiveId);
    element = perspective.components.find((component) => component.id === elementPath);
  }

  if (!element) return null;

  const resolvedChildren = element.children?.map((child) =>
    child.includes('/') ? child : `${elementPath}/${child}`,
  );
  const workspaceElement = findWorkspaceElementForApiElement(
    archStore,
    elementPath,
    element,
  );

  return {
    ...element,
    path: elementPath,
    layer: 'architecture',
    evidence_status: workspaceElement
      ? workspaceElement.stale ? 'stale' : 'grounded'
      : 'unknown',
    status_reason: workspaceElement?.stale_reason ?? (
      workspaceElement ? null : 'No architecture workspace evidence anchor matched this element.'
    ),
    evidence: workspaceElement?.evidence.map((anchor) => ({
      kind: anchor.kind,
      ref: anchor.id,
      filePath: anchor.filePath,
      line: anchor.line,
      detail: anchor.detail,
    })),
    children: resolvedChildren,
    description: archStore.readDescription(`${perspectiveId}/${elementPath}`) ?? undefined,
    diagram: archStore.readDiagram(`${perspectiveId}/${elementPath}`) ?? undefined,
  };
}

function findWorkspaceElementForApiElement(
  archStore: ArchitectureStore,
  elementPath: string,
  element: ArchitectureElement,
): ArchitectureWorkspaceElement | undefined {
  const workspace = archStore.readWorkspace();
  if (!workspace) return undefined;
  const directId = workspaceElementIdForApiElement(elementPath, element);
  return workspace.elements.find((candidate) => candidate.id === directId);
}

function workspaceElementIdForApiElement(
  elementPath: string,
  element: ArchitectureElement,
): string {
  if (!elementPath.includes('/')) {
    return `container:${elementPath}`;
  }
  const compact = compactRepeatedSegments(elementPath);
  if (element.kind === 'leaf' && (element.files?.length ?? 0) <= 1) {
    return `code_element:${compact}`;
  }
  return `component:${compact}`;
}

function compactRepeatedSegments(value: string): string {
  const result: string[] = [];
  for (const part of value.split('/')) {
    if (result[result.length - 1] === part) continue;
    result.push(part);
  }
  return result.join('/');
}

function sourcePathsForImpact(
  archStore: ArchitectureStore,
  elementPath: string,
  element: ApiElement,
): string[] {
  const sourcePaths = new Set<string>();
  if (element.directory) sourcePaths.add(element.directory);
  for (const filePath of element.files ?? []) {
    if (filePath) sourcePaths.add(filePath);
  }
  for (const anchor of element.evidence ?? []) {
    if (anchor.filePath) sourcePaths.add(anchor.filePath);
  }
  const workspaceElement = findWorkspaceElementForApiElement(archStore, elementPath, element);
  for (const sourcePath of workspaceElement?.source_paths ?? []) {
    if (sourcePath) sourcePaths.add(sourcePath);
  }
  return [...sourcePaths].sort();
}

function generateWorkbenchHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>cotx workbench</title>
<style>
:root {
  --bg: #0d1117;
  --text: #e0e0e0;
  --accent: #58a6ff;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  background: var(--bg);
  color: var(--text);
  font-family: Inter, system-ui, -apple-system, sans-serif;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
}
.container { text-align: center; }
h1 { font-size: 24px; color: var(--accent); margin-bottom: 8px; }
p { font-size: 14px; color: #8b949e; }
</style>
</head>
<body>
<div class="container" id="workbench-root">
  <h1>cotx workbench</h1>
  <p>SDK explorer app will mount here.</p>
</div>
</body>
</html>`;
}
