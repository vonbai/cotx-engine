import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function readJsonLines(file) {
  return fs.readFileSync(file, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function quote(value) {
  return String(value ?? '').replaceAll('\\', '\\\\').replaceAll("'", "\\'");
}

function csvValue(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

function writeCsv(filePath, header, rows) {
  fs.writeFileSync(
    filePath,
    `${header.join(',')}\n${rows.map((row) => row.map(csvValue).join(',')).join('\n')}\n`,
    'utf-8',
  );
}

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cotx-${name}-`));
}

function ms(start) {
  return Number((performance.now() - start).toFixed(2));
}

function loadDataset(repoPath, maxNodes, maxEdges) {
  const graphDir = path.join(repoPath, '.cotx', 'graph');
  const rawNodes = readJsonLines(path.join(graphDir, 'nodes.json'));
  const rawEdges = readJsonLines(path.join(graphDir, 'edges.json'));
  const rawNodeById = new Map(rawNodes.map((node) => [node.id, node]));
  const filePathFor = (id) => rawNodeById.get(id)?.properties?.filePath ?? '';
  const isTestishPath = (filePath) => {
    const normalized = `/${String(filePath).toLowerCase().replace(/^\/+|\/+$/g, '')}/`;
    return ['/test/', '/tests/', '/testing/', '/integration-tests/', '/example/', '/examples/', '/fixtures/', '/mocks/', '/scripts/', '/script/', '/benchmark/', '/benchmarks/', '/docs/', '/doc/']
      .some((segment) => normalized.includes(segment));
  };
  const isCodeNode = (id) => {
    const label = rawNodeById.get(id)?.label;
    return label === 'Function' || label === 'Method' || label === 'Class' || label === 'Interface';
  };
  const isProductionCodeEdge = (edge) =>
    isCodeNode(edge.sourceId) &&
    isCodeNode(edge.targetId) &&
    !isTestishPath(filePathFor(edge.sourceId)) &&
    !isTestishPath(filePathFor(edge.targetId));
  const prioritizedEdges = [
    ...rawEdges.filter((edge) => edge.type === 'CALLS' && isProductionCodeEdge(edge)),
    ...rawEdges.filter((edge) => edge.type !== 'CALLS' && isProductionCodeEdge(edge)),
    ...rawEdges.filter((edge) => edge.type === 'CALLS' && isCodeNode(edge.sourceId) && isCodeNode(edge.targetId)),
    ...rawEdges.filter((edge) => edge.type !== 'CALLS' && isCodeNode(edge.sourceId) && isCodeNode(edge.targetId)),
    ...rawEdges,
  ];
  const selectedEdgesRaw = [];
  const selectedNodeIds = new Set();
  for (const edge of prioritizedEdges) {
    if (selectedEdgesRaw.length >= maxEdges) break;
    const newNodeCount = (selectedNodeIds.has(edge.sourceId) ? 0 : 1) + (selectedNodeIds.has(edge.targetId) ? 0 : 1);
    if (selectedNodeIds.size + newNodeCount > maxNodes) continue;
    selectedNodeIds.add(edge.sourceId);
    selectedNodeIds.add(edge.targetId);
    selectedEdgesRaw.push(edge);
  }
  for (const node of rawNodes) {
    if (selectedNodeIds.size >= maxNodes) break;
    selectedNodeIds.add(node.id);
  }
  const selectedNodes = [...selectedNodeIds].map((id) => rawNodeById.get(id)).filter(Boolean).map((node) => ({
    id: node.id,
    kind: node.label ?? 'CodeElement',
    name: node.properties?.name ?? node.id,
    filePath: node.properties?.filePath ?? '',
    payload: {
      isExported: node.properties?.isExported ?? false,
      startLine: node.properties?.startLine ?? null,
      endLine: node.properties?.endLine ?? null,
    },
  }));
  const nodeIds = new Set(selectedNodes.map((node) => node.id));
  const selectedEdges = selectedEdgesRaw
    .filter((edge) => nodeIds.has(edge.sourceId) && nodeIds.has(edge.targetId))
    .map((edge, index) => ({
      id: `edge:${index}`,
      from: edge.sourceId,
      to: edge.targetId,
      type: edge.type ?? 'RELATED',
      confidence: edge.confidence ?? 1,
      detail: edge.reason ?? '',
    }));
  const startNode = selectedEdges.find((edge) => edge.type === 'CALLS' && isCodeNode(edge.from) && !isTestishPath(filePathFor(edge.from)))?.from ??
    selectedEdges.find((edge) => edge.type === 'CALLS' && isCodeNode(edge.from))?.from ??
    selectedEdges[0]?.from ??
    selectedNodes[0]?.id;
  return { nodes: selectedNodes, edges: selectedEdges, startNode };
}

function ok(adapter, dataset, metrics, results) {
  return { adapter, ok: true, dataset, metrics, results };
}

function failed(adapter, error) {
  return { adapter, ok: false, error: error instanceof Error ? error.stack ?? error.message : String(error) };
}

function adapterFromArgs() {
  const index = process.argv.indexOf('--adapter');
  return index === -1 ? null : process.argv[index + 1];
}

async function runLadybug(dataset) {
  const start = performance.now();
  const loadMode = arg('load-mode', 'copy');
  const lbug = await import('@ladybugdb/core');
  const mod = lbug.default ?? lbug;
  const dir = tmpDir('ladybug-repo');
  const db = new mod.Database(path.join(dir, 'graph.lbug'));
  const conn = new mod.Connection(db);
  const q = async (query) => {
    const result = await conn.query(query);
    return typeof result?.getAll === 'function' ? await result.getAll() : result;
  };
  try {
    await q('CREATE NODE TABLE Node (id STRING, kind STRING, name STRING, filePath STRING, payload STRING, PRIMARY KEY(id))');
    await q('CREATE REL TABLE Edge (FROM Node TO Node, type STRING, confidence DOUBLE, detail STRING)');
    if (loadMode === 'copy') {
      const nodeCsv = path.join(dir, 'nodes.csv');
      const edgeCsv = path.join(dir, 'edges.csv');
      writeCsv(nodeCsv, ['id', 'kind', 'name', 'filePath', 'payload'], dataset.nodes.map((node) => [node.id, node.kind, node.name, node.filePath, JSON.stringify(node.payload)]));
      writeCsv(edgeCsv, ['from', 'to', 'type', 'confidence', 'detail'], dataset.edges.map((edge) => [edge.from, edge.to, edge.type, edge.confidence, edge.detail]));
      await q(`COPY Node(id, kind, name, filePath, payload) FROM "${nodeCsv.replaceAll('\\', '/')}" (HEADER=true, ESCAPE='"', DELIM=',', QUOTE='"', PARALLEL=false, auto_detect=false)`);
      await q(`COPY Edge FROM "${edgeCsv.replaceAll('\\', '/')}" (from="Node", to="Node", HEADER=true, ESCAPE='"', DELIM=',', QUOTE='"', PARALLEL=false, auto_detect=false)`);
    } else {
      for (const node of dataset.nodes) {
        await q(`CREATE (:Node {id: '${quote(node.id)}', kind: '${quote(node.kind)}', name: '${quote(node.name)}', filePath: '${quote(node.filePath)}', payload: '${quote(JSON.stringify(node.payload))}'})`);
      }
      for (const edge of dataset.edges) {
        await q(`MATCH (a:Node {id: '${quote(edge.from)}'}), (b:Node {id: '${quote(edge.to)}'}) CREATE (a)-[:Edge {type: '${quote(edge.type)}', confidence: ${edge.confidence}, detail: '${quote(edge.detail)}'}]->(b)`);
      }
    }
    const context = await q(`MATCH (a:Node {id: '${quote(dataset.startNode)}'})-[e:Edge]->(b:Node) RETURN DISTINCT b.id, e.type LIMIT 50`);
    const impact = await q(`MATCH p=(a:Node {id: '${quote(dataset.startNode)}'})-[:Edge*1..2]->(b:Node) RETURN DISTINCT b.id LIMIT 100`);
    return ok('ladybug', { nodes: dataset.nodes.length, edges: dataset.edges.length, startNode: dataset.startNode, loadMode }, { elapsed_ms: ms(start) }, { context: context.length, impact: impact.length });
  } finally {
    try { await conn.close?.(); } catch {}
    try { await db.close?.(); } catch {}
  }
}

async function runKuzu(dataset) {
  const start = performance.now();
  const loadMode = arg('load-mode', 'copy');
  const kuzu = await import('kuzu');
  const dir = tmpDir('kuzu-repo');
  const db = new kuzu.Database(path.join(dir, 'graph.kuzu'));
  const conn = new kuzu.Connection(db);
  const q = async (query) => {
    const result = await conn.query(query);
    return typeof result?.getAll === 'function' ? await result.getAll() : result;
  };
  try {
    await q('CREATE NODE TABLE Node(id STRING, kind STRING, name STRING, filePath STRING, payload STRING, PRIMARY KEY(id))');
    await q('CREATE REL TABLE Edge(FROM Node TO Node, type STRING, confidence DOUBLE, detail STRING)');
    if (loadMode === 'copy') {
      const nodeCsv = path.join(dir, 'nodes.csv');
      const edgeCsv = path.join(dir, 'edges.csv');
      writeCsv(nodeCsv, ['id', 'kind', 'name', 'filePath', 'payload'], dataset.nodes.map((node) => [node.id, node.kind, node.name, node.filePath, JSON.stringify(node.payload)]));
      writeCsv(edgeCsv, ['from', 'to', 'type', 'confidence', 'detail'], dataset.edges.map((edge) => [edge.from, edge.to, edge.type, edge.confidence, edge.detail]));
      await q(`COPY Node FROM "${nodeCsv.replaceAll('\\', '/')}" (HEADER=true)`);
      await q(`COPY Edge FROM "${edgeCsv.replaceAll('\\', '/')}" (HEADER=true)`);
    } else {
      for (const node of dataset.nodes) {
        await q(`CREATE (:Node {id: '${quote(node.id)}', kind: '${quote(node.kind)}', name: '${quote(node.name)}', filePath: '${quote(node.filePath)}', payload: '${quote(JSON.stringify(node.payload))}'})`);
      }
      for (const edge of dataset.edges) {
        await q(`MATCH (a:Node {id: '${quote(edge.from)}'}), (b:Node {id: '${quote(edge.to)}'}) CREATE (a)-[:Edge {type: '${quote(edge.type)}', confidence: ${edge.confidence}, detail: '${quote(edge.detail)}'}]->(b)`);
      }
    }
    const context = await q(`MATCH (a:Node {id: '${quote(dataset.startNode)}'})-[e:Edge]->(b:Node) RETURN DISTINCT b.id, e.type LIMIT 50`);
    const impact = await q(`MATCH p=(a:Node {id: '${quote(dataset.startNode)}'})-[:Edge*1..2]->(b:Node) RETURN DISTINCT b.id LIMIT 100`);
    return ok('kuzu', { nodes: dataset.nodes.length, edges: dataset.edges.length, startNode: dataset.startNode, loadMode }, { elapsed_ms: ms(start) }, { context: context.length, impact: impact.length });
  } finally {
    try { await conn.close?.(); } catch {}
    try { await db.close?.(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function runCozo(dataset) {
  const start = performance.now();
  const { CozoDb } = await import('cozo-node');
  const dir = tmpDir('cozo-repo');
  const db = new CozoDb('sqlite', path.join(dir, 'graph.db'), {});
  try {
    await db.run(':create node {id: String => kind: String, name: String, filePath: String, payload: String}');
    await db.run(':create edge {id: String => from: String, to: String, type: String, confidence: Float, detail: String}');
    await db.run('?[id, kind, name, filePath, payload] <- $rows :put node {id => kind, name, filePath, payload}', {
      rows: dataset.nodes.map((node) => [node.id, node.kind, node.name, node.filePath, JSON.stringify(node.payload)]),
    });
    await db.run('?[id, from, to, type, confidence, detail] <- $rows :put edge {id => from, to, type, confidence, detail}', {
      rows: dataset.edges.map((edge) => [edge.id, edge.from, edge.to, edge.type, edge.confidence, edge.detail]),
    });
    const context = await db.run('?[to, type] := *edge{from: $id, to, type} :limit 50', { id: dataset.startNode });
    const impact = await db.run(`
      rel[from, to] := *edge{from, to}
      reach[from, to] := rel[from, to]
      reach[from, to] := rel[from, mid], rel[mid, to]
      ?[to] := reach[$id, to]
      :limit 100
    `, { id: dataset.startNode });
    return ok('cozo', { nodes: dataset.nodes.length, edges: dataset.edges.length, startNode: dataset.startNode }, { elapsed_ms: ms(start) }, { context: context.rows.length, impact: impact.rows.length });
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function runDuckDB(dataset) {
  const start = performance.now();
  const { DuckDBInstance } = await import('@duckdb/node-api');
  const dir = tmpDir('duckdb-repo');
  const instance = await DuckDBInstance.create(path.join(dir, 'graph.duckdb'));
  const conn = await instance.connect();
  try {
    await conn.run('CREATE TABLE node(id VARCHAR PRIMARY KEY, kind VARCHAR, name VARCHAR, filePath VARCHAR, payload JSON)');
    await conn.run('CREATE TABLE edge("from" VARCHAR, "to" VARCHAR, type VARCHAR, confidence DOUBLE, detail VARCHAR)');
    await conn.run(`INSERT INTO node VALUES ${dataset.nodes.map((node) => `('${quote(node.id)}', '${quote(node.kind)}', '${quote(node.name)}', '${quote(node.filePath)}', '${quote(JSON.stringify(node.payload))}')`).join(',')}`);
    if (dataset.edges.length > 0) {
      await conn.run(`INSERT INTO edge VALUES ${dataset.edges.map((edge) => `('${quote(edge.from)}', '${quote(edge.to)}', '${quote(edge.type)}', ${edge.confidence}, '${quote(edge.detail)}')`).join(',')}`);
    }
    const read = async (query) => (await conn.runAndReadAll(query)).getRowsJson();
    const context = await read(`SELECT DISTINCT e."to", e.type FROM edge e WHERE e."from" = '${quote(dataset.startNode)}' LIMIT 50`);
    const impact = await read(`
      WITH RECURSIVE reach(id, depth) AS (
        SELECT e."to", 1 FROM edge e WHERE e."from" = '${quote(dataset.startNode)}'
        UNION ALL
        SELECT e."to", r.depth + 1 FROM edge e JOIN reach r ON e."from" = r.id WHERE r.depth < 2
      )
      SELECT DISTINCT id FROM reach LIMIT 100
    `);
    return ok('duckdb', { nodes: dataset.nodes.length, edges: dataset.edges.length, startNode: dataset.startNode }, { elapsed_ms: ms(start) }, { context: context.length, impact: impact.length });
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

const repoPath = path.resolve(arg('repo', process.cwd()));
const maxNodes = positiveInt(arg('max-nodes', '1000'), 1000);
const maxEdges = positiveInt(arg('max-edges', '3000'), 3000);
const loadMode = arg('load-mode', 'copy');
const adapter = adapterFromArgs();
const dataset = loadDataset(repoPath, maxNodes, maxEdges);

if (adapter) {
  const run = candidateMap[adapter];
  if (!run) {
    console.log(JSON.stringify(failed(adapter, new Error(`Unknown adapter: ${adapter}`)), null, 2));
    process.exit(1);
  }
  try {
    console.log(JSON.stringify(await run(dataset), null, 2));
  } catch (error) {
    console.log(JSON.stringify(failed(adapter, error), null, 2));
    process.exitCode = 1;
  }
  process.exit();
}

const results = [];
for (const candidate of Object.keys(candidateMap)) {
  const child = spawnSync(process.execPath, [
    new URL(import.meta.url).pathname,
    '--adapter',
    candidate,
    '--repo',
    repoPath,
    '--max-nodes',
    String(maxNodes),
    '--max-edges',
    String(maxEdges),
    '--load-mode',
    loadMode,
  ], {
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

console.log(JSON.stringify({
  generated_at: new Date().toISOString(),
  repo: repoPath,
  maxNodes,
  maxEdges,
  loadMode,
  results,
}, null, 2));
