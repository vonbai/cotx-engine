import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GraphTruthStore, writeStorageV2 } from '../../src/store-v2/index.js';

describe('writeStorageV2 source file coverage', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-write-storage-v2-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('supplements missing source File nodes without duplicating existing file coverage', async () => {
    fs.mkdirSync(path.join(tmpDir, 'cmd', 'server'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'cmd', 'github-mcp-server'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'cmd', 'server', 'main.go'), 'package main\nfunc main() {}\n', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'cmd', 'github-mcp-server', 'main.go'), 'package main\nfunc main() {}\n', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'pkg', 'server.go'), 'package pkg\nfunc Run() {}\n', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# not a source file\n', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'github-mcp-server\n', 'utf-8');

    await writeStorageV2(tmpDir, {
      nodes: [
        {
          id: 'File:pkg/server.go',
          label: 'File',
          properties: {
            name: 'server.go',
            filePath: 'pkg/server.go',
          },
        },
      ],
      edges: [],
      processes: [],
      modules: [],
      concepts: [],
      contracts: [],
      flows: [],
      concerns: [],
      decisionOverrides: [],
      concernFamilies: [],
      canonicalPaths: [],
      symmetryEdges: [],
      closureSets: [],
      abstractionOpportunities: [],
    });

    const store = new GraphTruthStore({ dbPath: path.join(tmpDir, '.cotx', 'v2', 'truth.lbug') });
    await store.open();
    try {
      const rows = await store.query(
        "MATCH (n:CodeNode {label:'File'}) WHERE n.filePath = 'cmd/github-mcp-server/main.go' OR n.filePath = 'cmd/server/main.go' OR n.filePath = 'pkg/server.go' OR n.filePath = 'README.md' RETURN n.filePath AS filePath ORDER BY filePath",
      );
      expect(rows.map((row) => row.filePath)).toEqual([
        'cmd/github-mcp-server/main.go',
        'cmd/server/main.go',
        'pkg/server.go',
      ]);

      const duplicates = await store.query(
        "MATCH (n:CodeNode {label:'File'}) WHERE n.filePath = 'pkg/server.go' RETURN count(n) AS n",
      );
      expect(Number(duplicates[0]?.n ?? 0)).toBe(1);
    } finally {
      await store.close();
    }
  });
});
