import { readConfig } from '../config.js';
import { createLlmClient } from './client.js';

export interface DecisionAssistInput {
  ambiguous_zone: 'family_label' | 'canonical_rerank' | 'borderline_sibling' | 'abstraction_form';
  target: string;
  candidates: Array<{ id: string; summary: string }>;
  evidence: Array<{ ref: string; detail?: string }>;
}

export interface DecisionAssistResult {
  ambiguous_zone: DecisionAssistInput['ambiguous_zone'];
  selected_candidate_id?: string;
  explanation?: string;
  suggested_abstraction_level?: 'extract_helper' | 'extract_service' | 'lift_to_canonical_path';
}

function buildPrompt(input: DecisionAssistInput): { system: string; user: string } {
  return {
    system: `You are assisting with an ambiguous project decision.
You may only help inside these allowed zones:
- family_label
- canonical_rerank
- borderline_sibling
- abstraction_form

You do not own truth. Do not invent new evidence, new candidates, or new constraints.
Respond only with valid JSON:
{
  "selected_candidate_id": "optional-id",
  "explanation": "short explanation",
  "suggested_abstraction_level": "extract_helper | extract_service | lift_to_canonical_path | optional"
}`,
    user: JSON.stringify(input, null, 2),
  };
}

export async function assistDecisionAmbiguity(input: DecisionAssistInput): Promise<DecisionAssistResult> {
  const config = readConfig();
  if (!config.llm?.chat_model) {
    throw new Error('No LLM configured. Run `cotx setup` or set llm.chat_model in ~/.cotx/config.json');
  }

  const client = createLlmClient(config.llm);
  const { system, user } = buildPrompt(input);
  const response = await client.chat(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { max_tokens: config.llm.max_tokens ?? 1200 },
  );

  const raw = response.content.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  const parsed = JSON.parse(raw) as Partial<DecisionAssistResult>;
  return {
    ambiguous_zone: input.ambiguous_zone,
    selected_candidate_id: typeof parsed.selected_candidate_id === 'string' ? parsed.selected_candidate_id : undefined,
    explanation: typeof parsed.explanation === 'string' ? parsed.explanation : undefined,
    suggested_abstraction_level:
      parsed.suggested_abstraction_level === 'extract_helper' ||
      parsed.suggested_abstraction_level === 'extract_service' ||
      parsed.suggested_abstraction_level === 'lift_to_canonical_path'
        ? parsed.suggested_abstraction_level
        : undefined,
  };
}
