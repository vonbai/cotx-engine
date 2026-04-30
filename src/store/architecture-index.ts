// src/store/architecture-index.ts
import { BM25Index } from '../query/bm25.js';
import type { ArchitectureStore } from './architecture-store.js';
import { extendArray } from '../core/shared/array-utils.js';

export interface ArchitectureSearchResult {
  id: string;       // e.g. 'architecture/overall-architecture/store'
  score: number;
  kind: 'perspective' | 'element';
}

interface ArchitectureSearchDoc {
  id: string;
  text: string;
  kind: 'perspective' | 'element';
}

export class ArchitectureIndex {
  private bm25: BM25Index;
  private docs: ArchitectureSearchDoc[];

  private constructor(docs: ArchitectureSearchDoc[]) {
    this.docs = docs;
    this.bm25 = new BM25Index(docs.map((d) => ({ id: d.id, text: d.text })));
  }

  static fromStore(archStore: ArchitectureStore): ArchitectureIndex {
    const docs: ArchitectureSearchDoc[] = [];

    for (const perspId of archStore.listPerspectives()) {
      let perspectiveData;
      try {
        perspectiveData = archStore.readPerspective(perspId);
      } catch {
        continue;
      }

      // Perspective-level document
      const perspDesc = archStore.readDescription(perspId) ?? '';
      docs.push({
        id: `architecture/${perspId}`,
        text: [perspectiveData.label, perspDesc].filter(Boolean).join(' '),
        kind: 'perspective',
      });

      // Top-level components + nested element documents
      const elementPaths = [
        ...perspectiveData.components.map((c) => c.id),
        ...archStore.listElementPaths(perspId),
      ];
      const uniquePaths = [...new Set(elementPaths)].sort();

      for (const elementPath of uniquePaths) {
        let component;
        try {
          component = archStore.readElement(perspId, elementPath);
        } catch {
          // Top-level leaf/group may exist only in perspective.components until written explicitly
          component = perspectiveData.components.find((c) => c.id === elementPath);
          if (!component) continue;
        }

        const parts: string[] = [
          component.label,
          component.directory,
        ];
        if (component.files) extendArray(parts, component.files);
        if (component.exported_functions) extendArray(parts, component.exported_functions);
        if (component.contracts_provided) extendArray(parts, component.contracts_provided);
        if (component.contracts_consumed) extendArray(parts, component.contracts_consumed);
        if (component.related_flows) extendArray(parts, component.related_flows);

        const elemDesc = archStore.readDescription(`${perspId}/${elementPath}`);
        if (elemDesc) parts.push(elemDesc);

        docs.push({
          id: `architecture/${perspId}/${elementPath}`,
          text: parts.join(' '),
          kind: 'element',
        });
      }
    }

    return new ArchitectureIndex(docs);
  }

  search(query: string, limit = 20): ArchitectureSearchResult[] {
    const raw = this.bm25.search(query, limit, 0.5);
    return raw.map((r) => {
      const doc = this.docs.find((d) => d.id === r.id)!;
      return { id: r.id, score: r.score, kind: doc.kind };
    });
  }
}
