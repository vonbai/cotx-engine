import { readConfig } from '../config.js';
import { createLlmClient } from './client.js';
import type { DoctrineData } from '../store/schema.js';

export interface DoctrineRefineResult {
  refined: number;
}

function buildDoctrinePrompt(doctrine: DoctrineData): { system: string; user: string } {
  const payload = JSON.stringify({
    statements: doctrine.statements.map((statement) => ({
      id: statement.id,
      kind: statement.kind,
      title: statement.title,
      statement: statement.statement,
      evidence: statement.evidence,
    })),
  }, null, 2);

  return {
    system: `You are refining deterministic project doctrine statements.
For each statement, rewrite it to be clearer and more actionable without changing its meaning.
Do not invent new rules or evidence.
Respond only with valid JSON:
{
  "refinements": {
    "statement_id": "refined statement",
    "...": "..."
  }
}`,
    user: `Doctrine statements:\n${payload}`,
  };
}

export async function refineDoctrine(doctrine: DoctrineData): Promise<{ doctrine: DoctrineData; result: DoctrineRefineResult }> {
  const config = readConfig();
  if (!config.llm?.chat_model) {
    throw new Error('No LLM configured. Run `cotx setup` or set llm.chat_model in ~/.cotx/config.json');
  }

  const client = createLlmClient(config.llm);
  const { system, user } = buildDoctrinePrompt(doctrine);
  const response = await client.chat(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { max_tokens: config.llm.max_tokens ?? 2000 },
  );

  const raw = response.content.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  const parsed = JSON.parse(raw) as { refinements?: Record<string, unknown> };
  const refinements = parsed.refinements ?? {};

  let refined = 0;
  const next: DoctrineData = {
    ...doctrine,
    statements: doctrine.statements.map((statement) => {
      const candidate = refinements[statement.id];
      if (typeof candidate === 'string') {
        refined++;
        return { ...statement, refined_statement: candidate };
      }
      return statement;
    }),
  };

  return { doctrine: next, result: { refined } };
}
