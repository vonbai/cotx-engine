import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CotxStore } from '../../src/store/store.js';
import { ArchitectureStore } from '../../src/store/architecture-store.js';
import { compileDoctrine } from '../../src/compiler/doctrine-compiler.js';

describe('compileDoctrine', () => {
  let tmpDir: string;
  let store: CotxStore;
  let archStore: ArchitectureStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-doctrine-compiler-'));
    store = new CotxStore(tmpDir);
    store.init('doctrine-compiler-test');
    archStore = new ArchitectureStore(tmpDir);
    archStore.init({
      perspectives: ['overall-architecture'],
      generated_at: '2026-04-11T00:00:00Z',
      mode: 'auto',
      struct_hash: 'arch123',
    });
    archStore.writePerspective({
      id: 'overall-architecture',
      label: 'Overall Architecture',
      components: [
        {
          id: 'api',
          label: 'Api',
          kind: 'leaf',
          directory: 'src/api',
          files: ['src/api/main.ts'],
          exported_functions: ['runApi'],
          stats: {
            file_count: 1,
            function_count: 2,
            total_cyclomatic: 3,
            max_cyclomatic: 2,
            max_nesting_depth: 1,
            risk_score: 8,
          },
        },
      ],
      edges: [],
    });
    archStore.writeDescription('overall-architecture', 'Architecture overview.');
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# doctrine test\nThis repo manages APIs.\n');

    store.writeModule({
      id: 'api',
      canonical_entry: 'runApi',
      files: ['src/api/main.ts'],
      depends_on: ['db'],
      depended_by: [],
      struct_hash: 'mod1',
      annotations: [
        {
          author: 'human',
          type: 'constraint',
          content: 'API should not bypass contracts',
          date: '2026-04-11',
        },
      ],
    });
    store.writeModule({
      id: 'db',
      canonical_entry: 'query',
      files: ['src/db/query.ts'],
      depends_on: [],
      depended_by: ['api'],
      struct_hash: 'mod2',
    });
    store.writeContract({
      id: 'api-db',
      provider: 'db',
      consumer: 'api',
      interface: ['query'],
      struct_hash: 'contract1',
    });
    store.writeFlow({
      id: 'proc_run_api',
      type: 'flow',
      trigger: 'runApi',
      steps: [
        { module: 'api', function: 'runApi' },
        { module: 'db', function: 'query' },
      ],
      struct_hash: 'flow1',
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('compiles deterministic doctrine statements from modules, contracts, flows, architecture, and docs', () => {
    const doctrine = compileDoctrine(tmpDir, store);
    const titles = doctrine.statements.map((s) => s.title);

    expect(titles).toContain('Respect existing module boundaries');
    expect(titles).toContain('Change complete cross-module flows');
    expect(titles).toContain('Preserve current architecture shape');
    expect(titles).toContain('Existing explicit project constraint');
    expect(titles).toContain('Read project docs before changing boundaries');
  });
});
