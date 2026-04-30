import { execSync } from 'node:child_process';
import { detectChangedFilesFromGit } from '../compiler/change-review.js';
import { collectOnboardingContext, type OnboardingBudget } from '../compiler/onboarding-context.js';

function isOnboardingBudget(value: string | undefined): value is OnboardingBudget {
  return value === 'tiny' || value === 'standard' || value === 'deep';
}

function quoteShell(value: string): string {
  return JSON.stringify(value);
}

function printList(label: string, items: string[], empty: string): void {
  console.log(label);
  if (items.length === 0) {
    console.log(`- ${empty}`);
  } else {
    for (const item of items) {
      console.log(`- ${item}`);
    }
  }
  console.log('');
}

function safeDetectChangedFiles(projectRoot: string): string[] {
  try {
    execSync('git rev-parse --is-inside-work-tree', { cwd: projectRoot, stdio: 'ignore' });
    return detectChangedFilesFromGit(projectRoot);
  } catch {
    return [];
  }
}

export async function commandCodrive(
  projectRoot: string,
  taskParts: string[] = [],
  options?: { focus?: string; budget?: string; json?: boolean },
): Promise<void> {
  const budget = isOnboardingBudget(options?.budget) ? options.budget : 'standard';
  if (options?.budget && !isOnboardingBudget(options.budget)) {
    console.log('Invalid budget. Use: tiny, standard, or deep.');
    return;
  }

  const task = taskParts.join(' ').trim() || options?.focus?.trim() || 'requested task';
  const focus = options?.focus?.trim() || task;
  const onboarding = collectOnboardingContext(projectRoot, { budget });
  const changedFiles = safeDetectChangedFiles(projectRoot);
  const hasCotx = onboarding.summary.has_cotx;
  const hasArchitecture = onboarding.summary.has_architecture_store;

  const recommendedCommands = [
    `cotx codrive ${quoteShell(task)} --focus ${quoteShell(focus)} --budget ${budget}`,
    hasCotx ? `cotx map --scope ${hasArchitecture ? 'architecture' : 'overview'}` : 'cotx compile',
    hasCotx ? `cotx query ${quoteShell(focus)}${hasArchitecture ? ' --layer architecture' : ''}` : 'cotx status',
    hasCotx ? `cotx plan-change ${quoteShell(focus)} --intent ${quoteShell(task)}` : 'cotx compile',
    changedFiles.length > 0 ? `cotx review-change ${changedFiles.map(quoteShell).join(' ')}` : 'cotx review-change',
  ];

  const mcpWorkflow = [
    'cotx_prepare_task',
    'cotx_onboarding_context (if prepare_task says bootstrap/enrich details are needed)',
    hasArchitecture ? 'cotx_map scope=architecture' : 'cotx_map scope=overview',
    hasArchitecture ? 'cotx_query layer=architecture' : 'cotx_query',
    'cotx_context on one selected result',
    'cotx_plan_change',
    'cotx_detect_changes',
    'cotx_review_change',
  ];

  if (options?.json) {
    console.log(JSON.stringify({
      task,
      focus,
      budget,
      summary: onboarding.summary,
      changed_files: changedFiles,
      recommended_commands: recommendedCommands,
      mcp_workflow: mcpWorkflow,
    }, null, 2));
    return;
  }

  console.log(`## cotx Co-Driving Workflow: ${task}`);
  console.log('');
  console.log(`Project root: ${projectRoot}`);
  console.log(`Focus: ${focus}`);
  console.log(`Budget: ${budget}`);
  console.log('');

  console.log('### Starting Context');
  console.log(`- Sources: ${onboarding.summary.source_count}`);
  console.log(`- Workspace candidates: ${onboarding.summary.workspace_candidates}`);
  console.log(`- Asset directories: ${onboarding.summary.asset_directories}`);
  console.log(`- Graph file index: ${onboarding.summary.graph_file_index_status}`);
  console.log(`- cotx map present: ${hasCotx ? 'yes' : 'no'}`);
  console.log(`- Architecture store present: ${hasArchitecture ? 'yes' : 'no'}`);
  console.log('');

  const counts = onboarding.summary.consistency_counts;
  console.log('### Consistency Signals');
  console.log(`- Confirmed: ${counts.confirmed}`);
  console.log(`- Contradicted: ${counts.contradicted}`);
  console.log(`- Graph gap: ${counts['graph-gap']}`);
  console.log(`- Stale doc: ${counts['stale-doc']}`);
  console.log(`- Unknown: ${counts.unknown}`);
  console.log('');

  printList(
    '### Candidate Inputs',
    onboarding.workspace_scan.candidates.slice(0, 8).map((candidate) => `${candidate.path} (${candidate.kind})`),
    'No candidate onboarding inputs found.',
  );
  printList(
    '### Asset Directories',
    onboarding.workspace_scan.directories
      .filter((directory) => directory.kind === 'asset')
      .slice(0, 8)
      .map((directory) => directory.path),
    'No asset directories detected.',
  );
  printList('### Changed Files', changedFiles.slice(0, 12), 'No changed files detected.');
  printList('### CLI Workflow', recommendedCommands, 'No CLI workflow available.');
  printList('### MCP Workflow', mcpWorkflow, 'No MCP workflow available.');
}
