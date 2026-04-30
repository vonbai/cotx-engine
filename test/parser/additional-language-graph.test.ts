import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandCompile } from '../../src/commands/compile.js';
import { commandCypher } from '../../src/commands/cypher.js';

describe('additional language graph extraction', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-additional-language-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('extracts PHP classes, methods, and same-class calls', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'repo.php'),
      [
        '<?php',
        'class Repo {',
        '  public function find($id) { return $this->helper($id); }',
        '  private function helper($id) { return $id; }',
        '}',
        '',
      ].join('\n'),
    );

    await commandCompile(tmpDir, { silent: true });

    await expect(queryCount("MATCH (c:Class {name:'Repo'}) RETURN count(c) AS n")).resolves.toBe(1);
    await expect(queryCount("MATCH (c:Class {name:'Repo'})-[r:CodeRelation {type:'HAS_METHOD'}]->(m:Method {name:'find'}) RETURN count(r) AS n")).resolves.toBe(1);
    await expect(queryCount("MATCH (m:Method {name:'find'})-[r:CodeRelation {type:'CALLS'}]->(h:Method {name:'helper'}) RETURN count(r) AS n")).resolves.toBe(1);
  });

  it('extracts Ruby classes, methods, and same-class calls', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'repo.rb'),
      [
        'class Repo',
        '  def find(id)',
        '    helper(id)',
        '  end',
        '  def helper(id)',
        '    id',
        '  end',
        'end',
        '',
      ].join('\n'),
    );

    await commandCompile(tmpDir, { silent: true });

    await expect(queryCount("MATCH (c:Class {name:'Repo'}) RETURN count(c) AS n")).resolves.toBe(1);
    await expect(queryCount("MATCH (c:Class {name:'Repo'})-[r:CodeRelation {type:'HAS_METHOD'}]->(m:Method {name:'find'}) RETURN count(r) AS n")).resolves.toBe(1);
    await expect(queryCount("MATCH (m:Method {name:'find'})-[r:CodeRelation {type:'CALLS'}]->(h:Method {name:'helper'}) RETURN count(r) AS n")).resolves.toBe(1);
  });

  it('extracts C functions and direct calls', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'main.c'),
      [
        'int helper(int value) { return value; }',
        'int run(int value) { return helper(value); }',
        '',
      ].join('\n'),
    );

    await commandCompile(tmpDir, { silent: true });

    await expect(queryCount("MATCH (f:Function {name:'helper'}) RETURN count(f) AS n")).resolves.toBe(1);
    await expect(queryCount("MATCH (f:Function {name:'run'})-[r:CodeRelation {type:'CALLS'}]->(h:Function {name:'helper'}) RETURN count(r) AS n")).resolves.toBe(1);
  });

  it('extracts C++ classes, methods, and same-class calls', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'repo.cpp'),
      [
        'class Repo {',
        'public:',
        '  int find(int id) { return helper(id); }',
        'private:',
        '  int helper(int id) { return id; }',
        '};',
        '',
      ].join('\n'),
    );

    await commandCompile(tmpDir, { silent: true });

    await expect(queryCount("MATCH (c:Class {name:'Repo'}) RETURN count(c) AS n")).resolves.toBe(1);
    await expect(queryCount("MATCH (c:Class {name:'Repo'})-[r:CodeRelation {type:'HAS_METHOD'}]->(m:Method {name:'find'}) RETURN count(r) AS n")).resolves.toBe(1);
    await expect(queryCount("MATCH (m:Method {name:'find'})-[r:CodeRelation {type:'CALLS'}]->(h:Method {name:'helper'}) RETURN count(r) AS n")).resolves.toBe(1);
  });

  async function queryCount(query: string): Promise<number> {
    const result = await commandCypher(tmpDir, query);
    return Number(result.rows[0].n);
  }
});
