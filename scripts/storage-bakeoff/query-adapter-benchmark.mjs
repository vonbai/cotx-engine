import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const facts = {
  symbols: [
    ['sym:api.handleCreateUser', 'handleCreateUser', 'src/api/user.ts'],
    ['sym:svc.validateUser', 'validateUser', 'src/service/user.ts'],
    ['sym:repo.saveUser', 'saveUser', 'src/repo/user.ts'],
    ['sym:api.handleCreateAdmin', 'handleCreateAdmin', 'src/api/admin.ts'],
  ],
  routes: [
    ['route:POST /users', 'POST', '/users', 'src/api/user.ts', '["data","error"]'],
  ],
  consumers: [
    ['consumer:web.createUser', 'createUserForm', 'src/web/user.ts', '["data","missing"]'],
  ],
  tools: [
    ['tool:create_user', 'create_user', 'src/mcp/tools.ts', 'Create a user via the API handler'],
  ],
  processes: [
    ['process:create_user', 'CreateUserFlow', 'cross_module', 3],
  ],
  canonical: [
    ['canonical:create:repository_write', 'create:repository_write', 'api', 0.82],
  ],
  closures: [
    ['closure:createUser', 'unit:api.createUser', 'create:repository_write'],
  ],
  units: [
    ['unit:api.createUser'],
    ['unit:api.createAdmin'],
  ],
  plans: [
    ['plan:canonicalize', 'canonicalize_path', 0.82],
  ],
  reviews: [
    ['review:missingClosure', 'high', 'Patch updates createUser but misses sibling createAdmin closure member'],
  ],
  calls: [
    ['sym:api.handleCreateUser', 'sym:svc.validateUser', 1],
    ['sym:svc.validateUser', 'sym:repo.saveUser', 1],
    ['sym:api.handleCreateAdmin', 'sym:svc.validateUser', 1],
  ],
  fetches: [['consumer:web.createUser', 'route:POST /users']],
  handlesRoute: [['route:POST /users', 'sym:api.handleCreateUser']],
  handlesTool: [['tool:create_user', 'sym:api.handleCreateUser']],
  steps: [
    ['sym:api.handleCreateUser', 'process:create_user', 1],
    ['sym:svc.validateUser', 'process:create_user', 2],
    ['sym:repo.saveUser', 'process:create_user', 3],
  ],
  closureRequires: [
    ['closure:createUser', 'unit:api.createUser', 1, 'target'],
    ['closure:createUser', 'unit:api.createAdmin', 0.92, 'same family sibling'],
  ],
  planCoversClosure: [['plan:canonicalize', 'closure:createUser']],
  reviewFlagsPlan: [['review:missingClosure', 'plan:canonicalize']],
};

const querySpecs = [
  { id: 'context', expected: { rows: 1 } },
  { id: 'downstreamImpact', expected: { rows: 2 } },
  { id: 'upstreamImpact', expected: { rows: 3 } },
  { id: 'routeShape', expected: { mismatches: ['missing'] } },
  { id: 'toolMap', expected: { rows: 1 } },
  { id: 'processTrace', expected: { rows: 3 } },
  { id: 'canonicalForConcern', expected: { rows: 1 } },
  { id: 'closureForUnit', expected: { rows: 2 } },
  { id: 'reviewForPlan', expected: { rows: 1 } },
];

