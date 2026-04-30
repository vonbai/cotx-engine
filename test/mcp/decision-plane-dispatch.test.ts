import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { CotxStore } from '../../src/store/store.js';
import { handleToolCall } from '../../src/mcp/tools.js';
import { GraphTruthStore, type GraphFacts } from '../../src/store-v2/index.js';

function parse(result: Awaited<ReturnType<typeof handleToolCall>>) {
  return JSON.parse(result.content[0].text);
}

describe('MCP decision-plane dispatch', () => {
  let tmpDir: string;
  let store: CotxStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-mcp-decision-plane-'));
    store = new CotxStore(tmpDir);
    store.init('mcp-decision-plane-test');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('requires storage-v2 canonical path data instead of semantic artifact fallback', async () => {
    const result = parse(await handleToolCall('cotx_canonical_paths', { project_root: tmpDir }));
    expect(result.error).toContain('storage-v2 canonical path rule index');
  });

  it('serves storage-v2 cypher queries', async () => {
    const graphStore = new GraphTruthStore({ dbPath: path.join(tmpDir, '.cotx', 'v2', 'truth.lbug') });
    await graphStore.open();
    try {
      await graphStore.writeFacts(sampleGraphFacts());
    } finally {
      await graphStore.close();
    }

    const result = parse(await handleToolCall('cotx_cypher', {
      project_root: tmpDir,
      query: 'MATCH (n:CodeNode) RETURN n.id AS id ORDER BY id',
    }));

    expect(result.row_count).toBe(1);
    expect(result.rows[0].id).toBe('sym:api.run');
  });

  it('serves typed storage-v2 code node context and impact', async () => {
    const graphStore = new GraphTruthStore({ dbPath: path.join(tmpDir, '.cotx', 'v2', 'truth.lbug') });
    await graphStore.open();
    try {
      await graphStore.writeFacts({
        ...sampleGraphFacts(),
        codeNodes: [
          { id: 'sym:api.run', label: 'Function', name: 'run', filePath: 'src/api.ts', startLine: 1, endLine: 3, isExported: true, properties: JSON.stringify({ name: 'run' }) },
          { id: 'sym:svc.helper', label: 'Function', name: 'helper', filePath: 'src/service.ts', startLine: 1, endLine: 3, isExported: true, properties: JSON.stringify({ name: 'helper' }) },
        ],
        codeRelations: [{ from: 'sym:api.run', to: 'sym:svc.helper', type: 'CALLS', confidence: 1, reason: '', step: 0 }],
      });
    } finally {
      await graphStore.close();
    }

    const context = parse(await handleToolCall('cotx_context', {
      project_root: tmpDir,
      node_id: 'sym:api.run',
    }));
    expect(context.layer).toBe('Function');
    expect(context.outgoing[0].to).toBe('sym:svc.helper');

    const impact = parse(await handleToolCall('cotx_impact', {
      project_root: tmpDir,
      target: 'sym:api.run',
      direction: 'downstream',
    }));
    expect(impact.target.layer).toBe('Function');
    expect(impact.summary.affected_nodes).toContain('sym:svc.helper');
  });

  it('serves storage-v2 decision rule queries', async () => {
    const { DecisionRuleIndex } = await import('../../src/store-v2/index.js');
    const index = new DecisionRuleIndex({ dbPath: path.join(tmpDir, '.cotx', 'v2', 'rules.db') });
    await index.open();
    try {
      await index.writeFacts({
        canonical: [
          {
            id: 'canonical:create',
            familyId: 'create:repository_write',
            targetConcern: 'create:repository_write',
            owningModule: 'api',
            confidence: 0.8,
            status: 'canonical',
          },
        ],
        symmetry: [],
        closures: [],
        closureMembers: [],
        abstractions: [],
        abstractionUnits: [],
        plans: [],
        reviews: [],
        planCoversClosure: [],
        reviewFlagsPlan: [],
      });
    } finally {
      index.close();
    }

    const result = parse(await handleToolCall('cotx_decision_query', {
      project_root: tmpDir,
      kind: 'canonical',
      target: 'create:repository_write',
    }));

    expect(result.row_count).toBe(1);
    expect(result.rows[0].id).toBe('canonical:create');
  });

  it('serves typed graph route, shape, API impact, and tool maps', async () => {
    const graphStore = new GraphTruthStore({ dbPath: path.join(tmpDir, '.cotx', 'v2', 'truth.lbug') });
    await graphStore.open();
    try {
      await graphStore.writeFacts(sampleTypedApiGraphFacts());
    } finally {
      await graphStore.close();
    }

    const routeMap = parse(await handleToolCall('cotx_route_map', {
      project_root: tmpDir,
      route: '/users',
    }));
    expect(routeMap.routes[0].handlers[0].id).toBe('sym:api.run');
    expect(routeMap.routes[0].consumers[0].accessedKeys).toEqual(['data', 'missing']);

    const shape = parse(await handleToolCall('cotx_shape_check', {
      project_root: tmpDir,
      route: '/users',
    }));
    expect(shape.routes[0].status).toBe('MISMATCH');
    expect(shape.routes[0].missingKeys).toEqual(['missing']);

    const apiImpact = parse(await handleToolCall('cotx_api_impact', {
      project_root: tmpDir,
      route: '/users',
    }));
    expect(apiImpact.risk).toBe('MEDIUM');

    const toolMap = parse(await handleToolCall('cotx_tool_map', {
      project_root: tmpDir,
      tool: 'create_user',
    }));
    expect(toolMap.tools[0].handlers[0].id).toBe('sym:api.run');
  });

  it('maps git diff hunks to typed graph nodes for change detection', async () => {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'api.ts'), [
      'export function run() {',
      '  return helper();',
      '}',
      'export function helper() {',
      '  return 1;',
      '}',
      '',
    ].join('\n'));
    execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git add src/api.ts && git -c user.email=a@example.com -c user.name=a commit -m init', { cwd: tmpDir, stdio: 'ignore' });

    const graphStore = new GraphTruthStore({ dbPath: path.join(tmpDir, '.cotx', 'v2', 'truth.lbug') });
    await graphStore.open();
    try {
      await graphStore.writeFacts({
        ...sampleGraphFacts(),
        codeNodes: [
          { id: 'Function:src/api.ts:run', label: 'Function', name: 'run', filePath: 'src/api.ts', startLine: 1, endLine: 3, isExported: true, properties: JSON.stringify({ name: 'run' }) },
          { id: 'Function:src/api.ts:helper', label: 'Function', name: 'helper', filePath: 'src/api.ts', startLine: 4, endLine: 6, isExported: true, properties: JSON.stringify({ name: 'helper' }) },
        ],
        codeRelations: [
          { from: 'Function:src/api.ts:run', to: 'Function:src/api.ts:helper', type: 'CALLS', confidence: 1, reason: '', step: 0 },
        ],
      });
    } finally {
      await graphStore.close();
    }

    fs.writeFileSync(path.join(tmpDir, 'src', 'api.ts'), [
      'export function run() {',
      '  return helper();',
      '}',
      'export function helper() {',
      '  return 2;',
      '}',
      '',
    ].join('\n'));

    const result = parse(await handleToolCall('cotx_detect_changes', {
      project_root: tmpDir,
      scope: 'unstaged',
    }));

    expect(result.changed_symbols[0].id).toBe('Function:src/api.ts:helper');
    expect(result.affected_symbols).toContain('Function:src/api.ts:run');
  });

  it('prefers storage-v2 canonical paths when rule index exists', async () => {
    const { DecisionRuleIndex } = await import('../../src/store-v2/index.js');
    const index = new DecisionRuleIndex({ dbPath: path.join(tmpDir, '.cotx', 'v2', 'rules.db') });
    await index.open();
    try {
      await index.writeFacts({
        canonical: [
          {
            id: 'canonical:create',
            familyId: 'create:repository_write',
            targetConcern: 'create:repository_write',
            owningModule: 'api',
            confidence: 0.8,
            status: 'canonical',
          },
        ],
        symmetry: [],
        closures: [],
        closureMembers: [],
        abstractions: [],
        abstractionUnits: [],
        plans: [],
        reviews: [],
        planCoversClosure: [],
        reviewFlagsPlan: [],
      });
    } finally {
      index.close();
    }

    const result = parse(await handleToolCall('cotx_canonical_paths', { project_root: tmpDir }));

    expect(result[0].id).toBe('canonical:create');
    expect(result[0].targetConcern).toBe('create:repository_write');
  });
});

