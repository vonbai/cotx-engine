import { describe, it, expect } from 'vitest';
import { BM25Index } from '../../src/query/bm25.js';

describe('BM25Index', () => {
  it('ranks exact match highest', () => {
    const docs = [
      { id: 'a', text: 'inbox message queue' },
      { id: 'b', text: 'user authentication login' },
      { id: 'c', text: 'inbox delivery transport' },
    ];
    const index = new BM25Index(docs);
    const results = index.search('inbox');
    expect(results[0].id).toBe('a'); // or 'c', both contain inbox
    expect(results.length).toBe(2); // only a and c match
  });

  it('supports multi-term queries', () => {
    const docs = [
      { id: 'a', text: 'inbox message queue delivery' },
      { id: 'b', text: 'inbox only' },
      { id: 'c', text: 'message delivery system' },
    ];
    const index = new BM25Index(docs);
    const results = index.search('inbox delivery');
    expect(results[0].id).toBe('a'); // matches both terms
  });

  it('returns empty for no matches', () => {
    const docs = [{ id: 'a', text: 'hello world' }];
    const index = new BM25Index(docs);
    expect(index.search('xyz')).toHaveLength(0);
  });

  it('handles empty query', () => {
    const docs = [{ id: 'a', text: 'hello world' }];
    const index = new BM25Index(docs);
    expect(index.search('')).toHaveLength(0);
  });

  it('is case insensitive', () => {
    const docs = [{ id: 'a', text: 'Inbox Message' }];
    const index = new BM25Index(docs);
    expect(index.search('inbox')).toHaveLength(1);
  });

  it('respects limit parameter', () => {
    const docs = Array.from({ length: 50 }, (_, i) => ({ id: `d${i}`, text: `term ${i}` }));
    const index = new BM25Index(docs);
    const results = index.search('term', 5);
    expect(results).toHaveLength(5);
  });
});
