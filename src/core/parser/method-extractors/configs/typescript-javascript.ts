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
// TS/JS helpers
// ---------------------------------------------------------------------------

const VISIBILITY_KEYWORDS = new Set<MethodVisibility>(['public', 'private', 'protected']);

function extractParameters(node: SyntaxNode): ParameterInfo[] {
  const paramList = node.childForFieldName('parameters');
  if (!paramList) return [];
  const params: ParameterInfo[] = [];

  for (let i = 0; i < paramList.namedChildCount; i++) {
    const param = paramList.namedChild(i);
    if (!param) continue;

    switch (param.type) {
      case 'required_parameter': {
        const patternNode = param.childForFieldName('pattern');
        if (!patternNode) break;
        if (patternNode.type === 'this') break;

        const isRest = patternNode.type === 'rest_pattern';
        const nameNode = isRest ? patternNode.firstNamedChild : patternNode;
        if (!nameNode) break;

        const typeAnnotation = param.childForFieldName('type');
        const typeNode = typeAnnotation?.firstNamedChild;

        const hasDefault = !!param.childForFieldName('value');

        params.push({
          name: nameNode.text,
          type: typeNode
            ? (extractSimpleTypeName(typeNode) ?? typeNode.text?.trim() ?? null)
            : null,
          isOptional: hasDefault,
          isVariadic: isRest,
        });
        break;
      }
      case 'optional_parameter': {
        const nameNode = param.childForFieldName('pattern');
        if (!nameNode) break;
        const typeAnnotation = param.childForFieldName('type');
        const typeNode = typeAnnotation?.firstNamedChild;
        params.push({
          name: nameNode.text,
          type: typeNode
            ? (extractSimpleTypeName(typeNode) ?? typeNode.text?.trim() ?? null)
            : null,
          isOptional: true,
          isVariadic: false,
        });
        break;
      }
      case 'rest_parameter': {
        const nameNode = param.childForFieldName('pattern');
        if (!nameNode) break;
        const typeAnnotation = param.childForFieldName('type');
        const typeNode = typeAnnotation?.firstNamedChild;
        params.push({
          name: nameNode.text,
          type: typeNode
            ? (extractSimpleTypeName(typeNode) ?? typeNode.text?.trim() ?? null)
            : null,
          isOptional: false,
          isVariadic: true,
        });
        break;
      }
      case 'identifier': {
        params.push({ name: param.text, type: null, isOptional: false, isVariadic: false });
        break;
      }
      case 'assignment_pattern': {
        const left = param.childForFieldName('left');
        if (left) {
          params.push({ name: left.text, type: null, isOptional: true, isVariadic: false });
        }
        break;
      }
      case 'rest_pattern': {
        const inner = param.firstNamedChild;
        if (inner) {
          params.push({ name: inner.text, type: null, isOptional: false, isVariadic: true });
        }
        break;
      }
      case 'object_pattern':
      case 'array_pattern': {
        params.push({ name: param.text, type: null, isOptional: false, isVariadic: false });
        break;
      }
    }
  }
  return params;
}

const JSDOC_RETURN_RE = /@returns?\s*\{([^}]+)\}/;

function sanitizeJsDocReturnType(raw: string): string | undefined {
  let type = raw.trim();
  if (type.startsWith('?') || type.startsWith('!')) type = type.slice(1);
  if (type.startsWith('module:')) type = type.slice(7);
  if (type.includes('|')) return undefined;
  if (!type) return undefined;
  return type;
}

function extractJsDocReturnType(node: SyntaxNode): string | undefined {
  let sibling = node.previousSibling;
  while (sibling) {
    if (sibling.type === 'comment') {
      const match = JSDOC_RETURN_RE.exec(sibling.text);
      if (match) return sanitizeJsDocReturnType(match[1]);
    } else if (sibling.isNamed && sibling.type !== 'decorator') break;
    sibling = sibling.previousSibling;
  }
  return undefined;
}

function extractReturnType(node: SyntaxNode): string | undefined {
  const returnType = node.childForFieldName('return_type');
  if (returnType) {
    if (returnType.type === 'type_annotation') {
      const inner = returnType.firstNamedChild;
      if (inner) return inner.text?.trim();
    }
    return returnType.text?.trim();
  }
  return extractJsDocReturnType(node);
}

function extractVisibility(node: SyntaxNode): MethodVisibility {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && child.type === 'accessibility_modifier') {
      const t = child.text.trim();
      if (VISIBILITY_KEYWORDS.has(t as MethodVisibility)) return t as MethodVisibility;
    }
  }
  const nameNode = node.childForFieldName('name');
  if (nameNode && nameNode.type === 'private_property_identifier') return 'private';
  return 'public';
}

function extractDecorators(node: SyntaxNode): string[] {
  const decorators: string[] = [];
  let sibling = node.previousNamedSibling;
  while (sibling && sibling.type === 'decorator') {
    const name = extractDecoratorName(sibling);
    if (name) decorators.unshift(name);
    sibling = sibling.previousNamedSibling;
  }
  return decorators;
}

function extractDecoratorName(decorator: SyntaxNode): string | undefined {
  const expr = decorator.firstNamedChild;
  if (!expr) return undefined;
  if (expr.type === 'call_expression') {
    const fn = expr.childForFieldName('function');
    return fn ? '@' + fn.text : undefined;
  }
  if (expr.type === 'identifier') return '@' + expr.text;
  if (expr.type === 'member_expression') return '@' + expr.text;
  return undefined;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const shared: Omit<MethodExtractionConfig, 'language'> = {
  typeDeclarationNodes: [
    'class_declaration',
    'abstract_class_declaration',
    'interface_declaration',
  ],
  methodNodeTypes: [
    'method_definition',
    'method_signature',
    'abstract_method_signature',
    'function_declaration',
    'generator_function_declaration',
    'function_signature',
  ],
  bodyNodeTypes: ['class_body', 'interface_body'],

  extractName(node) {
    return node.childForFieldName('name')?.text;
  },

  extractReturnType,
  extractParameters,
  extractVisibility,

  isStatic(node) {
    return hasKeyword(node, 'static');
  },

  isAbstract(node, ownerNode) {
    if (hasKeyword(node, 'abstract')) return true;
    if (ownerNode.type === 'interface_declaration') return true;
    return false;
  },

  isFinal(_node) {
    return false;
  },

  extractAnnotations: extractDecorators,

  isAsync(node) {
    return hasKeyword(node, 'async');
  },

  isOverride(node) {
    return hasKeyword(node, 'override');
  },
};

export const typescriptMethodConfig: MethodExtractionConfig = {
  ...shared,
  language: SupportedLanguages.TypeScript,
};

export const javascriptMethodConfig: MethodExtractionConfig = {
  ...shared,
  language: SupportedLanguages.JavaScript,
};