function sampleGraphFacts(): GraphFacts {
  return {
    codeNodes: [{ id: 'sym:api.run', label: 'Function', name: 'run', filePath: 'src/api.ts', startLine: 1, endLine: 1, isExported: true, properties: JSON.stringify({ name: 'run' }) }],
    codeRelations: [],
  };
}

function sampleTypedApiGraphFacts(): GraphFacts {
  return {
    ...sampleGraphFacts(),
    codeNodes: [
      {
        id: 'sym:api.run',
        label: 'Function',
        name: 'run',
        filePath: 'src/api.ts',
        startLine: 1,
        endLine: 10,
        isExported: true,
        properties: JSON.stringify({ name: 'run', filePath: 'src/api.ts' }),
      },
      {
        id: 'route:POST /users',
        label: 'Route',
        name: '/users',
        filePath: 'src/api.ts',
        startLine: 1,
        endLine: 10,
        isExported: false,
        properties: JSON.stringify({ path: '/users', method: 'POST', responseKeys: ['data'], middleware: ['auth'] }),
      },
      {
        id: 'consumer:web.createUser',
        label: 'File',
        name: 'createUserForm',
        filePath: 'src/web.ts',
        startLine: 1,
        endLine: 10,
        isExported: false,
        properties: JSON.stringify({ name: 'createUserForm', filePath: 'src/web.ts' }),
      },
      {
        id: 'tool:create_user',
        label: 'Tool',
        name: 'create_user',
        filePath: 'src/tools.ts',
        startLine: 1,
        endLine: 10,
        isExported: false,
        properties: JSON.stringify({ name: 'create_user', description: 'Create a user' }),
      },
    ],
    codeRelations: [
      { from: 'sym:api.run', to: 'route:POST /users', type: 'HANDLES_ROUTE', confidence: 1, reason: 'decorator-post', step: 0 },
      { from: 'consumer:web.createUser', to: 'route:POST /users', type: 'FETCHES', confidence: 0.9, reason: 'fetch-url-match|keys:data,missing', step: 0 },
      { from: 'sym:api.run', to: 'tool:create_user', type: 'HANDLES_TOOL', confidence: 1, reason: 'tool-definition', step: 0 },
    ],
  };
}
