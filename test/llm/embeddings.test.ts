import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadEmbeddingIndex } from '../../src/llm/embeddings.js';
import type { EmbeddingIndexData } from '../../src/llm/embeddings.js';

// ── Cosine similarity helper (mirrors private implementation) ─────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

// ── cosineSimilarity tests ────────────────────────────────────────────────────

describe('cosineSimilarity', () => {
  it('returns 1.0 for identical vectors', () => {
    const v = [0.1, 0.5, -0.3, 0.8];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 10);
  });

  it('returns 0 for orthogonal vectors', () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 10);
  });

  it('returns -1 for opposite vectors', () => {
    const a = [1, 0, 0];
    const b = [-1, 0, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 10);
  });

  it('returns 0 for zero vector', () => {
    const a = [1, 2, 3];
    const b = [0, 0, 0];
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it('handles multi-dimensional vectors correctly', () => {
    // 45-degree angle → cos(45°) ≈ 0.707
    const a = [1, 0];
    const b = [1, 1];
    expect(cosineSimilarity(a, b)).toBeCloseTo(Math.SQRT1_2, 5);
  });
});

// ── loadEmbeddingIndex tests ──────────────────────────────────────────────────

describe('loadEmbeddingIndex', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-embed-test-'));
    fs.mkdirSync(path.join(tmpDir, '.cotx'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when no index exists', () => {
    const index = loadEmbeddingIndex(tmpDir);
    expect(index).toBeNull();
  });

  it('loads and searches correctly with pre-built index', () => {
    const indexData: EmbeddingIndexData = {
      model: 'test-embed-model',
      built_at: '2026-04-09T00:00:00.000Z',
      entries: [
        { id: 'auth', layer: 'module', vector: [1, 0, 0] },
        { id: 'payment', layer: 'module', vector: [0, 1, 0] },
        { id: 'token', layer: 'concept', vector: [0.9, 0.1, 0] },
        { id: 'auth-payment', layer: 'contract', vector: [0, 0, 1] },
      ],
    };

    fs.writeFileSync(
      path.join(tmpDir, '.cotx', 'embeddings.json'),
      JSON.stringify(indexData),
      'utf-8',
    );

    const index = loadEmbeddingIndex(tmpDir);
    expect(index).not.toBeNull();

    // Query closest to auth (1,0,0)
    const results = index!.search([1, 0, 0], 4);

    // auth should be first (score = 1.0), token second (score ≈ 0.994)
    expect(results[0].id).toBe('auth');
    expect(results[0].layer).toBe('module');
    expect(results[0].score).toBeCloseTo(1.0, 5);

    expect(results[1].id).toBe('token');
    expect(results[1].score).toBeGreaterThan(0.9);
  });

  it('returns results sorted by score descending', () => {
    const indexData: EmbeddingIndexData = {
      model: 'test-embed-model',
      built_at: '2026-04-09T00:00:00.000Z',
      entries: [
        { id: 'a', layer: 'module', vector: [1, 0] },
        { id: 'b', layer: 'concept', vector: [0.5, 0.5] },
        { id: 'c', layer: 'flow', vector: [0, 1] },
        { id: 'd', layer: 'contract', vector: [-1, 0] },
      ],
    };

    fs.writeFileSync(
      path.join(tmpDir, '.cotx', 'embeddings.json'),
      JSON.stringify(indexData),
      'utf-8',
    );

    const index = loadEmbeddingIndex(tmpDir);
    const results = index!.search([1, 0], 4);

    // Verify descending order
    for (let i = 0; i < results.length - 1; i++) {
      expect(results[i].score).toBeGreaterThanOrEqual(results[i + 1].score);
    }

    // a (1,0) is identical to query → score 1.0
    expect(results[0].id).toBe('a');
    expect(results[0].score).toBeCloseTo(1.0, 5);

    // d (-1,0) is opposite → score -1.0
    expect(results[results.length - 1].id).toBe('d');
    expect(results[results.length - 1].score).toBeCloseTo(-1.0, 5);
  });

  it('respects the limit parameter', () => {
    const indexData: EmbeddingIndexData = {
      model: 'test-embed-model',
      built_at: '2026-04-09T00:00:00.000Z',
      entries: [
        { id: 'a', layer: 'module', vector: [1, 0] },
        { id: 'b', layer: 'module', vector: [0.9, 0.1] },
        { id: 'c', layer: 'module', vector: [0.8, 0.2] },
        { id: 'd', layer: 'module', vector: [0.7, 0.3] },
        { id: 'e', layer: 'module', vector: [0.6, 0.4] },
      ],
    };

    fs.writeFileSync(
      path.join(tmpDir, '.cotx', 'embeddings.json'),
      JSON.stringify(indexData),
      'utf-8',
    );

    const index = loadEmbeddingIndex(tmpDir);

    const two = index!.search([1, 0], 2);
    expect(two).toHaveLength(2);

    const all = index!.search([1, 0], 10);
    expect(all).toHaveLength(5);
  });

  it('uses limit=10 by default', () => {
    const entries = Array.from({ length: 15 }, (_, i) => ({
      id: `node-${i}`,
      layer: 'module',
      vector: [Math.cos(i * 0.1), Math.sin(i * 0.1)],
    }));

    const indexData: EmbeddingIndexData = {
      model: 'test-embed-model',
      built_at: '2026-04-09T00:00:00.000Z',
      entries,
    };

    fs.writeFileSync(
      path.join(tmpDir, '.cotx', 'embeddings.json'),
      JSON.stringify(indexData),
      'utf-8',
    );

    const index = loadEmbeddingIndex(tmpDir);
    const results = index!.search([1, 0]);
    expect(results).toHaveLength(10);
  });
});
