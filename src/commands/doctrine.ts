import { CotxStore } from '../store/store.js';

function groupTitle(kind: string): string {
  switch (kind) {
    case 'principle': return 'Principles';
    case 'constraint': return 'Constraints';
    case 'preferred_pattern': return 'Preferred Patterns';
    case 'anti_pattern': return 'Anti-patterns';
    case 'decision_note': return 'Decision Notes';
    default: return kind;
  }
}

export async function commandDoctrine(projectRoot: string): Promise<void> {
  const store = new CotxStore(projectRoot);
  if (!store.exists()) {
    console.log('No .cotx/ found. Run: cotx compile');
    return;
  }

  const doctrine = store.readDoctrine();
  if (!doctrine) {
    console.log('No doctrine data. Run: cotx compile');
    return;
  }

  const meta = store.readMeta();
  console.log(`## Doctrine: ${meta.project}`);
  console.log('');

  const grouped = new Map<string, typeof doctrine.statements>();
  for (const statement of doctrine.statements) {
    const existing = grouped.get(statement.kind) ?? [];
    existing.push(statement);
    grouped.set(statement.kind, existing);
  }

  for (const [kind, statements] of grouped) {
    console.log(`### ${groupTitle(kind)}`);
    for (const statement of statements) {
      const scope = statement.scope === 'module' && statement.module ? ` [${statement.module}]` : '';
      console.log(`- ${statement.title}${scope}: ${statement.statement}`);
      if (statement.evidence.length > 0) {
        console.log(`  Evidence: ${statement.evidence.map((e) => `${e.kind}:${e.ref}`).join(', ')}`);
      }
    }
    console.log('');
  }
}
