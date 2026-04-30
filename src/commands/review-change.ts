import { CotxStore } from '../store/store.js';
import { buildChangeReview, detectAddedLinesFromGit, detectChangedFilesFromGit } from '../compiler/change-review.js';

export async function commandReviewChange(
  projectRoot: string,
  files?: string[],
): Promise<void> {
  const store = new CotxStore(projectRoot);
  if (!store.exists()) {
    console.log('No .cotx/ found. Run: cotx compile');
    return;
  }

  const changedFiles = files && files.length > 0 ? files : detectChangedFilesFromGit(projectRoot);
  if (changedFiles.length === 0) {
    console.log('No changed files detected.');
    return;
  }

  const review = buildChangeReview(projectRoot, store, {
    changedFiles,
    addedLines: detectAddedLinesFromGit(projectRoot, changedFiles),
  });
  store.writeLatestReview(review);
  store.appendReview(review);

  console.log('## Change Review');
  console.log('');
  console.log(`Changed files: ${review.changed_files.join(', ')}`);
  console.log('');
  if (review.findings.length === 0) {
    console.log('No suspicious project-level change patterns detected.');
    return;
  }
  for (const finding of review.findings) {
    console.log(`- [${finding.severity}] ${finding.kind}: ${finding.title}`);
    console.log(`  ${finding.message}`);
    if (finding.recommendation) {
      console.log(`  Recommendation: ${finding.recommendation}`);
    }
  }
}
