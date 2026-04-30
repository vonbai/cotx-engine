import { CotxStore } from '../store/store.js';
import path from 'node:path';

export async function commandInit(projectRoot: string): Promise<void> {
  const store = new CotxStore(projectRoot);
  if (store.exists()) {
    console.log('.cotx/ already exists');
    return;
  }
  const projectName = path.basename(projectRoot);
  store.init(projectName);
  console.log(`Initialized .cotx/ for project "${projectName}"`);
}
