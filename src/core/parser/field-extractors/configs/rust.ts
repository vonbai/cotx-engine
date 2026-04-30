/**
 * Field extraction configuration for Rust.
 *
 * Rust structs declare fields via `field_declaration` nodes inside a
 * `field_declaration_list`. Visibility is determined by the presence of a
 * `visibility_modifier` child (covers `pub`, `pub(crate)`, `pub(super)`).
 *
 * Rust fields are always immutable at the type level -- mutability is
 * controlled by the variable binding, not the struct definition.
 */

import { SupportedLanguages } from '../../../shared/index.js';
import type { FieldExtractionConfig } from '../generic.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';
import { hasKeyword } from './helpers.js';

export const rustConfig: FieldExtractionConfig = {
  language: SupportedLanguages.Rust,

  typeDeclarationNodes: ['struct_item', 'enum_item'],
  fieldNodeTypes: ['field_declaration'],
  bodyNodeTypes: ['field_declaration_list'],
  defaultVisibility: 'private',

  extractName(decl) {
    // Prefer the named 'name' field on the AST node
    const nameChild = decl.childForFieldName('name');
    if (nameChild) return nameChild.text;

    // Fallback: scan for a field_identifier among named children
    for (let idx = 0; idx < decl.namedChildCount; idx++) {
      const kid = decl.namedChild(idx);
      if (kid?.type === 'field_identifier') return kid.text;
    }
    return undefined;
  },

  extractType(decl) {
    const typeChild = decl.childForFieldName('type');
    if (!typeChild) return undefined;
    return extractSimpleTypeName(typeChild) ?? typeChild.text?.trim();
  },

  extractVisibility(decl) {
    // Look for a visibility_modifier named child (pub, pub(crate), etc.)
    for (let idx = 0; idx < decl.namedChildCount; idx++) {
      const kid = decl.namedChild(idx);
      if (kid?.type === 'visibility_modifier') return 'public';
    }
    // Also check for bare `pub` keyword token
    return hasKeyword(decl, 'pub') ? 'public' : 'private';
  },

  isStatic() {
    // Rust struct fields cannot be static
    return false;
  },

  isReadonly() {
    // All struct fields are immutable by default (mutability lives on bindings)
    return true;
  },
};