const cypherQueries = {
  context: "MATCH (s:Symbol {id:'sym:api.handleCreateUser'})-[c:Calls]->(t:Symbol) RETURN t.id, c.confidence ORDER BY t.id",
  downstreamImpact: "MATCH p=(s:Symbol {id:'sym:api.handleCreateUser'})-[:Calls*1..2]->(t:Symbol) RETURN DISTINCT t.id ORDER BY t.id",
  upstreamImpact: "MATCH p=(s:Symbol)-[:Calls*1..2]->(t:Symbol {id:'sym:repo.saveUser'}) RETURN DISTINCT s.id ORDER BY s.id",
  routeShape: "MATCH (c:Consumer)-[:Fetches]->(r:Route {id:'route:POST /users'}) RETURN c.accessedKeys, r.responseKeys",
  toolMap: "MATCH (tool:Tool)-[:HandlesTool]->(handler:Symbol) RETURN tool.name, handler.name",
  processTrace: "MATCH (sym:Symbol)-[step:StepInProcess]->(p:Process {id:'process:create_user'}) RETURN sym.name, step.step ORDER BY step.step",
  canonicalForConcern: "MATCH (c:Canonical {targetConcern:'create:repository_write'}) RETURN c.id, c.owningModule, c.confidence",
  closureForUnit: "MATCH (c:ClosureSet {id:'closure:createUser'})-[r:ClosureRequires]->(u:OperationUnit) RETURN u.id, r.confidence ORDER BY u.id",
  reviewForPlan: "MATCH (review:ReviewFinding)-[:ReviewFlagsPlan]->(plan:PlanOption {id:'plan:canonicalize'}) RETURN review.severity, review.finding",
};

