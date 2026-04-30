/**
 * Complexity Analyzer
 *
 * Walks function/method nodes from the raw graph, re-parses their source
 * files with tree-sitter, and computes per-function complexity metrics:
 *   - cyclomatic complexity (branch count + 1)
 *   - max nesting depth (deepest branch ancestor chain)
 *   - lines of code
 *
 * Aggregates per-module and writes ComplexityMetrics to each ModuleNode.
 */

import fs from 'node:fs';
import path from 'node:path';
import Parser from 'tree-sitter';
import type { GraphNode } from '../core/export/json-exporter.js';
import type { ModuleNode, ComplexityMetrics } from '../store/schema.js';
import { getLanguageFromFilename } from '../core/shared/index.js';
import { isLanguageAvailable, loadParser, loadLanguage } from '../core/tree-sitter/parser-loader.js';
import { getTreeSitterBufferSize } from '../core/parser/constants.js';
import { extendArray } from '../core/shared/array-utils.js';

/** AST node types that contribute to cyclomatic complexity. */
const BRANCH_NODE_TYPES = new Set([
  'if_statement', 'if_expression',
  'for_statement', 'for_in_statement', 'for_expression',
  'while_statement', 'while_expression',
  'do_statement',
  'switch_case', 'match_arm',        // each case/arm is a branch
  'catch_clause', 'except_clause',
  'ternary_expression', 'conditional_expression',
  'binary_expression',                // checked for && / || below
  'logical_expression',               // JS/TS: uses this node type
]);

/** Node types that represent logical AND/OR operators in binary/logical expressions. */
function isShortCircuitOp(node: Parser.SyntaxNode): boolean {
  if (node.type === 'binary_expression' || node.type === 'logical_expression') {
    const opNode = node.childForFieldName('operator');
    const op = opNode?.text ?? '';
    return op === '&&' || op === '||' || op === 'and' || op === 'or';
  }
  return false;
}

/** Node types that create nesting depth (control structures). */
const NESTING_NODE_TYPES = new Set([
  'if_statement', 'if_expression',
  'for_statement', 'for_in_statement', 'for_expression',
  'while_statement', 'while_expression',
  'do_statement',
  'switch_statement', 'match_expression',
  'try_statement',
]);

/** Node types that represent function definitions. */
const FUNCTION_NODE_TYPES = new Set([
  'function_declaration', 'function_definition',
  'method_definition', 'method_declaration',
  'arrow_function',
  'function_item',         // Rust
  'function_expression',
]);

interface FunctionComplexity {
  name: string;
  cyclomatic: number;
  nestingDepth: number;
  loc: number;
}

/**
 * Walk an AST subtree counting branch nodes for cyclomatic complexity
 * and tracking max nesting depth.
 */
function walkForComplexity(node: Parser.SyntaxNode): { cyclomatic: number; maxNesting: number } {
  let branchCount = 0;
  let maxNesting = 0;

  function walk(current: Parser.SyntaxNode, depth: number): void {
    let newDepth = depth;

    if (BRANCH_NODE_TYPES.has(current.type)) {
      if (current.type === 'binary_expression' || current.type === 'logical_expression') {
        if (isShortCircuitOp(current)) {
          branchCount++;
        }
      } else {
        branchCount++;
      }
    }

    if (NESTING_NODE_TYPES.has(current.type)) {
      newDepth = depth + 1;
      if (newDepth > maxNesting) maxNesting = newDepth;
    }

    for (let i = 0; i < current.childCount; i++) {
      walk(current.child(i)!, newDepth);
    }
  }

  walk(node, 0);
  return { cyclomatic: branchCount + 1, maxNesting };
}

/**
 * Analyze complexity for a single parsed source file.
 * Returns per-function complexity for functions matching the given startLines.
 */
function analyzeFile(
  tree: Parser.Tree,
  targetFunctions: Array<{ name: string; startLine: number; endLine: number }>,
): FunctionComplexity[] {
  const results: FunctionComplexity[] = [];

  // Find all function nodes in the AST
  const functionNodes: Parser.SyntaxNode[] = [];
  function collectFunctions(node: Parser.SyntaxNode): void {
    if (FUNCTION_NODE_TYPES.has(node.type)) {
      functionNodes.push(node);
    }
    for (let i = 0; i < node.childCount; i++) {
      collectFunctions(node.child(i)!);
    }
  }
  collectFunctions(tree.rootNode);

  // Match each target function to its AST node. Graph extraction may use a
  // decorator line or a 0-based start line for some languages, so require a
  // name match when possible and tolerate small start-line offsets.
  for (const target of targetFunctions) {
    const astNode = findFunctionNode(functionNodes, target);
    if (!astNode) continue;

    const body = astNode.childForFieldName('body') ?? astNode;
    const { cyclomatic, maxNesting } = walkForComplexity(body);
    const loc = (target.endLine - target.startLine) + 1;

    results.push({
      name: target.name,
      cyclomatic,
      nestingDepth: maxNesting,
      loc,
    });
  }

  return results;
}

function findFunctionNode(
  functionNodes: Parser.SyntaxNode[],
  target: { name: string; startLine: number; endLine: number },
): Parser.SyntaxNode | null {
  const targetName = target.name.split('.').at(-1) ?? target.name;
  const named = functionNodes.filter((node) => functionNodeName(node) === targetName);
  const candidates = named.length > 0 ? named : functionNodes;
  const scored = candidates
    .map((node) => ({
      node,
      lineDistance: Math.min(
        Math.abs(node.startPosition.row - (target.startLine - 1)),
        Math.abs(node.startPosition.row - target.startLine),
      ),
      endDistance: Math.min(
        Math.abs(node.endPosition.row - (target.endLine - 1)),
        Math.abs(node.endPosition.row - target.endLine),
      ),
      nameMatches: functionNodeName(node) === targetName,
    }))
    .sort((left, right) => Number(right.nameMatches) - Number(left.nameMatches) ||
      left.lineDistance - right.lineDistance ||
      left.endDistance - right.endDistance);
  const best = scored[0];
  if (!best) return null;
  if (best.lineDistance <= 2 || (best.nameMatches && best.lineDistance <= 10)) return best.node;
  return null;
}

