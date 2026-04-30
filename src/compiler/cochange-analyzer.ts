import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface CochangeRule {
  files: string[];
  cochange_count: number;
  confidence: number;
}

interface CochangeCache {
  head: string;
  options_key?: string;
  rules: CochangeRule[];
}

export interface AnalyzeCochangeOptions {
  maxCommits?: number;
  maxChangesetSize?: number;
  maxPairs?: number;
}

function positiveInteger(value: string | number | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function analyzeCochange(projectRoot: string, options: AnalyzeCochangeOptions = {}): CochangeRule[] {
  const maxCommits = positiveInteger(options.maxCommits ?? process.env.COTX_COCHANGE_MAX_COMMITS, 500);
  const maxChangesetSize = positiveInteger(options.maxChangesetSize ?? process.env.COTX_COCHANGE_MAX_CHANGESET, 30);
  const maxPairs = positiveInteger(options.maxPairs ?? process.env.COTX_COCHANGE_MAX_PAIRS, 200_000);
  const optionsKey = `${maxCommits}:${maxChangesetSize}:${maxPairs}`;
  const cacheFile = path.join(projectRoot, '.cotx', 'graph', 'cochange-cache.json');
  const readCache = (): CochangeCache | null => {
    try {
      if (!fs.existsSync(cacheFile)) return null;
      return JSON.parse(fs.readFileSync(cacheFile, 'utf-8')) as CochangeCache;
    } catch {
      return null;
    }
  };

  let head: string | null = null;
  try {
    head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return readCache()?.rules ?? [];
  }

  const cached = readCache();
  if (cached && cached.head === head && cached.options_key === optionsKey) {
    return cached.rules;
  }

  let raw = '';
  try {
    raw = execFileSync('git', ['log', '-n', String(maxCommits), '--name-only', '--pretty=format:__COTX_COMMIT__'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return [];
  }

  const commits = raw
    .split('__COTX_COMMIT__')
    .map((chunk) => [...new Set(chunk.split('\n').map((line) => line.trim()).filter(Boolean))].sort())
    .filter((files) => files.length <= maxChangesetSize)
    .filter((files) => files.length > 1);

  const togetherCounts = new Map<string, { files: string[]; together: number }>();
  const fileCommitCounts = new Map<string, number>();
  let pairObservations = 0;

  for (const commitFiles of commits) {
    for (const file of commitFiles) {
      fileCommitCounts.set(file, (fileCommitCounts.get(file) ?? 0) + 1);
    }
    for (let i = 0; i < commitFiles.length; i++) {
      for (let j = i + 1; j < commitFiles.length; j++) {
        pairObservations++;
        if (pairObservations > maxPairs) break;
        const files = [commitFiles[i], commitFiles[j]];
        const key = files.join('::');
        const item = togetherCounts.get(key) ?? { files, together: 0 };
        item.together++;
        togetherCounts.set(key, item);
      }
      if (pairObservations > maxPairs) break;
    }
    if (pairObservations > maxPairs) break;
  }

  const rules = [...togetherCounts.values()]
    .filter((pair) => pair.together >= 2)
    .map((pair) => ({
      files: pair.files,
      cochange_count: pair.together,
      confidence: Number((
        pair.together /
        Math.max(fileCommitCounts.get(pair.files[0]) ?? pair.together, fileCommitCounts.get(pair.files[1]) ?? pair.together)
      ).toFixed(3)),
    }))
    .filter((rule) => rule.confidence >= 0.5)
    .sort((a, b) => b.confidence - a.confidence || b.cochange_count - a.cochange_count);

  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({ head, options_key: optionsKey, rules }, null, 2), 'utf-8');
  } catch {
    // cache is best-effort only
  }

  return rules;
}
