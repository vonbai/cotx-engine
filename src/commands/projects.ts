import { listProjects, removeProject } from '../registry.js';

export function commandProjectsList(home?: string): void {
  const projects = listProjects(home);
  if (projects.length === 0) {
    console.log('No projects registered. Run `cotx compile` in a project directory.');
    return;
  }
  console.log(`${projects.length} registered project${projects.length !== 1 ? 's' : ''}:\n`);
  for (const p of projects) {
    const s = p.stats;
    console.log(`  ${p.name.padEnd(24)} ${s.modules}m ${s.concepts}c ${s.contracts}ct ${s.flows}f  ${p.path}`);
  }
}

export function commandProjectsRemove(name: string, home?: string): void {
  const removed = removeProject(name, home);
  if (removed) {
    console.log(`Removed "${name}" from registry.`);
  } else {
    console.log(`Project "${name}" not found in registry.`);
    process.exitCode = 1;
  }
}
