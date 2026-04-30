import { SupportedLanguages } from '../../../shared/index.js';
import type {
  MethodExtractionConfig,
  ParameterInfo,
  MethodVisibility,
} from '../../method-types.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

// ---------------------------------------------------------------------------
// Rust helpers
// ---------------------------------------------------------------------------

function extractName(node: SyntaxNode): string | undefined {
  return node.childForFieldName('name')?.text;
}

function extractReturnType(node: SyntaxNode): string | undefined {
  const typeNode = node.childForFieldName('return_type');
  return typeNode?.text?.trim();
}

function extractParameters(node: SyntaxNode): ParameterInfo[] {
  const paramList = node.childForFieldName('parameters');
  if (!paramList) return [];
  const params: ParameterInfo[] = [];

  for (let i = 0; i < paramList.namedChildCount; i++) {
    const param = paramList.namedChild(i);
    if (!param || param.type === 'self_parameter') continue;

    if (param.type === 'parameter') {
      const patternNode = param.childForFieldName('pattern');
      const typeNode = param.childForFieldName('type');
      params.push({
        name: patternNode?.text ?? '?',
        type: typeNode ? (extractSimpleTypeName(typeNode) ?? typeNode.text?.trim() ?? null) : null,
        isOptional: false,
        isVariadic: false,
      });
    }
  }
  return params;
}

function extractVisibility(node: SyntaxNode): MethodVisibility {
  for (let i = 0; i < node.namedChildCount; i++) {
    if (node.namedChild(i)?.type === 'visibility_modifier') return 'public';
  }
  return 'private';
}

function extractReceiverType(node: SyntaxNode): string | undefined {
  const paramList = node.childForFieldName('parameters');
  if (!paramList) return undefined;
  const first = paramList.namedChild(0);
  if (!first || first.type !== 'self_parameter') return undefined;
  return first.text;
}

function isAsync(node: SyntaxNode): boolean {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'function_modifiers' && child.text.includes('async')) return true;
  }
  return false;
}

function extractAnnotations(node: SyntaxNode): string[] {
  const annotations: string[] = [];
  let sibling = node.previousNamedSibling;
  while (sibling) {
    if (sibling.type === 'attribute_item') {
      annotations.unshift(sibling.text);
    } else {
      break;
    }
    sibling = sibling.previousNamedSibling;
  }
  return annotations;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const rustMethodConfig: MethodExtractionConfig = {
  language: SupportedLanguages.Rust,
  typeDeclarationNodes: ['impl_item', 'trait_item'],
  methodNodeTypes: ['function_item', 'function_signature_item'],
  bodyNodeTypes: ['declaration_list'],

  extractOwnerName(node) {
    if (node.type !== 'impl_item') return undefined;
    const children = node.children ?? [];
    const forIdx = children.findIndex((c: SyntaxNode) => c.text === 'for');
    if (forIdx !== -1) {
      const typeNode = children
        .slice(forIdx + 1)
        .find(
          (c: SyntaxNode) => c.type === 'type_identifier' || c.type === 'scoped_type_identifier',
        );
      if (typeNode) return typeNode.text;
    }
    const first = children.find((c: SyntaxNode) => c.type === 'type_identifier');
    return first?.text;
  },

  extractName,
  extractReturnType,
  extractParameters,
  extractVisibility,

  isStatic(node) {
    const paramList = node.childForFieldName('parameters');
    if (!paramList) return true;
    const first = paramList.namedChild(0);
    return !first || first.type !== 'self_parameter';
  },

  isAbstract(node, ownerNode) {
    if (ownerNode.type === 'trait_item' && node.type === 'function_signature_item') {
      return true;
    }
    return false;
  },

  isFinal() {
    return false;
  },

  extractAnnotations,
  extractReceiverType,
  isAsync,
};
