// src/viz/types.ts
import type {
  ModuleNode,
  ConceptNode,
  ContractNode,
  FlowNode,
  ConcernNode,
} from '../store/schema.js';

export interface CotxGraphData {
  meta: { project: string; compiled_at: string; version: string };
  modules: ModuleNode[];
  concepts: ConceptNode[];
  contracts: ContractNode[];
  flows: FlowNode[];
  concerns: ConcernNode[];
  edges: CotxVizEdge[];
}

export interface CotxVizEdge {
  source: string;
  target: string;
  type: 'depends_on' | 'owns_concept' | 'contract' | 'step_in_flow' | 'affects' | 'temporal_coupling';
  label?: string;
}

export type ViewMode = 'architecture' | 'concepts' | 'dependencies' | 'flows';
