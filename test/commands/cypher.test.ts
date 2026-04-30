import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandCompile } from '../../src/commands/compile.js';
import { commandCypher } from '../../src/commands/cypher.js';

describe('commandCypher', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-cypher-test-'));
    fs.writeFileSync(
      path.join(tmpDir, 'main.ts'),
      [
        'export function run() {',
        '  return helper();',
        '}',
        'export function helper() {',
        '  return 1;',
        '}',
        '',
      ].join('\n'),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('queries the storage-v2 truth graph after compile', async () => {
    await commandCompile(tmpDir, { silent: true });

    const result = await commandCypher(
      tmpDir,
      'MATCH (s:CodeNode) RETURN s.id AS id ORDER BY id',
    );

    expect(result.row_count).toBeGreaterThan(0);
    expect(result.rows.some((row) => String(row.id).includes('run'))).toBe(true);
    expect(result.markdown).toContain('| id |');
  });

  it('rejects write queries', async () => {
    await commandCompile(tmpDir, { silent: true });
    await expect(commandCypher(tmpDir, "CREATE (:CodeNode {id:'x'})")).rejects.toThrow('Write operations are not allowed');
  });

  it('allows read queries whose string literals contain write keywords', async () => {
    await commandCompile(tmpDir, { silent: true });

    const result = await commandCypher(
      tmpDir,
      "MATCH (s:CodeNode) WHERE s.name = 'load' OR s.name = 'import' RETURN count(s) AS n",
    );

    expect(result.rows[0].n).toBe(0);
  });

  it('preserves calls from Go methods with arity-suffixed method ids', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'transport.go'),
      [
        'package main',
        'type Request struct{}',
        'type Transport struct{}',
        'func helper() {}',
        'func (t *Transport) RoundTrip(req Request) {',
        '  helper()',
        '}',
        '',
      ].join('\n'),
    );
    await commandCompile(tmpDir, { silent: true });

    const result = await commandCypher(
      tmpDir,
      "MATCH (m:Method {filePath:'transport.go', name:'RoundTrip'})-[r:CodeRelation {type:'CALLS'}]->(f:Function {filePath:'transport.go', name:'helper'}) RETURN m.id AS sourceId, f.id AS targetId",
    );

    expect(result.rows).toEqual([
      {
        sourceId: 'Method:transport.go:Transport.RoundTrip#1',
        targetId: 'Function:transport.go:helper',
      },
    ]);
  });
});