const cozoQueries = {
  context: '?[to, confidence] := *calls{from: "sym:api.handleCreateUser", to, confidence}',
  downstreamImpact: `
    rel[from, to] := *calls{from, to}
    reach[from, to] := rel[from, to]
    reach[from, to] := rel[from, mid], rel[mid, to]
    ?[to] := reach["sym:api.handleCreateUser", to]
  `,
  upstreamImpact: `
    rel[from, to] := *calls{from, to}
    reach[from, to] := rel[from, to]
    reach[from, to] := rel[from, mid], rel[mid, to]
    ?[from] := reach[from, "sym:repo.saveUser"]
  `,
  routeShape: `
    ?[accessedKeys, responseKeys] :=
      *fetches{from: consumer, to: route},
      route = 'route:POST /users',
      *consumer{id: consumer, accessedKeys},
      *route{id: route, responseKeys}
  `,
  toolMap: '?[toolName, handlerName] := *handles_tool{from: tool, to: handler}, *tool{id: tool, name: toolName}, *symbol{id: handler, name: handlerName}',
  processTrace: '?[name, step] := *step_in_process{from: sym, to: "process:create_user", step}, *symbol{id: sym, name}',
  canonicalForConcern: '?[id, owningModule, confidence] := *canonical{id, targetConcern: "create:repository_write", owningModule, confidence}',
  closureForUnit: '?[unit, confidence] := *closure_requires{from: "closure:createUser", to: unit, confidence}',
  reviewForPlan: '?[severity, finding] := *review_flags_plan{from: review, to: "plan:canonicalize"}, *review{id: review, severity, finding}',
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

function parseKeys(value) {
  if (typeof value === 'string') return JSON.parse(value);
  if (Array.isArray(value)) return value;
  return [];
}

function routeMismatches(row) {
  const values = Array.isArray(row) ? row : Object.values(row);
  const consumerKeys = parseKeys(values[0]);
  const routeKeys = parseKeys(values[1]);
  return consumerKeys.filter((key) => !routeKeys.includes(key));
}

function summarizeRows(rows, spec) {
  if (spec.id === 'routeShape') return { mismatches: rows.flatMap(routeMismatches) };
  return { rows: rows.length };
}

function equivalent(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

async function runLadybug() {
  const start = performance.now();
  const lbug = await import('@ladybugdb/core');
  const mod = lbug.default ?? lbug;
  const dir = tmpDir('adapter-ladybug');
  const db = new mod.Database(path.join(dir, 'graph.lbug'));
  const conn = new mod.Connection(db);
  const q = async (query) => {
    const result = await conn.query(query);
    return typeof result?.getAll === 'function' ? await result.getAll() : result;
  };
  try {
    await createLadybug(q);
    const results = {};
    for (const spec of querySpecs) {
      results[spec.id] = summarizeRows(await q(cypherQueries[spec.id]), spec);
    }
    return { adapter: 'ladybug-cypher', elapsed_ms: ms(start), results };
  } finally {
    try { await conn.close?.(); } catch {}
    try { await db.close?.(); } catch {}
  }
}

async function createLadybug(q) {
  await q('CREATE NODE TABLE Symbol(id STRING, name STRING, filePath STRING, PRIMARY KEY(id))');
  await q('CREATE NODE TABLE Route(id STRING, method STRING, path STRING, filePath STRING, responseKeys STRING, PRIMARY KEY(id))');
  await q('CREATE NODE TABLE Consumer(id STRING, name STRING, filePath STRING, accessedKeys STRING, PRIMARY KEY(id))');
  await q('CREATE NODE TABLE Tool(id STRING, name STRING, filePath STRING, description STRING, PRIMARY KEY(id))');
  await q('CREATE NODE TABLE Process(id STRING, label STRING, processType STRING, stepCount INT64, PRIMARY KEY(id))');
  await q('CREATE NODE TABLE Canonical(id STRING, targetConcern STRING, owningModule STRING, confidence DOUBLE, PRIMARY KEY(id))');
  await q('CREATE NODE TABLE OperationUnit(id STRING, PRIMARY KEY(id))');
  await q('CREATE NODE TABLE ClosureSet(id STRING, PRIMARY KEY(id))');
  await q('CREATE NODE TABLE PlanOption(id STRING, kind STRING, PRIMARY KEY(id))');
  await q('CREATE NODE TABLE ReviewFinding(id STRING, severity STRING, finding STRING, PRIMARY KEY(id))');
  await q('CREATE REL TABLE Calls(FROM Symbol TO Symbol, confidence DOUBLE)');
  await q('CREATE REL TABLE Fetches(FROM Consumer TO Route)');
  await q('CREATE REL TABLE HandlesRoute(FROM Route TO Symbol)');
  await q('CREATE REL TABLE HandlesTool(FROM Tool TO Symbol)');
  await q('CREATE REL TABLE StepInProcess(FROM Symbol TO Process, step INT64)');
  await q('CREATE REL TABLE ClosureRequires(FROM ClosureSet TO OperationUnit, confidence DOUBLE)');
  await q('CREATE REL TABLE ReviewFlagsPlan(FROM ReviewFinding TO PlanOption)');

  for (const [id, name, filePath] of facts.symbols) await q(`CREATE (:Symbol {id:'${quote(id)}', name:'${quote(name)}', filePath:'${quote(filePath)}'})`);
  for (const [id, method, routePath, filePath, responseKeys] of facts.routes) await q(`CREATE (:Route {id:'${quote(id)}', method:'${method}', path:'${quote(routePath)}', filePath:'${quote(filePath)}', responseKeys:'${quote(responseKeys)}'})`);
  for (const [id, name, filePath, accessedKeys] of facts.consumers) await q(`CREATE (:Consumer {id:'${quote(id)}', name:'${quote(name)}', filePath:'${quote(filePath)}', accessedKeys:'${quote(accessedKeys)}'})`);
  for (const [id, name, filePath, description] of facts.tools) await q(`CREATE (:Tool {id:'${quote(id)}', name:'${quote(name)}', filePath:'${quote(filePath)}', description:'${quote(description)}'})`);
  for (const [id, label, processType, stepCount] of facts.processes) await q(`CREATE (:Process {id:'${quote(id)}', label:'${quote(label)}', processType:'${quote(processType)}', stepCount:${stepCount}})`);
  for (const [id, targetConcern, owningModule, confidence] of facts.canonical) await q(`CREATE (:Canonical {id:'${quote(id)}', targetConcern:'${quote(targetConcern)}', owningModule:'${quote(owningModule)}', confidence:${confidence}})`);
  for (const [id] of facts.closures) await q(`CREATE (:ClosureSet {id:'${quote(id)}'})`);
  for (const [id] of facts.units) await q(`CREATE (:OperationUnit {id:'${quote(id)}'})`);
  for (const [id, kind] of facts.plans) await q(`CREATE (:PlanOption {id:'${quote(id)}', kind:'${quote(kind)}'})`);
  for (const [id, severity, finding] of facts.reviews) await q(`CREATE (:ReviewFinding {id:'${quote(id)}', severity:'${quote(severity)}', finding:'${quote(finding)}'})`);
  for (const [from, to, confidence] of facts.calls) await q(`MATCH (a:Symbol {id:'${quote(from)}'}), (b:Symbol {id:'${quote(to)}'}) CREATE (a)-[:Calls {confidence:${confidence}}]->(b)`);
  for (const [from, to] of facts.fetches) await q(`MATCH (a:Consumer {id:'${quote(from)}'}), (b:Route {id:'${quote(to)}'}) CREATE (a)-[:Fetches]->(b)`);
  for (const [from, to] of facts.handlesRoute) await q(`MATCH (a:Route {id:'${quote(from)}'}), (b:Symbol {id:'${quote(to)}'}) CREATE (a)-[:HandlesRoute]->(b)`);
  for (const [from, to] of facts.handlesTool) await q(`MATCH (a:Tool {id:'${quote(from)}'}), (b:Symbol {id:'${quote(to)}'}) CREATE (a)-[:HandlesTool]->(b)`);
  for (const [from, to, step] of facts.steps) await q(`MATCH (a:Symbol {id:'${quote(from)}'}), (b:Process {id:'${quote(to)}'}) CREATE (a)-[:StepInProcess {step:${step}}]->(b)`);
  for (const [from, to, confidence] of facts.closureRequires) await q(`MATCH (a:ClosureSet {id:'${quote(from)}'}), (b:OperationUnit {id:'${quote(to)}'}) CREATE (a)-[:ClosureRequires {confidence:${confidence}}]->(b)`);
  for (const [from, to] of facts.reviewFlagsPlan) await q(`MATCH (a:ReviewFinding {id:'${quote(from)}'}), (b:PlanOption {id:'${quote(to)}'}) CREATE (a)-[:ReviewFlagsPlan]->(b)`);
}

async function runCozo() {
  const start = performance.now();
  const { CozoDb } = await import('cozo-node');
  const dir = tmpDir('adapter-cozo');
  const db = new CozoDb('sqlite', path.join(dir, 'graph.db'), {});
  try {
    await createCozo(db);
    const results = {};
    for (const spec of querySpecs) {
      const output = await db.run(cozoQueries[spec.id]);
      results[spec.id] = summarizeRows(output.rows, spec);
    }
    return { adapter: 'cozo-query-adapter', elapsed_ms: ms(start), results };
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function createCozo(db) {
  await db.run(':create symbol {id: String => name: String, filePath: String}');
  await db.run(':create route {id: String => method: String, path: String, filePath: String, responseKeys: String}');
  await db.run(':create consumer {id: String => name: String, filePath: String, accessedKeys: String}');
  await db.run(':create tool {id: String => name: String, filePath: String, description: String}');
  await db.run(':create process {id: String => label: String, processType: String, stepCount: Int}');
  await db.run(':create canonical {id: String => targetConcern: String, owningModule: String, confidence: Float}');
  await db.run(':create calls {from: String, to: String => confidence: Float}');
  await db.run(':create fetches {from: String, to: String}');
  await db.run(':create handles_tool {from: String, to: String}');
  await db.run(':create step_in_process {from: String, to: String => step: Int}');
  await db.run(':create closure_requires {from: String, to: String => confidence: Float}');
  await db.run(':create review {id: String => severity: String, finding: String}');
  await db.run(':create review_flags_plan {from: String, to: String}');
  await db.run('?[id, name, filePath] <- $rows :put symbol {id => name, filePath}', { rows: facts.symbols });
  await db.run('?[id, method, path, filePath, responseKeys] <- $rows :put route {id => method, path, filePath, responseKeys}', { rows: facts.routes.map(([id, method, routePath, filePath, responseKeys]) => [id, method, routePath, filePath, responseKeys]) });
  await db.run('?[id, name, filePath, accessedKeys] <- $rows :put consumer {id => name, filePath, accessedKeys}', { rows: facts.consumers });
  await db.run('?[id, name, filePath, description] <- $rows :put tool {id => name, filePath, description}', { rows: facts.tools });
  await db.run('?[id, label, processType, stepCount] <- $rows :put process {id => label, processType, stepCount}', { rows: facts.processes });
  await db.run('?[id, targetConcern, owningModule, confidence] <- $rows :put canonical {id => targetConcern, owningModule, confidence}', { rows: facts.canonical });
  await db.run('?[from, to, confidence] <- $rows :put calls {from, to => confidence}', { rows: facts.calls });
  await db.run('?[from, to] <- $rows :put fetches {from, to}', { rows: facts.fetches });
  await db.run('?[from, to] <- $rows :put handles_tool {from, to}', { rows: facts.handlesTool });
  await db.run('?[from, to, step] <- $rows :put step_in_process {from, to => step}', { rows: facts.steps });
  await db.run('?[from, to, confidence] <- $rows :put closure_requires {from, to => confidence}', { rows: facts.closureRequires.map(([from, to, confidence]) => [from, to, confidence]) });
  await db.run('?[id, severity, finding] <- $rows :put review {id => severity, finding}', { rows: facts.reviews });
  await db.run('?[from, to] <- $rows :put review_flags_plan {from, to}', { rows: facts.reviewFlagsPlan });
}

function templateStats(queries) {
  const values = Object.values(queries);
  return {
    templates: values.length,
    total_chars: values.reduce((sum, value) => sum + value.length, 0),
    avg_chars: Math.round(values.reduce((sum, value) => sum + value.length, 0) / values.length),
  };
}

function readAdapterArg() {
  const index = process.argv.indexOf('--adapter');
  return index === -1 ? null : process.argv[index + 1];
}

const adapterArg = readAdapterArg();
if (adapterArg) {
  if (adapterArg === 'ladybug') {
    console.log(JSON.stringify(await runLadybug(), null, 2));
    process.exit();
  }
  if (adapterArg === 'cozo') {
    console.log(JSON.stringify(await runCozo(), null, 2));
    process.exit();
  }
  console.log(JSON.stringify({ adapter: adapterArg, ok: false, error: `Unknown adapter: ${adapterArg}` }, null, 2));
  process.exit(1);
}

function runAdapter(adapter) {
  const child = spawnSync(process.execPath, [new URL(import.meta.url).pathname, '--adapter', adapter], {
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (child.status === 0 && child.stdout.trim()) return JSON.parse(child.stdout);
  return {
    adapter,
    failed: true,
    exit_status: child.status,
    signal: child.signal,
    stdout: child.stdout,
    stderr: child.stderr,
  };
}

const ladybug = runAdapter('ladybug');
const cozo = runAdapter('cozo');
if (ladybug.failed || cozo.failed) {
  console.log(JSON.stringify({ generated_at: new Date().toISOString(), ladybug, cozo }, null, 2));
  process.exitCode = 1;
  process.exit();
}
const comparisons = Object.fromEntries(querySpecs.map((spec) => [
  spec.id,
  {
    expected: spec.expected,
    ladybug: ladybug.results[spec.id],
    cozo: cozo.results[spec.id],
    ladybug_ok: equivalent(ladybug.results[spec.id], spec.expected),
    cozo_ok: equivalent(cozo.results[spec.id], spec.expected),
    parity: equivalent(ladybug.results[spec.id], cozo.results[spec.id]),
  },
]));

console.log(JSON.stringify({
  generated_at: new Date().toISOString(),
  query_count: querySpecs.length,
  adapters: {
    ladybug: { elapsed_ms: ladybug.elapsed_ms, templateStats: templateStats(cypherQueries) },
    cozo: { elapsed_ms: cozo.elapsed_ms, templateStats: templateStats(cozoQueries) },
  },
  comparisons,
  conclusion_signal: {
    cozo_requires_adapter_templates: Object.keys(cozoQueries).length,
    cypher_supports_agent_ad_hoc_queries_directly: true,
    cozo_supports_agent_ad_hoc_queries_directly: false,
  },
}, null, 2));
