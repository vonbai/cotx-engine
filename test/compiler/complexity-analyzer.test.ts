import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { analyzeComplexity } from '../../src/compiler/complexity-analyzer.js';
import type { GraphNode } from '../../src/core/export/json-exporter.js';
import type { ModuleNode } from '../../src/store/schema.js';

describe('analyzeComplexity', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-complexity-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('computes cyclomatic complexity for a simple function', async () => {
    // Create a TypeScript file with known complexity
    const code = `
export function simple(x: number): string {
  if (x > 0) {
    return 'positive';
  } else if (x < 0) {
    return 'negative';
  }
  return 'zero';
}
`;
    fs.writeFileSync(path.join(tmpDir, 'simple.ts'), code);

    const nodes: GraphNode[] = [
      {
        id: 'fn-simple',
        label: 'Function',
        properties: {
          name: 'simple',
          filePath: 'simple.ts',
          startLine: 2,
          endLine: 9,
          isExported: true,
        },
      },
    ];

    const modules: ModuleNode[] = [
      {
        id: 'test-mod',
        canonical_entry: 'simple',
        files: ['simple.ts'],
        depends_on: [],
        depended_by: [],
        struct_hash: 'h1',
      },
    ];

    await analyzeComplexity(tmpDir, nodes, modules);

    expect(modules[0].complexity).toBeDefined();
    expect(modules[0].complexity!.total_functions).toBe(1);
    // 2 if branches → cyclomatic = 3 (2 + 1 base)
    expect(modules[0].complexity!.max_cyclomatic).toBe(3);
    // else-if is nested in tree-sitter AST (if_statement inside else_clause) → depth 2
    expect(modules[0].complexity!.max_nesting_depth).toBe(2);
  });

  it('computes nesting depth for nested control flow', async () => {
    const code = `
export function nested(items: number[]): number {
  let count = 0;
  for (const item of items) {
    if (item > 0) {
      if (item > 10) {
        count++;
      }
    }
  }
  return count;
}
`;
    fs.writeFileSync(path.join(tmpDir, 'nested.ts'), code);

    const nodes: GraphNode[] = [
      {
        id: 'fn-nested',
        label: 'Function',
        properties: {
          name: 'nested',
          filePath: 'nested.ts',
          startLine: 2,
          endLine: 12,
          isExported: true,
        },
      },
    ];

    const modules: ModuleNode[] = [
      {
        id: 'test-mod',
        canonical_entry: 'nested',
        files: ['nested.ts'],
        depends_on: [],
        depended_by: [],
        struct_hash: 'h1',
      },
    ];

    await analyzeComplexity(tmpDir, nodes, modules);

    expect(modules[0].complexity).toBeDefined();
    // for → if → if = nesting depth 3
    expect(modules[0].complexity!.max_nesting_depth).toBe(3);
  });

  it('identifies hotspot functions', async () => {
    const code = `
export function easyFn(): void {}

export function hardFn(x: number): void {
  if (x > 0) {
    for (let i = 0; i < x; i++) {
      if (i % 2 === 0) {
        while (true) { break; }
      }
    }
  }
}
`;
    fs.writeFileSync(path.join(tmpDir, 'hotspot.ts'), code);

    const nodes: GraphNode[] = [
      {
        id: 'fn-easy',
        label: 'Function',
        properties: { name: 'easyFn', filePath: 'hotspot.ts', startLine: 2, endLine: 2, isExported: true },
      },
      {
        id: 'fn-hard',
        label: 'Function',
        properties: { name: 'hardFn', filePath: 'hotspot.ts', startLine: 4, endLine: 13, isExported: true },
      },
    ];

    const modules: ModuleNode[] = [
      {
        id: 'test-mod',
        canonical_entry: 'hardFn',
        files: ['hotspot.ts'],
        depends_on: [],
        depended_by: [],
        struct_hash: 'h1',
      },
    ];

    await analyzeComplexity(tmpDir, nodes, modules);

    expect(modules[0].complexity!.hotspot_functions[0]).toBe('hardFn');
  });

  it('matches Python methods when graph start lines point at decorators or zero-based rows', async () => {
    const code = [
      'class Client:',
      '    @property',
      '    def session(self):',
      '        if self.connected:',
      '            return self.connected',
      '        return None',
      '',
      '    async def initialize(self):',
      '        for item in self.items:',
      '            if item.ready:',
      '                return item',
      '        return None',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, 'client.py'), code);

    const nodes: GraphNode[] = [
      {
        id: 'fn-session',
        label: 'Function',
        properties: {
          name: 'session',
          filePath: 'client.py',
          startLine: 2,
          endLine: 5,
          isExported: true,
        },
      },
      {
        id: 'fn-initialize',
        label: 'Function',
        properties: {
          name: 'initialize',
          filePath: 'client.py',
          startLine: 7,
          endLine: 11,
          isExported: true,
        },
      },
    ];

    const modules: ModuleNode[] = [
      {
        id: 'client',
        canonical_entry: 'client',
        files: ['client.py'],
        depends_on: [],
        depended_by: [],
        struct_hash: 'h1',
      },
    ];

    await analyzeComplexity(tmpDir, nodes, modules);

    expect(modules[0].complexity).toBeDefined();
    expect(modules[0].complexity!.total_functions).toBe(2);
    expect(modules[0].complexity!.max_cyclomatic).toBeGreaterThan(1);
    expect(modules[0].complexity!.max_nesting_depth).toBeGreaterThan(0);
  });

  it('switches parser language when mixed-language files are analyzed out of order', async () => {
    fs.writeFileSync(path.join(tmpDir, 'first.py'), [
      'def first(value):',
      '    if value:',
      '        return value',
      '    return None',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(tmpDir, 'middle.ts'), [
      'export function middle(value: number) {',
      '  if (value > 0) return value;',
      '  return 0;',
      '}',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(tmpDir, 'second.py'), [
      'def second(items):',
      '    for item in items:',
      '        if item:',
      '            return item',
      '    return None',
      '',
    ].join('\n'));

    const nodes: GraphNode[] = [
      { id: 'fn-first', label: 'Function', properties: { name: 'first', filePath: 'first.py', startLine: 1, endLine: 4, isExported: true } },
      { id: 'fn-middle', label: 'Function', properties: { name: 'middle', filePath: 'middle.ts', startLine: 1, endLine: 4, isExported: true } },
      { id: 'fn-second', label: 'Function', properties: { name: 'second', filePath: 'second.py', startLine: 1, endLine: 5, isExported: true } },
    ];
    const modules: ModuleNode[] = [
      { id: 'mixed', canonical_entry: 'mixed', files: ['first.py', 'middle.ts', 'second.py'], depends_on: [], depended_by: [], struct_hash: 'h1' },
    ];

    await analyzeComplexity(tmpDir, nodes, modules);

    expect(modules[0].complexity?.total_functions).toBe(3);
    expect(modules[0].complexity?.hotspot_functions).toContain('second');
  });

  it('gracefully handles modules with no functions', async () => {
    const modules: ModuleNode[] = [
      {
        id: 'empty-mod',
        canonical_entry: '',
        files: [],
        depends_on: [],
        depended_by: [],
        struct_hash: 'h1',
      },
    ];

    await analyzeComplexity(tmpDir, [], modules);

    expect(modules[0].complexity).toBeUndefined();
  });
});
