import fs from 'node:fs';
import path from 'node:path';
import { GraphTruthStore } from '../store-v2/graph-truth-store.js';

export interface CypherResult {
  query: string;
  row_count: number;
  rows: Record<string, unknown>[];
  markdown?: string;
}

export async function commandCypher(projectRoot: string, query: string): Promise<CypherResult> {
  if (isWriteCypher(query)) {
    throw new Error('Write operations are not allowed in cotx cypher. The storage-v2 truth graph is read-only.');
  }
  const dbPath = path.join(projectRoot, '.cotx', 'v2', 'truth.lbug');
  if (!fs.existsSync(dbPath)) {
    throw new Error('No storage-v2 truth store found. Run: cotx compile');
  }
  const store = new GraphTruthStore({ dbPath, readOnly: true });
  await store.open();
  try {
    const rows = await store.query(query);
    return { query, row_count: rows.length, rows, markdown: formatRowsAsMarkdown(rows) };
  } finally {
    await store.close();
  }
}

function isWriteCypher(query: string): boolean {
  return /\b(CREATE|DELETE|SET|MERGE|REMOVE|DROP|ALTER|COPY|DETACH|LOAD|IMPORT|EXPORT)\b/i.test(stripStringLiterals(query));
}

function stripStringLiterals(query: string): string {
  return query.replace(/'(?:\\.|''|[^'\\])*'|"(?:\\.|""|[^"\\])*"/g, "''");
}

function formatRowsAsMarkdown(rows: Record<string, unknown>[]): string | undefined {
  if (rows.length === 0) return undefined;
  const keys = Object.keys(rows[0] ?? {});
  if (keys.length === 0) return undefined;
  const header = `| ${keys.join(' | ')} |`;
  const separator = `| ${keys.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) =>
    `| ${keys.map((key) => markdownCell(row[key])).join(' | ')} |`,
  );
  return [header, separator, ...body].join('\n');
}

function markdownCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const raw = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return raw.replaceAll('|', '\\|').replaceAll('\n', ' ');
}
