import { CotxStore } from '../store/store.js';
import { walkRepositoryPaths } from '../core/parser/filesystem-walker.js';
import { getLanguageFromFilename } from '../core/shared/language-detection.js';
import fs from 'node:fs';
import path from 'node:path';

export interface LintIssue {
  level: 'ERROR' | 'WARN' | 'INFO';
  type: string;
  node_id: string;
  layer: string;
  message: string;
}

export async function commandLint(
  projectRoot: string,
  options: { json?: boolean; strict?: boolean; silent?: boolean; fix?: boolean },
): Promise<LintIssue[]> {
  const store = new CotxStore(projectRoot);
  if (!store.exists()) {
    if (!options.silent) console.log('No .cotx/ found. Run: cotx compile');
    return [];
  }

  let issues: LintIssue[] = [];

  // Single bulk read of every semantic layer. The previous implementation
  // repeated listX().forEach(readX(id)) seven times; on repos with >1000
  // semantic nodes that routinely pushed cotx_lint past the 120 s MCP
  // timeout (observed on autoresearch). One read per layer caps the lint
  // wall-time at O(total nodes) regardless of how many rules run.
  const { modules, concepts, contracts, flows } = store.loadAllSemanticArtifacts();

  // Check modules: MISSING_FILE + STALE_ENRICHMENT
  for (const mod of modules) {
    for (const file of mod.files ?? []) {
      const fullPath = path.join(projectRoot, file);
      if (!fs.existsSync(fullPath)) {
        issues.push({
          level: 'ERROR',
          type: 'MISSING_FILE',
          node_id: mod.id,
          layer: 'module',
          message: `Module "${mod.id}" references missing file: ${file}`,
        });
      }
    }
    if (mod.enriched && mod.enriched.source_hash !== mod.struct_hash) {
      issues.push({
        level: 'WARN',
        type: 'STALE_ENRICHMENT',
        node_id: mod.id,
        layer: 'module',
        message: `Module "${mod.id}" enrichment is stale (source_hash ${mod.enriched.source_hash} ≠ struct_hash ${mod.struct_hash})`,
      });
    }
  }

  for (const concept of concepts) {
    if (concept.enriched && concept.enriched.source_hash !== concept.struct_hash) {
      issues.push({ level: 'WARN', type: 'STALE_ENRICHMENT', node_id: concept.id, layer: 'concept', message: `Concept "${concept.id}" enrichment is stale` });
    }
  }
  for (const contract of contracts) {
    if (contract.enriched && contract.enriched.source_hash !== contract.struct_hash) {
      issues.push({ level: 'WARN', type: 'STALE_ENRICHMENT', node_id: contract.id, layer: 'contract', message: `Contract "${contract.id}" enrichment is stale` });
    }
  }
  for (const flow of flows) {
    if (flow.enriched && flow.enriched.source_hash !== flow.struct_hash) {
      issues.push({ level: 'WARN', type: 'STALE_ENRICHMENT', node_id: flow.id, layer: 'flow', message: `Flow "${flow.id}" enrichment is stale` });
    }
  }

  // ── 3. STALE_ANNOTATION ───────────────────────────────────────────────────
  const annotationLayers: Array<{ nodes: Array<{ id: string; annotations?: Array<{ stale?: boolean; stale_reason?: string }> }>; layer: string }> = [
    { nodes: modules, layer: 'module' },
    { nodes: concepts, layer: 'concept' },
    { nodes: contracts, layer: 'contract' },
    { nodes: flows, layer: 'flow' },
  ];
  for (const { nodes, layer } of annotationLayers) {
    for (const node of nodes) {
      if (!node.annotations) continue;
      for (let i = 0; i < node.annotations.length; i++) {
        if (node.annotations[i].stale) {
          issues.push({
            level: 'WARN',
            type: 'STALE_ANNOTATION',
            node_id: node.id,
            layer,
            message: `Annotation ${i} on "${node.id}" is stale: ${node.annotations[i].stale_reason ?? 'unknown reason'}`,
          });
        }
      }
    }
  }

  // ── 4. ORPHAN_MODULE ──────────────────────────────────────────────────────
  for (const mod of modules) {
    if (mod.id === '_root') continue;
    if ((mod.files?.length ?? 0) > 0 && (mod.depends_on?.length ?? 0) === 0 && (mod.depended_by?.length ?? 0) === 0) {
      issues.push({
        level: 'INFO',
        type: 'ORPHAN_MODULE',
        node_id: mod.id,
        layer: 'module',
        message: `Module "${mod.id}" has no dependencies or dependents (isolated)`,
      });
    }
  }

  // ── 5. UNCOVERED_FILE ─────────────────────────────────────────────────────
  const claimedFiles = new Set<string>();
  for (const mod of modules) for (const f of mod.files ?? []) claimedFiles.add(f);

  const allSourceFiles = (await walkRepositoryPaths(projectRoot))
    .map((file) => file.path)
    .filter((file) => getLanguageFromFilename(file) !== null);

  let uncoveredCount = 0;
  for (const file of allSourceFiles) {
    if (!claimedFiles.has(file)) {
      uncoveredCount++;
      if (uncoveredCount <= 20) {
        issues.push({
          level: 'INFO',
          type: 'UNCOVERED_FILE',
          node_id: file,
          layer: 'module',
          message: `Source file not claimed by any module: ${file}`,
        });
      }
    }
  }
  if (uncoveredCount > 20) {
    issues.push({
      level: 'INFO',
      type: 'UNCOVERED_FILE',
      node_id: '_summary',
      layer: 'module',
      message: `${uncoveredCount - 20} more uncovered source files (only first 20 shown)`,
    });
  }

  // ── 6. MISSING_CONCEPT_REF ────────────────────────────────────────────────
  for (const concept of concepts) {
    for (const file of concept.appears_in ?? []) {
      if (!fs.existsSync(path.join(projectRoot, file))) {
        issues.push({
          level: 'WARN',
          type: 'MISSING_CONCEPT_REF',
          node_id: concept.id,
          layer: 'concept',
          message: `Concept "${concept.id}" references missing file: ${file}`,
        });
      }
    }
  }

  // ── 7. CONTRACT_MODULE_MISSING ────────────────────────────────────────────
  const moduleSet = new Set(modules.map((m) => m.id));
  for (const contract of contracts) {
    if (!moduleSet.has(contract.provider)) {
      issues.push({ level: 'ERROR', type: 'CONTRACT_MODULE_MISSING', node_id: contract.id, layer: 'contract', message: `Contract "${contract.id}" references missing provider module: ${contract.provider}` });
    }
    if (!moduleSet.has(contract.consumer)) {
      issues.push({ level: 'ERROR', type: 'CONTRACT_MODULE_MISSING', node_id: contract.id, layer: 'contract', message: `Contract "${contract.id}" references missing consumer module: ${contract.consumer}` });
    }
  }

  // ── 8. FLOW_MODULE_MISSING ────────────────────────────────────────────────
  for (const flow of flows) {
    for (const step of flow.steps ?? []) {
      if (step.module && !moduleSet.has(step.module)) {
        issues.push({ level: 'WARN', type: 'FLOW_MODULE_MISSING', node_id: flow.id, layer: 'flow', message: `Flow "${flow.id}" step references missing module: ${step.module}` });
        break;
      }
    }
  }

  // ── Staleness threshold ───────────────────────────────────────────────────
  const totalModules = modules.length;
  const modulesWithMissingFiles = new Set(issues.filter((i) => i.type === 'MISSING_FILE').map((i) => i.node_id)).size;
  const stalenessPercent = totalModules > 0 ? Math.round((modulesWithMissingFiles / totalModules) * 100) : 0;

  if (stalenessPercent > 30) {
    issues.push({
      level: 'WARN',
      type: 'HIGH_STALENESS',
      node_id: '_map',
      layer: 'module',
      message: `Map staleness: HIGH (${stalenessPercent}% of modules have missing files). Run cotx compile for full recompile.`,
    });
  }

  // ── --fix: remove broken file references ─────────────────────────────────
  if (options.fix) {
    const fixableIssues = issues.filter(i => i.type === 'MISSING_FILE');
    for (const issue of fixableIssues) {
      const mod = store.readModule(issue.node_id);
      const missingFile = issue.message.match(/missing file: (.+)$/)?.[1];
      if (missingFile) {
        mod.files = mod.files.filter(f => f !== missingFile);
        store.writeModule(mod);
      }
    }
    const fixedCount = fixableIssues.length;
    issues = issues.filter(i => i.type !== 'MISSING_FILE');
    if (!options.silent) {
      console.log(`Fixed ${fixedCount} MISSING_FILE issues.`);
    }
  }

  // ── Sort: ERROR > WARN > INFO ─────────────────────────────────────────────
  const levelOrder = { ERROR: 0, WARN: 1, INFO: 2 };
  issues.sort((a, b) => levelOrder[a.level] - levelOrder[b.level]);

  // Output
  if (!options.silent) {
    if (options.json) {
      console.log(JSON.stringify(issues, null, 2));
    } else {
      if (issues.length === 0) {
        console.log('No issues found.');
      } else {
        const errors = issues.filter((i) => i.level === 'ERROR').length;
        const warnings = issues.filter((i) => i.level === 'WARN').length;
        console.log(`Found ${issues.length} issues (${errors} errors, ${warnings} warnings):\n`);
        for (const issue of issues) {
          console.log(
            `  ${issue.level}  [${issue.layer}/${issue.node_id}] ${issue.type}: ${issue.message}`,
          );
        }
      }
    }
  }

  // Strict mode: exit 1 on any ERROR
  if (options.strict && issues.some((i) => i.level === 'ERROR')) {
    process.exitCode = 1;
  }

  store.appendLog({
    operation: 'lint',
    summary: `${issues.length} issues (${issues.filter(i => i.level === 'ERROR').length} errors)`,
  });

  return issues;
}
