import { CotxStore } from '../store/store.js';
import { splitCompoundName } from '../lib/naming.js';
import type { CanonicalPath } from '../store/schema.js';
import fs from 'node:fs';
import path from 'node:path';
import { DecisionRuleIndex } from '../store-v2/decision-rule-index.js';

const DISPLAY_ACTION_ROOTS = new Set([
  'auth', 'authorize', 'commit', 'create', 'delete', 'dispatch', 'fetch', 'find',
  'load', 'persist', 'query', 'read', 'save', 'send', 'store', 'sync', 'update',
  'validate', 'write',
]);

function ownerContainsHead(owner: string, head: string): boolean {
  return splitCompoundName(owner).includes(head);
}

function tokens(value: string): Set<string> {
  return new Set(
    value
      .replace(/[:/._-]+/g, ' ')
      .split(/\s+/)
      .flatMap((part) => splitCompoundName(part).length > 0 ? splitCompoundName(part) : [part.toLowerCase()])
      .filter(Boolean),
  );
}

function targetRelevance(canonicalPath: CanonicalPath, target?: string): number {
  if (!target) return 0;
  const targetTokens = tokens(target);
  const haystack = tokens([
    canonicalPath.id,
    canonicalPath.name,
    canonicalPath.target_concern,
    canonicalPath.owning_module,
  ].join(' '));
  const overlap = [...targetTokens].filter((token) => haystack.has(token)).length;
  return overlap / Math.max(1, targetTokens.size);
}

export async function commandCanonicalPaths(projectRoot: string, options?: { target?: string }): Promise<void> {
  const store = new CotxStore(projectRoot);
  if (!store.exists()) {
    console.log('No .cotx/ found. Run: cotx compile');
    return;
  }

  const printed = await printV2CanonicalPaths(projectRoot, options);
  if (!printed) console.log('No storage-v2 canonical path rule index data. Run: cotx compile');
}

async function printV2CanonicalPaths(projectRoot: string, options?: { target?: string }): Promise<boolean> {
  const dbPath = path.join(projectRoot, '.cotx', 'v2', 'rules.db');
  if (!fs.existsSync(dbPath)) return false;
  const index = new DecisionRuleIndex({ dbPath });
  await index.open();
  try {
    const canonicalPaths = (await index.listCanonical()).sort((a, b) => a.id.localeCompare(b.id));
    if (canonicalPaths.length === 0) return false;

    console.log('## Canonical Paths');
    console.log('');

    const scored = canonicalPaths
      .map((canonicalPath) => {
        const [head, sinkRole] = canonicalPath.targetConcern.split(':');
        const unknownConcern = canonicalPath.targetConcern.endsWith(':unknown');
        const displayableHead = DISPLAY_ACTION_ROOTS.has(head) || ownerContainsHead(canonicalPath.owningModule, head);
        const displayableSink = sinkRole !== 'unknown' && sinkRole !== 'formatting';
        const relevance = targetRelevance({
          id: canonicalPath.id,
          name: canonicalPath.id,
          target_concern: canonicalPath.targetConcern,
          owning_module: canonicalPath.owningModule,
        } as CanonicalPath, options?.target);
        const shouldShow = options?.target !== undefined
          ? relevance > 0 && canonicalPath.confidence >= 0.55 && displayableSink && !unknownConcern
          : canonicalPath.status === 'canonical' &&
            canonicalPath.confidence >= 0.7 &&
            displayableHead &&
            displayableSink &&
            !unknownConcern;
        return { canonicalPath, relevance, shouldShow };
      })
      .sort((left, right) =>
        right.relevance - left.relevance ||
        right.canonicalPath.confidence - left.canonicalPath.confidence ||
        left.canonicalPath.id.localeCompare(right.canonicalPath.id),
      );

    const visible = scored
      .filter((item) => item.shouldShow)
      .slice(0, options?.target ? 8 : 12)
      .map((item) => item.canonicalPath);
    const suppressed = canonicalPaths.length - visible.length;

    for (const canonicalPath of visible) {
      console.log(`- [${canonicalPath.status}] ${canonicalPath.id}`);
      console.log(`  Concern: ${canonicalPath.targetConcern}`);
      console.log(`  Owner: ${canonicalPath.owningModule}`);
      console.log(`  Confidence: ${canonicalPath.confidence}`);
    }
    if (suppressed > 0) {
      console.log(`Suppressed ${suppressed} low-confidence or noisy candidates.`);
    }
    return true;
  } finally {
    index.close();
  }
}
