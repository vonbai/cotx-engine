/**
 * Field extraction configurations for Java and Kotlin.
 *
 * Java: Fields appear as `field_declaration` nodes. The name is inside a
 *   `variable_declarator` (via the `declarator` field or as a named child).
 *   Modifiers live in a `modifiers` wrapper node. Default visibility is
 *   package-private when no access modifier is specified.
 *
 * Kotlin: Properties appear as `property_declaration` nodes. The name is
 *   inside a `variable_declaration > simple_identifier` subtree. Types may
 *   appear as `user_type`, `nullable_type`, or other type nodes under the
 *   variable_declaration. Default visibility is public. `val` = readonly,
 *   `var` = mutable.
 */

import { SupportedLanguages } from '../../../shared/index.js';
import type { FieldExtractionConfig } from '../generic.js';
import { findVisibility, hasKeyword, hasModifier, typeFromField } from './helpers.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';
import type { FieldVisibility } from '../../field-types.js';

// =========================================================================
// Java
// =========================================================================

const JAVA_VISIBILITY_SET = new Set<FieldVisibility>(['public', 'private', 'protected']);

export const javaConfig: FieldExtractionConfig = {
  language: SupportedLanguages.Java,

  typeDeclarationNodes: [
    'class_declaration',
    'interface_declaration',
    'enum_declaration',
    'record_declaration',
  ],
  fieldNodeTypes: ['field_declaration'],
  bodyNodeTypes: ['class_body', 'interface_body', 'enum_body'],
  defaultVisibility: 'package',

  extractName(fieldDecl) {
    // field_declaration > declarator:(variable_declarator name:(identifier))
    const declarator = fieldDecl.childForFieldName('declarator');
    if (declarator) {
      const nameChild = declarator.childForFieldName('name');
      return nameChild?.text;
    }
    // Fallback: scan named children for a variable_declarator
    for (let idx = 0; idx < fieldDecl.namedChildCount; idx++) {
      const kid = fieldDecl.namedChild(idx);
      if (kid?.type === 'variable_declarator') {
        const nameChild = kid.childForFieldName('name');
        return nameChild?.text;
      }
    }
    return undefined;
  },

  extractType(fieldDecl) {
    // Try the named 'type' field first
    const fromField = typeFromField(fieldDecl, 'type');
    if (fromField) return fromField;
    // Fallback: first named child that is not a 'modifiers' node
    const first = fieldDecl.firstNamedChild;
    if (first && first.type !== 'modifiers') {
      return extractSimpleTypeName(first) ?? first.text?.trim();
    }
    return undefined;
  },

  extractVisibility(fieldDecl) {
    return findVisibility(fieldDecl, JAVA_VISIBILITY_SET, 'package', 'modifiers');
  },

  isStatic(fieldDecl) {
    return hasKeyword(fieldDecl, 'static') || hasModifier(fieldDecl, 'modifiers', 'static');
  },

  isReadonly(fieldDecl) {
    return hasKeyword(fieldDecl, 'final') || hasModifier(fieldDecl, 'modifiers', 'final');
  },
};

// =========================================================================
// Kotlin
// =========================================================================

const KOTLIN_VISIBILITY_SET = new Set<FieldVisibility>([
  'public',
  'private',
  'protected',
  'internal',
]);

export const kotlinConfig: FieldExtractionConfig = {
  language: SupportedLanguages.Kotlin,

  typeDeclarationNodes: ['class_declaration', 'object_declaration'],
  fieldNodeTypes: ['property_declaration'],
  bodyNodeTypes: ['class_body'],
  defaultVisibility: 'public',

  extractName(propDecl) {
    // property_declaration > variable_declaration > simple_identifier
    for (let idx = 0; idx < propDecl.namedChildCount; idx++) {
      const kid = propDecl.namedChild(idx);
      if (kid?.type === 'variable_declaration') {
        for (let j = 0; j < kid.namedChildCount; j++) {
          const ident = kid.namedChild(j);
          if (ident?.type === 'simple_identifier') return ident.text;
        }
      }
      // Direct simple_identifier child
      if (kid?.type === 'simple_identifier') return kid.text;
    }
    return undefined;
  },

  extractType(propDecl) {
    // Types may live inside variable_declaration as user_type, nullable_type, etc.
    for (let idx = 0; idx < propDecl.namedChildCount; idx++) {
      const kid = propDecl.namedChild(idx);
      if (kid?.type === 'variable_declaration') {
        for (let j = 0; j < kid.namedChildCount; j++) {
          const typeNode = kid.namedChild(j);
          if (
            typeNode &&
            (typeNode.type === 'user_type' ||
              typeNode.type === 'type_identifier' ||
              typeNode.type === 'nullable_type' ||
              typeNode.type === 'generic_type')
          ) {
            return extractSimpleTypeName(typeNode) ?? typeNode.text?.trim();
          }
        }
      }
      // Direct type children on the property_declaration
      if (kid?.type === 'user_type' || kid?.type === 'nullable_type') {
        return extractSimpleTypeName(kid) ?? kid.text?.trim();
      }
    }
    return undefined;
  },

  extractVisibility(propDecl) {
    return findVisibility(propDecl, KOTLIN_VISIBILITY_SET, 'public', 'modifiers');
  },

  isStatic() {
    // Kotlin has no static keyword; companion object members are separate
    return false;
  },

  isReadonly(propDecl) {
    // `val` declares an immutable property, `var` is mutable
    return hasKeyword(propDecl, 'val');
  },
};
