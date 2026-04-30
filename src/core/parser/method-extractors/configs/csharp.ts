import { SupportedLanguages } from '../../../shared/index.js';
import type {
  MethodExtractionConfig,
  MethodInfo,
  MethodExtractorContext,
  ParameterInfo,
  MethodVisibility,
} from '../../method-types.js';
import {
  findVisibility,
  hasModifier,
  hasKeyword,
  collectModifierTexts,
} from '../../field-extractors/configs/helpers.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

// ---------------------------------------------------------------------------
// C# helpers
// ---------------------------------------------------------------------------

const CSHARP_VIS = new Set<MethodVisibility>(['public', 'private', 'protected', 'internal']);

function extractParametersFromList(paramList: SyntaxNode): ParameterInfo[] {
  const params: ParameterInfo[] = [];

  let i = 0;
  while (i < paramList.childCount) {
    const child = paramList.child(i);
    if (!child) {
      i++;
      continue;
    }

    if (!child.isNamed && child.type === 'params') {
      let typeNode: SyntaxNode | null = null;
      let nameText: string | undefined;
      let j = i + 1;
      while (j < paramList.childCount) {
        const sibling = paramList.child(j);
        if (!sibling) {
          j++;
          continue;
        }
        if (sibling.isNamed && sibling.type !== 'parameter') {
          if (!typeNode) {
            typeNode = sibling;
          } else if (sibling.type === 'identifier') {
            nameText = sibling.text;
            i = j;
            break;
          }
        }
        j++;
      }
      if (nameText) {
        params.push({
          name: nameText,
          type: typeNode
            ? (extractSimpleTypeName(typeNode) ?? typeNode.text?.trim() ?? null)
            : null,
          isOptional: false,
          isVariadic: true,
        });
      }
      i++;
      continue;
    }

    if (child.isNamed && child.type === 'parameter') {
      const nameNode = child.childForFieldName('name');
      if (nameNode && nameNode.text.trim()) {
        const typeNode = child.childForFieldName('type');
        let typeName: string | null = typeNode
          ? (extractSimpleTypeName(typeNode) ?? typeNode.text?.trim() ?? null)
          : null;

        for (let j = 0; j < child.namedChildCount; j++) {
          const c = child.namedChild(j);
          if (!c || c.type !== 'modifier') continue;
          const modText = c.text.trim();
          if (modText === 'out' || modText === 'ref' || modText === 'in' || modText === 'this') {
            typeName = typeName ? `${modText} ${typeName}` : modText;
            break;
          }
        }

        let isOptional = false;
        for (let j = 0; j < child.childCount; j++) {
          const c = child.child(j);
          if (c && c.text.trim() === '=') {
            isOptional = true;
            break;
          }
        }

        params.push({
          name: nameNode.text,
          type: typeName,
          isOptional,
          isVariadic: false,
        });
      }
    }

    i++;
  }

  return params;
}

function extractCSharpParameters(node: SyntaxNode): ParameterInfo[] {
  const paramList = node.childForFieldName('parameters');
  if (!paramList) return [];
  return extractParametersFromList(paramList);
}

