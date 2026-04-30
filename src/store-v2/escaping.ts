export function quoteCypher(value: unknown): string {
  return String(value ?? '').replaceAll('\\', '\\\\').replaceAll("'", "\\'");
}

export function jsonString(value: unknown): string {
  return JSON.stringify(value);
}

export function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string' || value.length === 0) return [];
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed.map(String) : [];
}
