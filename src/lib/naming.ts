import { split as changeCaseSplit } from 'change-case';

/**
 * Split a compound identifier into lowercase word roots.
 * Uses change-case for robust handling of CamelCase, snake_case,
 * kebab-case, and consecutive uppercase (e.g. HTTPClient → http, client).
 */
export function splitCompoundName(name: string): string[] {
  return changeCaseSplit(name)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 1);
}

export function toKebabCase(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .toLowerCase();
}

/**
 * Derive the top-level module ID from a file path.
 * Files with no parent directory (e.g. "main.go") map to '_root'.
 */
export function moduleIdForFile(filePath: string): string {
  const parts = filePath.split('/');
  if (parts.length <= 1) return '_root';
  return parts[0];
}
