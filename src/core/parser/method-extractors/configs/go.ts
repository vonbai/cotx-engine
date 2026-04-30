import { SupportedLanguages } from '../../../shared/index.js';
import type {
  MethodExtractionConfig,
  ParameterInfo,
  MethodVisibility,
} from '../../method-types.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

// ---------------------------------------------------------------------------
// Go helpers
// ---------------------------------------------------------------------------

function extractName(node: SyntaxNode): string | undefined {
  return node.childForFieldName('name')?.text;
}

function extractReturnType(node: SyntaxNode): string | undefined {
  const result = node.childForFieldName('result');
  if (!result) return undefined;

  if (result.type !== 'parameter_list') {
    return result.text?.trim();
  }

  for (let i = 0; i < result.namedChildCount; i++) {
    const param = result.namedChild(i);
    if (param?.type === 'parameter_declaration') {
      const typeNode = param.childForFieldName('type');
      if (typeNode) return typeNode.text?.trim();
    }
  }
  return undefined;
}

function extractParameters(node: SyntaxNode): ParameterInfo[] {
  const paramList = node.childForFieldName('parameters');
  if (!paramList) return [];
  const params: ParameterInfo[] = [];

  for (let i = 0; i < paramList.namedChildCount; i++) {
    const param = paramList.namedChild(i);
    if (!param) continue;

    if (param.type === 'parameter_declaration') {
      const typeNode = param.childForFieldName('type');
      const typeName = typeNode
        ? (extractSimpleTypeName(typeNode) ?? typeNode.text?.trim() ?? null)
        : null;

      const names: string[] = [];
      for (let j = 0; j < param.namedChildCount; j++) {
        const child = param.namedChild(j);
        if (child?.type === 'identifier') names.push(child.text);
      }

      if (names.length === 0) {
        params.push({ name: `_${i}`, type: typeName, isOptional: false, isVariadic: false });
      } else {
        for (const name of names) {
          params.push({ name, type: typeName, isOptional: false, isVariadic: false });
        }
      }
    } else if (param.type === 'variadic_parameter_declaration') {
      const nameNode = param.childForFieldName('name');
      const typeNode = param.childForFieldName('type');
      const typeName = typeNode
        ? (extractSimpleTypeName(typeNode) ?? typeNode.text?.trim() ?? null)
        : null;
      params.push({
        name: nameNode?.text ?? `_${i}`,
        type: typeName,
        isOptional: false,
        isVariadic: true,
      });
    }
  }
  return params;
}

function extractVisibility(node: SyntaxNode): MethodVisibility {
  const name = extractName(node);
  if (!name || name.length === 0) return 'private';
  const first = name[0];
  return first === first.toUpperCase() && first !== first.toLowerCase() ? 'public' : 'private';
}

function extractReceiverType(node: SyntaxNode): string | undefined {
  const receiver = node.childForFieldName('receiver');
  if (!receiver) return undefined;

  for (let i = 0; i < receiver.namedChildCount; i++) {
    const param = receiver.namedChild(i);
    if (param?.type === 'parameter_declaration') {
      const typeNode = param.childForFieldName('type');
      if (!typeNode) continue;
      const inner = typeNode.type === 'pointer_type' ? typeNode.firstNamedChild : typeNode;
      return inner?.text;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const goMethodConfig: MethodExtractionConfig = {
  language: SupportedLanguages.Go,
  typeDeclarationNodes: ['method_declaration', 'function_declaration', 'method_elem'],
  methodNodeTypes: ['method_declaration', 'function_declaration', 'method_elem'],
  bodyNodeTypes: [],

  extractName,
  extractReturnType,
  extractParameters,
  extractVisibility,
  extractReceiverType,

  extractOwnerName(node) {
    return extractReceiverType(node);
  },

  isStatic(node) {
    return node.type === 'function_declaration';
  },

  isAbstract(node, _ownerNode) {
    return node.type === 'method_elem';
  },

  isFinal(_node) {
    return false;
  },
};
