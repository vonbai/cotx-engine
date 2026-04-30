import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandCompile } from '../../src/commands/compile.js';
import { commandCypher } from '../../src/commands/cypher.js';

describe('object model graph extraction', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-object-model-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('preserves Java interface implementation and dispatch edges', async () => {
    const root = path.join(tmpDir, 'src', 'main', 'java', 'example');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      path.join(root, 'Repo.java'),
      [
        'package example;',
        'public interface Repo {',
        '  String find(String id);',
        '}',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(root, 'SqlRepo.java'),
      [
        'package example;',
        'public class SqlRepo implements Repo {',
        '  public String find(String id) { return helper(id); }',
        '  private String helper(String id) { return id; }',
        '}',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(root, 'Service.java'),
      [
        'package example;',
        'public class Service {',
        '  private final Repo repo;',
        '  public Service(Repo repo) { this.repo = repo; }',
        '  public String load(String id) { return repo.find(id); }',
        '}',
        '',
      ].join('\n'),
    );

    await commandCompile(tmpDir, { silent: true });

    await expect(edgeCount("Class:src/main/java/example/SqlRepo.java:SqlRepo", 'IMPLEMENTS', "Interface:src/main/java/example/Repo.java:Repo")).resolves.toBe(1);
    await expect(edgeCount("Interface:src/main/java/example/Repo.java:Repo", 'HAS_METHOD', "Method:src/main/java/example/Repo.java:Repo.find#1")).resolves.toBe(1);
    await expect(edgeCount("Method:src/main/java/example/SqlRepo.java:SqlRepo.find#1", 'METHOD_IMPLEMENTS', "Method:src/main/java/example/Repo.java:Repo.find#1")).resolves.toBe(1);
    await expect(edgeCount("Method:src/main/java/example/Service.java:Service.load#1", 'CALLS', "Method:src/main/java/example/Repo.java:Repo.find#1")).resolves.toBe(1);
    await expect(edgeCount("Method:src/main/java/example/Service.java:Service.load#1", 'CALLS', "Method:src/main/java/example/SqlRepo.java:SqlRepo.find#1")).resolves.toBe(1);
  });

  it('preserves C# interface implementation and dispatch edges', async () => {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'Repo.cs'),
      [
        'namespace Example;',
        'public interface IRepo {',
        '  string Find(string id);',
        '}',
        'public class SqlRepo : IRepo {',
        '  public string Find(string id) { return Helper(id); }',
        '  private string Helper(string id) { return id; }',
        '}',
        'public class Service {',
        '  private readonly IRepo repo;',
        '  public Service(IRepo repo) { this.repo = repo; }',
        '  public string Load(string id) { return repo.Find(id); }',
        '}',
        '',
      ].join('\n'),
    );

    await commandCompile(tmpDir, { silent: true });

    await expect(edgeCount('Class:src/Repo.cs:SqlRepo', 'IMPLEMENTS', 'Interface:src/Repo.cs:IRepo')).resolves.toBe(1);
    await expect(edgeCount('Interface:src/Repo.cs:IRepo', 'HAS_METHOD', 'Method:src/Repo.cs:IRepo.Find#1')).resolves.toBe(1);
    await expect(edgeCount('Method:src/Repo.cs:SqlRepo.Find#1', 'METHOD_IMPLEMENTS', 'Method:src/Repo.cs:IRepo.Find#1')).resolves.toBe(1);
    await expect(edgeCount('Method:src/Repo.cs:Service.Load#1', 'CALLS', 'Method:src/Repo.cs:IRepo.Find#1')).resolves.toBe(1);
    await expect(edgeCount('Method:src/Repo.cs:Service.Load#1', 'CALLS', 'Method:src/Repo.cs:SqlRepo.Find#1')).resolves.toBe(1);
  });

  async function edgeCount(sourceId: string, type: string, targetId: string): Promise<number> {
    const result = await commandCypher(
      tmpDir,
      `MATCH (a {id:'${sourceId}'})-[r:CodeRelation {type:'${type}'}]->(b {id:'${targetId}'}) RETURN count(r) AS n`,
    );
    return Number(result.rows[0].n);
  }
});
