import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface RegistryEntry {
  name: string;
  path: string;
  compiled_at: string;
  stats: {
    modules: number;
    concepts: number;
    contracts: number;
    flows: number;
    concerns: number;
  };
}

function registryDir(home?: string): string {
  return path.join(home ?? os.homedir(), '.cotx');
}

function registryPath(home?: string): string {
  return path.join(registryDir(home), 'registry.json');
}

function readRegistry(home?: string): RegistryEntry[] {
  try {
    const raw = fs.readFileSync(registryPath(home), 'utf-8');
    return JSON.parse(raw) as RegistryEntry[];
  } catch {
    return [];
  }
}

function writeRegistry(entries: RegistryEntry[], home?: string): void {
  const dir = registryDir(home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(registryPath(home), JSON.stringify(entries, null, 2), 'utf-8');
}

function uniqueProjectName(absPath: string, entries: RegistryEntry[]): string {
  const taken = new Set(entries.map((entry) => entry.name.toLowerCase()));
  const base = path.basename(absPath) || 'project';

  if (!taken.has(base.toLowerCase())) {
    return base;
  }

  const parents: string[] = [];
  let current = path.dirname(absPath);
  while (current !== path.dirname(current)) {
    const part = path.basename(current);
    if (part) parents.push(part);
    current = path.dirname(current);
  }

  for (let i = 0; i < parents.length; i++) {
    const candidate = `${base}-${parents.slice(0, i + 1).join('-')}`;
    if (!taken.has(candidate.toLowerCase())) {
      return candidate;
    }
  }

  let suffix = 2;
  while (taken.has(`${base}-${suffix}`.toLowerCase())) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
}

export function listProjects(home?: string): RegistryEntry[] {
  return readRegistry(home).filter((e) =>
    fs.existsSync(path.join(e.path, '.cotx')),
  );
}

export function findProject(name: string, home?: string): RegistryEntry | undefined {
  const lower = name.toLowerCase();
  return listProjects(home).find((e) => e.name.toLowerCase() === lower);
}

export function registerProject(
  projectRoot: string,
  compiledAt: string,
  stats: RegistryEntry['stats'],
  home?: string,
): RegistryEntry {
  const absPath = path.resolve(projectRoot);
  const entries = readRegistry(home);

  // Check if already registered by path
  const existing = entries.findIndex((e) => e.path === absPath);
  if (existing >= 0) {
    // Update in place
    entries[existing].compiled_at = compiledAt;
    entries[existing].stats = stats;
    writeRegistry(entries, home);
    return entries[existing];
  }

  const name = uniqueProjectName(absPath, entries);

  const entry: RegistryEntry = { name, path: absPath, compiled_at: compiledAt, stats };
  entries.push(entry);
  writeRegistry(entries, home);
  return entry;
}

export function removeProject(name: string, home?: string): boolean {
  const entries = readRegistry(home);
  const lower = name.toLowerCase();
  const idx = entries.findIndex((e) => e.name.toLowerCase() === lower);
  if (idx < 0) return false;
  entries.splice(idx, 1);
  writeRegistry(entries, home);
  return true;
}
