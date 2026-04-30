import { isTestFile } from '../core/parser/entry-point-scoring.js';

export type DecisionRole =
  | 'prod_core'
  | 'prod_entrypoint'
  | 'test'
  | 'example'
  | 'dev_tool'
  | 'generated'
  | 'peripheral';

export interface InferredRole {
  role: DecisionRole;
  confidence: number;
}

interface RoleInput {
  filePath: string;
  moduleId: string;
  entryPointScore: number;
  externalRefs: number;
  processRefs: number;
  contractRefs: number;
}

const EXAMPLE_SEGMENTS = ['/example/', '/examples/', '/demo/', '/demos/', '/sample/', '/samples/', '/playground/'];
const TOOLING_SEGMENTS = ['/scripts/', '/script/', '/xtask/', '/hack/', '/tooling/', '/benchmarks/'];
const GENERATED_SEGMENTS = ['/generated/', '/gen/'];
const PERIPHERAL_SEGMENTS = ['/default-plugins/', '/plugins/'];

export function inferScopeHint(moduleId: string, filePath?: string): string {
  if (!filePath) return moduleId;
  const parts = filePath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length === 0) return moduleId;

  if (parts[0] === moduleId) {
    if (parts[1] && ['src', 'app', 'lib'].includes(parts[1]) && parts[2]) {
      return `${parts[0]}/${parts[2]}`;
    }
    if (parts[1]) return `${parts[0]}/${parts[1]}`;
    return moduleId;
  }

  if (['src', 'app', 'lib', 'pkg', 'internal', 'cmd'].includes(parts[0]) && parts[1]) {
    return `${parts[0]}/${parts[1]}`;
  }

  return moduleId;
}

function hasAnySegment(filePath: string, segments: string[]): boolean {
  const normalized = `/${filePath.toLowerCase().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')}/`;
  return segments.some((segment) => normalized.includes(segment));
}

export function inferRole(input: RoleInput): InferredRole {
  const normalized = input.filePath.toLowerCase().replace(/\\/g, '/');

  if (isTestFile(input.filePath)) {
    return { role: 'test', confidence: 0.98 };
  }
  if (hasAnySegment(normalized, GENERATED_SEGMENTS) || normalized.endsWith('.pb.go') || normalized.endsWith('_pb2.py')) {
    return { role: 'generated', confidence: 0.95 };
  }
  if (hasAnySegment(normalized, EXAMPLE_SEGMENTS)) {
    return { role: 'example', confidence: 0.92 };
  }
  if (hasAnySegment(normalized, TOOLING_SEGMENTS)) {
    return { role: 'dev_tool', confidence: 0.9 };
  }
  if (hasAnySegment(normalized, PERIPHERAL_SEGMENTS)) {
    return { role: 'peripheral', confidence: 0.85 };
  }

  const structuralScore =
    Math.min(1, input.externalRefs / 6) * 0.35 +
    Math.min(1, input.processRefs / 4) * 0.35 +
    Math.min(1, input.contractRefs / 3) * 0.2 +
    Math.min(1, input.entryPointScore / 4) * 0.1;

  const scopeHint = inferScopeHint(input.moduleId, input.filePath);
  const looksLikeEntrypoint =
    input.entryPointScore > 1.3 ||
    scopeHint.includes('/server') ||
    scopeHint.includes('/client') ||
    scopeHint.includes('/cli') ||
    normalized.endsWith('/main.py') ||
    normalized.endsWith('/main.go') ||
    normalized.endsWith('/main.rs') ||
    normalized.endsWith('/__main__.py');

  if (looksLikeEntrypoint && (structuralScore >= 0.25 || input.entryPointScore >= 1.5)) {
    return { role: 'prod_entrypoint', confidence: Number((0.65 + structuralScore * 0.3).toFixed(3)) };
  }
  if (structuralScore >= 0.28) {
    return { role: 'prod_core', confidence: Number((0.55 + structuralScore * 0.35).toFixed(3)) };
  }
  return { role: 'peripheral', confidence: Number((0.45 + structuralScore * 0.2).toFixed(3)) };
}

export function roleWeight(role: DecisionRole): number {
  switch (role) {
    case 'prod_core':
      return 1;
    case 'prod_entrypoint':
      return 0.95;
    case 'peripheral':
      return 0.45;
    case 'example':
      return 0.18;
    case 'dev_tool':
      return 0.14;
    case 'generated':
      return 0.08;
    case 'test':
      return 0.05;
  }
}