function functionNodeName(node: Parser.SyntaxNode): string | null {
  return node.childForFieldName('name')?.text ?? null;
}

/**
 * Main entry point: compute complexity metrics for all modules.
 *
 * @param projectRoot - absolute path to project root (for reading source files)
 * @param nodes - raw graph nodes (GraphNode[])
 * @param modules - compiled module nodes (ModuleNode[])
 * @returns modules with complexity field populated
 */
export async function analyzeComplexity(
  projectRoot: string,
  nodes: GraphNode[],
  modules: ModuleNode[],
): Promise<void> {
  // Step 1: Identify function/method nodes with line info, grouped by file
  const fileToFunctions = new Map<string, Array<{ nodeId: string; name: string; startLine: number; endLine: number }>>();

  for (const node of nodes) {
    const label = node.label;
    if (label !== 'Function' && label !== 'Method') continue;

    const filePath = node.properties.filePath as string | undefined;
    const name = node.properties.name as string | undefined;
    const startLine = node.properties.startLine as number | undefined;
    const endLine = node.properties.endLine as number | undefined;

    if (!filePath || !name || !startLine || !endLine) continue;

    const existing = fileToFunctions.get(filePath) ?? [];
    existing.push({ nodeId: node.id, name, startLine, endLine });
    fileToFunctions.set(filePath, existing);
  }

  // Step 2: Build file → module mapping
  const fileToModule = new Map<string, string>();
  for (const mod of modules) {
    for (const f of mod.files) {
      fileToModule.set(f, mod.id);
    }
  }

  // Step 3: Parse each file and compute complexity
  const moduleComplexities = new Map<string, FunctionComplexity[]>();

  // Accumulator for per-function complexity data (written to graph/complexity.json)
  const allFunctionComplexities: Record<string, {
    cyclomatic: number;
    nestingDepth: number;
    loc: number;
    filePath: string;
    name: string;
  }> = {};

  const parser = await loadParser();
  let currentParserLanguageKey = '';

  for (const [filePath, functions] of fileToFunctions) {
    const language = getLanguageFromFilename(filePath);
    if (!language || !isLanguageAvailable(language)) continue;

    const absPath = path.join(projectRoot, filePath);
    if (!fs.existsSync(absPath)) continue;

    const content = fs.readFileSync(absPath, 'utf-8');

    try {
      const parserLanguageKey = `${language}:${filePath.endsWith('.tsx') ? 'tsx' : ''}`;
      if (currentParserLanguageKey !== parserLanguageKey) {
        await loadLanguage(language, filePath);
        currentParserLanguageKey = parserLanguageKey;
      }
      const tree = parser.parse(content, undefined, {
        bufferSize: getTreeSitterBufferSize(content.length),
      });

      const results = analyzeFile(tree, functions);

      // Collect per-function data for graph/complexity.json
      for (const result of results) {
        const key = `${filePath}:${result.name}`;
        allFunctionComplexities[key] = {
          cyclomatic: result.cyclomatic,
          nestingDepth: result.nestingDepth,
          loc: result.loc,
          filePath,
          name: result.name,
        };
      }

      // Group results by module
      const modId = fileToModule.get(filePath);
      if (!modId) continue;

      const existing = moduleComplexities.get(modId) ?? [];
      extendArray(existing, results);
      moduleComplexities.set(modId, existing);
    } catch {
      // Skip files that can't be parsed
      continue;
    }
  }

  // Step 4: Aggregate per-module and write to ModuleNode
  for (const mod of modules) {
    const functions = moduleComplexities.get(mod.id);
    if (!functions || functions.length === 0) continue;

    const totalFunctions = functions.length;
    const maxNestingDepth = Math.max(...functions.map((f) => f.nestingDepth));
    const avgNestingDepth = parseFloat(
      (functions.reduce((sum, f) => sum + f.nestingDepth, 0) / totalFunctions).toFixed(2),
    );
    const maxCyclomatic = Math.max(...functions.map((f) => f.cyclomatic));
    const avgCyclomatic = parseFloat(
      (functions.reduce((sum, f) => sum + f.cyclomatic, 0) / totalFunctions).toFixed(2),
    );
    const maxFunctionLoc = Math.max(...functions.map((f) => f.loc));

    // Hotspot score = nesting_depth * cyclomatic
    const scored = functions
      .map((f) => ({ name: f.name, score: f.nestingDepth * f.cyclomatic }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((f) => f.name);

    mod.complexity = {
      total_functions: totalFunctions,
      max_nesting_depth: maxNestingDepth,
      avg_nesting_depth: avgNestingDepth,
      max_cyclomatic: maxCyclomatic,
      avg_cyclomatic: avgCyclomatic,
      max_function_loc: maxFunctionLoc,
      hotspot_functions: scored,
    };
  }

  // Step 5: Write per-function complexity to graph/complexity.json
  const graphDir = path.join(projectRoot, '.cotx', 'graph');
  if (fs.existsSync(graphDir)) {
    fs.writeFileSync(
      path.join(graphDir, 'complexity.json'),
      JSON.stringify(allFunctionComplexities, null, 2),
      'utf-8',
    );
  }
}