function extractAnnotations(node: SyntaxNode): string[] {
  const annotations: string[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child || child.type !== 'attribute_list') continue;
    let hasTarget = false;
    for (let j = 0; j < child.namedChildCount; j++) {
      if (child.namedChild(j)?.type === 'attribute_target_specifier') {
        hasTarget = true;
        break;
      }
    }
    if (hasTarget) continue;
    for (let j = 0; j < child.namedChildCount; j++) {
      const attr = child.namedChild(j);
      if (!attr || attr.type !== 'attribute') continue;
      const nameNode = attr.childForFieldName('name');
      if (nameNode) annotations.push('@' + nameNode.text);
    }
  }
  return annotations;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const csharpMethodConfig: MethodExtractionConfig = {
  language: SupportedLanguages.CSharp,
  typeDeclarationNodes: [
    'class_declaration',
    'struct_declaration',
    'interface_declaration',
    'record_declaration',
  ],
  methodNodeTypes: [
    'method_declaration',
    'constructor_declaration',
    'destructor_declaration',
    'operator_declaration',
    'conversion_operator_declaration',
    'local_function_statement',
  ],
  bodyNodeTypes: ['declaration_list'],

  extractName(node) {
    if (node.type === 'destructor_declaration') {
      const name = node.childForFieldName('name')?.text;
      return name ? `~${name}` : undefined;
    }
    if (node.type === 'operator_declaration') {
      const op = node.childForFieldName('operator');
      return op ? `operator ${op.text.trim()}` : undefined;
    }
    if (node.type === 'conversion_operator_declaration') {
      const typeNode = node.childForFieldName('type');
      const typeName = typeNode
        ? (extractSimpleTypeName(typeNode) ?? typeNode.text?.trim())
        : undefined;
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (c && !c.isNamed && (c.text === 'implicit' || c.text === 'explicit')) {
          return typeName ? `${c.text} operator ${typeName}` : undefined;
        }
      }
      return typeName ? `operator ${typeName}` : undefined;
    }
    return node.childForFieldName('name')?.text;
  },

  extractReturnType(node) {
    const returnsNode = node.childForFieldName('returns');
    if (returnsNode) return returnsNode.text?.trim();
    if (node.type === 'operator_declaration' || node.type === 'conversion_operator_declaration') {
      const typeNode = node.childForFieldName('type');
      if (typeNode) return extractSimpleTypeName(typeNode) ?? typeNode.text?.trim();
    }
    return undefined;
  },

  extractParameters: extractCSharpParameters,

  extractVisibility(node) {
    const mods = collectModifierTexts(node);
    if (mods.has('protected') && mods.has('internal')) return 'protected internal';
    if (mods.has('private') && mods.has('protected')) return 'private protected';
    return findVisibility(node, CSHARP_VIS, 'private', 'modifier');
  },

  isStatic(node) {
    return hasKeyword(node, 'static') || hasModifier(node, 'modifier', 'static');
  },

  isAbstract(node, ownerNode) {
    if (hasKeyword(node, 'abstract') || hasModifier(node, 'modifier', 'abstract')) return true;
    if (ownerNode.type === 'interface_declaration') {
      const body = node.childForFieldName('body');
      return !body;
    }
    return false;
  },

  isFinal(node) {
    return hasKeyword(node, 'sealed') || hasModifier(node, 'modifier', 'sealed');
  },

  extractAnnotations,

  isVirtual(node) {
    return hasKeyword(node, 'virtual') || hasModifier(node, 'modifier', 'virtual');
  },

  isOverride(node) {
    return hasKeyword(node, 'override') || hasModifier(node, 'modifier', 'override');
  },

  isAsync(node) {
    return hasKeyword(node, 'async') || hasModifier(node, 'modifier', 'async');
  },

  isPartial(node) {
    return hasKeyword(node, 'partial') || hasModifier(node, 'modifier', 'partial');
  },

  extractPrimaryConstructor(
    ownerNode: SyntaxNode,
    context: MethodExtractorContext,
  ): MethodInfo | null {
    let paramList: SyntaxNode | null = null;
    for (let i = 0; i < ownerNode.namedChildCount; i++) {
      const child = ownerNode.namedChild(i);
      if (child?.type === 'parameter_list') {
        paramList = child;
        break;
      }
    }
    if (!paramList) return null;

    const name = ownerNode.childForFieldName('name')?.text;
    if (!name) return null;

    const parameters = extractParametersFromList(paramList);

    return {
      name,
      receiverType: null,
      returnType: null,
      parameters,
      visibility: csharpMethodConfig.extractVisibility(ownerNode),
      isStatic: false,
      isAbstract: false,
      isFinal: false,
      annotations: [],
      sourceFile: context.filePath,
      line: paramList.startPosition.row + 1,
    };
  },
};
