import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendTruthCorrectionProposal,
  buildTruthCorrectionRegressionPlan,
  formatTruthCorrectionRegressionPlanMarkdown,
  normalizeTruthCorrectionProposal,
  readTruthCorrectionRecords,
  summarizeTruthCorrections,
  truthCorrectionProposalKey,
  truthCorrectionProposalPath,
  updateTruthCorrectionStatus,
  validateTruthCorrectionProposalCandidate,
  validateTruthCorrectionRecords,
} from '../../src/compiler/truth-correction-proposals.js';
import { writeStorageV2 } from '../../src/store-v2/write-storage-v2.js';

describe('truth correction proposals', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-truth-corrections-'));
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'export const x = true;\n', 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('normalizes, writes, reads, and summarizes proposal records', () => {
    const normalized = normalizeTruthCorrectionProposal(tmpDir, {
      kind: 'compiler-gap',
      title: '  Missing source grouping  ',
      proposed_fact: '  Group source roots deterministically.  ',
      current_fact: '  source root is too broad  ',
      evidence_file_paths: ['./src/index.ts', 'src/index.ts'],
      evidence_refs: ['file:src/index.ts', 'file:src/index.ts'],
      suggested_test: '  add fixture  ',
      confidence: 'high',
    });

    expect(normalized.title).toBe('Missing source grouping');
    expect(normalized.evidence_file_paths).toEqual(['src/index.ts']);
    expect(normalized.evidence_refs).toEqual(['file:src/index.ts']);

    appendTruthCorrectionProposal(tmpDir, 'architecture', normalized, {
      createdAt: '2026-04-13T01:02:00.000Z',
    });

    const records = readTruthCorrectionRecords(tmpDir);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      schema_version: 'cotx.truth_correction_proposal.v1',
      layer: 'architecture',
      kind: 'compiler-gap',
      confidence: 'high',
      status: 'open',
    });

    const summary = summarizeTruthCorrections(tmpDir);
    expect(summary.total).toBe(1);
    expect(summary.high_confidence).toBe(1);
    expect(summary.by_kind['compiler-gap']).toBe(1);
    expect(summary.by_status.open).toBe(1);
    expect(summary.by_layer.architecture).toBe(1);
    expect(summary.latest_created_at).toBe('2026-04-13T01:02:00.000Z');
    expect(fs.existsSync(truthCorrectionProposalPath(tmpDir))).toBe(true);
  });

  it('updates proposal lifecycle status and excludes fixed proposals from regression candidates', () => {
    const record = appendTruthCorrectionProposal(tmpDir, 'architecture', {
      kind: 'architecture-description-gap',
      title: 'Generic architecture description',
      proposed_fact: 'Use deterministic metadata.',
      evidence_file_paths: ['src/index.ts'],
      confidence: 'high',
    }, {
      createdAt: '2026-04-13T01:02:00.000Z',
    });

    const updated = updateTruthCorrectionStatus(tmpDir, record.id, 'fixed', {
      reason: 'covered by architecture description regression',
      updatedAt: '2026-04-13T01:04:00.000Z',
    });

    expect(updated.status).toBe('fixed');
    expect(updated.status_reason).toContain('covered');
    const summary = summarizeTruthCorrections(tmpDir);
    expect(summary.by_status.fixed).toBe(1);
    expect(buildTruthCorrectionRegressionPlan(tmpDir).total_candidates).toBe(0);
  });

  it('uses stable keys for duplicate detection', () => {
    const proposal = normalizeTruthCorrectionProposal(tmpDir, {
      kind: 'architecture-description-gap',
      title: 'Generic description',
      proposed_fact: 'Use deterministic metadata.',
      evidence_file_paths: ['src/index.ts'],
      confidence: 'medium',
    });

    expect(truthCorrectionProposalKey(proposal)).toBe(truthCorrectionProposalKey({ ...proposal }));
  });

  it('rejects non-file evidence paths during normalization', () => {
    expect(() => normalizeTruthCorrectionProposal(tmpDir, {
      kind: 'missing-node',
      title: 'Bad evidence',
      proposed_fact: 'missing thing',
      evidence_file_paths: ['onboarding_context_response'],
      evidence_refs: ['onboarding_context.summary.consistency_counts.graph-gap'],
      confidence: 'high',
    })).toThrow('Evidence path does not exist');
  });

  it('builds deterministic regression candidates from proposal records', () => {
    appendTruthCorrectionProposal(tmpDir, 'architecture', {
      kind: 'architecture-description-gap',
      title: 'Generic architecture description',
      proposed_fact: 'Use deterministic metadata.',
      evidence_file_paths: ['src/index.ts'],
      suggested_test: 'Assert generated descriptions use function names.',
      confidence: 'high',
    }, {
      createdAt: '2026-04-13T01:02:00.000Z',
    });

    const plan = buildTruthCorrectionRegressionPlan(tmpDir, {
      generatedAt: '2026-04-13T01:03:00.000Z',
    });

    expect(plan.schema_version).toBe('cotx.truth_correction_regression_plan.v1');
    expect(plan.total_candidates).toBe(1);
    expect(plan.high_confidence_candidates).toBe(1);
    expect(plan.candidates[0].implementation_targets).toContain('src/compiler/architecture-compiler.ts');
    expect(plan.candidates[0].test_targets).toContain('test/compiler/architecture-compiler.test.ts');

    const markdown = formatTruthCorrectionRegressionPlanMarkdown(plan);
    expect(markdown).toContain('# Truth Correction Regression Plan');
    expect(markdown).toContain('Generic architecture description');
    expect(markdown).toContain('Assert generated descriptions use function names.');
  });

  it('validates missing-node proposals against storage-v2 graph facts', async () => {
    await writeStorageV2(tmpDir, {
      projectRoot: tmpDir,
      nodes: [{
        id: 'fn:index',
        label: 'Function',
        properties: {
          name: 'entry',
          filePath: 'src/index.ts',
          startLine: 1,
          endLine: 1,
          isExported: true,
        },
      } as any],
      edges: [],
      communities: [],
      processes: [],
      modules: [],
      concepts: [],
      contracts: [],
      flows: [],
      concerns: [],
      concernFamilies: [],
      canonicalPaths: [],
      symmetryEdges: [],
      closureSets: [],
      abstractionOpportunities: [],
      decisionOverrides: [],
    } as any);
    fs.mkdirSync(path.join(tmpDir, '.cotx', 'graph'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.cotx', 'graph', 'nodes.json'), JSON.stringify([{
      properties: { filePath: 'src/index.ts' },
    }]), 'utf-8');
    appendTruthCorrectionProposal(tmpDir, 'module', {
      kind: 'missing-node',
      title: 'Missing index node',
      proposed_fact: 'src/index.ts should be in graph',
      evidence_file_paths: ['src/index.ts'],
      confidence: 'high',
    }, {
      createdAt: '2026-04-13T01:02:00.000Z',
    });

    const validation = await validateTruthCorrectionRecords(tmpDir);

    expect(validation.graph_status).toBe('present');
    expect(validation.ok).toBe(false);
    expect(validation.findings).toContainEqual(expect.objectContaining({
      code: 'MISSING_NODE_ALREADY_EXISTS',
      evidence: 'src/index.ts',
    }));
  });

  it('preflights missing-node candidates before they enter the proposal queue', async () => {
    await writeStorageV2(tmpDir, {
      projectRoot: tmpDir,
      nodes: [{
        id: 'fn:index',
        label: 'Function',
        properties: {
          name: 'entry',
          filePath: 'src/index.ts',
          startLine: 1,
          endLine: 1,
          isExported: true,
        },
      } as any],
      edges: [],
      communities: [],
      processes: [],
      modules: [],
      concepts: [],
      contracts: [],
      flows: [],
      concerns: [],
      concernFamilies: [],
      canonicalPaths: [],
      symmetryEdges: [],
      closureSets: [],
      abstractionOpportunities: [],
      decisionOverrides: [],
    } as any);
    fs.mkdirSync(path.join(tmpDir, '.cotx', 'graph'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.cotx', 'graph', 'nodes.json'), JSON.stringify([{
      properties: { filePath: 'src/index.ts' },
    }]), 'utf-8');
    const proposal = normalizeTruthCorrectionProposal(tmpDir, {
      kind: 'missing-node',
      title: 'Missing index node',
      proposed_fact: 'src/index.ts should be in graph',
      evidence_file_paths: ['src/index.ts'],
      confidence: 'high',
    });

    const findings = await validateTruthCorrectionProposalCandidate(tmpDir, 'module', proposal);

    expect(findings).toContainEqual(expect.objectContaining({
      code: 'MISSING_NODE_ALREADY_EXISTS',
      evidence: 'src/index.ts',
    }));
  });

  it('rejects graph-gap proposals when the graph file index is incomplete', async () => {
    const proposal = normalizeTruthCorrectionProposal(tmpDir, {
      kind: 'missing-node',
      title: 'Missing index node',
      proposed_fact: 'src/index.ts should be in graph',
      evidence_file_paths: ['src/index.ts'],
      confidence: 'high',
    });

    const findings = await validateTruthCorrectionProposalCandidate(tmpDir, 'module', proposal, {
      graphFileIndexStatus: 'partial',
    });

    expect(findings).toContainEqual(expect.objectContaining({
      code: 'GRAPH_FILE_INDEX_INCOMPLETE',
      level: 'error',
    }));
  });

  it('drops incomplete graph sidecar warnings once storage-v2 truth already disproves the proposal', async () => {
    fs.writeFileSync(path.join(tmpDir, 'src', 'missing.ts'), 'export const missing = true;\n', 'utf-8');
    await writeStorageV2(tmpDir, {
      projectRoot: tmpDir,
      nodes: [{
        id: 'fn:index',
        label: 'Function',
        properties: {
          name: 'entry',
          filePath: 'src/index.ts',
          startLine: 1,
          endLine: 1,
          isExported: true,
        },
      } as any],
      edges: [],
      communities: [],
      processes: [],
      modules: [],
      concepts: [],
      contracts: [],
      flows: [],
      concerns: [],
      concernFamilies: [],
      canonicalPaths: [],
      symmetryEdges: [],
      closureSets: [],
      abstractionOpportunities: [],
      decisionOverrides: [],
    } as any);
    const proposal = normalizeTruthCorrectionProposal(tmpDir, {
      kind: 'missing-node',
      title: 'Missing missing.ts node',
      proposed_fact: 'src/missing.ts should be in graph',
      evidence_file_paths: ['src/missing.ts'],
      confidence: 'high',
    });

    const findings = await validateTruthCorrectionProposalCandidate(tmpDir, 'module', proposal, {
      graphFileIndexStatus: 'partial',
      truthGraphPresent: true,
    });

    expect(findings).toContainEqual(expect.objectContaining({
      code: 'MISSING_NODE_ALREADY_EXISTS',
      level: 'error',
      evidence: 'src/missing.ts',
    }));
    expect(findings.some((finding) => finding.code === 'GRAPH_FILE_INDEX_INCOMPLETE')).toBe(false);
  });

  it('does not treat markdown reference evidence as the missing graph node target', async () => {
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), 'See src/index.ts\n', 'utf-8');
    fs.mkdirSync(path.join(tmpDir, '.cotx', 'graph'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.cotx', 'graph', 'nodes.json'), JSON.stringify([{
      properties: { filePath: 'src/index.ts' },
    }]), 'utf-8');
    appendTruthCorrectionProposal(tmpDir, 'module', {
      kind: 'missing-node',
      title: 'Missing fixtures directory',
      proposed_fact: 'tests/fixtures should be in graph',
      evidence_file_paths: ['CLAUDE.md'],
      confidence: 'high',
    }, {
      createdAt: '2026-04-13T01:02:00.000Z',
    });

    const validation = await validateTruthCorrectionRecords(tmpDir);

    expect(validation.ok).toBe(true);
    expect(validation.findings.some((finding) => finding.code === 'MISSING_NODE_ALREADY_EXISTS')).toBe(false);
  });

  it('reclassifies directory missing-node evidence when the underlying source files already exist in the graph', async () => {
    fs.mkdirSync(path.join(tmpDir, 'src', 'agent'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'agent', 'index.ts'), 'export const agent = true;\n', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'src', 'agent', 'helper.ts'), 'export const helper = true;\n', 'utf-8');
    await writeStorageV2(tmpDir, {
      projectRoot: tmpDir,
      nodes: [
        {
          id: 'fn:index',
          label: 'Function',
          properties: {
            name: 'agent',
            filePath: 'src/agent/index.ts',
            startLine: 1,
            endLine: 1,
            isExported: true,
          },
        } as any,
        {
          id: 'fn:helper',
          label: 'Function',
          properties: {
            name: 'helper',
            filePath: 'src/agent/helper.ts',
            startLine: 1,
            endLine: 1,
            isExported: true,
          },
        } as any,
      ],
      edges: [],
      communities: [],
      processes: [],
      modules: [],
      concepts: [],
      contracts: [],
      flows: [],
      concerns: [],
      concernFamilies: [],
      canonicalPaths: [],
      symmetryEdges: [],
      closureSets: [],
      abstractionOpportunities: [],
      decisionOverrides: [],
    } as any);
    const proposal = normalizeTruthCorrectionProposal(tmpDir, {
      kind: 'missing-node',
      title: 'Missing agent directory',
      proposed_fact: 'src/agent should be included in the graph',
      evidence_file_paths: ['src/agent'],
      confidence: 'high',
    });

    const findings = await validateTruthCorrectionProposalCandidate(tmpDir, 'module', proposal, {
      graphFileIndexStatus: 'complete',
      truthGraphPresent: true,
    });

    expect(findings).toContainEqual(expect.objectContaining({
      code: 'MISSING_NODE_DIRECTORY_EVIDENCE',
      level: 'error',
      evidence: 'src/agent',
      message: expect.stringContaining('architecture-grouping-gap'),
    }));
    expect(findings[0]?.message).toContain('already exist in the graph');
  });

  it('retains incomplete graph sidecar warnings when graph-backed validation cannot yet disprove the proposal', async () => {
    await writeStorageV2(tmpDir, {
      projectRoot: tmpDir,
      nodes: [{
        id: 'fn:index',
        label: 'Function',
        properties: {
          name: 'entry',
          filePath: 'src/index.ts',
          startLine: 1,
          endLine: 1,
          isExported: true,
        },
      } as any],
      edges: [],
      communities: [],
      processes: [],
      modules: [],
      concepts: [],
      contracts: [],
      flows: [],
      concerns: [],
      concernFamilies: [],
      canonicalPaths: [],
      symmetryEdges: [],
      closureSets: [],
      abstractionOpportunities: [],
      decisionOverrides: [],
    } as any);
    const proposal = normalizeTruthCorrectionProposal(tmpDir, {
      kind: 'wrong-relation',
      title: 'Wrong relation between entry and helper',
      proposed_fact: 'fn:index should not be modeled as fn:helper',
      evidence_file_paths: ['src/index.ts'],
      confidence: 'high',
    });

    const findings = await validateTruthCorrectionProposalCandidate(tmpDir, 'module', proposal, {
      graphFileIndexStatus: 'partial',
      truthGraphPresent: true,
    });

    expect(findings).toContainEqual(expect.objectContaining({
      code: 'GRAPH_FILE_INDEX_INCOMPLETE',
      level: 'warning',
    }));
    expect(findings.some((finding) => finding.code === 'MISSING_NODE_ALREADY_EXISTS')).toBe(false);
    expect(findings.some((finding) => finding.code === 'VALIDATION_LIMITATION')).toBe(true);
  });

  it('reclassifies asset-only directories away from missing-node proposals', async () => {
    fs.mkdirSync(path.join(tmpDir, 'assets', 'icons'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'assets', 'icons', 'logo.png'), 'not-a-real-png', 'utf-8');
    await writeStorageV2(tmpDir, {
      projectRoot: tmpDir,
      nodes: [{
        id: 'fn:index',
        label: 'Function',
        properties: {
          name: 'entry',
          filePath: 'src/index.ts',
          startLine: 1,
          endLine: 1,
          isExported: true,
        },
      } as any],
      edges: [],
      communities: [],
      processes: [],
      modules: [],
      concepts: [],
      contracts: [],
      flows: [],
      concerns: [],
      concernFamilies: [],
      canonicalPaths: [],
      symmetryEdges: [],
      closureSets: [],
      abstractionOpportunities: [],
      decisionOverrides: [],
    } as any);
    const proposal = normalizeTruthCorrectionProposal(tmpDir, {
      kind: 'missing-node',
      title: 'Missing icon directory',
      proposed_fact: 'assets/icons should be included in the graph',
      evidence_file_paths: ['assets/icons'],
      confidence: 'high',
    });

    const findings = await validateTruthCorrectionProposalCandidate(tmpDir, 'module', proposal, {
      graphFileIndexStatus: 'complete',
      truthGraphPresent: true,
    });

    expect(findings).toContainEqual(expect.objectContaining({
      code: 'MISSING_NODE_DIRECTORY_EVIDENCE',
      level: 'error',
      evidence: 'assets/icons',
      message: expect.stringContaining('no graph-indexable source files'),
    }));
  });

  it('reports recorded graph-gap proposals as invalid when the graph file index is incomplete', async () => {
    appendTruthCorrectionProposal(tmpDir, 'module', {
      kind: 'missing-node',
      title: 'Missing index node',
      proposed_fact: 'src/index.ts should be in graph',
      evidence_file_paths: ['src/index.ts'],
      confidence: 'high',
    }, {
      createdAt: '2026-04-13T01:02:00.000Z',
    });

    const validation = await validateTruthCorrectionRecords(tmpDir);

    expect(validation.ok).toBe(false);
    expect(validation.findings).toContainEqual(expect.objectContaining({
      code: 'GRAPH_FILE_INDEX_INCOMPLETE',
      level: 'error',
    }));
  });

  it('drops recorded graph-gap sidecar warnings once storage-v2 truth already disproves the proposal', async () => {
    fs.writeFileSync(path.join(tmpDir, 'src', 'missing.ts'), 'export const missing = true;\n', 'utf-8');
    await writeStorageV2(tmpDir, {
      projectRoot: tmpDir,
      nodes: [{
        id: 'fn:index',
        label: 'Function',
        properties: {
          name: 'entry',
          filePath: 'src/index.ts',
          startLine: 1,
          endLine: 1,
          isExported: true,
        },
      } as any],
      edges: [],
      communities: [],
      processes: [],
      modules: [],
      concepts: [],
      contracts: [],
      flows: [],
      concerns: [],
      concernFamilies: [],
      canonicalPaths: [],
      symmetryEdges: [],
      closureSets: [],
      abstractionOpportunities: [],
      decisionOverrides: [],
    } as any);
    appendTruthCorrectionProposal(tmpDir, 'module', {
      kind: 'missing-node',
      title: 'Missing missing.ts node',
      proposed_fact: 'src/missing.ts should be in graph',
      evidence_file_paths: ['src/missing.ts'],
      confidence: 'high',
    }, {
      createdAt: '2026-04-13T01:02:00.000Z',
    });

    const validation = await validateTruthCorrectionRecords(tmpDir);

    expect(validation.ok).toBe(false);
    expect(validation.records[0]?.ok).toBe(false);
    expect(validation.findings).toContainEqual(expect.objectContaining({
      code: 'MISSING_NODE_ALREADY_EXISTS',
      level: 'error',
      evidence: 'src/missing.ts',
    }));
    expect(validation.findings.some((finding) => finding.code === 'GRAPH_FILE_INDEX_INCOMPLETE')).toBe(false);
  });
});
