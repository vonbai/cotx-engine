/**
 * Field extraction configuration for Ruby.
 *
 * Ruby does not have traditional field declarations. Accessible attributes
 * are declared via `attr_accessor`, `attr_reader`, and `attr_writer` calls
 * in the class body. Each call can list multiple symbol arguments, e.g.:
 *
 *   attr_accessor :foo, :bar, :baz
 *
 * We match `call` nodes inside `body_statement` and inspect the method name.
 * Instance variable assignments (`@var = ...`) would need deeper analysis
 * and are not extracted here.
 */

import { SupportedLanguages } from '../../../shared/index.js';
import type { FieldExtractionConfig } from '../generic.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

const ATTR_METHODS = new Set(['attr_accessor', 'attr_reader', 'attr_writer']);

/**
 * Given an attr_* call node, collect every symbol argument into a list of
 * field names (stripping the leading `:` from each symbol).
 */
function gatherSymbolNames(callNode: SyntaxNode): string[] {
  const methodChild = callNode.childForFieldName('method');
  if (!methodChild || !ATTR_METHODS.has(methodChild.text)) return [];

  const argsChild = callNode.childForFieldName('arguments');
  if (!argsChild) return [];

  const result: string[] = [];
  for (let idx = 0; idx < argsChild.namedChildCount; idx++) {
    const arg = argsChild.namedChild(idx);
    if (!arg) continue;
    const raw = arg.text;
    result.push(raw.startsWith(':') ? raw.slice(1) : raw);
  }
  return result;
}

export const rubyConfig: FieldExtractionConfig = {
  language: SupportedLanguages.Ruby,

  typeDeclarationNodes: ['class'],
  fieldNodeTypes: ['call'],
  bodyNodeTypes: ['body_statement'],
  defaultVisibility: 'public',

  extractName(callNode) {
    // Return first symbol name for the single-name interface contract.
    // Multi-name extraction is handled by extractNames below.
    const names = gatherSymbolNames(callNode);
    return names.length > 0 ? names[0] : undefined;
  },

  extractNames(callNode) {
    return gatherSymbolNames(callNode);
  },

  extractType() {
    // Standard Ruby has no type annotations
    return undefined;
  },

  extractVisibility() {
    // attr_* declarations are public by default
    return 'public';
  },

  isStatic() {
    return false;
  },

  isReadonly(callNode) {
    const methodChild = callNode.childForFieldName('method');
    return methodChild?.text === 'attr_reader';
  },
};
