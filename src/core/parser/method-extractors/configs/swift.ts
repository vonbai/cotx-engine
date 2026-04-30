import { SupportedLanguages } from '../../../shared/index.js';
import type {
  MethodExtractionConfig,
  ParameterInfo,
  MethodVisibility,
} from '../../method-types.js';
import { findVisibility, hasKeyword, hasModifier } from '../../field-extractors/configs/helpers.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

// ---------------------------------------------------------------------------
// Swift helpers
// ---------------------------------------------------------------------------

const SWIFT_VIS = new Set<MethodVisibility>([
  'public',
  'private',
  'fileprivate',
  'internal',
  'open',
]);

function extractName(node: SyntaxNode): string | undefined {
  const nameField = node.childForFieldName('name');
  if (nameField) return nameField.text;

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'simple_identifier') return child.text;
  }
  return undefined;
}

function extractReturnType(node: SyntaxNode): string | undefined {
  let seenParams = false;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === 'parameter') {
      seenParams = true;
      continue;
    }
    if (seenParams || child.type === 'type_annotation') {
      if (child.type === 'type_annotation') {
        const inner = child.firstNamedChild;
        if (inner) return inner.text?.trim();
      }
      if (
        child.type === 'user_type' ||
        child.type === 'optional_type' ||
        child.type === 'tuple_type' ||
        child.type === 'array_type' ||
        child.type === 'dictionary_type' ||
        child.type === 'function_type'
      ) {
        return child.text?.trim();
      }
    }
  }

  let seenArrow = false;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (!child.isNamed && child.text.trim() === '->') {
      seenArrow = true;
      continue;
    }
    if (seenArrow && child.isNamed) {
      return child.text?.trim();
    }
  }

  return undefined;
}

function extractParameters(node: SyntaxNode): ParameterInfo[] {
  const params: ParameterInfo[] = [];

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child?.isNamed || child.type !== 'parameter') continue;

    let paramName: string | undefined;
    for (let j = 0; j < child.namedChildCount; j++) {
      const part = child.namedChild(j);
      if (part?.type === 'simple_identifier') paramName = part.text;
    }
    if (!paramName) continue;

    let typeName: string | null = null;
    for (let j = 0; j < child.namedChildCount; j++) {
      const part = child.namedChild(j);
      if (part?.type === 'user_type' || part?.type === 'type_annotation') {
        const inner = part.firstNamedChild;
        if (inner) {
          typeName = extractSimpleTypeName(inner) ?? inner.text?.trim() ?? null;
        } else {
          typeName = part.text?.trim() ?? null;
        }
        break;
      }
      if (part?.type.endsWith('_type') && part.type !== 'simple_identifier') {
        typeName = extractSimpleTypeName(part) ?? part.text?.trim() ?? null;
        break;
      }
    }

    let isOptional = false;
    const nextSibling = node.child(i + 1);
    if (nextSibling && !nextSibling.isNamed && nextSibling.text.trim() === '=') {
      isOptional = true;
    }

    let isVariadic = false;
    for (let j = 0; j < child.childCount; j++) {
      const c = child.child(j);
      if (c && c.text.trim() === '...') {
        isVariadic = true;
        break;
      }
    }

    params.push({ name: paramName, type: typeName, isOptional, isVariadic });
  }

  return params;
}

function isAbstract(node: SyntaxNode, ownerNode: SyntaxNode): boolean {
  if (node.type === 'protocol_function_declaration') return true;

  if (ownerNode.type === 'protocol_declaration') {
    const body = node.childForFieldName('body');
    if (!body) {
      for (let i = 0; i < node.namedChildCount; i++) {
        if (node.namedChild(i)?.type === 'function_body') return false;
      }
      return true;
    }
    return false;
  }

  return false;
}

function extractAnnotations(node: SyntaxNode): string[] {
  const annotations: string[] = [];

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;

    if (child.type === 'attribute') {
      const text = child.text?.trim();
      if (text) {
        const match = text.match(/^@(\w+)/);
        annotations.push(match ? '@' + match[1] : text);
      }
    }

    if (child.type === 'modifiers') {
      for (let j = 0; j < child.namedChildCount; j++) {
        const mod = child.namedChild(j);
        if (mod?.type === 'attribute') {
          const text = mod.text?.trim();
          if (text) {
            const match = text.match(/^@(\w+)/);
            annotations.push(match ? '@' + match[1] : text);
          }
        }
      }
    }
  }

  return annotations;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const swiftMethodConfig: MethodExtractionConfig = {
  language: SupportedLanguages.Swift,
  typeDeclarationNodes: ['class_declaration', 'protocol_declaration'],
  methodNodeTypes: ['function_declaration', 'protocol_function_declaration'],
  bodyNodeTypes: ['class_body', 'protocol_body'],

  extractName,
  extractReturnType,
  extractParameters,

  extractVisibility(node) {
    return findVisibility(node, SWIFT_VIS, 'internal', 'modifiers');
  },

  isStatic(node) {
    return (
      hasKeyword(node, 'static') ||
      hasKeyword(node, 'class') ||
      hasModifier(node, 'modifiers', 'static') ||
      hasModifier(node, 'modifiers', 'class')
    );
  },

  isAbstract,

  isFinal(node) {
    return hasKeyword(node, 'final') || hasModifier(node, 'modifiers', 'final');
  },

  isAsync(node) {
    return hasKeyword(node, 'async') || hasModifier(node, 'modifiers', 'async');
  },

  isOverride(node) {
    return hasKeyword(node, 'override') || hasModifier(node, 'modifiers', 'override');
  },

  extractAnnotations,
};
