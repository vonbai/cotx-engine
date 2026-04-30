import fs from 'node:fs';
import path from 'node:path';
import { CotxStore } from '../store/store.js';

export async function commandSnapshot(
  projectRoot: string,
  options: { tag: string },
): Promise<{ success: boolean; message: string }> {
  const store = new CotxStore(projectRoot);
  if (!store.exists()) {
    return { success: false, message: 'No .cotx/ found. Run: cotx compile' };
  }

  const tag = options.tag;
  if (!tag || !/^[a-zA-Z0-9_-]+$/.test(tag)) {
    return { success: false, message: 'Invalid tag. Use alphanumeric, dash, or underscore.' };
  }

  const cotxDir = path.join(projectRoot, '.cotx');
  const snapshotDir = path.join(cotxDir, 'snapshots', tag);

  if (fs.existsSync(snapshotDir)) {
    return { success: false, message: `Snapshot "${tag}" already exists.` };
  }

  // Copy semantic truth and graph files needed for structural diffs.
  // Do NOT copy snapshots/ (avoid nesting) or log.jsonl.
  const dirsToCopy = ['v2', 'graph', 'architecture'];
  const filesToCopy = ['meta.yaml', 'index.json'];

  fs.mkdirSync(snapshotDir, { recursive: true });

  // Copy directories
  for (const dir of dirsToCopy) {
    const srcDir = path.join(cotxDir, dir);
    const dstDir = path.join(snapshotDir, dir);
    if (fs.existsSync(srcDir)) {
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }

  // Copy files
  for (const file of filesToCopy) {
    const src = path.join(cotxDir, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(snapshotDir, file));
    }
  }

  const stats = store.readMeta().stats;
  return {
    success: true,
    message: `Snapshot "${tag}" saved (${stats.modules} modules, ${stats.concepts} concepts, ${stats.contracts} contracts, ${stats.flows} flows)`,
  };
}
