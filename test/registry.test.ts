import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { listProjects, findProject, registerProject, removeProject } from '../src/registry.js';

function makeProject(dir: string, name: string): string {
  const projectDir = path.join(dir, name);
  fs.mkdirSync(path.join(projectDir, '.cotx'), { recursive: true });
  return projectDir;
}

const STATS = { modules: 5, concepts: 10, contracts: 3, flows: 2, concerns: 0 };

describe('registry', () => {
  let tmpHome: string;
  let tmpProjects: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-reg-home-'));
    tmpProjects = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-reg-proj-'));
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpProjects, { recursive: true, force: true });
  });

  it('returns empty array when registry does not exist', () => {
    expect(listProjects(tmpHome)).toEqual([]);
  });

  it('registerProject creates directory and file', () => {
    const proj = makeProject(tmpProjects, 'myapp');
    registerProject(proj, '2026-04-09T00:00:00Z', STATS, tmpHome);
    expect(fs.existsSync(path.join(tmpHome, '.cotx', 'registry.json'))).toBe(true);
  });

  it('registerProject returns entry with correct name', () => {
    const proj = makeProject(tmpProjects, 'myapp');
    const entry = registerProject(proj, '2026-04-09T00:00:00Z', STATS, tmpHome);
    expect(entry.name).toBe('myapp');
    expect(entry.path).toBe(proj);
    expect(entry.stats).toEqual(STATS);
  });

  it('same path registers as update, not duplicate', () => {
    const proj = makeProject(tmpProjects, 'myapp');
    registerProject(proj, '2026-04-09T00:00:00Z', STATS, tmpHome);
    registerProject(proj, '2026-04-10T00:00:00Z', { ...STATS, modules: 8 }, tmpHome);
    const projects = listProjects(tmpHome);
    expect(projects).toHaveLength(1);
    expect(projects[0].compiled_at).toBe('2026-04-10T00:00:00Z');
    expect(projects[0].stats.modules).toBe(8);
  });

  it('listProjects filters out stale entries', () => {
    const proj = makeProject(tmpProjects, 'myapp');
    registerProject(proj, '2026-04-09T00:00:00Z', STATS, tmpHome);
    // Remove the .cotx directory to make it stale
    fs.rmSync(path.join(proj, '.cotx'), { recursive: true });
    expect(listProjects(tmpHome)).toHaveLength(0);
  });

  it('findProject is case-insensitive', () => {
    const proj = makeProject(tmpProjects, 'MyApp');
    registerProject(proj, '2026-04-09T00:00:00Z', STATS, tmpHome);
    expect(findProject('myapp', tmpHome)).toBeDefined();
    expect(findProject('MYAPP', tmpHome)).toBeDefined();
    expect(findProject('MyApp', tmpHome)).toBeDefined();
  });

  it('findProject returns undefined for unknown name', () => {
    expect(findProject('nonexistent', tmpHome)).toBeUndefined();
  });

  it('removeProject returns true when found', () => {
    const proj = makeProject(tmpProjects, 'myapp');
    registerProject(proj, '2026-04-09T00:00:00Z', STATS, tmpHome);
    expect(removeProject('myapp', tmpHome)).toBe(true);
    expect(listProjects(tmpHome)).toHaveLength(0);
  });

  it('removeProject returns false for unknown name', () => {
    expect(removeProject('nonexistent', tmpHome)).toBe(false);
  });

  it('disambiguates names when basename collides', () => {
    const dir1 = path.join(tmpProjects, 'workspace-a');
    const dir2 = path.join(tmpProjects, 'workspace-b');
    const proj1 = makeProject(dir1, 'api');
    const proj2 = makeProject(dir2, 'api');
    const entry1 = registerProject(proj1, '2026-04-09T00:00:00Z', STATS, tmpHome);
    const entry2 = registerProject(proj2, '2026-04-09T00:00:00Z', STATS, tmpHome);
    expect(entry1.name).toBe('api');
    expect(entry2.name).toBe('api-workspace-b');
    expect(listProjects(tmpHome)).toHaveLength(2);
  });

  it('adding new project preserves existing entries', () => {
    const proj1 = makeProject(tmpProjects, 'app1');
    const proj2 = makeProject(tmpProjects, 'app2');
    registerProject(proj1, '2026-04-09T00:00:00Z', STATS, tmpHome);
    registerProject(proj2, '2026-04-09T00:00:00Z', STATS, tmpHome);
    const projects = listProjects(tmpHome);
    expect(projects).toHaveLength(2);
    expect(projects.map((p) => p.name).sort()).toEqual(['app1', 'app2']);
  });

  it('keeps generating unique names when basename and parent both collide', () => {
    const proj1 = makeProject(path.join(tmpProjects, 'alpha', 'ws'), 'api');
    const proj2 = makeProject(path.join(tmpProjects, 'beta', 'ws'), 'api');
    const proj3 = makeProject(path.join(tmpProjects, 'gamma', 'ws'), 'api');

    registerProject(proj1, '2026-04-09T00:00:00Z', STATS, tmpHome);
    registerProject(proj2, '2026-04-09T00:00:00Z', STATS, tmpHome);
    registerProject(proj3, '2026-04-09T00:00:00Z', STATS, tmpHome);

    const names = listProjects(tmpHome).map((p) => p.name);
    expect(new Set(names).size).toBe(3);
  });
});
