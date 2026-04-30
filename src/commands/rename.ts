import { CotxStore } from '../store/store.js';
import { rebuildDerivedIndex } from '../store/derived-index.js';
import { CotxGraph } from '../query/graph-index.js';
import type { ConceptNode, ContractNode, FlowNode } from '../store/schema.js';

type Layer = 'module' | 'concept' | 'contract' | 'flow';

export async function commandRename(
  projectRoot: string,
  layer: string,
  oldId: string,
  newId: string,
): Promise<{ success: boolean; message: string; updatedFiles: string[] }> {
  const store = new CotxStore(projectRoot);
  if (!store.exists()) {
    return { success: false, message: 'No .cotx/ found.', updatedFiles: [] };
  }

  const validLayers: Layer[] = ['module', 'concept', 'contract', 'flow'];
  if (!validLayers.includes(layer as Layer)) {
    return {
      success: false,
      message: `Invalid layer: ${layer}. Use: ${validLayers.join(', ')}`,
      updatedFiles: [],
    };
  }

  if (layer === 'module') {
    return renameModule(store, oldId, newId);
  } else if (layer === 'concept') {
    return renameSimple(store, 'concept', oldId, newId, (data) => {
      data.id = newId;
      return data;
    });
  } else if (layer === 'contract') {
    return renameSimple(store, 'contract', oldId, newId, (data) => {
      data.id = newId;
      return data;
    });
  } else {
    // flow
    return renameSimple(store, 'flow', oldId, newId, (data) => {
      data.id = newId;
      return data;
    });
  }
}

function renameSimple(
  store: CotxStore,
  layer: Exclude<Layer, 'module'>,
  oldId: string,
  newId: string,
  transform: (data: Record<string, unknown>) => Record<string, unknown>,
): { success: boolean; message: string; updatedFiles: string[] } {
  const list = semanticList(store, layer);

  if (!list.includes(oldId)) {
    return { success: false, message: `${layer}/${oldId} not found`, updatedFiles: [] };
  }
  if (list.includes(newId)) {
    return { success: false, message: `${layer}/${newId} already exists`, updatedFiles: [] };
  }

  const data = semanticRead(store, layer, oldId) as unknown as Record<string, unknown>;
  const transformed = transform(data);
  semanticWrite(store, layer, transformed);
  store.deleteSemanticNode(layer, oldId);
  rebuildDerivedIndex(store);
  CotxGraph.invalidateCache();

  return {
    success: true,
    message: `Renamed ${layer}/${oldId} → ${newId}`,
    updatedFiles: [`v2/truth.lbug#semantic/${layer}/${newId}`],
  };
}

function renameModule(
  store: CotxStore,
  oldId: string,
  newId: string,
): { success: boolean; message: string; updatedFiles: string[] } {
  if (!store.listModules().includes(oldId)) {
    return { success: false, message: `Module "${oldId}" not found`, updatedFiles: [] };
  }
  if (store.listModules().includes(newId)) {
    return { success: false, message: `Module "${newId}" already exists`, updatedFiles: [] };
  }

  const updatedFiles: string[] = [];

  // 1. Rename module artifact — update id, then delete old artifact key
  const mod = store.readModule(oldId);
  mod.id = newId;
  store.writeModule(mod);
  store.deleteSemanticNode('module', oldId);
  updatedFiles.push(`v2/truth.lbug#semantic/module/${newId}`);

  // 2. Update other modules' depends_on / depended_by
  for (const id of store.listModules()) {
    if (id === newId) continue;
    const other = store.readModule(id);
    let changed = false;
    const depIdx = other.depends_on?.indexOf(oldId) ?? -1;
    if (depIdx >= 0) {
      other.depends_on[depIdx] = newId;
      changed = true;
    }
    const revIdx = other.depended_by?.indexOf(oldId) ?? -1;
    if (revIdx >= 0) {
      other.depended_by[revIdx] = newId;
      changed = true;
    }
    if (changed) {
      store.writeModule(other);
      updatedFiles.push(`v2/truth.lbug#semantic/module/${id}`);
    }
  }

  // 3. Update contracts referencing this module
  for (const id of store.listContracts()) {
    const contract = store.readContract(id);
    let changed = false;
    if (contract.provider === oldId) {
      contract.provider = newId;
      changed = true;
    }
    if (contract.consumer === oldId) {
      contract.consumer = newId;
      changed = true;
    }
    if (changed) {
      // Also rename the contract file if its id embeds the old module name
      const newContractId = contract.id.replace(oldId, newId);
      if (newContractId !== contract.id) {
        const oldContractId = contract.id;
        contract.id = newContractId;
        store.writeContract(contract);
        store.deleteSemanticNode('contract', oldContractId);
        updatedFiles.push(`v2/truth.lbug#semantic/contract/${newContractId}`);
      } else {
        store.writeContract(contract);
        updatedFiles.push(`v2/truth.lbug#semantic/contract/${contract.id}`);
      }
    }
  }

  // 4. Update flows with steps referencing this module
  for (const id of store.listFlows()) {
    const flow = store.readFlow(id);
    let changed = false;
    if (flow.steps) {
      for (const step of flow.steps) {
        if (step.module === oldId) {
          step.module = newId;
          changed = true;
        }
      }
    }
    if (changed) {
      store.writeFlow(flow);
      updatedFiles.push(`v2/truth.lbug#semantic/flow/${id}`);
    }
  }

  // 5. Update concepts with layer referencing this module
  for (const id of store.listConcepts()) {
    const concept = store.readConcept(id);
    if (concept.layer === oldId) {
      concept.layer = newId;
      store.writeConcept(concept);
      updatedFiles.push(`v2/truth.lbug#semantic/concept/${id}`);
    }
  }

  rebuildDerivedIndex(store);
  CotxGraph.invalidateCache();

  return {
    success: true,
    message: `Renamed module "${oldId}" → "${newId}" (${updatedFiles.length} files updated)`,
    updatedFiles,
  };
}

function semanticList(store: CotxStore, layer: Exclude<Layer, 'module'>): string[] {
  if (layer === 'concept') return store.listConcepts();
  if (layer === 'contract') return store.listContracts();
  return store.listFlows();
}

function semanticRead(store: CotxStore, layer: Exclude<Layer, 'module'>, id: string): ConceptNode | ContractNode | FlowNode {
  if (layer === 'concept') return store.readConcept(id);
  if (layer === 'contract') return store.readContract(id);
  return store.readFlow(id);
}

function semanticWrite(store: CotxStore, layer: Exclude<Layer, 'module'>, data: Record<string, unknown>): void {
  if (layer === 'concept') {
    store.writeConcept(data as unknown as ConceptNode);
  } else if (layer === 'contract') {
    store.writeContract(data as unknown as ContractNode);
  } else {
    store.writeFlow(data as unknown as FlowNode);
  }
}
