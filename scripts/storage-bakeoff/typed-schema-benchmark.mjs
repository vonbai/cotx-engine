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
  closures: [
    { id: 'closure:createUser', targetUnit: 'unit:api.createUser', familyId: 'create:repository_write' },
  ],
  plans: [
    { id: 'plan:canonicalize', kind: 'canonicalize_path', totalScore: 0.82 },
  ],
  reviews: [
    { id: 'review:missingClosure', severity: 'high', finding: 'Patch updates createUser but misses sibling createAdmin closure member' },
  ],
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

async function runLadybug() {
  const start = performance.now();
  const lbug = await import('@ladybugdb/core');
  const mod = lbug.default ?? lbug;
  const dir = tmpDir('ladybug-typed');
  const db = new mod.Database(path.join(dir, 'graph.lbug'));
  const conn = new mod.Connection(db);
  const q = async (query) => {
    const result = await conn.query(query);
    return typeof result?.getAll === 'function' ? await result.getAll() : result;
  };
  try {
    await createCypherSchema(q);
    await insertCypherFacts(q);
    const result = await runCypherQueries(q);
    return ok('ladybug', { elapsed_ms: ms(start) }, result, ['typed node tables', 'typed relation tables', 'cypher']);
  } finally {
    try { await conn.close?.(); } catch {}
    try { await db.close?.(); } catch {}
  }
}

