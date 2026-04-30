import { collectOnboardingContext, type OnboardingBudget } from '../compiler/onboarding-context.js';
import { collectProjectSourceRootInventory } from '../compiler/source-root-inventory.js';
import { readExistingConfig } from '../config.js';
import { scanWorkspaceLayout } from '../compiler/workspace-scan.js';

export async function commandSourceRoots(
  projectRoot: string,
  options: {
    json?: boolean;
    assist?: boolean;
    budget?: OnboardingBudget;
  } = {},
): Promise<void> {
  const budget = options.budget ?? 'standard';
  const workspaceLayout = scanWorkspaceLayout(projectRoot);
  const inventory = await collectProjectSourceRootInventory(projectRoot, { workspaceLayout });

  if (options.json) {
    if (!options.assist) {
      console.log(JSON.stringify({ inventory }, null, 2));
      return;
    }

    const config = readExistingConfig();
    if (!config?.llm?.chat_model) {
      console.log(JSON.stringify({
        inventory,
        assistant: {
          requested: true,
          available: false,
          reason: 'No built-in LLM configured. Set llm.chat_model in ~/.cotx/config.json.',
        },
      }, null, 2));
      return;
    }

    const onboarding = collectOnboardingContext(projectRoot, { budget });
    const { runSourceRootDiscoveryAdvisor } = await import('../llm/source-root-advisor.js');
    const advisor = await runSourceRootDiscoveryAdvisor({
      projectRoot,
      inventory,
      onboarding,
      llm: config.llm,
      log: console.log,
    });
    console.log(JSON.stringify({
      inventory,
      assistant: {
        requested: true,
        available: true,
        parsed: advisor.parsed,
        raw_output: advisor.raw_output,
        tool_calls: advisor.tool_calls,
        truth_correction_proposals: advisor.truth_correction_proposals,
        truth_correction_events: advisor.truth_correction_events,
        model: advisor.model,
      },
    }, null, 2));
    return;
  }

  console.log('Deterministic source roots:');
  for (const root of inventory.selected) {
    console.log(`- ${root.path} [${root.role}] (${root.file_count} files)`);
    console.log(`  reason: ${root.reason}`);
  }
  if (inventory.excluded.length > 0) {
    console.log('\nExcluded/peripheral roots:');
    for (const root of inventory.excluded) {
      console.log(`- ${root.path} [${root.role}] (${root.file_count} files)`);
    }
  }

  if (!options.assist) return;

  const config = readExistingConfig();
  if (!config?.llm?.chat_model) {
    console.log('\nAssistant review unavailable: no built-in LLM configured.');
    return;
  }

  const onboarding = collectOnboardingContext(projectRoot, { budget });
  const { runSourceRootDiscoveryAdvisor } = await import('../llm/source-root-advisor.js');
  const advisor = await runSourceRootDiscoveryAdvisor({
    projectRoot,
    inventory,
    onboarding,
    llm: config.llm,
    log: console.log,
  });
  console.log('\nAssistant advisory:');
  if (advisor.parsed) {
    console.log(`- verdict: ${advisor.parsed.verdict}`);
    for (const note of advisor.parsed.notes) {
      console.log(`- note: ${note}`);
    }
    for (const suggestion of advisor.parsed.suggested_roots) {
      console.log(`- suggestion: ${suggestion.path} [${suggestion.role}] include=${suggestion.include_in_overall_architecture} confidence=${suggestion.confidence}`);
      console.log(`  rationale: ${suggestion.rationale}`);
    }
  } else {
    console.log(advisor.raw_output);
  }
}
