/**
 * Field extraction configuration for Python.
 *
 * Python class-level fields appear as expression_statement nodes wrapping
 * either annotated assignments (`name: str = ""`) or plain assignments
 * (`x = 5`). Instance variables set on `self` in `__init__` are not
 * captured here -- only body-level declarations are in scope.
 *
 * Visibility uses Python convention:
 *   - `__name` (dunder without trailing __) -> private
 *   - `_name` -> protected
 *   - anything else -> public
 */

import { SupportedLanguages } from '../../../shared/index.js';
import type { FieldExtractionConfig } from '../generic.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';

export const pythonConfig: FieldExtractionConfig = {
  language: SupportedLanguages.Python,

  typeDeclarationNodes: ['class_definition'],
  fieldNodeTypes: ['expression_statement'],
  bodyNodeTypes: ['block'],
  defaultVisibility: 'public',

  extractName(stmt) {
    const inner = stmt.firstNamedChild;
    if (!inner) return undefined;

    // Annotated assignment: expression_statement > type > identifier
    if (inner.type === 'type') {
      const ident = inner.childForFieldName('name') ?? inner.firstNamedChild;
      return ident?.type === 'identifier' ? ident.text : undefined;
    }

    // Plain assignment: expression_statement > assignment > left:identifier
    if (inner.type === 'assignment') {
      const lhs = inner.childForFieldName('left');
      if (lhs?.type === 'identifier') return lhs.text;
    }

    return undefined;
  },

  extractType(stmt) {
    const inner = stmt.firstNamedChild;
    if (!inner) return undefined;

    // Annotated assignment with type node
    if (inner.type === 'type') {
      const typeChild = inner.childForFieldName('type') ?? inner.namedChild(1);
      if (typeChild) return extractSimpleTypeName(typeChild) ?? typeChild.text?.trim();
    }

    // Assignment that may contain a type child (annotation without value)
    if (inner.type === 'assignment') {
      for (let idx = 0; idx < inner.childCount; idx++) {
        const kid = inner.child(idx);
        if (kid?.type === 'type') {
          const typeId = kid.firstNamedChild;
          if (typeId) return extractSimpleTypeName(typeId) ?? typeId.text?.trim();
        }
      }
    }

    return undefined;
  },

  extractVisibility(stmt) {
    const inner = stmt.firstNamedChild;
    let fieldName: string | undefined;

    if (inner?.type === 'type') {
      const ident = inner.childForFieldName('name') ?? inner.firstNamedChild;
      fieldName = ident?.text;
    } else if (inner?.type === 'assignment') {
      const lhs = inner.childForFieldName('left');
      fieldName = lhs?.text;
    }

    if (!fieldName) return 'public';
    // Double underscore without trailing dunder => name-mangled (private)
    if (fieldName.startsWith('__') && !fieldName.endsWith('__')) return 'private';
    // Single underscore prefix => protected by convention
    if (fieldName.startsWith('_')) return 'protected';
    return 'public';
  },

  isStatic() {
    // Python has no explicit static keyword for class variables.
    // (Class-body assignments are class variables, but the AST has no modifier.)
    return false;
  },

  isReadonly() {
    return false;
  },
};
