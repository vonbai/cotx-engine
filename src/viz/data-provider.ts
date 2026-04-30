import fs from 'node:fs';
import path from 'node:path';
import { CotxStore } from '../store/store.js';
import type { CotxGraphData, CotxVizEdge } from './types.js';

export class CotxDataProvider {
  static fromDirectory(projectRoot: string): CotxGraphData {
    const store = new CotxStore(projectRoot);
    const meta = store.readMeta();

    const { modules, concepts, contracts, flows } = store.loadAllSemanticArtifacts();
    // Concerns aren't part of loadAllSemanticArtifacts (they're still yaml-
    // backed on disk); keep the explicit loop. Usually small (<100).
    const concerns = store.listConcerns().map((id) => store.readConcern(id));

    const edgeSet = new Set<string>();
    const edges: CotxVizEdge[] = [];

    function addEdge(edge: CotxVizEdge): void {
      const key = `${edge.source}\0${edge.target}\0${edge.type}`;
      if (edgeSet.has(key)) return;
      edgeSet.add(key);
      edges.push(edge);
    }

    for (const mod of modules) {
      for (const dep of mod.depends_on ?? []) {
        addEdge({ source: mod.id, target: dep, type: 'depends_on' });
      }
    }

    for (const concept of concepts) {
      if (concept.layer) {
        addEdge({ source: concept.layer, target: concept.id, type: 'owns_concept' });
      }
    }

    for (const contract of contracts) {
      addEdge({
        source: contract.consumer,
        target: contract.provider,
        type: 'contract',
        label: contract.interface.slice(0, 3).join(', '),
      });
    }

    for (const flow of flows) {
      if (flow.steps) {
        for (const step of flow.steps) {
          addEdge({ source: flow.id, target: step.module, type: 'step_in_flow' });
        }
      }
    }

    for (const concern of concerns) {
      for (const mod of concern.affected_modules ?? []) {
        addEdge({ source: concern.id, target: mod, type: 'affects' });
      }
    }

    // Load temporal coupling edges
    try {
      const couplingFile = path.join(projectRoot, '.cotx', 'graph', 'temporal-coupling.json');
      if (fs.existsSync(couplingFile)) {
        const content = fs.readFileSync(couplingFile, 'utf-8');
        const lines = content.split('\n').filter(Boolean);
        for (const line of lines) {
          const edge = JSON.parse(line) as { from: string; to: string };
          addEdge({ source: edge.from, target: edge.to, type: 'temporal_coupling' });
        }
      }
    } catch {
      // Optional
    }

    return {
      meta: {
        project: meta.project,
        compiled_at: meta.compiled_at,
        version: meta.version,
      },
      modules,
      concepts,
      contracts,
      flows,
      concerns,
      edges,
    };
  }

  static fromJSON(json: unknown): CotxGraphData {
    const data = json as CotxGraphData;
    if (!data.meta || !Array.isArray(data.modules) || !Array.isArray(data.edges)) {
      throw new Error('Invalid CotxGraphData: missing required fields');
    }
    // Defensive defaults for optional arrays
    data.concepts ??= [];
    data.contracts ??= [];
    data.flows ??= [];
    data.concerns ??= [];
    return data;
  }
}
