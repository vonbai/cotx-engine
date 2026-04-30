import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendTruthCorrectionProposal } from '../../src/compiler/truth-correction-proposals.js';
import { commandTruthCorrections } from '../../src/commands/truth-corrections.js';

describe('commandTruthCorrections', () => {
  let tmpDir: string;
  let logs: string[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-truth-corrections-command-'));
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((message?: unknown) => {
      logs.push(String(message ?? ''));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('prints a readable truth correction proposal summary', async () => {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'export const x = true;\n', 'utf-8');
    appendTruthCorrectionProposal(tmpDir, 'architecture', {
      kind: 'architecture-description-gap',
      title: 'Improve generic description',
      current_fact: 'owns code',
      proposed_fact: 'describe runtime role',
      evidence_file_paths: ['src/index.ts'],
      suggested_test: 'add deterministic description fixture',
      confidence: 'high',
    }, { createdAt: '2026-04-13T01:02:00.000Z' });

    await commandTruthCorrections(tmpDir);

    const output = logs.join('\n');
    expect(output).toContain('# Truth Correction Proposals');
    expect(output).toContain('Total: 1');
    expect(output).toContain('architecture/architecture-description-gap: Improve generic description');
    expect(output).toContain('add deterministic description fixture');
  });

  it('prints JSON when requested', async () => {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'export const x = true;\n', 'utf-8');
    appendTruthCorrectionProposal(tmpDir, 'module', {
      kind: 'compiler-gap',
      title: 'Module grouping',
      proposed_fact: 'group package root',
      evidence_file_paths: ['src/index.ts'],
      confidence: 'medium',
    }, { createdAt: '2026-04-13T01:02:00.000Z' });

    await commandTruthCorrections(tmpDir, { json: true });

    const parsed = JSON.parse(logs.join('\n')) as { total: number; records: Array<{ title: string }> };
    expect(parsed.total).toBe(1);
    expect(parsed.records[0].title).toBe('Module grouping');
  });

  it('prints a regression plan when requested', async () => {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'export const x = true;\n', 'utf-8');
    appendTruthCorrectionProposal(tmpDir, 'architecture', {
      kind: 'architecture-description-gap',
      title: 'Generic description',
      proposed_fact: 'use metadata',
      evidence_file_paths: ['src/index.ts'],
      confidence: 'high',
    }, { createdAt: '2026-04-13T01:02:00.000Z' });

    await commandTruthCorrections(tmpDir, { plan: true });

    const output = logs.join('\n');
    expect(output).toContain('# Truth Correction Regression Plan');
    expect(output).toContain('Implementation targets');
    expect(output).toContain('src/compiler/architecture-compiler.ts');
  });

  it('updates proposal lifecycle status from the CLI command', async () => {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'export const x = true;\n', 'utf-8');
    const record = appendTruthCorrectionProposal(tmpDir, 'architecture', {
      kind: 'architecture-description-gap',
      title: 'Generic description',
      proposed_fact: 'use metadata',
      evidence_file_paths: ['src/index.ts'],
      confidence: 'high',
    }, { createdAt: '2026-04-13T01:02:00.000Z' });

    await commandTruthCorrections(tmpDir, {
      setStatus: record.id,
      status: 'accepted',
      reason: 'reviewed',
    });

    const output = logs.join('\n');
    expect(output).toContain(`Updated ${record.id} → accepted`);
  });

  it('prints validation JSON when requested', async () => {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'export const x = true;\n', 'utf-8');
    appendTruthCorrectionProposal(tmpDir, 'architecture', {
      kind: 'architecture-description-gap',
      title: 'Generic description',
      proposed_fact: 'use metadata',
      evidence_file_paths: ['src/index.ts'],
      confidence: 'high',
    }, { createdAt: '2026-04-13T01:02:00.000Z' });

    await commandTruthCorrections(tmpDir, { validate: true });

    const parsed = JSON.parse(logs.join('\n')) as { schema_version: string; ok: boolean };
    expect(parsed.schema_version).toBe('cotx.truth_correction_validation.v1');
    expect(parsed.ok).toBe(true);
  });
});
