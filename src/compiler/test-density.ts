/**
 * Test Density Analyzer
 *
 * Identifies test files by naming pattern (*.test.*, *.spec.*, test/**, __tests__/**),
 * reads their imports from the raw graph, and computes what percentage of each
 * module's exported symbols are referenced by test files.
 *
 * Result: a number 0.0-1.0 representing test density per module.
 */

import type { GraphNode, GraphEdge } from '../core/export/json-exporter.js';
import type { ModuleNode } from '../store/schema.js';

const TEST_FILE_PATTERNS = [
  /\.test\./,
  /\.spec\./,
  /\/__tests__\//,
  /^test\//,
  /^tests\//,
  /_test\./,           // Go convention
  /test_.*\./,         // Python convention
];

function isTestFile(filePath: string): boolean {
  return TEST_FILE_PATTERNS.some((p) => p.test(filePath));
}

/**
 * Compute test density for each module.
 *
 * Test density = (number of module files referenced by test IMPORTS edges)
 *                / (total module files)
 *
 * @returns Map<moduleId, testDensity (0.0-1.0)>
 */
export function analyzeTestDensity(
  nodes: GraphNode[],
  edges: GraphEdge[],
  modules: ModuleNode[],
): Map<string, number> {
  // Step 1: Identify test file node IDs
  const testNodeIds = new Set<string>();
  const testFiles = new Set<string>();

  for (const node of nodes) {
    const fp = node.properties.filePath as string | undefined;
    if (fp && isTestFile(fp)) {
      testNodeIds.add(node.id);
      testFiles.add(fp);
    }
  }

  // Step 2: Find which non-test files are IMPORTED by test files
  const testedFiles = new Set<string>();

  for (const edge of edges) {
    if (edge.type !== 'IMPORTS') continue;

    // If source is a test node and target is a non-test node
    if (testNodeIds.has(edge.sourceId)) {
      const targetNode = nodes.find((n) => n.id === edge.targetId);
      if (targetNode) {
        const fp = targetNode.properties.filePath as string | undefined;
        if (fp && !isTestFile(fp)) {
          testedFiles.add(fp);
        }
      }
    }
  }

  // Step 3: Compute per-module test density
  const result = new Map<string, number>();

  for (const mod of modules) {
    // Filter out test files from module's own files
    const nonTestFiles = mod.files.filter((f) => !isTestFile(f));
    if (nonTestFiles.length === 0) {
      result.set(mod.id, 0);
      continue;
    }

    const testedCount = nonTestFiles.filter((f) => testedFiles.has(f)).length;
    const density = parseFloat((testedCount / nonTestFiles.length).toFixed(2));
    result.set(mod.id, density);
  }

  return result;
}
