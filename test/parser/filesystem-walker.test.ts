import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { walkRepositoryPaths } from '../../src/core/parser/filesystem-walker.js';

describe('walkRepositoryPaths Go cmd roots', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-filesystem-walker-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('keeps Go command source roots when bare .gitignore names match built binaries', async () => {
    fs.mkdirSync(path.join(tmpDir, 'cmd', 'github-mcp-server'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'cmd', 'mcpcurl'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'pkg'), { recursive: true });

    fs.writeFileSync(path.join(tmpDir, 'cmd', 'github-mcp-server', 'main.go'), 'package main\n', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'cmd', 'github-mcp-server', 'serve.go'), 'package main\n', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'cmd', 'github-mcp-server', 'github-mcp-server'), 'binary\n', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'cmd', 'mcpcurl', 'main.go'), 'package main\n', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'pkg', 'server.go'), 'package pkg\n', 'utf-8');
    fs.writeFileSync(
      path.join(tmpDir, '.gitignore'),
      ['github-mcp-server', 'mcpcurl', 'cmd/github-mcp-server/github-mcp-server'].join('\n'),
      'utf-8',
    );

    const scanned = await walkRepositoryPaths(tmpDir);
    const scannedPaths = scanned.map((file) => file.path).sort();

    expect(scannedPaths).toEqual([
      'cmd/github-mcp-server/main.go',
      'cmd/github-mcp-server/serve.go',
      'cmd/mcpcurl/main.go',
      'pkg/server.go',
    ]);
  });
});
