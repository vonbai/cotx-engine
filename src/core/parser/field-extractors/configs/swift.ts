/**
 * Field extraction configuration for Swift.
 *
 * Swift stored and computed properties are represented as
 * `property_declaration` nodes inside `class_body` or `protocol_body`.
 *
 * The name sits inside a `pattern` child (pattern > simple_identifier).
 * Type annotations appear as `type_annotation` children.
 *
 * Visibility modifiers: public, private, fileprivate, internal (default), open.
 * Static properties use the `static` or `class` keyword.
 * `let` declarations are readonly; `var` declarations are mutable.
 */

import { SupportedLanguages } from '../../../shared/index.js';
import type { FieldExtractionConfig } from '../generic.js';
import { hasKeyword, findVisibility } from './helpers.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';
import type { FieldVisibility } from '../../field-types.js';

const SWIFT_VISIBILITY_SET = new Set<FieldVisibility>([
  'public',
  'private',
  'fileprivate',
  'internal',
  'open',
]);

export const swiftConfig: FieldExtractionConfig = {
  language: SupportedLanguages.Swift,

  typeDeclarationNodes: ['class_declaration', 'struct_declaration', 'protocol_declaration'],
  fieldNodeTypes: ['property_declaration'],
  bodyNodeTypes: ['class_body', 'protocol_body'],
  defaultVisibility: 'internal',

  extractName(propDecl) {
    // property_declaration > pattern > simple_identifier
    for (let idx = 0; idx < propDecl.namedChildCount; idx++) {
      const kid = propDecl.namedChild(idx);
      if (kid?.type === 'pattern') {
        // Look for simple_identifier inside the pattern
        for (let j = 0; j < kid.namedChildCount; j++) {
          const inner = kid.namedChild(j);
          if (inner?.type === 'simple_identifier') return inner.text;
        }
        // Pattern itself may be the identifier text
        return kid.text;
      }
      // Direct simple_identifier child
      if (kid?.type === 'simple_identifier') return kid.text;
    }
    // Fallback: try the named 'name' field
    const nameChild = propDecl.childForFieldName('name');
    return nameChild?.text;
  },

  extractType(propDecl) {
    // property_declaration > type_annotation > user_type / type_identifier
    for (let idx = 0; idx < propDecl.namedChildCount; idx++) {
      const kid = propDecl.namedChild(idx);
      if (kid?.type === 'type_annotation') {
        const inner = kid.firstNamedChild;
        if (inner) return extractSimpleTypeName(inner) ?? inner.text?.trim();
      }
    }
    return undefined;
  },

  extractVisibility(propDecl) {
    return findVisibility(propDecl, SWIFT_VISIBILITY_SET, 'internal', 'modifiers');
  },

  isStatic(propDecl) {
    return hasKeyword(propDecl, 'static') || hasKeyword(propDecl, 'class');
  },

  isReadonly(propDecl) {
    // `let` = constant (readonly), `var` = variable (mutable)
    return hasKeyword(propDecl, 'let');
  },
};
