import { CotxStore } from '../store/store.js';
import { buildChangePlan } from '../compiler/change-planner.js';

function printList(label: string, items: string[], limit = items.length): void {
  console.log(label);
  const visible = items.slice(0, limit);
  for (const item of visible) {
    console.log(`- ${item}`);
  }
  if (items.length > limit) {
    console.log(`- ... and ${items.length - limit} more`);
  }
  console.log('');
}

export async function commandPlanChange(
  projectRoot: string,
  target: string,
  options?: { intent?: string },
): Promise<void> {
  const store = new CotxStore(projectRoot);
  if (!store.exists()) {
    console.log('No .cotx/ found. Run: cotx compile');
    return;
  }

  const plan = buildChangePlan(projectRoot, store, target, options?.intent);
  store.writeLatestPlan(plan);
  store.appendPlan(plan);

  console.log(`## Change Plan: ${target}`);
  console.log('');
  if (plan.intent) {
    console.log(`Intent: ${plan.intent}`);
    console.log('');
  }
  printList('### Recommended Modules', plan.recommended_modules);
  if (plan.scope_hints && plan.scope_hints.length > 0) {
    printList('### Scope Hints', plan.scope_hints);
  }
  printList('### Entry Points', plan.entry_points, 6);
  printList('### Recommended Steps', plan.recommended_steps);
  printList('### Discouraged Approaches', plan.discouraged_approaches);
}
