import path from 'node:path';
import type { CotxIndex } from './schema.js';
import type { CotxStore } from './store.js';
import type { ConceptNode, ContractNode, ConcernNode, FlowNode, ModuleNode } from './schema.js';
import { readSemanticArtifactsSync } from '../store-v2/graph-truth-store.js';

export function buildDerivedIndex(store: CotxStore): CotxIndex {
  const meta = store.readMeta();

  const artifacts = readSemanticArtifactsSync(path.join(store.projectRoot, '.cotx', 'v2', 'truth.lbug'));
  const modules = artifacts.filter((item) => item.layer === 'module').map((item) => item.payload as ModuleNode);
  const concepts = artifacts.filter((item) => item.layer === 'concept').map((item) => item.payload as ConceptNode);
  const contracts = artifacts.filter((item) => item.layer === 'contract').map((item) => item.payload as ContractNode);
  const flows = artifacts.filter((item) => item.layer === 'flow').map((item) => item.payload as FlowNode);
  const concerns = artifacts.filter((item) => item.layer === 'concern').map((item) => item.payload as ConcernNode);

  return {
    version: '1',
    compiled_at: meta.compiled_at,
    project: meta.project,
    stats: meta.stats,
    graph: {
      nodes: [
        ...modules.map((mod) => ({
          id: mod.id,
          layer: 'module',
          file: `v2/truth.lbug#semantic/module/${store.safeFilename(mod.id)}`,
        })),
        ...concepts.map((concept) => ({
          id: concept.id,
          layer: 'concept',
          file: `v2/truth.lbug#semantic/concept/${store.safeFilename(concept.id)}`,
        })),
        ...contracts.map((contract) => ({
          id: contract.id,
          layer: 'contract',
          file: `v2/truth.lbug#semantic/contract/${store.safeFilename(contract.id)}`,
        })),
        ...flows.map((flow) => ({
          id: flow.id,
          layer: 'flow',
          file: `v2/truth.lbug#semantic/flow/${store.safeFilename(flow.id)}`,
        })),
        ...concerns.map((concern) => ({
          id: concern.id,
          layer: 'concern',
          file: `v2/truth.lbug#semantic/concern/${store.safeFilename(concern.id)}`,
        })),
      ],
      edges: [
        ...modules.flatMap((mod) =>
          (mod.depends_on ?? []).map((dep) => ({ from: mod.id, to: dep, relation: 'depends_on' })),
        ),
        ...concepts
          .filter((concept) => Boolean(concept.layer))
          .map((concept) => ({ from: concept.layer, to: concept.id, relation: 'owns_concept' })),
        ...contracts.map((contract) => ({
          from: contract.consumer,
          to: contract.provider,
          relation: 'contract',
        })),
        ...flows.flatMap((flow) =>
          (flow.steps ?? []).map((step) => ({
            from: flow.id,
            to: step.module,
            relation: 'step_in_flow',
          })),
        ),
        ...concerns.flatMap((concern) =>
          (concern.affected_modules ?? []).map((mod) => ({
            from: concern.id,
            to: mod,
            relation: 'affects',
          })),
        ),
      ],
    },
  };
}

export function rebuildDerivedIndex(store: CotxStore): void {
  store.writeIndex(buildDerivedIndex(store));
}
