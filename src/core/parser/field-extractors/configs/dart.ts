/**
 * Field extraction configuration for Dart.
 *
 * Dart fields appear as `declaration` nodes inside `class_body`. The
 * declaration typically nests:
 *   declaration > initialized_identifier_list > initialized_identifier > identifier
 *
 * Visibility follows Dart convention: an underscore prefix marks the
 * member as library-private.
 */

import { SupportedLanguages } from '../../../shared/index.js';
import type { FieldExtractionConfig } from '../generic.js';
import { hasKeyword } from './helpers.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';

/** AST node types that represent Dart type references. */
const DART_TYPE_NODES = new Set([
  'type_identifier',
  'generic_type',
  'function_type',
]);

/**
 * Walk a declaration node to find the first identifier text representing
 * the field name. Handles both the common initialized_identifier_list
 * wrapper and direct initialized_identifier children.
 */
function locateFieldName(decl: import('../../utils/ast-helpers.js').SyntaxNode): string | undefined {
  for (let idx = 0; idx < decl.namedChildCount; idx++) {
    const kid = decl.namedChild(idx);

    // initialized_identifier_list > initialized_identifier > identifier
    if (kid?.type === 'initialized_identifier_list') {
      for (let j = 0; j < kid.namedChildCount; j++) {
        const init = kid.namedChild(j);
        if (init?.type === 'initialized_identifier') {
          const ident = init.firstNamedChild;
          if (ident?.type === 'identifier') return ident.text;
        }
      }
    }

    // Direct initialized_identifier child
    if (kid?.type === 'initialized_identifier') {
      const ident = kid.firstNamedChild;
      if (ident?.type === 'identifier') return ident.text;
    }
  }

  // Last resort: named 'name' field
  const nameChild = decl.childForFieldName('name');
  return nameChild?.text;
}

export const dartConfig: FieldExtractionConfig = {
  language: SupportedLanguages.Dart,

  typeDeclarationNodes: ['class_definition'],
  fieldNodeTypes: ['declaration'],
  bodyNodeTypes: ['class_body'],
  defaultVisibility: 'public',

  extractName(decl) {
    return locateFieldName(decl);
  },

  extractType(decl) {
    // Scan for a type node among named children
    for (let idx = 0; idx < decl.namedChildCount; idx++) {
      const kid = decl.namedChild(idx);
      if (kid && DART_TYPE_NODES.has(kid.type)) {
        return extractSimpleTypeName(kid) ?? kid.text?.trim();
      }
    }
    return undefined;
  },

  extractVisibility(decl) {
    // Walk to find the identifier and check underscore convention
    for (let idx = 0; idx < decl.namedChildCount; idx++) {
      const kid = decl.namedChild(idx);
      if (kid?.type === 'initialized_identifier_list') {
        for (let j = 0; j < kid.namedChildCount; j++) {
          const init = kid.namedChild(j);
          if (init?.type === 'initialized_identifier') {
            const ident = init.firstNamedChild;
            if (ident?.text?.startsWith('_')) return 'private';
          }
        }
      }
    }
    return 'public';
  },

  isStatic(decl) {
    return hasKeyword(decl, 'static');
  },

  isReadonly(decl) {
    return hasKeyword(decl, 'final') || hasKeyword(decl, 'const');
  },
};
