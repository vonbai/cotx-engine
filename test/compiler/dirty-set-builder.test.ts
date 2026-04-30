import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  IncrementalCache,
  buildEngineVersion,
} from '../../src/compiler/incremental-cache.js';
import {
  buildDirtySet,
  summarizeDirtySet,
} from '../../src/compiler/dirty-set-builder.js';

describe('buildDirtySet', () => {
  let tmpDir: string;
  let cache: IncrementalCache;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-ds-'));
    cache = new IncrementalCache(tmpDir, buildEngineVersion('0.1.0', 'lang'));
  });

  afterEach(() => {
    cache.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns an empty set when nothing is changed', () => {
    const set = buildDirtySet({
      changedFiles: [],
      presentFiles: ['a.ts', 'b.ts'],
      cache,
    });
    expect(set.files.size).toBe(0);
    expect(set.symbols.size).toBe(0);
    expect(set.modules.size).toBe(0);
  });

  it('marks each changed file and its exports as dirty', () => {
    cache.setExports('a.ts', ['foo', 'bar']);
    cache.setExports('b.ts', ['baz']);
    const set = buildDirtySet({
      changedFiles: ['a.ts'],
      presentFiles: ['a.ts', 'b.ts'],
      cache,
    });
    expect(set.files.has('a.ts')).toBe(true);
    expect(set.files.has('b.ts')).toBe(false);
    expect(set.symbols.has('a.ts::foo')).toBe(true);
    expect(set.symbols.has('a.ts::bar')).toBe(true);
    expect(set.symbols.has('b.ts::baz')).toBe(false);
  });

  it('propagates dirty to modules via moduleFiles map', () => {
    const moduleFiles = new Map<string, string[]>([
      ['cmd', ['cmd/main.ts', 'cmd/helper.ts']],
      ['lib', ['lib/core.ts']],
      ['test', ['test/t1.ts']],
    ]);
    const set = buildDirtySet({
      changedFiles: ['cmd/main.ts', 'lib/core.ts'],
      presentFiles: [...moduleFiles.values()].flat(),
      cache,
      moduleFiles,
    });
    expect(set.modules.has('cmd')).toBe(true);
    expect(set.modules.has('lib')).toBe(true);
    expect(set.modules.has('test')).toBe(false);
  });

  it('treats added files (not in cache) as dirty', () => {
    const set = buildDirtySet({
      changedFiles: ['new.ts'],
      presentFiles: ['new.ts'],
      cache,
    });
    expect(set.files.has('new.ts')).toBe(true);
  });

  it('summarizeDirtySet reports counts for all buckets', () => {
    cache.setExports('a.ts', ['x']);
    const moduleFiles = new Map([['m', ['a.ts']]]);
    const set = buildDirtySet({
      changedFiles: ['a.ts'],
      presentFiles: ['a.ts'],
      cache,
      moduleFiles,
    });
    const summary = summarizeDirtySet(set);
    expect(summary.files).toBe(1);
    expect(summary.symbols).toBe(1);
    expect(summary.modules).toBe(1);
    expect(summary.callSiteFiles).toBe(1);
  });
});
