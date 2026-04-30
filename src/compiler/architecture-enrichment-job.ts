import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ArchitectureStore } from '../store/architecture-store.js';
import { GraphTruthStore } from '../store-v2/graph-truth-store.js';
import type {
  ArchitectureEnrichmentJob,
  ArchitectureEnrichmentValidationFinding,
  ArchitectureEnrichmentValidationResult,
  ArchitectureEvidenceAnchor,
  ArchitectureWorkspaceData,
} from '../store/schema.js';

export function hashArchitectureEnrichmentOutput(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function validateArchitectureEnrichmentJob(
  projectRoot: string,
  job: ArchitectureEnrichmentJob,
  archStore = new ArchitectureStore(projectRoot),
): ArchitectureEnrichmentValidationResult {
  const findings: ArchitectureEnrichmentValidationFinding[] = [];

  if (!job.target?.id || !job.target.kind) {
    findings.push({
      level: 'error',
      code: 'MISSING_TARGET',
      message: 'Enrichment job must declare a target kind and id.',
    });
  }

  if (job.evidence.length === 0) {
    findings.push({
      level: 'error',
      code: 'MISSING_EVIDENCE',
      message: 'Enrichment job must include at least one evidence anchor.',
    });
  }

  const workspace = archStore.readWorkspace();
  for (const anchor of job.evidence) {
    findings.push(...validateEvidenceAnchor(projectRoot, anchor, archStore, workspace));
  }

  if (job.output && job.output.hash !== hashArchitectureEnrichmentOutput(job.output.content)) {
    findings.push({
      level: 'error',
      code: 'OUTPUT_HASH_MISMATCH',
      message: 'Enrichment job output hash does not match output content.',
    });
  }

  return {
    ok: findings.every((finding) => finding.level !== 'error'),
    findings,
  };
}

export async function validateArchitectureEnrichmentJobWithGraph(
  projectRoot: string,
  job: ArchitectureEnrichmentJob,
  archStore = new ArchitectureStore(projectRoot),
): Promise<ArchitectureEnrichmentValidationResult> {
  const graphPath = path.join(projectRoot, '.cotx', 'v2', 'truth.lbug');
  if (!fs.existsSync(graphPath)) return validateArchitectureEnrichmentJob(projectRoot, job, archStore);

  const graph = new GraphTruthStore({ dbPath: graphPath, readOnly: true });
  await graph.open();
  try {
    const base = validateArchitectureEnrichmentJob(projectRoot, job, archStore);
    const graphValidatedKinds = new Set(['node', 'relation', 'process', 'route', 'tool', 'module']);
    const findings = base.findings.filter((finding) => {
      if (finding.code !== 'UNSUPPORTED_ANCHOR_VALIDATION') return true;
      return !finding.anchor || !graphValidatedKinds.has(finding.anchor.kind);
    });
    for (const anchor of job.evidence) {
      findings.push(...await validateEvidenceAnchorWithGraph(graph, anchor));
    }
    return {
      ok: findings.every((finding) => finding.level !== 'error'),
      findings,
    };
  } finally {
    await graph.close();
  }
}

function validateEvidenceAnchor(
  projectRoot: string,
  anchor: ArchitectureEvidenceAnchor,
  archStore: ArchitectureStore,
  workspace: ArchitectureWorkspaceData | null,
): ArchitectureEnrichmentValidationFinding[] {
  if (anchor.kind === 'file') {
    const filePath = anchor.filePath ?? anchor.id;
    if (!fs.existsSync(path.join(projectRoot, filePath))) {
      return [{
        level: 'error',
        code: 'MISSING_FILE',
        message: `Evidence file does not exist: ${filePath}`,
        anchor,
      }];
    }
    return [];
  }

  if (anchor.kind === 'module') {
    const exists = workspace?.elements.some((element) => element.id === anchor.id || element.source_paths?.includes(anchor.id));
    return exists
      ? []
      : [{
          level: 'warning',
          code: 'UNSUPPORTED_ANCHOR_VALIDATION',
          message: `Module anchor is recorded but not yet validated against storage-v2 truth graph: ${anchor.id}`,
          anchor,
        }];
  }

  if (anchor.kind === 'node' || anchor.kind === 'relation' || anchor.kind === 'process' || anchor.kind === 'route' || anchor.kind === 'tool' || anchor.kind === 'decision') {
    const existsInWorkspace = workspaceContainsAnchor(workspace, anchor);
    return existsInWorkspace
      ? []
      : [{
          level: 'warning',
          code: 'UNSUPPORTED_ANCHOR_VALIDATION',
          message: `${anchor.kind} anchor is recorded but not yet validated against storage-v2 truth graph: ${anchor.id}`,
          anchor,
        }];
  }

  return [];
}

export function validateArchitectureTarget(
  projectRoot: string,
  job: ArchitectureEnrichmentJob,
  archStore = new ArchitectureStore(projectRoot),
): ArchitectureEnrichmentValidationResult {
  const result = validateArchitectureEnrichmentJob(projectRoot, job, archStore);
  const findings = [...result.findings];

  if (job.target.kind === 'architecture-element') {
    const workspace = archStore.readWorkspace();
    const inWorkspace = workspace?.elements.some((element) => element.id === job.target.id) ?? false;
    if (!inWorkspace) {
      findings.push({
        level: 'error',
        code: 'MISSING_ARCHITECTURE_ELEMENT',
        message: `Architecture workspace element does not exist: ${job.target.id}`,
      });
    }
  }

  if (job.target.kind === 'architecture-perspective') {
    const exists = archStore.listPerspectives().includes(job.target.id);
    if (!exists) {
      findings.push({
        level: 'error',
        code: 'MISSING_ARCHITECTURE_PERSPECTIVE',
        message: `Architecture perspective does not exist: ${job.target.id}`,
      });
    }
  }

  return {
    ok: findings.every((finding) => finding.level !== 'error'),
    findings,
  };
}

function workspaceContainsAnchor(workspace: ArchitectureWorkspaceData | null, anchor: ArchitectureEvidenceAnchor): boolean {
  if (!workspace) return false;
  return workspace.elements.some((element) => element.evidence.some((item) => item.kind === anchor.kind && item.id === anchor.id)) ||
    workspace.relationships.some((relationship) => relationship.evidence.some((item) => item.kind === anchor.kind && item.id === anchor.id));
}

async function validateEvidenceAnchorWithGraph(
  graph: GraphTruthStore,
  anchor: ArchitectureEvidenceAnchor,
): Promise<ArchitectureEnrichmentValidationFinding[]> {
  if (anchor.kind === 'node') {
    return await codeNodeExists(graph, anchor.id, undefined)
      ? []
      : [missingGraphAnchor(anchor, `Code node does not exist: ${anchor.id}`)];
  }
  if (anchor.kind === 'route') {
    return await codeNodeExists(graph, anchor.id, 'Route')
      ? []
      : [missingGraphAnchor(anchor, `Route node does not exist: ${anchor.id}`)];
  }
  if (anchor.kind === 'tool') {
    return await codeNodeExists(graph, anchor.id, 'Tool')
      ? []
      : [missingGraphAnchor(anchor, `Tool node does not exist: ${anchor.id}`)];
  }
  if (anchor.kind === 'process') {
    return await codeNodeExists(graph, anchor.id, 'Process')
      ? []
      : [missingGraphAnchor(anchor, `Process node does not exist: ${anchor.id}`)];
  }
  if (anchor.kind === 'module') {
    return await semanticArtifactExists(graph, anchor.id, 'module')
      ? []
      : [missingGraphAnchor(anchor, `Module semantic artifact does not exist: ${anchor.id}`)];
  }
  if (anchor.kind === 'relation') {
    const [from, to] = anchor.id.split('->');
    if (!from || !to) {
      return [{
        level: 'warning',
        code: 'UNSUPPORTED_ANCHOR_VALIDATION',
        message: `Relation anchor must use from->to format for graph-backed validation: ${anchor.id}`,
        anchor,
      }];
    }
    return await relationExists(graph, from, to)
      ? []
      : [missingGraphAnchor(anchor, `Code relation does not exist: ${anchor.id}`)];
  }
  if (anchor.kind === 'decision') {
    return [{
      level: 'warning',
      code: 'UNSUPPORTED_ANCHOR_VALIDATION',
      message: `Decision anchor is recorded but not yet validated against the rule index: ${anchor.id}`,
      anchor,
    }];
  }
  return [];
}

async function codeNodeExists(graph: GraphTruthStore, id: string, label: string | undefined): Promise<boolean> {
  const where = label ? `WHERE n.label = '${quoteCypher(label)}'` : '';
  const rows = await graph.query(`MATCH (n:CodeNode {id:'${quoteCypher(id)}'}) ${where} RETURN n.id AS id LIMIT 1`);
  return rows.length > 0;
}

async function relationExists(graph: GraphTruthStore, from: string, to: string): Promise<boolean> {
  const rows = await graph.query(`MATCH (a {id:'${quoteCypher(from)}'})-[r:CodeRelation]->(b {id:'${quoteCypher(to)}'}) RETURN r.type AS type LIMIT 1`);
  return rows.length > 0;
}

async function semanticArtifactExists(graph: GraphTruthStore, id: string, layer: string): Promise<boolean> {
  const rows = await graph.query(`MATCH (a:SemanticArtifact {id:'${quoteCypher(id)}'}) WHERE a.layer = '${quoteCypher(layer)}' RETURN a.id AS id LIMIT 1`);
  return rows.length > 0;
}

function missingGraphAnchor(anchor: ArchitectureEvidenceAnchor, message: string): ArchitectureEnrichmentValidationFinding {
  return {
    level: 'error',
    code: 'MISSING_GRAPH_ANCHOR',
    message,
    anchor,
  };
}

function quoteCypher(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
}
