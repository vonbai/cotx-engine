import type { DecisionOverride } from '../store/schema.js';
import type { CotxStore } from '../store/store.js';

export function validateDecisionOverride(input: DecisionOverride): DecisionOverride {
  if (!input.target_id.trim()) {
    throw new Error('Decision override requires a target_id.');
  }
  if (!input.reason.trim()) {
    throw new Error('Decision override requires a non-empty reason.');
  }
  if (input.evidence.length === 0) {
    throw new Error('Decision override requires at least one evidence reference.');
  }
  return {
    ...input,
    reason: input.reason.trim(),
  };
}

export function recordDecisionOverride(store: CotxStore, input: DecisionOverride): DecisionOverride {
  const override = validateDecisionOverride(input);
  store.writeDecisionOverride(override);
  return override;
}
