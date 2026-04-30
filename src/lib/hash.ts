import { createHash } from 'node:crypto';

export function structHash(fields: Record<string, unknown>): string {
  const sorted = JSON.stringify(fields, Object.keys(fields).sort());
  return createHash('sha256').update(sorted).digest('hex').slice(0, 8);
}
