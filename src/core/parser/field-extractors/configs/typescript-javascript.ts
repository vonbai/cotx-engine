/**
 * Field extraction configurations for TypeScript and JavaScript.
 *
 * Both languages share identical extraction logic; only the language
 * enum value differs. Fields live in `class_body`, `interface_body`,
 * or `object_type` as `public_field_definition`, `property_signature`,
 * or `field_definition` nodes.
 *
 * Visibility is determined by `accessibility_modifier` children
 * (TypeScript only) or direct keyword tokens.
 */

import { SupportedLanguages } from '../../../shared/index.js';
import type { FieldExtractionConfig } from '../generic.js';
import { hasKeyword, findVisibility, typeFromAnnotation } from './helpers.js';
import type { FieldVisibility } from '../../field-types.js';

const TS_JS_VISIBILITY_SET = new Set<FieldVisibility>(['public', 'private', 'protected']);

/**
 * Shared config body for both TypeScript and JavaScript.
 * The `language` property is applied by the two named exports below.
 */
const commonConfig: Omit<FieldExtractionConfig, 'language'> = {
  typeDeclarationNodes: [
    'class_declaration',
    'abstract_class_declaration',
    'interface_declaration',
  ],
  fieldNodeTypes: ['public_field_definition', 'property_signature', 'field_definition'],
  bodyNodeTypes: ['class_body', 'interface_body', 'object_type'],
  defaultVisibility: 'public',

  extractName(fieldNode) {
    const nameChild = fieldNode.childForFieldName('name') ?? fieldNode.childForFieldName('property');
    return nameChild?.text;
  },

  extractType(fieldNode) {
    // tree-sitter-typescript may expose the type via a named 'type' field
    const typeChild = fieldNode.childForFieldName('type');
    if (typeChild) {
      if (typeChild.type === 'type_annotation') {
        const inner = typeChild.firstNamedChild;
        return inner?.text?.trim();
      }
      return typeChild.text?.trim();
    }
    // Fallback: walk children for a type_annotation node
    return typeFromAnnotation(fieldNode);
  },

  extractVisibility(fieldNode) {
    // Check for accessibility_modifier (TypeScript-specific)
    for (let idx = 0; idx < fieldNode.namedChildCount; idx++) {
      const kid = fieldNode.namedChild(idx);
      if (kid && kid.type === 'accessibility_modifier') {
        const vis = kid.text.trim() as FieldVisibility;
        if (TS_JS_VISIBILITY_SET.has(vis)) return vis;
      }
    }
    return findVisibility(fieldNode, TS_JS_VISIBILITY_SET, 'public', 'modifiers');
  },

  isStatic(fieldNode) {
    return hasKeyword(fieldNode, 'static');
  },

  isReadonly(fieldNode) {
    return hasKeyword(fieldNode, 'readonly');
  },
};

export const typescriptConfig: FieldExtractionConfig = {
  ...commonConfig,
  language: SupportedLanguages.TypeScript,
};

export const javascriptConfig: FieldExtractionConfig = {
  ...commonConfig,
  language: SupportedLanguages.JavaScript,
};
