import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';

const nodes = [
  { id: 'sym:api.handleCreateUser', kind: 'Symbol', name: 'handleCreateUser', filePath: 'src/api/user.ts', payload: {} },
  { id: 'sym:svc.validateUser', kind: 'Symbol', name: 'validateUser', filePath: 'src/service/user.ts', payload: {} },
  { id: 'sym:repo.saveUser', kind: 'Symbol', name: 'saveUser', filePath: 'src/repo/user.ts', payload: {} },
  { id: 'route:POST /users', kind: 'Route', name: 'POST /users', filePath: 'src/api/user.ts', payload: { responseKeys: ['data', 'error'] } },
  { id: 'consumer:web.createUser', kind: 'Consumer', name: 'createUserForm', filePath: 'src/web/user.ts', payload: { accessedKeys: ['data', 'missing'] } },
  { id: 'unit:api.createUser', kind: 'OperationUnit', name: 'createUser', filePath: 'src/api/user.ts', payload: {} },
  { id: 'unit:api.createAdmin', kind: 'OperationUnit', name: 'createAdmin', filePath: 'src/api/admin.ts', payload: {} },
  { id: 'closure:createUser', kind: 'ClosureSet', name: 'create user closure', filePath: '', payload: {} },
];

const edges = [
  { from: 'sym:api.handleCreateUser', to: 'sym:svc.validateUser', type: 'CALLS', confidence: 1, detail: '' },
  { from: 'sym:svc.validateUser', to: 'sym:repo.saveUser', type: 'CALLS', confidence: 1, detail: '' },
  { from: 'route:POST /users', to: 'sym:api.handleCreateUser', type: 'HANDLES_ROUTE', confidence: 1, detail: '' },
  { from: 'consumer:web.createUser', to: 'route:POST /users', type: 'FETCHES', confidence: 1, detail: '' },
  { from: 'closure:createUser', to: 'unit:api.createUser', type: 'CLOSURE_REQUIRES', confidence: 1, detail: 'target' },
  { from: 'closure:createUser', to: 'unit:api.createAdmin', type: 'CLOSURE_REQUIRES', confidence: 0.92, detail: 'sibling create handler' },
  { from: 'unit:api.createUser', to: 'unit:api.createAdmin', type: 'SYMMETRIC_WITH', confidence: 0.92, detail: 'same verb and sink' },
].map((edge, index) => ({ id: `edge:${index}`, ...edge }));

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cotx-${name}-`));
}

function ms(start) {
  return Number((performance.now() - start).toFixed(2));
}

function ok(adapter, metrics, results) {
  return { adapter, ok: true, metrics, results };
}

function failed(adapter, error) {
  return { adapter, ok: false, error: error instanceof Error ? error.stack ?? error.message : String(error) };
}

function quote(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'");
}

async function runLadybug() {
  const start = performance.now();
  const lbug = await import('@ladybugdb/core');
  const mod = lbug.default ?? lbug;
  const dir = tmpDir('ladybug');
  const db = new mod.Database(path.join(dir, 'graph.lbug'));
  const conn = new mod.Connection(db);
  const q = async (query) => {
    const result = await conn.query(query);
    return typeof result?.getAll === 'function' ? await result.getAll() : result;
  };
  try {
    await q('CREATE NODE TABLE Node (id STRING, kind STRING, name STRING, filePath STRING, payload STRING, PRIMARY KEY(id))');
    await q('CREATE REL TABLE Edge (FROM Node TO Node, type STRING, confidence DOUBLE, detail STRING)');
    for (const n of nodes) {
      await q(`CREATE (:Node {id: '${quote(n.id)}', kind: '${quote(n.kind)}', name: '${quote(n.name)}', filePath: '${quote(n.filePath)}', payload: '${quote(JSON.stringify(n.payload))}'})`);
    }
    for (const e of edges) {
      await q(`MATCH (a:Node {id: '${quote(e.from)}'}), (b:Node {id: '${quote(e.to)}'}) CREATE (a)-[:Edge {type: '${quote(e.type)}', confidence: ${e.confidence}, detail: '${quote(e.detail)}'}]->(b)`);
    }
    const context = await q("MATCH (a:Node {id: 'sym:api.handleCreateUser'})-[e:Edge]->(b:Node) RETURN b.id, e.type ORDER BY b.id");
    const impact = await q("MATCH p=(a:Node {id: 'sym:api.handleCreateUser'})-[:Edge*1..2]->(b:Node) RETURN DISTINCT b.id ORDER BY b.id");
    const routeShape = await q("MATCH (c:Node)-[:Edge {type: 'FETCHES'}]->(r:Node {id: 'route:POST /users'}) RETURN c.payload, r.payload");
    const closure = await q("MATCH (c:Node {id: 'closure:createUser'})-[e:Edge {type: 'CLOSURE_REQUIRES'}]->(u:Node) RETURN u.id, e.confidence, e.detail ORDER BY u.id");
    return ok('ladybug', { elapsed_ms: ms(start) }, { context: context.length, impact: impact.length, routeShape: routeShape.length, closure: closure.length });
  } finally {
    // Avoid deleting the backing file inside the same process. The current
    // native binding can segfault during teardown on minimal scripts; child
    // process isolation keeps this from contaminating the rest of the bakeoff.
    try { await conn.close?.(); } catch {}
    try { await db.close?.(); } catch {}
  }
}

async function runKuzu() {
  const start = performance.now();
  const kuzu = await import('kuzu');
  const dir = tmpDir('kuzu');
  const db = new kuzu.Database(path.join(dir, 'graph.kuzu'));
  const conn = new kuzu.Connection(db);
  const q = async (query) => {
    const result = await conn.query(query);
    return typeof result.getAll === 'function' ? await result.getAll() : result;
  };
  try {
    await q('CREATE NODE TABLE Node(id STRING, kind STRING, name STRING, filePath STRING, payload STRING, PRIMARY KEY(id))');
    await q('CREATE REL TABLE Edge(FROM Node TO Node, type STRING, confidence DOUBLE, detail STRING)');
    for (const n of nodes) {
      await q(`CREATE (:Node {id: '${quote(n.id)}', kind: '${quote(n.kind)}', name: '${quote(n.name)}', filePath: '${quote(n.filePath)}', payload: '${quote(JSON.stringify(n.payload))}'})`);
    }
    for (const e of edges) {
      await q(`MATCH (a:Node {id: '${quote(e.from)}'}), (b:Node {id: '${quote(e.to)}'}) CREATE (a)-[:Edge {type: '${quote(e.type)}', confidence: ${e.confidence}, detail: '${quote(e.detail)}'}]->(b)`);
    }
    const context = await q("MATCH (a:Node {id: 'sym:api.handleCreateUser'})-[e:Edge]->(b:Node) RETURN b.id, e.type ORDER BY b.id");
    const impact = await q("MATCH p=(a:Node {id: 'sym:api.handleCreateUser'})-[:Edge*1..2]->(b:Node) RETURN DISTINCT b.id ORDER BY b.id");
    const routeShape = await q("MATCH (c:Node)-[:Edge {type: 'FETCHES'}]->(r:Node {id: 'route:POST /users'}) RETURN c.payload, r.payload");
    const closure = await q("MATCH (c:Node {id: 'closure:createUser'})-[e:Edge {type: 'CLOSURE_REQUIRES'}]->(u:Node) RETURN u.id, e.confidence, e.detail ORDER BY u.id");
    return ok('kuzu', { elapsed_ms: ms(start) }, { context: context.length, impact: impact.length, routeShape: routeShape.length, closure: closure.length });
  } finally {
    await conn.close?.();
    await db.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function runCozo() {
  const start = performance.now();
  const { CozoDb } = await import('cozo-node');
  const dir = tmpDir('cozo');
  const db = new CozoDb('sqlite', path.join(dir, 'graph.db'), {});
  try {
    await db.run(':create node {id: String => kind: String, name: String, filePath: String, payload: String}');
    await db.run(':create edge {id: String => from: String, to: String, type: String, confidence: Float, detail: String}');
    await db.run('?[id, kind, name, filePath, payload] <- $rows :put node {id => kind, name, filePath, payload}', {
      rows: nodes.map((n) => [n.id, n.kind, n.name, n.filePath, JSON.stringify(n.payload)]),
    });
    await db.run('?[id, from, to, type, confidence, detail] <- $rows :put edge {id => from, to, type, confidence, detail}', {
      rows: edges.map((e) => [e.id, e.from, e.to, e.type, e.confidence, e.detail]),
    });
    const context = await db.run('?[to, type] := *edge{from: $id, to, type}', { id: 'sym:api.handleCreateUser' });
    const impact = await db.run(`
      rel[from, to] := *edge{from, to, type: 'CALLS'}
      reach[from, to] := rel[from, to]
      reach[from, to] := rel[from, mid], rel[mid, to]
      ?[to] := reach[$id, to]
    `, { id: 'sym:api.handleCreateUser' });
    const routeShape = await db.run(`
      ?[consumerPayload, routePayload] :=
        *edge{from: c, to: r, type: 'FETCHES'},
        r = 'route:POST /users',
        *node{id: c, payload: consumerPayload},
        *node{id: r, payload: routePayload}
    `);
    const closure = await db.run(`
      ?[unit, confidence, detail] :=
        *edge{from: 'closure:createUser', to: unit, type: 'CLOSURE_REQUIRES', confidence, detail}
    `);
    return ok('cozo', { elapsed_ms: ms(start) }, { context: context.rows.length, impact: impact.rows.length, routeShape: routeShape.rows.length, closure: closure.rows.length });
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function runDuckDB() {
  const start = performance.now();
  const { DuckDBInstance } = await import('@duckdb/node-api');
  const dir = tmpDir('duckdb');
  const instance = await DuckDBInstance.create(path.join(dir, 'graph.duckdb'));
  const conn = await instance.connect();
  try {
    await conn.run('CREATE TABLE node(id VARCHAR PRIMARY KEY, kind VARCHAR, name VARCHAR, filePath VARCHAR, payload JSON)');
    await conn.run('CREATE TABLE edge("from" VARCHAR, "to" VARCHAR, type VARCHAR, confidence DOUBLE, detail VARCHAR)');
    for (const n of nodes) {
      await conn.run(`INSERT INTO node VALUES ('${quote(n.id)}', '${quote(n.kind)}', '${quote(n.name)}', '${quote(n.filePath)}', '${quote(JSON.stringify(n.payload))}')`);
    }
    for (const e of edges) {
      await conn.run(`INSERT INTO edge VALUES ('${quote(e.from)}', '${quote(e.to)}', '${quote(e.type)}', ${e.confidence}, '${quote(e.detail)}')`);
    }
    const read = async (query) => (await conn.runAndReadAll(query)).getRowsJson();
    const context = await read("SELECT e.\"to\", e.type FROM edge e WHERE e.\"from\" = 'sym:api.handleCreateUser' ORDER BY e.\"to\"");
    const impact = await read(`
      WITH RECURSIVE reach(id, depth) AS (
        SELECT e."to", 1 FROM edge e WHERE e."from" = 'sym:api.handleCreateUser' AND e.type = 'CALLS'
        UNION ALL
        SELECT e."to", r.depth + 1 FROM edge e JOIN reach r ON e."from" = r.id WHERE e.type = 'CALLS' AND r.depth < 2
      )
      SELECT DISTINCT id FROM reach ORDER BY id
    `);
    const routeShape = await read("SELECT c.payload, r.payload FROM edge e JOIN node c ON c.id = e.\"from\" JOIN node r ON r.id = e.\"to\" WHERE e.type = 'FETCHES' AND r.id = 'route:POST /users'");
    const closure = await read("SELECT e.\"to\", e.confidence, e.detail FROM edge e WHERE e.\"from\" = 'closure:createUser' AND e.type = 'CLOSURE_REQUIRES' ORDER BY e.\"to\"");
    return ok('duckdb', { elapsed_ms: ms(start) }, { context: context.length, impact: impact.length, routeShape: routeShape.length, closure: closure.length });
  } finally {
    conn.closeSync?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const candidateMap = {
  ladybug: runLadybug,
  kuzu: runKuzu,
  cozo: runCozo,
  duckdb: runDuckDB,
};

const adapterArgIndex = process.argv.indexOf('--adapter');
if (adapterArgIndex !== -1) {
  const adapter = process.argv[adapterArgIndex + 1];
  const run = candidateMap[adapter];
  if (!run) {
    console.log(JSON.stringify(failed(adapter ?? 'unknown', new Error(`Unknown adapter: ${adapter}`)), null, 2));
    process.exit(1);
  }
  try {
    console.log(JSON.stringify(await run(), null, 2));
  } catch (error) {
    console.log(JSON.stringify(failed(adapter, error), null, 2));
    process.exitCode = 1;
  }
  process.exit();
}

const results = [];
for (const adapter of Object.keys(candidateMap)) {
  const child = spawnSync(process.execPath, [new URL(import.meta.url).pathname, '--adapter', adapter], {
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (child.status === 0 && child.stdout.trim()) {
    try {
      results.push(JSON.parse(child.stdout));
    } catch (error) {
      results.push(failed(adapter, new Error(`Invalid JSON output: ${child.stdout.slice(0, 500)}`)));
    }
  } else {
    results.push({
      adapter,
      ok: false,
      exit_status: child.status,
      signal: child.signal,
      stdout: child.stdout,
      stderr: child.stderr,
    });
  }
}

console.log(JSON.stringify({ generated_at: new Date().toISOString(), results }, null, 2));
