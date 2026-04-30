import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandCompile } from '../../src/commands/compile.js';
import { GraphTruthStore } from '../../src/store-v2/index.js';

describe('TypeScript route and shape extraction', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-ts-route-shape-'));
    fs.mkdirSync(path.join(tmpDir, 'app', 'api', 'users'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'web'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('maps Next.js routes to fetch consumers and reports response-shape mismatches', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'app', 'api', 'users', 'route.ts'),
      [
        'export async function GET() {',
        '  return Response.json({ data: [{ id: 1 }], total: 1 });',
        '}',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(tmpDir, 'web', 'users.ts'),
      [
        'export async function loadUsers() {',
        "  const response = await fetch('/api/users');",
        '  const data = await response.json();',
        '  return data.missing;',
        '}',
        '',
      ].join('\n'),
    );

    await commandCompile(tmpDir, { silent: true });

    const store = new GraphTruthStore({
      dbPath: path.join(tmpDir, '.cotx', 'v2', 'truth.lbug'),
    });
    await store.open();
    try {
      const [route] = await store.routeMap('/api/users');
      expect(route).toMatchObject({
        id: 'Route:/api/users',
        filePath: 'app/api/users/route.ts',
        responseKeys: ['data', 'total'],
      });
      expect(route.handlers).toEqual([
        expect.objectContaining({
          id: 'File:app/api/users/route.ts',
          label: 'File',
        }),
      ]);
      expect(route.consumers).toEqual([
        expect.objectContaining({
          id: 'File:web/users.ts',
          accessedKeys: ['missing'],
        }),
      ]);

      const [shape] = await store.shapeCheck('/api/users');
      expect(shape.status).toBe('MISMATCH');
      expect(shape.missingKeys).toEqual(['missing']);
    } finally {
      await store.close();
    }
  });
});
