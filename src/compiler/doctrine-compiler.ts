import fs from 'node:fs';
import path from 'node:path';
import { structHash } from '../lib/hash.js';
import { ArchitectureStore } from '../store/architecture-store.js';
import type { CotxStore } from '../store/store.js';
import type { ContractNode, DoctrineData, DoctrineStatement, FlowNode, ModuleNode } from '../store/schema.js';
import { readSemanticArtifactsSync } from '../store-v2/graph-truth-store.js';

function makeStatement(input: Omit<DoctrineStatement, 'id'> & { id?: string }): DoctrineStatement {
  const id = input.id ?? `${input.kind}:${input.title}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return { ...input, id };
}

export interface DoctrineSemanticInput {
  modules: ModuleNode[];
  contracts: ContractNode[];
  flows: FlowNode[];
}

export function compileDoctrine(projectRoot: string, store: CotxStore, input?: DoctrineSemanticInput): DoctrineData {
  const statements: DoctrineStatement[] = [];
  const semantic = input ?? readDoctrineSemanticInput(store);
  const { modules, contracts, flows } = semantic;
  const archStore = new ArchitectureStore(projectRoot);

  if (modules.length > 1) {
    statements.push(makeStatement({
      kind: 'principle',
      title: 'Respect existing module boundaries',
      statement: 'Prefer modifying the owning module before introducing new cross-module indirection.',
      strength: 'soft',
      scope: 'repo',
      inferred: true,
      evidence: modules.slice(0, 5).map((mod) => ({ kind: 'module' as const, ref: mod.id })),
    }));
  }

  if (contracts.length > 0) {
    statements.push(makeStatement({
      kind: 'preferred_pattern',
      title: 'Use existing contract surfaces',
      statement: 'Cross-module changes should prefer extending existing contract surfaces over bypassing boundaries with one-off adapters.',
      strength: 'soft',
      scope: 'repo',
      inferred: true,
      evidence: contracts.slice(0, 5).map((contract) => ({
        kind: 'contract' as const,
        ref: contract.id,
        detail: `${contract.consumer} -> ${contract.provider}`,
      })),
    }));
  }

  if (flows.length > 0) {
    statements.push(makeStatement({
      kind: 'preferred_pattern',
      title: 'Change complete cross-module flows',
      statement: 'When changing behavior, review the whole affected flow rather than only the first touched function.',
      strength: 'soft',
      scope: 'repo',
      inferred: true,
      evidence: flows.slice(0, 5).map((flow) => ({
        kind: 'flow' as const,
        ref: flow.id,
        detail: flow.trigger ?? flow.id,
      })),
    }));
  }

  if (archStore.exists()) {
    statements.push(makeStatement({
      kind: 'constraint',
      title: 'Preserve current architecture shape',
      statement: 'Do not introduce changes that contradict the current project architecture without an explicit architectural decision.',
      strength: 'hard',
      scope: 'repo',
      inferred: true,
      evidence: [{ kind: 'architecture', ref: 'overall-architecture' }],
    }));
  }

  for (const mod of modules) {
    for (const ann of mod.annotations ?? []) {
      if (ann.stale) continue;
      if (ann.type === 'constraint' || ann.type === 'intent') {
        statements.push(makeStatement({
          kind: ann.type === 'constraint' ? 'constraint' : 'decision_note',
          title: ann.type === 'constraint' ? 'Existing explicit project constraint' : 'Existing explicit project intent',
          statement: ann.content,
          strength: ann.type === 'constraint' ? 'hard' : 'soft',
          scope: 'module',
          module: mod.id,
          inferred: false,
          evidence: [{ kind: 'annotation', ref: mod.id, detail: ann.type }],
        }));
      }
    }
  }

  const readmePath = path.join(projectRoot, 'README.md');
  if (fs.existsSync(readmePath)) {
    statements.push(makeStatement({
      kind: 'decision_note',
      title: 'Read project docs before changing boundaries',
      statement: 'Project documentation should be consulted before changing architecture boundaries or cross-module contracts.',
      strength: 'soft',
      scope: 'repo',
      inferred: true,
      evidence: [{ kind: 'doc', ref: 'README.md' }],
    }));
  }

  const unique = new Map<string, DoctrineStatement>();
  for (const statement of statements) unique.set(statement.id, statement);
  const finalStatements = [...unique.values()].sort((a, b) => a.id.localeCompare(b.id));

  return {
    generated_at: new Date().toISOString(),
    struct_hash: structHash({ statements: finalStatements }),
    statements: finalStatements,
  };
}

function readDoctrineSemanticInput(store: CotxStore): DoctrineSemanticInput {
  const artifacts = readSemanticArtifactsSync(path.join(store.projectRoot, '.cotx', 'v2', 'truth.lbug'));
  return {
    modules: artifacts.filter((item) => item.layer === 'module').map((item) => item.payload as ModuleNode),
    contracts: artifacts.filter((item) => item.layer === 'contract').map((item) => item.payload as ContractNode),
    flows: artifacts.filter((item) => item.layer === 'flow').map((item) => item.payload as FlowNode),
  };
}
