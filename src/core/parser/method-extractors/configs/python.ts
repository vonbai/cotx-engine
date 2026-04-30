import { SupportedLanguages } from '../../../shared/index.js';
import type {
  MethodExtractionConfig,
  ParameterInfo,
  MethodVisibility,
} from '../../method-types.js';
import { hasKeyword } from '../../field-extractors/configs/helpers.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

// ---------------------------------------------------------------------------
// Python helpers
// ---------------------------------------------------------------------------

const SELF_NAMES = new Set(['self', 'cls']);

function unwrapDecorated(node: SyntaxNode): SyntaxNode {
  if (node.type === 'decorated_definition') {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child && child.type === 'function_definition') return child;
    }
  }
  return node;
}

function collectDecorators(node: SyntaxNode): SyntaxNode[] {
  let wrapper: SyntaxNode | null = null;
  if (node.type === 'decorated_definition') {
    wrapper = node;
  } else if (node.parent?.type === 'decorated_definition') {
    wrapper = node.parent;
  }
  if (!wrapper) return [];

  const decorators: SyntaxNode[] = [];
  for (let i = 0; i < wrapper.namedChildCount; i++) {
    const child = wrapper.namedChild(i);
    if (child && child.type === 'decorator') decorators.push(child);
  }
  return decorators;
}

function extractDecoratorName(decorator: SyntaxNode): string | undefined {
  const expr = decorator.firstNamedChild;
  if (!expr) return undefined;
  if (expr.type === 'identifier') return '@' + expr.text;
  if (expr.type === 'attribute') return '@' + expr.text;
  if (expr.type === 'call') {
    const fn = expr.childForFieldName('function');
    return fn ? '@' + fn.text : undefined;
  }
  return undefined;
}

function hasDecorator(node: SyntaxNode, name: string): boolean {
  for (const dec of collectDecorators(node)) {
    const decName = extractDecoratorName(dec);
    if (decName === '@' + name || decName?.endsWith('.' + name)) return true;
  }
  return false;
}

function extractParameters(node: SyntaxNode): ParameterInfo[] {
  const funcNode = unwrapDecorated(node);
  const paramList = funcNode.childForFieldName('parameters');
  if (!paramList) return [];

  const params: ParameterInfo[] = [];
  let isFirst = true;

  for (let i = 0; i < paramList.namedChildCount; i++) {
    const param = paramList.namedChild(i);
    if (!param) continue;

    switch (param.type) {
      case 'identifier': {
        if (isFirst && SELF_NAMES.has(param.text)) {
          isFirst = false;
          continue;
        }
        isFirst = false;
        params.push({ name: param.text, type: null, isOptional: false, isVariadic: false });
        break;
      }
      case 'default_parameter': {
        isFirst = false;
        const nameNode = param.childForFieldName('name');
        if (nameNode) {
          params.push({ name: nameNode.text, type: null, isOptional: true, isVariadic: false });
        }
        break;
      }
      case 'typed_parameter': {
        const inner = param.firstNamedChild;
        if (!inner) break;

        if (isFirst && inner.type === 'identifier' && SELF_NAMES.has(inner.text)) {
          isFirst = false;
          continue;
        }
        isFirst = false;

        const typeNode = param.childForFieldName('type');
        const typeText = typeNode
          ? (extractSimpleTypeName(typeNode) ?? typeNode.text?.trim() ?? null)
          : null;

        if (inner.type === 'list_splat_pattern') {
          const nameId = inner.firstNamedChild;
          if (nameId) {
            params.push({ name: nameId.text, type: typeText, isOptional: false, isVariadic: true });
          }
        } else if (inner.type === 'dictionary_splat_pattern') {
          const nameId = inner.firstNamedChild;
          if (nameId) {
            params.push({ name: nameId.text, type: typeText, isOptional: false, isVariadic: true });
          }
        } else {
          params.push({
            name: inner.text,
            type: typeText,
            isOptional: false,
            isVariadic: false,
          });
        }
        break;
      }
      case 'typed_default_parameter': {
        isFirst = false;
        const nameNode = param.childForFieldName('name');
        const typeNode = param.childForFieldName('type');
        if (nameNode) {
          params.push({
            name: nameNode.text,
            type: typeNode
              ? (extractSimpleTypeName(typeNode) ?? typeNode.text?.trim() ?? null)
              : null,
            isOptional: true,
            isVariadic: false,
          });
        }
        break;
      }
      case 'list_splat_pattern': {
        isFirst = false;
        const nameId = param.firstNamedChild;
        if (nameId) {
          params.push({ name: nameId.text, type: null, isOptional: false, isVariadic: true });
        }
        break;
      }
      case 'dictionary_splat_pattern': {
        isFirst = false;
        const nameId = param.firstNamedChild;
        if (nameId) {
          params.push({ name: nameId.text, type: null, isOptional: false, isVariadic: true });
        }
        break;
      }
      default:
        isFirst = false;
        break;
    }
  }
  return params;
}

function extractReturnType(node: SyntaxNode): string | undefined {
  const funcNode = unwrapDecorated(node);
  const returnType = funcNode.childForFieldName('return_type');
  if (!returnType) return undefined;
  return returnType.text?.trim();
}

function extractVisibility(node: SyntaxNode): MethodVisibility {
  const funcNode = unwrapDecorated(node);
  const nameNode = funcNode.childForFieldName('name');
  const name = nameNode?.text;
  if (!name) return 'public';
  if (name.startsWith('__') && !name.endsWith('__')) return 'private';
  if (name.startsWith('_') && !(name.startsWith('__') && name.endsWith('__'))) return 'protected';
  return 'public';
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const pythonMethodConfig: MethodExtractionConfig = {
  language: SupportedLanguages.Python,
  typeDeclarationNodes: ['class_definition'],
  methodNodeTypes: ['function_definition', 'decorated_definition'],
  bodyNodeTypes: ['block'],

  extractName(node) {
    const funcNode = unwrapDecorated(node);
    return funcNode.childForFieldName('name')?.text;
  },

  extractReturnType,
  extractParameters,
  extractVisibility,

  isStatic(node) {
    return hasDecorator(node, 'staticmethod') || hasDecorator(node, 'classmethod');
  },

  isAbstract(node, _ownerNode) {
    return hasDecorator(node, 'abstractmethod');
  },

  isFinal(_node) {
    return false;
  },

  extractAnnotations(node) {
    const decorators = collectDecorators(node);
    const annotations: string[] = [];
    for (const dec of decorators) {
      const name = extractDecoratorName(dec);
      if (name) annotations.push(name);
    }
    return annotations;
  },

  isAsync(node) {
    const funcNode = unwrapDecorated(node);
    return hasKeyword(funcNode, 'async');
  },
};
