import fs from 'node:fs';
import path from 'node:path';
import { DecisionRuleIndex } from '../store-v2/decision-rule-index.js';

export interface DecisionQueryResult {
  kind: 'canonical' | 'closure';
  target: string;
  row_count: number;
  rows: unknown[];
}

export async function commandDecisionQuery(
  projectRoot: string,
  kind: 'canonical' | 'closure',
  target: string,
): Promise<DecisionQueryResult> {
  const dbPath = path.join(projectRoot, '.cotx', 'v2', 'rules.db');
  if (!fs.existsSync(dbPath)) {
    throw new Error('No storage-v2 rule index found. Run: cotx compile');
  }
  const index = new DecisionRuleIndex({ dbPath });
  await index.open();
  try {
    const rows = kind === 'canonical'
      ? await index.canonicalForConcern(target)
      : await index.closureFor(target);
    return { kind, target, row_count: rows.length, rows };
  } finally {
    index.close();
  }
}
