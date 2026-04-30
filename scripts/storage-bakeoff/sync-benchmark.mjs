import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import yaml from 'js-yaml';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function ms(start) {
  return Number((performance.now() - start).toFixed(2));
}

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cotx-${name}-`));
}

function readYamlDir(repoPath, layer, limit) {
  const dir = path.join(repoPath, '.cotx', layer);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((file) => file.endsWith('.yaml'))
    .slice(0, limit)
    .map((file) => yaml.load(fs.readFileSync(path.join(dir, file), 'utf-8')))
    .filter(Boolean);
}

function rowsFromArtifacts(repoPath, limitPerLayer) {
  const started = performance.now();
  const canonical = readYamlDir(repoPath, 'canonical-paths', limitPerLayer);
  const symmetry = readYamlDir(repoPath, 'symmetry', limitPerLayer);
  const closures = readYamlDir(repoPath, 'closures', limitPerLayer);
  const abstractions = readYamlDir(repoPath, 'abstractions', limitPerLayer);

  const rows = {
    canonical: canonical.map((item) => [
      item.id,
      item.family_id ?? '',
      item.target_concern ?? '',
      item.owning_module ?? '',
      Number(item.confidence ?? 0),
      item.status ?? '',
    ]),
    canonical_entry: canonical.flatMap((item) =>
      (item.primary_entry_symbols ?? []).map((symbol) => [item.id, String(symbol)]),
    ),
    canonical_deviation: canonical.flatMap((item) =>
      (item.deviations ?? []).map((dev) => [item.id, dev.module ?? '', dev.symbol ?? '', dev.reason ?? '']),
    ),
    symmetry: symmetry.map((item) => [
      item.id,
      item.family_id ?? '',
      item.from_unit ?? '',
      item.to_unit ?? '',
      item.strength ?? '',
      Number(item.score ?? 0),
    ]),
    closure: closures.map((item) => [
      item.id,
      item.target_unit ?? '',
      item.family_id ?? '',
    ]),
    closure_member: closures.flatMap((item) =>
      (item.members ?? []).map((member) => [
        item.id,
        member.unit_id ?? '',
        member.level ?? '',
        Number(member.confidence ?? 0),
        (member.reasons ?? []).join('; '),
      ]),
    ),
    abstraction: abstractions.map((item) => [
      item.id,
      item.family_id ?? '',
      item.title ?? '',
      item.candidate_owning_module ?? '',
      item.suggested_abstraction_level ?? '',
      Number(item.confidence ?? 0),
      item.status ?? '',
    ]),
    abstraction_unit: abstractions.flatMap((item) =>
      (item.candidate_units ?? []).map((unit) => [item.id, String(unit)]),
    ),
  };

  return {
    artifacts: { canonical: canonical.length, symmetry: symmetry.length, closures: closures.length, abstractions: abstractions.length },
    rows,
    parse_ms: ms(started),
  };
}

async function createCozoDecisionSchema(db) {
  await db.run(':create canonical {id: String => familyId: String, targetConcern: String, owningModule: String, confidence: Float, status: String}');
  await db.run(':create canonical_entry {canonicalId: String, symbol: String}');
  await db.run(':create canonical_deviation {canonicalId: String, module: String, symbol: String => reason: String}');
  await db.run(':create symmetry {id: String => familyId: String, fromUnit: String, toUnit: String, strength: String, score: Float}');
  await db.run(':create closure {id: String => targetUnit: String, familyId: String}');
  await db.run(':create closure_member {closureId: String, unitId: String => level: String, confidence: Float, reasons: String}');
  await db.run(':create abstraction {id: String => familyId: String, title: String, owningModule: String, level: String, confidence: Float, status: String}');
  await db.run(':create abstraction_unit {abstractionId: String, unitId: String}');
}

async function putRows(db, name, columns, keySpec, rows) {
  if (rows.length === 0) return;
  await db.run(`?[${columns.join(', ')}] <- $rows :put ${name} ${keySpec}`, { rows });
}

async function insertCozoDecisionRows(db, rows) {
  await putRows(db, 'canonical', ['id', 'familyId', 'targetConcern', 'owningModule', 'confidence', 'status'], '{id => familyId, targetConcern, owningModule, confidence, status}', rows.canonical);
  await putRows(db, 'canonical_entry', ['canonicalId', 'symbol'], '{canonicalId, symbol}', rows.canonical_entry);
  await putRows(db, 'canonical_deviation', ['canonicalId', 'module', 'symbol', 'reason'], '{canonicalId, module, symbol => reason}', rows.canonical_deviation);
  await putRows(db, 'symmetry', ['id', 'familyId', 'fromUnit', 'toUnit', 'strength', 'score'], '{id => familyId, fromUnit, toUnit, strength, score}', rows.symmetry);
  await putRows(db, 'closure', ['id', 'targetUnit', 'familyId'], '{id => targetUnit, familyId}', rows.closure);
  await putRows(db, 'closure_member', ['closureId', 'unitId', 'level', 'confidence', 'reasons'], '{closureId, unitId => level, confidence, reasons}', rows.closure_member);
  await putRows(db, 'abstraction', ['id', 'familyId', 'title', 'owningModule', 'level', 'confidence', 'status'], '{id => familyId, title, owningModule, level, confidence, status}', rows.abstraction);
  await putRows(db, 'abstraction_unit', ['abstractionId', 'unitId'], '{abstractionId, unitId}', rows.abstraction_unit);
}

async function queryCozoDecisionRows(db) {
  const highConfidenceCanonical = await db.run('?[id, confidence] := *canonical{id, confidence}, confidence >= 0.7');
  const largeClosures = await db.run(`
    member_count[closureId, count(unitId)] := *closure_member{closureId, unitId}
    ?[closureId, count] := member_count[closureId, count], count >= 5
  `);
  const symmetryPartners = await db.run(`
    ?[partner, score] := *symmetry{fromUnit: "src/tool:list_tools", toUnit: partner, score}
  `);
  const abstractionTargets = await db.run(`
    ?[unit, title] := *abstraction{id, title, status: "recommended"}, *abstraction_unit{abstractionId: id, unitId: unit}
    :limit 20
  `);
  return {
    highConfidenceCanonical: highConfidenceCanonical.rows.length,
    largeClosures: largeClosures.rows.length,
    symmetryPartners: symmetryPartners.rows.length,
    abstractionTargets: abstractionTargets.rows.length,
  };
}

async function main() {
  const repoPath = path.resolve(arg('repo', process.cwd()));
  const limitPerLayer = positiveInt(arg('limit-per-layer', '1000000'), 1_000_000);
  const { CozoDb } = await import('cozo-node');
  const totalStarted = performance.now();
  const parsed = rowsFromArtifacts(repoPath, limitPerLayer);
  const dir = tmpDir('sync-cozo');
  const db = new CozoDb('sqlite', path.join(dir, 'decision.db'), {});
  try {
    const schemaStarted = performance.now();
    await createCozoDecisionSchema(db);
    const schemaMs = ms(schemaStarted);
    const insertStarted = performance.now();
    await insertCozoDecisionRows(db, parsed.rows);
    const insertMs = ms(insertStarted);
    const queryStarted = performance.now();
    const queryResults = await queryCozoDecisionRows(db);
    const queryMs = ms(queryStarted);
    const rowCounts = Object.fromEntries(Object.entries(parsed.rows).map(([key, rows]) => [key, rows.length]));
    console.log(JSON.stringify({
      generated_at: new Date().toISOString(),
      repo: repoPath,
      limitPerLayer,
      artifacts: parsed.artifacts,
      rowCounts,
      timings: {
        parse_ms: parsed.parse_ms,
        schema_ms: schemaMs,
        insert_ms: insertMs,
        query_ms: queryMs,
        total_ms: ms(totalStarted),
      },
      queryResults,
    }, null, 2));
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
