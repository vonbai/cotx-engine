// src/store/architecture-store.ts
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type {
  PerspectiveData,
  ArchitectureMeta,
  ArchitectureElement,
  ArchitectureWorkspaceData,
  ArchitectureEnrichmentJob,
  ArchitectureRecursionPlan,
  ArchitectureBoundaryReview,
} from './schema.js';

export class ArchitectureStore {
  private readonly archDir: string;

  constructor(projectRoot: string) {
    this.archDir = path.join(projectRoot, '.cotx', 'architecture');
  }

  private resolvePath(archPath: string): string {
    return path.join(this.archDir, archPath);
  }

  exists(): boolean {
    return fs.existsSync(path.join(this.archDir, 'meta.yaml'));
  }

  init(meta: ArchitectureMeta): void {
    fs.mkdirSync(this.archDir, { recursive: true });
    this.writeMeta(meta);
  }

  readMeta(): ArchitectureMeta {
    return yaml.load(fs.readFileSync(path.join(this.archDir, 'meta.yaml'), 'utf-8')) as ArchitectureMeta;
  }

  writeMeta(meta: ArchitectureMeta): void {
    fs.writeFileSync(path.join(this.archDir, 'meta.yaml'), yaml.dump(meta, { lineWidth: -1 }), 'utf-8');
  }

  listPerspectives(): string[] {
    return this.exists() ? this.readMeta().perspectives : [];
  }

  writeWorkspace(workspace: ArchitectureWorkspaceData): void {
    fs.mkdirSync(this.archDir, { recursive: true });
    fs.writeFileSync(
      path.join(this.archDir, 'workspace.json'),
      JSON.stringify(workspace, null, 2),
      'utf-8',
    );
  }

  readWorkspace(): ArchitectureWorkspaceData | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.archDir, 'workspace.json'), 'utf-8')) as ArchitectureWorkspaceData;
    } catch {
      return null;
    }
  }

  writeRecursionPlan(plan: ArchitectureRecursionPlan): void {
    fs.mkdirSync(this.archDir, { recursive: true });
    fs.writeFileSync(
      path.join(this.archDir, 'recursion-plan.json'),
      JSON.stringify(plan, null, 2),
      'utf-8',
    );
  }

  readRecursionPlan(): ArchitectureRecursionPlan | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.archDir, 'recursion-plan.json'), 'utf-8')) as ArchitectureRecursionPlan;
    } catch {
      return null;
    }
  }

  writeBoundaryReview(review: ArchitectureBoundaryReview): void {
    fs.mkdirSync(this.archDir, { recursive: true });
    fs.writeFileSync(
      path.join(this.archDir, 'boundary-review.json'),
      JSON.stringify(review, null, 2),
      'utf-8',
    );
  }

  readBoundaryReview(): ArchitectureBoundaryReview | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.archDir, 'boundary-review.json'), 'utf-8')) as ArchitectureBoundaryReview;
    } catch {
      return null;
    }
  }

  writeEnrichmentJob(job: ArchitectureEnrichmentJob): void {
    const dir = path.join(this.archDir, 'enrichment-jobs');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${encodeURIComponent(job.id)}.json`), JSON.stringify(job, null, 2), 'utf-8');
  }

  readEnrichmentJob(id: string): ArchitectureEnrichmentJob | null {
    try {
      return JSON.parse(
        fs.readFileSync(path.join(this.archDir, 'enrichment-jobs', `${encodeURIComponent(id)}.json`), 'utf-8'),
      ) as ArchitectureEnrichmentJob;
    } catch {
      return null;
    }
  }

  listEnrichmentJobs(): string[] {
    const dir = path.join(this.archDir, 'enrichment-jobs');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => decodeURIComponent(entry.name.replace(/\.json$/, '')))
      .sort();
  }

  writePerspective(perspective: PerspectiveData): void {
    const dir = this.resolvePath(perspective.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'data.yaml'), yaml.dump(perspective, { lineWidth: -1 }), 'utf-8');
  }

  readPerspective(perspectiveId: string): PerspectiveData {
    const perspective = yaml.load(
      fs.readFileSync(path.join(this.resolvePath(perspectiveId), 'data.yaml'), 'utf-8'),
    ) as PerspectiveData;

    perspective.components = perspective.components.map((component) => {
      try {
        return this.readElement(perspectiveId, component.id);
      } catch {
        return component;
      }
    });

    return perspective;
  }

  writeElement(perspectiveId: string, elementPath: string, element: ArchitectureElement): void {
    const dir = this.resolvePath(`${perspectiveId}/${elementPath}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'data.yaml'), yaml.dump(element, { lineWidth: -1 }), 'utf-8');
  }

  readElement(perspectiveId: string, elementPath: string): ArchitectureElement {
    const dir = this.resolvePath(`${perspectiveId}/${elementPath}`);
    return yaml.load(fs.readFileSync(path.join(dir, 'data.yaml'), 'utf-8')) as ArchitectureElement;
  }

  writeDescription(archPath: string, content: string): void {
    const dir = this.resolvePath(archPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'description.md'), content, 'utf-8');
  }

  readDescription(archPath: string): string | null {
    try {
      return fs.readFileSync(path.join(this.resolvePath(archPath), 'description.md'), 'utf-8');
    } catch {
      return null;
    }
  }

  writeDiagram(archPath: string, content: string): void {
    const dir = this.resolvePath(archPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'diagram.mmd'), content, 'utf-8');
  }

  readDiagram(archPath: string): string | null {
    try {
      return fs.readFileSync(path.join(this.resolvePath(archPath), 'diagram.mmd'), 'utf-8');
    } catch {
      return null;
    }
  }

  listChildren(archPath: string): string[] {
    const dir = this.resolvePath(archPath);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort();
  }

  listElementPaths(perspectiveId: string): string[] {
    const result: string[] = [];
    const walk = (prefix = ''): void => {
      const basePath = prefix ? `${perspectiveId}/${prefix}` : perspectiveId;
      for (const child of this.listChildren(basePath)) {
        const next = prefix ? `${prefix}/${child}` : child;
        result.push(next);
        walk(next);
      }
    };
    walk();
    return result;
  }

  listAllPaths(): string[] {
    const result: string[] = [];
    for (const perspectiveId of this.listPerspectives()) {
      result.push(perspectiveId);
      for (const elementPath of this.listElementPaths(perspectiveId)) {
        result.push(`${perspectiveId}/${elementPath}`);
      }
    }
    return result;
  }

  writeField(archPath: string, field: string, content: string): void {
    if (field === 'description') {
      this.writeDescription(archPath, content);
      return;
    }
    if (field === 'diagram') {
      this.writeDiagram(archPath, content);
      return;
    }
    if (field !== 'data') {
      throw new Error(`Unknown architecture field: ${field}. Use: description, diagram, data`);
    }

    const parsed = yaml.load(content) as PerspectiveData | ArchitectureElement;
    const [perspectiveId, ...rest] = archPath.split('/');
    if (rest.length === 0) {
      this.writePerspective(parsed as PerspectiveData);
    } else {
      this.writeElement(perspectiveId, rest.join('/'), parsed as ArchitectureElement);
    }
  }

  clear(): void {
    if (fs.existsSync(this.archDir)) fs.rmSync(this.archDir, { recursive: true, force: true });
  }
}
