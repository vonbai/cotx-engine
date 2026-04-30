/**
 * Field extraction configuration for Go.
 *
 * Go struct fields are nested as:
 *   type_declaration > type_spec > struct_type > field_declaration_list > field_declaration
 *
 * Visibility follows Go's capitalization convention: an uppercase initial
 * letter means the field is exported (public), lowercase means unexported
 * (package-scoped).
 */

import { SupportedLanguages } from '../../../shared/index.js';
import type { FieldExtractionConfig } from '../generic.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';

export const goConfig: FieldExtractionConfig = {
  language: SupportedLanguages.Go,

  typeDeclarationNodes: ['type_declaration'],
  fieldNodeTypes: ['field_declaration'],
  bodyNodeTypes: ['field_declaration_list'],
  defaultVisibility: 'package',

  extractName(decl) {
    // Primary path: named 'name' field holds a field_identifier
    const nameChild = decl.childForFieldName('name');
    if (nameChild) return nameChild.text;

    // Fallback: first field_identifier among named children
    for (let idx = 0; idx < decl.namedChildCount; idx++) {
      const kid = decl.namedChild(idx);
      if (kid?.type === 'field_identifier') return kid.text;
    }
    return undefined;
  },

  extractType(decl) {
    // Named 'type' field on field_declaration
    const typeChild = decl.childForFieldName('type');
    if (typeChild) return extractSimpleTypeName(typeChild) ?? typeChild.text?.trim();

    // Fallback: the second named child is typically the type
    if (decl.namedChildCount >= 2) {
      const second = decl.namedChild(1);
      if (second) return extractSimpleTypeName(second) ?? second.text?.trim();
    }
    return undefined;
  },

  extractVisibility(decl) {
    const nameChild = decl.childForFieldName('name');
    const identifier = nameChild?.text;
    if (identifier && identifier.length > 0) {
      const ch = identifier.charAt(0);
      // Uppercase first character that is NOT lowercase => exported
      if (ch === ch.toUpperCase() && ch !== ch.toLowerCase()) return 'public';
      return 'package';
    }
    return 'package';
  },

  isStatic() {
    // Go does not support static struct fields
    return false;
  },

  isReadonly() {
    // Go struct fields are always mutable
    return false;
  },
};
