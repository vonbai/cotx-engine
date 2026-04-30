import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  IncrementalCache,
  hashContent,
  buildEngineVersion,
} from '../../src/compiler/incremental-cache.js';

describe('IncrementalCache', () => {
  let tmpDir: string;
  let cache: IncrementalCache;
  const engineVersion = buildEngineVersion('0.1.0', 'test-lang-hash');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-ic-'));
    cache = new IncrementalCache(tmpDir, engineVersion);
  });

  afterEach(() => {
    cache.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists and retrieves file-level entries by content hash', () => {
    const payload = JSON.stringify({ nodes: [], edges: [] });
    const contentHash = hashContent('console.log("hello")');
    cache.putFile({
      path: 'src/index.ts',
      content_hash: contentHash,
      mtime_ms: 100,
      parse_payload: payload,
    });
    const hit = cache.getFileByHash('src/index.ts', contentHash);
    expect(hit).not.toBeNull();
    expect(hit?.parse_payload).toBe(payload);
    expect(cache.getStats().hits).toBe(1);
  });

  it('returns null (miss) when content_hash differs', () => {
    cache.putFile({
      path: 'src/a.ts',
      content_hash: 'abc',
      mtime_ms: 1,
      parse_payload: '{}',
    });
    expect(cache.getFileByHash('src/a.ts', 'different')).toBeNull();
    expect(cache.getStats().misses).toBe(1);
  });

  it('looks up by content hash alone across rename', () => {
    const hash = hashContent('same content');
    cache.putFile({ path: 'old.ts', content_hash: hash, mtime_ms: 1, parse_payload: 'payload' });
    const byHash = cache.getAnyByHash(hash);
    expect(byHash).not.toBeNull();
    expect(byHash?.path).toBe('old.ts');
  });

  it('cascades cache deletion across companion tables', () => {
    cache.putFile({ path: 'f.ts', content_hash: 'h', mtime_ms: 1, parse_payload: '{}' });
    cache.setExports('f.ts', ['foo', 'bar']);
    cache.setRoutesForFile('f.ts', [{ url: '/x', handler_id: 'h1' }]);
    cache.setFetchCallsForFile('f.ts', [{ url: '/y', confidence: 0.9 }]);

    cache.deleteFile('f.ts');
    expect(cache.getFileByHash('f.ts', 'h')).toBeNull();
    expect(cache.getExports('f.ts')).toEqual([]);
    expect(cache.getAllRoutes().filter((r) => r.file_path === 'f.ts')).toEqual([]);
    expect(cache.getAllFetchCalls().filter((c) => c.file_path === 'f.ts')).toEqual([]);
  });

  it('wipes on engine_version mismatch', () => {
    cache.putFile({ path: 'a.ts', content_hash: 'aaa', mtime_ms: 1, parse_payload: '{}' });
    cache.close();

    // Reopen with different engine version.
    const otherCache = new IncrementalCache(tmpDir, buildEngineVersion('0.2.0', 'test-lang-hash'));
    expect(otherCache.getFileByHash('a.ts', 'aaa')).toBeNull();
    expect(otherCache.countFiles()).toBe(0);
    expect(otherCache.getStats().wiped).toBe(true);
    otherCache.close();
  });

  it('reuses existing cache when engine_version matches', () => {
    cache.putFile({ path: 'a.ts', content_hash: 'aaa', mtime_ms: 1, parse_payload: 'PAYLOAD' });
    cache.close();

    const sameCache = new IncrementalCache(tmpDir, engineVersion);
    const entry = sameCache.getFileByHash('a.ts', 'aaa');
    expect(entry?.parse_payload).toBe('PAYLOAD');
    expect(sameCache.getStats().wiped).toBe(false);
    sameCache.close();
  });

  it('prunes files no longer on disk', () => {
    cache.putFile({ path: 'a.ts', content_hash: 'a', mtime_ms: 1, parse_payload: '{}' });
    cache.putFile({ path: 'b.ts', content_hash: 'b', mtime_ms: 1, parse_payload: '{}' });
    cache.putFile({ path: 'c.ts', content_hash: 'c', mtime_ms: 1, parse_payload: '{}' });
    const removed = cache.pruneMissingFiles(new Set(['a.ts', 'c.ts']));
    expect(removed).toBe(1);
    expect(cache.countFiles()).toBe(2);
    expect(cache.getFileByHash('b.ts', 'b')).toBeNull();
  });

  it('round-trips exports map', () => {
    cache.setExports('m.ts', ['alpha', 'beta', 'gamma']);
    expect(new Set(cache.getExports('m.ts'))).toEqual(new Set(['alpha', 'beta', 'gamma']));
    cache.setExports('m.ts', ['alpha']); // replace
    expect(cache.getExports('m.ts')).toEqual(['alpha']);
  });

  it('replaces implementor map atomically', () => {
    cache.replaceImplementors([
      { interface_id: 'Iface', class_id: 'A' },
      { interface_id: 'Iface', class_id: 'B' },
    ]);
    expect(cache.getAllImplementors()).toHaveLength(2);
    cache.replaceImplementors([{ interface_id: 'Other', class_id: 'C' }]);
    const all = cache.getAllImplementors();
    expect(all).toHaveLength(1);
    expect(all[0].interface_id).toBe('Other');
  });
});
