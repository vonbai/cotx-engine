/**
 * Field extraction configuration for PHP.
 *
 * PHP class properties are represented as `property_declaration` nodes
 * inside a `declaration_list` body. Each property_declaration typically
 * contains a `property_element` with a `variable_name` (prefixed with `$`).
 *
 * Type declarations may appear as named_type, primitive_type, union_type,
 * optional_type, intersection_type, or nullable_type children.
 */

import { SupportedLanguages } from '../../../shared/index.js';
import type { FieldExtractionConfig } from '../generic.js';
import { findVisibility, hasKeyword } from './helpers.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';
import type { FieldVisibility } from '../../field-types.js';

const PHP_VISIBILITY_SET = new Set<FieldVisibility>(['public', 'private', 'protected']);

/** AST node types that represent PHP type annotations. */
const PHP_TYPE_NODES = new Set([
  'union_type',
  'named_type',
  'optional_type',
  'primitive_type',
  'intersection_type',
  'nullable_type',
]);

export const phpConfig: FieldExtractionConfig = {
  language: SupportedLanguages.PHP,

  typeDeclarationNodes: ['class_declaration', 'interface_declaration', 'trait_declaration'],
  fieldNodeTypes: ['property_declaration'],
  bodyNodeTypes: ['declaration_list'],
  defaultVisibility: 'public',

  extractName(propDecl) {
    // property_declaration > property_element > variable_name ($foo)
    for (let idx = 0; idx < propDecl.namedChildCount; idx++) {
      const kid = propDecl.namedChild(idx);

      if (kid?.type === 'property_element') {
        const varNode = kid.childForFieldName('name') ?? kid.firstNamedChild;
        if (varNode) {
          const raw = varNode.text;
          return raw.startsWith('$') ? raw.slice(1) : raw;
        }
      }

      // Direct variable_name child (alternative tree shape)
      if (kid?.type === 'variable_name') {
        const raw = kid.text;
        return raw.startsWith('$') ? raw.slice(1) : raw;
      }
    }
    return undefined;
  },

  extractType(propDecl) {
    // Scan named children for a type annotation node
    for (let idx = 0; idx < propDecl.namedChildCount; idx++) {
      const kid = propDecl.namedChild(idx);
      if (kid && PHP_TYPE_NODES.has(kid.type)) {
        return extractSimpleTypeName(kid) ?? kid.text?.trim();
      }
    }
    return undefined;
  },

  extractVisibility(propDecl) {
    return findVisibility(propDecl, PHP_VISIBILITY_SET, 'public');
  },

  isStatic(propDecl) {
    return hasKeyword(propDecl, 'static');
  },

  isReadonly(propDecl) {
    return hasKeyword(propDecl, 'readonly');
  },
};
