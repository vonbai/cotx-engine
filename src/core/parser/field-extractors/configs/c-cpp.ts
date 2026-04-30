/**
 * Field extraction configurations for C and C++.
 *
 * Both languages use `field_declaration` nodes inside `field_declaration_list`.
 * The field name sits in a declarator child (field_identifier or
 * pointer_declarator > field_identifier).
 *
 * C++ adds access specifiers (public:/private:/protected:) resolved by
 * walking backwards through siblings. Struct members default to public;
 * class members default to private.
 *
 * C has no access control -- all struct/union fields are public.
 */

import { SupportedLanguages } from '../../../shared/index.js';
import type { FieldExtractionConfig } from '../generic.js';
import { hasKeyword } from './helpers.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';
import type { FieldVisibility } from '../../field-types.js';

// -------------------------------------------------------------------------
// Shared helpers for C/C++ field extraction
// -------------------------------------------------------------------------

/**
 * Walk backward through named siblings looking for the nearest C++
 * `access_specifier` node. Returns the visibility keyword or undefined.
 */
function resolveAccessSpecifier(fieldNode: SyntaxNode): FieldVisibility | undefined {
  let prev = fieldNode.previousNamedSibling;
  while (prev) {
    if (prev.type === 'access_specifier') {
      const keyword = prev.text.replace(':', '').trim();
      if (keyword === 'public' || keyword === 'private' || keyword === 'protected') {
        return keyword;
      }
    }
    prev = prev.previousNamedSibling;
  }
  return undefined;
}

/**
 * Extract the field name from a C/C++ field_declaration node.
 * Handles both direct field_identifier and pointer_declarator wrappers.
 */
function fieldDeclName(fieldNode: SyntaxNode): string | undefined {
  const declarator = fieldNode.childForFieldName('declarator');
  if (declarator) {
    if (declarator.type === 'field_identifier') return declarator.text;
    // pointer_declarator wraps the actual field_identifier
    for (let idx = 0; idx < declarator.namedChildCount; idx++) {
      const inner = declarator.namedChild(idx);
      if (inner?.type === 'field_identifier') return inner.text;
    }
    return declarator.text;
  }
  // Fallback: scan named children for a field_identifier
  for (let idx = 0; idx < fieldNode.namedChildCount; idx++) {
    const kid = fieldNode.namedChild(idx);
    if (kid?.type === 'field_identifier') return kid.text;
  }
  return undefined;
}

/**
 * Extract the type from a C/C++ field_declaration node.
 * Prefers the named `type` field; falls back to the first child that
 * looks like a type node.
 */
function fieldDeclType(fieldNode: SyntaxNode): string | undefined {
  const typeChild = fieldNode.childForFieldName('type');
  if (typeChild) return extractSimpleTypeName(typeChild) ?? typeChild.text?.trim();

  const first = fieldNode.firstNamedChild;
  if (
    first &&
    (first.type === 'type_identifier' ||
      first.type === 'primitive_type' ||
      first.type === 'sized_type_specifier' ||
      first.type === 'template_type')
  ) {
    return extractSimpleTypeName(first) ?? first.text?.trim();
  }
  return undefined;
}

// -------------------------------------------------------------------------
// C++ config
// -------------------------------------------------------------------------

export const cppConfig: FieldExtractionConfig = {
  language: SupportedLanguages.CPlusPlus,

  typeDeclarationNodes: ['struct_specifier', 'class_specifier', 'union_specifier'],
  fieldNodeTypes: ['field_declaration'],
  bodyNodeTypes: ['field_declaration_list'],
  defaultVisibility: 'private',

  extractName: fieldDeclName,
  extractType: fieldDeclType,

  extractVisibility(fieldNode) {
    const explicit = resolveAccessSpecifier(fieldNode);
    if (explicit) return explicit;
    // struct defaults to public; class defaults to private
    const container = fieldNode.parent?.parent;
    return container?.type === 'struct_specifier' ? 'public' : 'private';
  },

  isStatic(fieldNode) {
    return hasKeyword(fieldNode, 'static');
  },

  isReadonly(fieldNode) {
    return hasKeyword(fieldNode, 'const');
  },
};

// -------------------------------------------------------------------------
// C config (no access control, no class_specifier)
// -------------------------------------------------------------------------

export const cConfig: FieldExtractionConfig = {
  language: SupportedLanguages.C,

  typeDeclarationNodes: ['struct_specifier', 'union_specifier'],
  fieldNodeTypes: ['field_declaration'],
  bodyNodeTypes: ['field_declaration_list'],
  defaultVisibility: 'public',

  extractName: fieldDeclName,
  extractType: fieldDeclType,

  extractVisibility() {
    // C has no access control; all fields are public
    return 'public';
  },

  isStatic(fieldNode) {
    return hasKeyword(fieldNode, 'static');
  },

  isReadonly(fieldNode) {
    return hasKeyword(fieldNode, 'const');
  },
};
