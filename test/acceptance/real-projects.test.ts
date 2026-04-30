import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { runAcceptanceSuites } from '../../scripts/acceptance/run-real-projects.mjs';

describe('real project acceptance', () => {
  it(
    'passes all capability checks against real projects',
    async () => {
      const repoRoot = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
      );
      const fixtureDir = path.join(repoRoot, 'example', 'oh-my-mermaid');
      const projects = [repoRoot];
      if (fs.existsSync(fixtureDir)) {
        projects.push(fixtureDir);
      }
      const results = await runAcceptanceSuites({
        projects,
        quiet: true,
      });

      expect(results.failedChecks).toEqual([]);
      for (const project of results.projects) {
        expect(Object.values(project.checks).every(Boolean)).toBe(true);
      }
    },
    180_000,
  );
});
