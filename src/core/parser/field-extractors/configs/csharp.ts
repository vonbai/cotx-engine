/**
 * Field extraction configuration for C#.
 *
 * Handles `field_declaration` and `property_declaration` inside
 * class/struct/interface/record bodies (`declaration_list`).
 *
 * C# has compound visibility modifiers:
 *   - `protected internal`  (accessible from same assembly OR derived types)
 *   - `private protected`   (accessible from derived types in same assembly)
 *
 * Record positional parameters (and C# 12 primary constructor parameters)
 * are extracted via the `extractPrimaryFields` hook on the owner node.
 */

import { SupportedLanguages } from '../../../shared/index.js';
import type { FieldExtractionConfig } from '../generic.js';
import { findVisibility, hasKeyword, hasModifier, collectModifierTexts } from './helpers.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';
import type { FieldVisibility, FieldInfo, FieldExtractorContext } from '../../field-types.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

const CSHARP_VISIBILITY_SET = new Set<FieldVisibility>([
  'public',
  'private',
  'protected',
  'internal',
]);

export const csharpConfig: FieldExtractionConfig = {
  language: SupportedLanguages.CSharp,

  typeDeclarationNodes: [
    'class_declaration',
    'struct_declaration',
    'interface_declaration',
    'record_declaration',
  ],
  fieldNodeTypes: ['field_declaration', 'property_declaration'],
  bodyNodeTypes: ['declaration_list'],
  defaultVisibility: 'private',

  extractName(decl) {
    // field_declaration > variable_declaration > variable_declarator > identifier
    for (let idx = 0; idx < decl.namedChildCount; idx++) {
      const kid = decl.namedChild(idx);
      if (kid?.type === 'variable_declaration') {
        for (let j = 0; j < kid.namedChildCount; j++) {
          const declarator = kid.namedChild(j);
          if (declarator?.type === 'variable_declarator') {
            const nameChild = declarator.childForFieldName('name');
            return nameChild?.text ?? declarator.firstNamedChild?.text;
          }
        }
      }
    }
    // property_declaration uses the named 'name' field
    const nameChild = decl.childForFieldName('name');
    return nameChild?.text;
  },

  extractType(decl) {
    // field_declaration > variable_declaration > type:(predefined_type | identifier | ...)
    for (let idx = 0; idx < decl.namedChildCount; idx++) {
      const kid = decl.namedChild(idx);
      if (kid?.type === 'variable_declaration') {
        const typeChild = kid.childForFieldName('type');
        if (typeChild) return extractSimpleTypeName(typeChild) ?? typeChild.text?.trim();
        // Fallback: first child that is not a variable_declarator
        const first = kid.firstNamedChild;
        if (first && first.type !== 'variable_declarator') {
          return extractSimpleTypeName(first) ?? first.text?.trim();
        }
      }
    }
    // property_declaration: use named 'type' field
    const typeChild = decl.childForFieldName('type');
    if (typeChild) return extractSimpleTypeName(typeChild) ?? typeChild.text?.trim();
    return undefined;
  },

  extractVisibility(decl) {
    // Detect compound C# visibilities first
    const mods = collectModifierTexts(decl);
    if (mods.has('protected') && mods.has('internal')) return 'protected internal';
    if (mods.has('private') && mods.has('protected')) return 'private protected';
    return findVisibility(decl, CSHARP_VISIBILITY_SET, 'private', 'modifier');
  },

  isStatic(decl) {
    return hasKeyword(decl, 'static') || hasModifier(decl, 'modifier', 'static');
  },

  isReadonly(decl) {
    return hasKeyword(decl, 'readonly') || hasModifier(decl, 'modifier', 'readonly');
  },

  extractPrimaryFields(ownerNode: SyntaxNode, ctx: FieldExtractorContext): FieldInfo[] {
    // Find a parameter_list directly on the type declaration node
    // (C# record positional params or C# 12 class primary constructors)
    let paramList: SyntaxNode | null = null;
    for (let idx = 0; idx < ownerNode.namedChildCount; idx++) {
      const kid = ownerNode.namedChild(idx);
      if (kid?.type === 'parameter_list') {
        paramList = kid;
        break;
      }
    }
    if (!paramList) return [];

    const ownerIsRecord = ownerNode.type === 'record_declaration';
    const results: FieldInfo[] = [];

    for (let idx = 0; idx < paramList.namedChildCount; idx++) {
      const param = paramList.namedChild(idx);
      if (!param || param.type !== 'parameter') continue;

      const nameChild = param.childForFieldName('name');
      if (!nameChild) continue;

      const typeChild = param.childForFieldName('type');
      let resolvedType: string | null = null;
      if (typeChild) {
        resolvedType = extractSimpleTypeName(typeChild) ?? typeChild.text?.trim() ?? null;
      }

      results.push({
        name: nameChild.text,
        type: resolvedType,
        // Record params become public properties; class params are private captures
        visibility: ownerIsRecord ? 'public' : 'private',
        isStatic: false,
        isReadonly: ownerIsRecord, // record positional params are init-only
        sourceFile: ctx.filePath,
        line: param.startPosition.row + 1,
      });
    }

    return results;
  },
};
