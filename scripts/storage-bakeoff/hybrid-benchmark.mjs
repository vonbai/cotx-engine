import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const facts = {
  symbols: [
    { id: 'sym:api.handleCreateUser', name: 'handleCreateUser', filePath: 'src/api/user.ts' },
    { id: 'sym:svc.validateUser', name: 'validateUser', filePath: 'src/service/user.ts' },
    { id: 'sym:repo.saveUser', name: 'saveUser', filePath: 'src/repo/user.ts' },
  ],
  routes: [
    { id: 'route:POST /users', method: 'POST', path: '/users', filePath: 'src/api/user.ts', responseKeys: ['data', 'error'], middleware: ['auth'] },
  ],
  consumers: [
    { id: 'consumer:web.createUser', name: 'createUserForm', filePath: 'src/web/user.ts', accessedKeys: ['data', 'missing'] },
  ],
  tools: [
    { id: 'tool:create_user', name: 'create_user', filePath: 'src/mcp/tools.ts', description: 'Create a user via the API handler' },
  ],
  processes: [
    { id: 'process:create_user', label: 'CreateUserFlow', processType: 'cross_module', stepCount: 3 },
  ],
  units: [
    { id: 'unit:api.createUser', familyId: 'create:repository_write', module: 'api', symbol: 'createUser' },
    { id: 'unit:api.createAdmin', familyId: 'create:repository_write', module: 'api', symbol: 'createAdmin' },
  ],
  closures: [{ id: 'closure:createUser', targetUnit: 'unit:api.createUser', familyId: 'create:repository_write' }],
  plans: [{ id: 'plan:canonicalize', kind: 'canonicalize_path', totalScore: 0.82 }],
  reviews: [{ id: 'review:missingClosure', severity: 'high', finding: 'Patch updates createUser but misses sibling createAdmin closure member' }],
  calls: [
    { from: 'sym:api.handleCreateUser', to: 'sym:svc.validateUser', confidence: 1 },
    { from: 'sym:svc.validateUser', to: 'sym:repo.saveUser', confidence: 1 },
  ],
  handlesRoute: [{ from: 'route:POST /users', to: 'sym:api.handleCreateUser' }],
  fetches: [{ from: 'consumer:web.createUser', to: 'route:POST /users' }],
  handlesTool: [{ from: 'tool:create_user', to: 'sym:api.handleCreateUser' }],
  steps: [
    { from: 'sym:api.handleCreateUser', to: 'process:create_user', step: 1 },
    { from: 'sym:svc.validateUser', to: 'process:create_user', step: 2 },
    { from: 'sym:repo.saveUser', to: 'process:create_user', step: 3 },
  ],
  closureRequires: [
    { from: 'closure:createUser', to: 'unit:api.createUser', confidence: 1, reason: 'target' },
    { from: 'closure:createUser', to: 'unit:api.createAdmin', confidence: 0.92, reason: 'same family sibling' },
  ],
  planCoversClosure: [{ from: 'plan:canonicalize', to: 'closure:createUser' }],
  reviewFlagsPlan: [{ from: 'review:missingClosure', to: 'plan:canonicalize' }],
};

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cotx-${name}-`));
}

function ms(start) {
  return Number((performance.now() - start).toFixed(2));
}

function quote(value) {
  return String(value ?? '').replaceAll('\\', '\\\\').replaceAll("'", "\\'");
}

function json(value) {
  return JSON.stringify(value);
}

function parseKeys(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return JSON.parse(value);
  return [];
}

function shapeMissing(row) {
  const consumerKeys = parseKeys(row.accessedKeys ?? row['c.accessedKeys'] ?? row[0]);
  const routeKeys = parseKeys(row.responseKeys ?? row['r.responseKeys'] ?? row[1]);
  return consumerKeys.filter((key) => !routeKeys.includes(key));
}

function ok(adapter, metrics, results, notes = []) {
  return { adapter, ok: true, metrics, results, notes };
}

function failed(adapter, error) {
  return { adapter, ok: false, error: error instanceof Error ? error.stack ?? error.message : String(error) };
}

async function openLadybug(name) {
  const lbug = await import('@ladybugdb/core');
  const mod = lbug.default ?? lbug;
  const dir = tmpDir(name);
  const db = new mod.Database(path.join(dir, 'graph.lbug'));
  const conn = new mod.Connection(db);
  const q = async (query) => {
    const result = await conn.query(query);
    return typeof result?.getAll === 'function' ? await result.getAll() : result;
  };
  return { dir, db, conn, q };
}

async function openCozo(name) {
  const { CozoDb } = await import('cozo-node');
  const dir = tmpDir(name);
  const db = new CozoDb('sqlite', path.join(dir, 'graph.db'), {});
  return { dir, db };
}

async function openDuckDB(name) {
  const { DuckDBInstance } = await import('@duckdb/node-api');
  const dir = tmpDir(name);
  const instance = await DuckDBInstance.create(path.join(dir, 'graph.duckdb'));
  const conn = await instance.connect();
  return { dir, conn };
}

async function closeLadybug(handle) {
  try { await handle.conn.close?.(); } catch {}
  try { await handle.db.close?.(); } catch {}
}

async function closeCozo(handle) {
  try { handle.db.close(); } catch {}
  fs.rmSync(handle.dir, { recursive: true, force: true });
}

async function closeDuckDB(handle) {
  try { handle.conn.closeSync?.(); } catch {}
  fs.rmSync(handle.dir, { recursive: true, force: true });
}

async function createLadybugCore(q) {
  await q('CREATE NODE TABLE Symbol(id STRING, name STRING, filePath STRING, PRIMARY KEY(id))');
  await q('CREATE NODE TABLE Route(id STRING, method STRING, path STRING, filePath STRING, responseKeys STRING, middleware STRING, PRIMARY KEY(id))');
  await q('CREATE NODE TABLE Consumer(id STRING, name STRING, filePath STRING, accessedKeys STRING, PRIMARY KEY(id))');
  await q('CREATE NODE TABLE Tool(id STRING, name STRING, filePath STRING, description STRING, PRIMARY KEY(id))');
  await q('CREATE NODE TABLE Process(id STRING, label STRING, processType STRING, stepCount INT64, PRIMARY KEY(id))');
  await q('CREATE REL TABLE Calls(FROM Symbol TO Symbol, confidence DOUBLE)');
  await q('CREATE REL TABLE HandlesRoute(FROM Route TO Symbol)');
  await q('CREATE REL TABLE Fetches(FROM Consumer TO Route)');
  await q('CREATE REL TABLE HandlesTool(FROM Tool TO Symbol)');
  await q('CREATE REL TABLE StepInProcess(FROM Symbol TO Process, step INT64)');
}

async function insertLadybugCore(q) {
  for (const item of facts.symbols) await q(`CREATE (:Symbol {id:'${quote(item.id)}', name:'${quote(item.name)}', filePath:'${quote(item.filePath)}'})`);
  for (const item of facts.routes) await q(`CREATE (:Route {id:'${quote(item.id)}', method:'${quote(item.method)}', path:'${quote(item.path)}', filePath:'${quote(item.filePath)}', responseKeys:'${quote(json(item.responseKeys))}', middleware:'${quote(json(item.middleware))}'})`);
  for (const item of facts.consumers) await q(`CREATE (:Consumer {id:'${quote(item.id)}', name:'${quote(item.name)}', filePath:'${quote(item.filePath)}', accessedKeys:'${quote(json(item.accessedKeys))}'})`);
  for (const item of facts.tools) await q(`CREATE (:Tool {id:'${quote(item.id)}', name:'${quote(item.name)}', filePath:'${quote(item.filePath)}', description:'${quote(item.description)}'})`);
  for (const item of facts.processes) await q(`CREATE (:Process {id:'${quote(item.id)}', label:'${quote(item.label)}', processType:'${quote(item.processType)}', stepCount:${item.stepCount}})`);
  for (const item of facts.calls) await q(`MATCH (a:Symbol {id:'${quote(item.from)}'}), (b:Symbol {id:'${quote(item.to)}'}) CREATE (a)-[:Calls {confidence:${item.confidence}}]->(b)`);
  for (const item of facts.handlesRoute) await q(`MATCH (a:Route {id:'${quote(item.from)}'}), (b:Symbol {id:'${quote(item.to)}'}) CREATE (a)-[:HandlesRoute]->(b)`);
  for (const item of facts.fetches) await q(`MATCH (a:Consumer {id:'${quote(item.from)}'}), (b:Route {id:'${quote(item.to)}'}) CREATE (a)-[:Fetches]->(b)`);
  for (const item of facts.handlesTool) await q(`MATCH (a:Tool {id:'${quote(item.from)}'}), (b:Symbol {id:'${quote(item.to)}'}) CREATE (a)-[:HandlesTool]->(b)`);
  for (const item of facts.steps) await q(`MATCH (a:Symbol {id:'${quote(item.from)}'}), (b:Process {id:'${quote(item.to)}'}) CREATE (a)-[:StepInProcess {step:${item.step}}]->(b)`);
}

async function queryLadybugCore(q) {
  const context = await q("MATCH (s:Symbol {id:'sym:api.handleCreateUser'})-[c:Calls]->(t:Symbol) RETURN t.id, c.confidence ORDER BY t.id");
  const routeShapeRows = await q("MATCH (c:Consumer)-[:Fetches]->(r:Route {id:'route:POST /users'}) RETURN c.accessedKeys, r.responseKeys");
  const toolMap = await q("MATCH (tool:Tool)-[:HandlesTool]->(handler:Symbol) RETURN tool.name, handler.name");
  const processTrace = await q("MATCH (sym:Symbol)-[step:StepInProcess]->(p:Process {id:'process:create_user'}) RETURN sym.name, step.step ORDER BY step.step");
  return {
    context: context.length,
    routeShapeMismatches: routeShapeRows.flatMap(shapeMissing),
    toolMap: toolMap.length,
    processTrace: processTrace.length,
  };
}

async function createCozoRules(db) {
  await db.run(':create op_unit {id: String => familyId: String, module: String, symbol: String}');
  await db.run(':create closure {id: String => targetUnit: String, familyId: String}');
  await db.run(':create plan {id: String => kind: String, totalScore: Float}');
  await db.run(':create review {id: String => severity: String, finding: String}');
  await db.run(':create closure_requires {from: String, to: String => confidence: Float, reason: String}');
  await db.run(':create plan_covers_closure {from: String, to: String}');
  await db.run(':create review_flags_plan {from: String, to: String}');
}

async function insertCozoRules(db) {
  await db.run('?[id, familyId, module, symbol] <- $rows :put op_unit {id => familyId, module, symbol}', { rows: facts.units.map((item) => [item.id, item.familyId, item.module, item.symbol]) });
  await db.run('?[id, targetUnit, familyId] <- $rows :put closure {id => targetUnit, familyId}', { rows: facts.closures.map((item) => [item.id, item.targetUnit, item.familyId]) });
  await db.run('?[id, kind, totalScore] <- $rows :put plan {id => kind, totalScore}', { rows: facts.plans.map((item) => [item.id, item.kind, item.totalScore]) });
  await db.run('?[id, severity, finding] <- $rows :put review {id => severity, finding}', { rows: facts.reviews.map((item) => [item.id, item.severity, item.finding]) });
  await db.run('?[from, to, confidence, reason] <- $rows :put closure_requires {from, to => confidence, reason}', { rows: facts.closureRequires.map((item) => [item.from, item.to, item.confidence, item.reason]) });
  await db.run('?[from, to] <- $rows :put plan_covers_closure {from, to}', { rows: facts.planCoversClosure.map((item) => [item.from, item.to]) });
  await db.run('?[from, to] <- $rows :put review_flags_plan {from, to}', { rows: facts.reviewFlagsPlan.map((item) => [item.from, item.to]) });
}

async function queryCozoRules(db) {
  const closure = await db.run('?[unit, confidence, reason] := *closure_requires{from: "closure:createUser", to: unit, confidence, reason}');
  const review = await db.run('?[severity, kind, closure] := *review_flags_plan{from: review, to: plan}, *plan_covers_closure{from: plan, to: closure}, *review{id: review, severity}, *plan{id: plan, kind}');
  const hardClosure = await db.run(`
    closure_member[unit] := *closure_requires{from: "closure:createUser", to: unit, confidence}, confidence >= 0.9
    ?[unit] := closure_member[unit]
  `);
  return { closure: closure.rows.length, hardClosure: hardClosure.rows.length, review: review.rows.length };
}

async function runLadybugCozo() {
  const start = performance.now();
  const ladybug = await openLadybug('hybrid-ladybug-cozo');
  const cozo = await openCozo('hybrid-ladybug-cozo');
  try {
    await createLadybugCore(ladybug.q);
    await insertLadybugCore(ladybug.q);
    await createCozoRules(cozo.db);
    await insertCozoRules(cozo.db);
    const graph = await queryLadybugCore(ladybug.q);
    const rules = await queryCozoRules(cozo.db);
    return ok('ladybug-primary+cozo-rules', { elapsed_ms: ms(start) }, { ...graph, ...rules }, [
      'Cypher graph facts stay ergonomic for agents',
      'Datalog sidecar naturally handles closure/review rules',
      'Requires dual-store sync and query orchestration',
    ]);
  } finally {
    await closeLadybug(ladybug);
    await closeCozo(cozo);
  }
}

async function createCozoPrimary(db) {
  await db.run(':create symbol {id: String => name: String, filePath: String}');
  await db.run(':create route {id: String => method: String, path: String, filePath: String, responseKeys: String, middleware: String}');
  await db.run(':create consumer {id: String => name: String, filePath: String, accessedKeys: String}');
  await db.run(':create tool {id: String => name: String, filePath: String, description: String}');
  await db.run(':create process {id: String => label: String, processType: String, stepCount: Int}');
  await db.run(':create calls {from: String, to: String => confidence: Float}');
  await db.run(':create fetches {from: String, to: String}');
  await db.run(':create handles_tool {from: String, to: String}');
  await db.run(':create step_in_process {from: String, to: String => step: Int}');
  await createCozoRules(db);
}

async function insertCozoPrimary(db) {
  await db.run('?[id, name, filePath] <- $rows :put symbol {id => name, filePath}', { rows: facts.symbols.map((item) => [item.id, item.name, item.filePath]) });
  await db.run('?[id, method, path, filePath, responseKeys, middleware] <- $rows :put route {id => method, path, filePath, responseKeys, middleware}', { rows: facts.routes.map((item) => [item.id, item.method, item.path, item.filePath, json(item.responseKeys), json(item.middleware)]) });
  await db.run('?[id, name, filePath, accessedKeys] <- $rows :put consumer {id => name, filePath, accessedKeys}', { rows: facts.consumers.map((item) => [item.id, item.name, item.filePath, json(item.accessedKeys)]) });
  await db.run('?[id, name, filePath, description] <- $rows :put tool {id => name, filePath, description}', { rows: facts.tools.map((item) => [item.id, item.name, item.filePath, item.description]) });
  await db.run('?[id, label, processType, stepCount] <- $rows :put process {id => label, processType, stepCount}', { rows: facts.processes.map((item) => [item.id, item.label, item.processType, item.stepCount]) });
  await db.run('?[from, to, confidence] <- $rows :put calls {from, to => confidence}', { rows: facts.calls.map((item) => [item.from, item.to, item.confidence]) });
  await db.run('?[from, to] <- $rows :put fetches {from, to}', { rows: facts.fetches.map((item) => [item.from, item.to]) });
  await db.run('?[from, to] <- $rows :put handles_tool {from, to}', { rows: facts.handlesTool.map((item) => [item.from, item.to]) });
  await db.run('?[from, to, step] <- $rows :put step_in_process {from, to => step}', { rows: facts.steps.map((item) => [item.from, item.to, item.step]) });
  await insertCozoRules(db);
}

async function queryCozoPrimaryViaAdapter(db) {
  // This is not general Cypher support. It is a query-template adapter that
  // maps known cotx tool queries to Datalog. The amount of glue is the signal.
  const context = await db.run('?[to, confidence] := *calls{from: "sym:api.handleCreateUser", to, confidence}');
  const routeShapeRows = await db.run(`
    ?[accessedKeys, responseKeys] :=
      *fetches{from: consumer, to: route},
      route = 'route:POST /users',
      *consumer{id: consumer, accessedKeys},
      *route{id: route, responseKeys}
  `);
  const toolMap = await db.run('?[toolName, handlerName] := *handles_tool{from: tool, to: handler}, *tool{id: tool, name: toolName}, *symbol{id: handler, name: handlerName}');
  const processTrace = await db.run('?[name, step] := *step_in_process{from: sym, to: "process:create_user", step}, *symbol{id: sym, name}');
  const rules = await queryCozoRules(db);
  return {
    context: context.rows.length,
    routeShapeMismatches: routeShapeRows.rows.flatMap((row) => shapeMissing({ 0: row[0], 1: row[1] })),
    toolMap: toolMap.rows.length,
    processTrace: processTrace.rows.length,
    ...rules,
    adapterTemplates: 4,
  };
}

async function runCozoPrimary() {
  const start = performance.now();
  const cozo = await openCozo('hybrid-cozo-primary');
  try {
    await createCozoPrimary(cozo.db);
    await insertCozoPrimary(cozo.db);
    const result = await queryCozoPrimaryViaAdapter(cozo.db);
    return ok('cozo-primary+query-adapter', { elapsed_ms: ms(start) }, result, [
      'Single rule-capable store',
      'Decision queries are natural',
      'Agent ad-hoc graph query requires an adapter/template layer',
    ]);
  } finally {
    await closeCozo(cozo);
  }
}

async function createDuckAnalytics(conn) {
  await conn.run('CREATE TABLE route(id VARCHAR PRIMARY KEY, responseKeys JSON)');
  await conn.run('CREATE TABLE consumer(id VARCHAR PRIMARY KEY, accessedKeys JSON)');
  await conn.run('CREATE TABLE fetches("from" VARCHAR, "to" VARCHAR)');
  for (const item of facts.routes) await conn.run(`INSERT INTO route VALUES ('${quote(item.id)}', '${quote(json(item.responseKeys))}')`);
  for (const item of facts.consumers) await conn.run(`INSERT INTO consumer VALUES ('${quote(item.id)}', '${quote(json(item.accessedKeys))}')`);
  for (const item of facts.fetches) await conn.run(`INSERT INTO fetches VALUES ('${quote(item.from)}', '${quote(item.to)}')`);
}

async function queryDuckAnalytics(conn) {
  const read = async (query) => (await conn.runAndReadAll(query)).getRowObjectsJson();
  const rows = await read("SELECT consumer.accessedKeys, route.responseKeys FROM fetches JOIN consumer ON consumer.id = fetches.from JOIN route ON route.id = fetches.to WHERE route.id = 'route:POST /users'");
  return { routeShapeMismatches: rows.flatMap(shapeMissing), analyticsRows: rows.length };
}

async function runLadybugDuckDB() {
  const start = performance.now();
  const ladybug = await openLadybug('hybrid-ladybug-duckdb');
  const duck = await openDuckDB('hybrid-ladybug-duckdb');
  try {
    await createLadybugCore(ladybug.q);
    await insertLadybugCore(ladybug.q);
    await createDuckAnalytics(duck.conn);
    const graph = await queryLadybugCore(ladybug.q);
    const analytics = await queryDuckAnalytics(duck.conn);
    return ok('ladybug-primary+duckdb-analytics', { elapsed_ms: ms(start) }, { ...graph, ...analytics }, [
      'Cypher graph facts stay primary',
      'SQL sidecar handles tabular analytics and JSON-ish shape checks',
      'Does not help rule/closure reasoning as much as Cozo',
    ]);
  } finally {
    await closeLadybug(ladybug);
    await closeDuckDB(duck);
  }
}

const scenarioMap = {
  'ladybug-cozo': runLadybugCozo,
  'cozo-primary': runCozoPrimary,
  'ladybug-duckdb': runLadybugDuckDB,
};

const scenarioIndex = process.argv.indexOf('--scenario');
if (scenarioIndex !== -1) {
  const scenario = process.argv[scenarioIndex + 1];
  const run = scenarioMap[scenario];
  if (!run) {
    console.log(JSON.stringify(failed(scenario ?? 'unknown', new Error(`Unknown scenario: ${scenario}`)), null, 2));
    process.exit(1);
  }
  try {
    console.log(JSON.stringify(await run(), null, 2));
  } catch (error) {
    console.log(JSON.stringify(failed(scenario, error), null, 2));
    process.exitCode = 1;
  }
  process.exit();
}

const results = [];
for (const scenario of Object.keys(scenarioMap)) {
  const child = spawnSync(process.execPath, [new URL(import.meta.url).pathname, '--scenario', scenario], {
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (child.status === 0 && child.stdout.trim()) {
    try {
      results.push(JSON.parse(child.stdout));
    } catch {
      results.push(failed(scenario, new Error(`Invalid JSON output: ${child.stdout.slice(0, 500)}`)));
    }
  } else {
    results.push({ adapter: scenario, ok: false, exit_status: child.status, signal: child.signal, stdout: child.stdout, stderr: child.stderr });
  }
}

console.log(JSON.stringify({ generated_at: new Date().toISOString(), results }, null, 2));
