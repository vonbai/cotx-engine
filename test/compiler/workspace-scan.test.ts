import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanWorkspaceLayout } from '../../src/compiler/workspace-scan.js';

describe('scanWorkspaceLayout', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-workspace-scan-'));
    fs.mkdirSync(path.join(tmpDir, 'docs', 'architecture'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'packages', 'core'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'pkg', 'octicons', 'icons'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'example', 'reference'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'external', 'tooling', '.git'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.cotx', 'architecture', 'overall-architecture'), { recursive: true });

    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Project\n', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# Agents\n', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"root"}\n', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'docs', 'architecture', 'overview.md'), '# Architecture\n', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'packages', 'core', 'package.json'), '{"name":"core"}\n', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'pkg', 'octicons', 'icons', 'repo-dark.png'), 'png', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'example', 'reference', 'README.md'), '# Reference\n', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'external', 'tooling', 'README.md'), '# Tooling\n', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, '.cotx', 'meta.yaml'), 'project: scan\n', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, '.cotx', 'architecture', 'meta.yaml'), 'perspectives:\n  - overall-architecture\n', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, '.cotx', 'architecture', 'overall-architecture', 'description.md'), '# Arch\n', 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('scans structure into repo/package boundaries and candidate inputs without reading generated .cotx artifacts', () => {
    const scan = scanWorkspaceLayout(tmpDir, { generatedAt: '2026-04-13T00:00:00.000Z' });
    const candidates = new Map(scan.candidates.map((candidate) => [candidate.path, candidate]));

    expect(scan.generated_at).toBe('2026-04-13T00:00:00.000Z');
    expect(scan.directories.some((entry) => entry.path === '.' && entry.kind === 'repo-root')).toBe(true);
    expect(scan.directories.some((entry) => entry.path === 'external/tooling' && entry.kind === 'nested-repo')).toBe(true);
    expect(scan.directories.some((entry) => entry.path === 'packages/core' && entry.kind === 'package')).toBe(true);
    expect(scan.directories.some((entry) => entry.path === 'pkg/octicons/icons' && entry.kind === 'asset')).toBe(true);
    expect(scan.directories.some((entry) => entry.path === '.cotx/architecture' && entry.kind === 'architecture-store')).toBe(true);
    expect(candidates.get('README.md')?.kind).toBe('readme');
    expect(candidates.get('AGENTS.md')?.kind).toBe('agent-instructions');
    expect(candidates.get('docs/architecture/overview.md')?.kind).toBe('architecture-doc');
    expect(candidates.get('packages/core/package.json')?.kind).toBe('manifest');
    expect(candidates.get('example/reference/README.md')?.kind).toBe('example');
    expect(candidates.has('.cotx/meta.yaml')).toBe(false);
    expect(candidates.has('.cotx/architecture/overall-architecture/description.md')).toBe(false);
    expect(scan.summary.repo_boundaries).toBe(2);
    expect(scan.summary.packages).toBeGreaterThanOrEqual(2);
    expect(scan.summary.asset_dirs).toBeGreaterThanOrEqual(1);
    expect(scan.summary.cotx_present).toBe(true);
  });

  it('prioritizes root docs and manifests ahead of example material when candidate budget is tight', () => {
    for (let i = 0; i < 20; i += 1) {
      const dir = path.join(tmpDir, 'example', 'reference', `case-${i}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'README.md'), `# Example ${i}\n`, 'utf-8');
    }

    const scan = scanWorkspaceLayout(tmpDir, { maxCandidates: 4 });
    const paths = scan.candidates.map((candidate) => candidate.path);

    expect(paths).toContain('README.md');
    expect(paths).toContain('AGENTS.md');
    expect(paths).toContain('package.json');
    expect(paths.some((candidatePath) => candidatePath.startsWith('example/'))).toBe(false);
  });
});
