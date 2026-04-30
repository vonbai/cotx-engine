import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(import.meta.dirname, '../..');

function readJson(rel: string) {
  return JSON.parse(readFileSync(resolve(ROOT, rel), 'utf-8'));
}

describe('workspace layout', () => {
  it('root package.json exposes workspaces', () => {
    const pkg = readJson('package.json');
    expect(pkg.workspaces).toEqual(['packages/*', 'apps/*']);
  });

  it('root package is still cotx-engine', () => {
    const pkg = readJson('package.json');
    expect(pkg.name).toBe('cotx-engine');
  });

  it('cotx-sdk-core package exists', () => {
    expect(existsSync(resolve(ROOT, 'packages/cotx-sdk-core/package.json'))).toBe(true);
    const pkg = readJson('packages/cotx-sdk-core/package.json');
    expect(pkg.name).toBe('cotx-sdk-core');
    expect(pkg.type).toBe('module');
    expect(pkg.private).not.toBe(true);
    expect(pkg.exports).toHaveProperty('.');
  });

  it('cotx-sdk-react package exists', () => {
    expect(existsSync(resolve(ROOT, 'packages/cotx-sdk-react/package.json'))).toBe(true);
    const pkg = readJson('packages/cotx-sdk-react/package.json');
    expect(pkg.name).toBe('cotx-sdk-react');
    expect(pkg.peerDependencies).toHaveProperty('react');
    expect(pkg.private).not.toBe(true);
    expect(pkg.exports).toHaveProperty('.');
    expect(pkg.exports).toHaveProperty('./theme.css');
  });

  it('cotx-workbench app exists', () => {
    expect(existsSync(resolve(ROOT, 'apps/cotx-workbench/package.json'))).toBe(true);
    const pkg = readJson('apps/cotx-workbench/package.json');
    expect(pkg.name).toBe('cotx-workbench');
    expect(pkg.private).toBe(true);
  });

  it('cotx-sdk-react depends on cotx-sdk-core', () => {
    const pkg = readJson('packages/cotx-sdk-react/package.json');
    expect(pkg.dependencies).toHaveProperty('cotx-sdk-core');
  });

  it('cotx-workbench depends on both sdk packages', () => {
    const pkg = readJson('apps/cotx-workbench/package.json');
    expect(pkg.dependencies).toHaveProperty('cotx-sdk-core');
    expect(pkg.dependencies).toHaveProperty('cotx-sdk-react');
  });
});