async function runKuzu() {
  const start = performance.now();
  const kuzu = await import('kuzu');
  const dir = tmpDir('kuzu-typed');
  const db = new kuzu.Database(path.join(dir, 'graph.kuzu'));
  const conn = new kuzu.Connection(db);
  const q = async (query) => {
    const result = await conn.query(query);
    return typeof result?.getAll === 'function' ? await result.getAll() : result;
  };
  try {
    await createCypherSchema(q);
    await insertCypherFacts(q);
    const result = await runCypherQueries(q);
    return ok('kuzu', { elapsed_ms: ms(start) }, result, ['typed node tables', 'typed relation tables', 'cypher']);
  } finally {
    try { await conn.close?.(); } catch {}
    try { await db.close?.(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function createCypherSchema(q) {
  await q('CREATE NODE TABLE Symbol(id STRING, name STRING, filePath STRING, PRIMARY KEY(id))');
  await q('CREATE NODE TABLE Route(id STRING, method STRING, path STRING, filePath STRING, responseKeys STRING, middleware STRING, PRIMARY KEY(id))');
  await q('CREATE NODE TABLE Consumer(id STRING, name STRING, filePath STRING, accessedKeys STRING, PRIMARY KEY(id))');
  await q('CREATE NODE TABLE Tool(id STRING, name STRING, filePath STRING, description STRING, PRIMARY KEY(id))');
  await q('CREATE NODE TABLE Process(id STRING, label STRING, processType STRING, stepCount INT64, PRIMARY KEY(id))');
  await q('CREATE NODE TABLE OperationUnit(id STRING, familyId STRING, module STRING, symbol STRING, PRIMARY KEY(id))');
  await q('CREATE NODE TABLE ClosureSet(id STRING, targetUnit STRING, familyId STRING, PRIMARY KEY(id))');
  await q('CREATE NODE TABLE PlanOption(id STRING, kind STRING, totalScore DOUBLE, PRIMARY KEY(id))');
  await q('CREATE NODE TABLE ReviewFinding(id STRING, severity STRING, finding STRING, PRIMARY KEY(id))');
  await q('CREATE REL TABLE Calls(FROM Symbol TO Symbol, confidence DOUBLE)');
  await q('CREATE REL TABLE HandlesRoute(FROM Route TO Symbol)');
  await q('CREATE REL TABLE Fetches(FROM Consumer TO Route)');
  await q('CREATE REL TABLE HandlesTool(FROM Tool TO Symbol)');
  await q('CREATE REL TABLE StepInProcess(FROM Symbol TO Process, step INT64)');
  await q('CREATE REL TABLE ClosureRequires(FROM ClosureSet TO OperationUnit, confidence DOUBLE, reason STRING)');
  await q('CREATE REL TABLE PlanCoversClosure(FROM PlanOption TO ClosureSet)');
  await q('CREATE REL TABLE ReviewFlagsPlan(FROM ReviewFinding TO PlanOption)');
}

async function insertCypherFacts(q) {
  for (const item of facts.symbols) await q(`CREATE (:Symbol {id:'${quote(item.id)}', name:'${quote(item.name)}', filePath:'${quote(item.filePath)}'})`);
  for (const item of facts.routes) await q(`CREATE (:Route {id:'${quote(item.id)}', method:'${quote(item.method)}', path:'${quote(item.path)}', filePath:'${quote(item.filePath)}', responseKeys:'${quote(json(item.responseKeys))}', middleware:'${quote(json(item.middleware))}'})`);
  for (const item of facts.consumers) await q(`CREATE (:Consumer {id:'${quote(item.id)}', name:'${quote(item.name)}', filePath:'${quote(item.filePath)}', accessedKeys:'${quote(json(item.accessedKeys))}'})`);
  for (const item of facts.tools) await q(`CREATE (:Tool {id:'${quote(item.id)}', name:'${quote(item.name)}', filePath:'${quote(item.filePath)}', description:'${quote(item.description)}'})`);
  for (const item of facts.processes) await q(`CREATE (:Process {id:'${quote(item.id)}', label:'${quote(item.label)}', processType:'${quote(item.processType)}', stepCount:${item.stepCount}})`);
  for (const item of facts.units) await q(`CREATE (:OperationUnit {id:'${quote(item.id)}', familyId:'${quote(item.familyId)}', module:'${quote(item.module)}', symbol:'${quote(item.symbol)}'})`);
  for (const item of facts.closures) await q(`CREATE (:ClosureSet {id:'${quote(item.id)}', targetUnit:'${quote(item.targetUnit)}', familyId:'${quote(item.familyId)}'})`);
  for (const item of facts.plans) await q(`CREATE (:PlanOption {id:'${quote(item.id)}', kind:'${quote(item.kind)}', totalScore:${item.totalScore}})`);
  for (const item of facts.reviews) await q(`CREATE (:ReviewFinding {id:'${quote(item.id)}', severity:'${quote(item.severity)}', finding:'${quote(item.finding)}'})`);
  for (const item of facts.calls) await q(`MATCH (a:Symbol {id:'${quote(item.from)}'}), (b:Symbol {id:'${quote(item.to)}'}) CREATE (a)-[:Calls {confidence:${item.confidence}}]->(b)`);
  for (const item of facts.handlesRoute) await q(`MATCH (a:Route {id:'${quote(item.from)}'}), (b:Symbol {id:'${quote(item.to)}'}) CREATE (a)-[:HandlesRoute]->(b)`);
  for (const item of facts.fetches) await q(`MATCH (a:Consumer {id:'${quote(item.from)}'}), (b:Route {id:'${quote(item.to)}'}) CREATE (a)-[:Fetches]->(b)`);
  for (const item of facts.handlesTool) await q(`MATCH (a:Tool {id:'${quote(item.from)}'}), (b:Symbol {id:'${quote(item.to)}'}) CREATE (a)-[:HandlesTool]->(b)`);
  for (const item of facts.steps) await q(`MATCH (a:Symbol {id:'${quote(item.from)}'}), (b:Process {id:'${quote(item.to)}'}) CREATE (a)-[:StepInProcess {step:${item.step}}]->(b)`);
  for (const item of facts.closureRequires) await q(`MATCH (a:ClosureSet {id:'${quote(item.from)}'}), (b:OperationUnit {id:'${quote(item.to)}'}) CREATE (a)-[:ClosureRequires {confidence:${item.confidence}, reason:'${quote(item.reason)}'}]->(b)`);
  for (const item of facts.planCoversClosure) await q(`MATCH (a:PlanOption {id:'${quote(item.from)}'}), (b:ClosureSet {id:'${quote(item.to)}'}) CREATE (a)-[:PlanCoversClosure]->(b)`);
  for (const item of facts.reviewFlagsPlan) await q(`MATCH (a:ReviewFinding {id:'${quote(item.from)}'}), (b:PlanOption {id:'${quote(item.to)}'}) CREATE (a)-[:ReviewFlagsPlan]->(b)`);
}

async function runCypherQueries(q) {
  const context = await q("MATCH (s:Symbol {id:'sym:api.handleCreateUser'})-[c:Calls]->(t:Symbol) RETURN t.id, c.confidence ORDER BY t.id");
  const routeShapeRows = await q("MATCH (c:Consumer)-[:Fetches]->(r:Route {id:'route:POST /users'}) RETURN c.accessedKeys, r.responseKeys");
  const toolMap = await q("MATCH (tool:Tool)-[:HandlesTool]->(handler:Symbol) RETURN tool.name, handler.name");
  const processTrace = await q("MATCH (sym:Symbol)-[step:StepInProcess]->(p:Process {id:'process:create_user'}) RETURN sym.name, step.step ORDER BY step.step");
  const closure = await q("MATCH (c:ClosureSet {id:'closure:createUser'})-[r:ClosureRequires]->(u:OperationUnit) RETURN u.id, r.confidence, r.reason ORDER BY u.id");
  const review = await q("MATCH (review:ReviewFinding)-[:ReviewFlagsPlan]->(plan:PlanOption)-[:PlanCoversClosure]->(closure:ClosureSet) RETURN review.severity, plan.kind, closure.id");
  return {
    context: context.length,
    routeShapeMismatches: routeShapeRows.flatMap(shapeMissing),
    toolMap: toolMap.length,
    processTrace: processTrace.length,
    closure: closure.length,
    review: review.length,
  };
}

async function runCozo() {
  const start = performance.now();
  const { CozoDb } = await import('cozo-node');
  const dir = tmpDir('cozo-typed');
  const db = new CozoDb('sqlite', path.join(dir, 'graph.db'), {});
  try {
    await createCozoSchema(db);
    await insertCozoFacts(db);
    const result = await runCozoQueries(db);
    return ok('cozo', { elapsed_ms: ms(start) }, result, ['typed relations', 'datalog']);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function createCozoSchema(db) {
  await db.run(':create symbol {id: String => name: String, filePath: String}');
  await db.run(':create route {id: String => method: String, path: String, filePath: String, responseKeys: String, middleware: String}');
  await db.run(':create consumer {id: String => name: String, filePath: String, accessedKeys: String}');
  await db.run(':create tool {id: String => name: String, filePath: String, description: String}');
  await db.run(':create process {id: String => label: String, processType: String, stepCount: Int}');
  await db.run(':create op_unit {id: String => familyId: String, module: String, symbol: String}');
  await db.run(':create closure {id: String => targetUnit: String, familyId: String}');
  await db.run(':create plan {id: String => kind: String, totalScore: Float}');
  await db.run(':create review {id: String => severity: String, finding: String}');
  await db.run(':create calls {from: String, to: String => confidence: Float}');
  await db.run(':create handles_route {from: String, to: String}');
  await db.run(':create fetches {from: String, to: String}');
  await db.run(':create handles_tool {from: String, to: String}');
  await db.run(':create step_in_process {from: String, to: String => step: Int}');
  await db.run(':create closure_requires {from: String, to: String => confidence: Float, reason: String}');
  await db.run(':create plan_covers_closure {from: String, to: String}');
  await db.run(':create review_flags_plan {from: String, to: String}');
}

async function insertCozoFacts(db) {
  await db.run('?[id, name, filePath] <- $rows :put symbol {id => name, filePath}', { rows: facts.symbols.map((item) => [item.id, item.name, item.filePath]) });
  await db.run('?[id, method, path, filePath, responseKeys, middleware] <- $rows :put route {id => method, path, filePath, responseKeys, middleware}', { rows: facts.routes.map((item) => [item.id, item.method, item.path, item.filePath, json(item.responseKeys), json(item.middleware)]) });
  await db.run('?[id, name, filePath, accessedKeys] <- $rows :put consumer {id => name, filePath, accessedKeys}', { rows: facts.consumers.map((item) => [item.id, item.name, item.filePath, json(item.accessedKeys)]) });
  await db.run('?[id, name, filePath, description] <- $rows :put tool {id => name, filePath, description}', { rows: facts.tools.map((item) => [item.id, item.name, item.filePath, item.description]) });
  await db.run('?[id, label, processType, stepCount] <- $rows :put process {id => label, processType, stepCount}', { rows: facts.processes.map((item) => [item.id, item.label, item.processType, item.stepCount]) });
  await db.run('?[id, familyId, module, symbol] <- $rows :put op_unit {id => familyId, module, symbol}', { rows: facts.units.map((item) => [item.id, item.familyId, item.module, item.symbol]) });
  await db.run('?[id, targetUnit, familyId] <- $rows :put closure {id => targetUnit, familyId}', { rows: facts.closures.map((item) => [item.id, item.targetUnit, item.familyId]) });
  await db.run('?[id, kind, totalScore] <- $rows :put plan {id => kind, totalScore}', { rows: facts.plans.map((item) => [item.id, item.kind, item.totalScore]) });
  await db.run('?[id, severity, finding] <- $rows :put review {id => severity, finding}', { rows: facts.reviews.map((item) => [item.id, item.severity, item.finding]) });
  await db.run('?[from, to, confidence] <- $rows :put calls {from, to => confidence}', { rows: facts.calls.map((item) => [item.from, item.to, item.confidence]) });
  await db.run('?[from, to] <- $rows :put handles_route {from, to}', { rows: facts.handlesRoute.map((item) => [item.from, item.to]) });
  await db.run('?[from, to] <- $rows :put fetches {from, to}', { rows: facts.fetches.map((item) => [item.from, item.to]) });
  await db.run('?[from, to] <- $rows :put handles_tool {from, to}', { rows: facts.handlesTool.map((item) => [item.from, item.to]) });
  await db.run('?[from, to, step] <- $rows :put step_in_process {from, to => step}', { rows: facts.steps.map((item) => [item.from, item.to, item.step]) });
  await db.run('?[from, to, confidence, reason] <- $rows :put closure_requires {from, to => confidence, reason}', { rows: facts.closureRequires.map((item) => [item.from, item.to, item.confidence, item.reason]) });
  await db.run('?[from, to] <- $rows :put plan_covers_closure {from, to}', { rows: facts.planCoversClosure.map((item) => [item.from, item.to]) });
  await db.run('?[from, to] <- $rows :put review_flags_plan {from, to}', { rows: facts.reviewFlagsPlan.map((item) => [item.from, item.to]) });
}

async function runCozoQueries(db) {
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
  const closure = await db.run('?[unit, confidence, reason] := *closure_requires{from: "closure:createUser", to: unit, confidence, reason}');
  const review = await db.run('?[severity, kind, closure] := *review_flags_plan{from: review, to: plan}, *plan_covers_closure{from: plan, to: closure}, *review{id: review, severity}, *plan{id: plan, kind}');
  return {
    context: context.rows.length,
    routeShapeMismatches: routeShapeRows.rows.flatMap((row) => shapeMissing({ 0: row[0], 1: row[1] })),
    toolMap: toolMap.rows.length,
    processTrace: processTrace.rows.length,
    closure: closure.rows.length,
    review: review.rows.length,
  };
}

async function runDuckDB() {
  const start = performance.now();
  const { DuckDBInstance } = await import('@duckdb/node-api');
  const dir = tmpDir('duckdb-typed');
  const instance = await DuckDBInstance.create(path.join(dir, 'graph.duckdb'));
  const conn = await instance.connect();
  const q = (query) => conn.run(query);
  const read = async (query) => (await conn.runAndReadAll(query)).getRowObjectsJson();
  try {
    await createDuckDBSchema(q);
    await insertDuckDBFacts(q);
    const context = await read("SELECT calls.to, calls.confidence FROM calls WHERE calls.from = 'sym:api.handleCreateUser'");
    const routeShapeRows = await read("SELECT consumer.accessedKeys, route.responseKeys FROM fetches JOIN consumer ON consumer.id = fetches.from JOIN route ON route.id = fetches.to WHERE route.id = 'route:POST /users'");
    const toolMap = await read("SELECT tool.name AS toolName, symbol.name AS handlerName FROM handles_tool JOIN tool ON tool.id = handles_tool.from JOIN symbol ON symbol.id = handles_tool.to");
    const processTrace = await read("SELECT symbol.name, step_in_process.step FROM step_in_process JOIN symbol ON symbol.id = step_in_process.from WHERE step_in_process.to = 'process:create_user' ORDER BY step_in_process.step");
    const closure = await read("SELECT * FROM closure_requires WHERE closure_requires.from = 'closure:createUser' ORDER BY closure_requires.to");
    const review = await read("SELECT review.severity, plan.kind, plan_covers_closure.to AS closure FROM review_flags_plan JOIN review ON review.id = review_flags_plan.from JOIN plan ON plan.id = review_flags_plan.to JOIN plan_covers_closure ON plan_covers_closure.from = plan.id");
    return ok('duckdb', { elapsed_ms: ms(start) }, {
      context: context.length,
      routeShapeMismatches: routeShapeRows.flatMap(shapeMissing),
      toolMap: toolMap.length,
      processTrace: processTrace.length,
      closure: closure.length,
      review: review.length,
    }, ['typed SQL tables', 'recursive graph queries require SQL patterns']);
  } finally {
    conn.closeSync?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function createDuckDBSchema(q) {
  await q('CREATE TABLE symbol(id VARCHAR PRIMARY KEY, name VARCHAR, filePath VARCHAR)');
  await q('CREATE TABLE route(id VARCHAR PRIMARY KEY, method VARCHAR, path VARCHAR, filePath VARCHAR, responseKeys JSON, middleware JSON)');
  await q('CREATE TABLE consumer(id VARCHAR PRIMARY KEY, name VARCHAR, filePath VARCHAR, accessedKeys JSON)');
  await q('CREATE TABLE tool(id VARCHAR PRIMARY KEY, name VARCHAR, filePath VARCHAR, description VARCHAR)');
  await q('CREATE TABLE process(id VARCHAR PRIMARY KEY, label VARCHAR, processType VARCHAR, stepCount INTEGER)');
  await q('CREATE TABLE op_unit(id VARCHAR PRIMARY KEY, familyId VARCHAR, module VARCHAR, symbol VARCHAR)');
  await q('CREATE TABLE closure(id VARCHAR PRIMARY KEY, targetUnit VARCHAR, familyId VARCHAR)');
  await q('CREATE TABLE plan(id VARCHAR PRIMARY KEY, kind VARCHAR, totalScore DOUBLE)');
  await q('CREATE TABLE review(id VARCHAR PRIMARY KEY, severity VARCHAR, finding VARCHAR)');
  await q('CREATE TABLE calls("from" VARCHAR, "to" VARCHAR, confidence DOUBLE)');
  await q('CREATE TABLE handles_route("from" VARCHAR, "to" VARCHAR)');
  await q('CREATE TABLE fetches("from" VARCHAR, "to" VARCHAR)');
  await q('CREATE TABLE handles_tool("from" VARCHAR, "to" VARCHAR)');
  await q('CREATE TABLE step_in_process("from" VARCHAR, "to" VARCHAR, step INTEGER)');
  await q('CREATE TABLE closure_requires("from" VARCHAR, "to" VARCHAR, confidence DOUBLE, reason VARCHAR)');
  await q('CREATE TABLE plan_covers_closure("from" VARCHAR, "to" VARCHAR)');
  await q('CREATE TABLE review_flags_plan("from" VARCHAR, "to" VARCHAR)');
}

async function insertDuckDBFacts(q) {
  for (const item of facts.symbols) await q(`INSERT INTO symbol VALUES ('${quote(item.id)}', '${quote(item.name)}', '${quote(item.filePath)}')`);
  for (const item of facts.routes) await q(`INSERT INTO route VALUES ('${quote(item.id)}', '${quote(item.method)}', '${quote(item.path)}', '${quote(item.filePath)}', '${quote(json(item.responseKeys))}', '${quote(json(item.middleware))}')`);
  for (const item of facts.consumers) await q(`INSERT INTO consumer VALUES ('${quote(item.id)}', '${quote(item.name)}', '${quote(item.filePath)}', '${quote(json(item.accessedKeys))}')`);
  for (const item of facts.tools) await q(`INSERT INTO tool VALUES ('${quote(item.id)}', '${quote(item.name)}', '${quote(item.filePath)}', '${quote(item.description)}')`);
  for (const item of facts.processes) await q(`INSERT INTO process VALUES ('${quote(item.id)}', '${quote(item.label)}', '${quote(item.processType)}', ${item.stepCount})`);
  for (const item of facts.units) await q(`INSERT INTO op_unit VALUES ('${quote(item.id)}', '${quote(item.familyId)}', '${quote(item.module)}', '${quote(item.symbol)}')`);
  for (const item of facts.closures) await q(`INSERT INTO closure VALUES ('${quote(item.id)}', '${quote(item.targetUnit)}', '${quote(item.familyId)}')`);
  for (const item of facts.plans) await q(`INSERT INTO plan VALUES ('${quote(item.id)}', '${quote(item.kind)}', ${item.totalScore})`);
  for (const item of facts.reviews) await q(`INSERT INTO review VALUES ('${quote(item.id)}', '${quote(item.severity)}', '${quote(item.finding)}')`);
  for (const item of facts.calls) await q(`INSERT INTO calls VALUES ('${quote(item.from)}', '${quote(item.to)}', ${item.confidence})`);
  for (const item of facts.handlesRoute) await q(`INSERT INTO handles_route VALUES ('${quote(item.from)}', '${quote(item.to)}')`);
  for (const item of facts.fetches) await q(`INSERT INTO fetches VALUES ('${quote(item.from)}', '${quote(item.to)}')`);
  for (const item of facts.handlesTool) await q(`INSERT INTO handles_tool VALUES ('${quote(item.from)}', '${quote(item.to)}')`);
  for (const item of facts.steps) await q(`INSERT INTO step_in_process VALUES ('${quote(item.from)}', '${quote(item.to)}', ${item.step})`);
  for (const item of facts.closureRequires) await q(`INSERT INTO closure_requires VALUES ('${quote(item.from)}', '${quote(item.to)}', ${item.confidence}, '${quote(item.reason)}')`);
  for (const item of facts.planCoversClosure) await q(`INSERT INTO plan_covers_closure VALUES ('${quote(item.from)}', '${quote(item.to)}')`);
  for (const item of facts.reviewFlagsPlan) await q(`INSERT INTO review_flags_plan VALUES ('${quote(item.from)}', '${quote(item.to)}')`);
}

const candidateMap = {
  ladybug: runLadybug,
  kuzu: runKuzu,
  cozo: runCozo,
  duckdb: runDuckDB,
};

const adapterIndex = process.argv.indexOf('--adapter');
if (adapterIndex !== -1) {
  const adapter = process.argv[adapterIndex + 1];
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
for (const candidate of Object.keys(candidateMap)) {
  const child = spawnSync(process.execPath, [new URL(import.meta.url).pathname, '--adapter', candidate], {
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (child.status === 0 && child.stdout.trim()) {
    try {
      results.push(JSON.parse(child.stdout));
    } catch {
      results.push(failed(candidate, new Error(`Invalid JSON output: ${child.stdout.slice(0, 500)}`)));
    }
  } else {
    results.push({ adapter: candidate, ok: false, exit_status: child.status, signal: child.signal, stdout: child.stdout, stderr: child.stderr });
  }
}

console.log(JSON.stringify({ generated_at: new Date().toISOString(), results }, null, 2));
