import { SupportedLanguages } from '../../../shared/index.js';
import type {
  MethodExtractionConfig,
  ParameterInfo,
  MethodVisibility,
} from '../../method-types.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

// ---------------------------------------------------------------------------
// Ruby helpers
// ---------------------------------------------------------------------------

const VISIBILITY_MODIFIERS = new Set(['private', 'protected', 'public']);

const YARD_RETURN_RE = /@return\s+\[([^\]]+)\]/;

function extractYardTypeName(yardType: string): string | undefined {
  const trimmed = yardType.trim();

  const parts: string[] = [];
  let depth = 0,
    start = 0;
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === '<') depth++;
    else if (trimmed[i] === '>') depth--;
    else if (trimmed[i] === ',' && depth === 0) {
      parts.push(trimmed.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(trimmed.slice(start).trim());
  const filtered = parts.filter((p) => p !== '' && p !== 'nil');
  if (filtered.length !== 1) return undefined;

  const typePart = filtered[0];
  const segments = typePart.split('::');
  const last = segments[segments.length - 1];

  const genericMatch = last.match(/^(\w+)\s*[<{(]/);
  if (genericMatch) return genericMatch[1];

  if (/^\w+$/.test(last)) return last;

  return undefined;
}

function extractVisibility(node: SyntaxNode): MethodVisibility {
  const parent = node.parent;
  if (!parent) return 'public';

  let methodIndex = -1;
  for (let i = 0; i < parent.namedChildCount; i++) {
    if (parent.namedChild(i) === node) {
      methodIndex = i;
      break;
    }
  }
  if (methodIndex < 0) return 'public';

  for (let i = methodIndex - 1; i >= 0; i--) {
    const sibling = parent.namedChild(i);
    if (!sibling) continue;
    if (sibling.type === 'identifier' && VISIBILITY_MODIFIERS.has(sibling.text)) {
      return sibling.text as MethodVisibility;
    }
    if (sibling.type === 'identifier' && sibling.text === 'module_function') {
      return 'private';
    }
  }
  return 'public';
}

function extractParameters(node: SyntaxNode): ParameterInfo[] {
  const paramList = node.childForFieldName('parameters');
  if (!paramList) return [];

  const params: ParameterInfo[] = [];

  for (let i = 0; i < paramList.namedChildCount; i++) {
    const param = paramList.namedChild(i);
    if (!param) continue;

    switch (param.type) {
      case 'identifier': {
        params.push({ name: param.text, type: null, isOptional: false, isVariadic: false });
        break;
      }
      case 'optional_parameter': {
        const nameNode = param.childForFieldName('name');
        if (nameNode) {
          params.push({ name: nameNode.text, type: null, isOptional: true, isVariadic: false });
        }
        break;
      }
      case 'splat_parameter': {
        const nameNode = param.childForFieldName('name');
        if (nameNode) {
          params.push({ name: nameNode.text, type: null, isOptional: false, isVariadic: true });
        }
        break;
      }
      case 'hash_splat_parameter': {
        const nameNode = param.childForFieldName('name');
        if (nameNode) {
          params.push({ name: nameNode.text, type: null, isOptional: false, isVariadic: true });
        }
        break;
      }
      case 'block_parameter': {
        const nameNode = param.childForFieldName('name');
        if (nameNode) {
          params.push({ name: nameNode.text, type: null, isOptional: false, isVariadic: false });
        }
        break;
      }
      case 'keyword_parameter': {
        const nameNode = param.childForFieldName('name');
        const valueNode = param.childForFieldName('value');
        if (nameNode) {
          params.push({
            name: nameNode.text,
            type: null,
            isOptional: !!valueNode,
            isVariadic: false,
          });
        }
        break;
      }
    }
  }
  return params;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const rubyMethodConfig: MethodExtractionConfig = {
  language: SupportedLanguages.Ruby,
  typeDeclarationNodes: ['class', 'module', 'singleton_class'],
  methodNodeTypes: ['method', 'singleton_method'],
  bodyNodeTypes: ['body_statement'],

  extractOwnerName(node) {
    if (node.type === 'singleton_class') {
      let ancestor = node.parent;
      while (ancestor) {
        if (ancestor.type === 'class' || ancestor.type === 'module') {
          return ancestor.childForFieldName('name')?.text;
        }
        ancestor = ancestor.parent;
      }
      return undefined;
    }
    return undefined;
  },

  extractName(node) {
    return node.childForFieldName('name')?.text;
  },

  extractReturnType(node) {
    const search = (startNode: SyntaxNode): string | undefined => {
      let sibling = startNode.previousSibling;
      while (sibling) {
        if (sibling.type === 'comment') {
          const match = YARD_RETURN_RE.exec(sibling.text);
          if (match) return extractYardTypeName(match[1]);
        } else if (sibling.isNamed) {
          break;
        }
        sibling = sibling.previousSibling;
      }
      return undefined;
    };

    const result = search(node);
    if (result) return result;

    if (node.parent?.type === 'body_statement') {
      return search(node.parent);
    }
    return undefined;
  },

  extractParameters,
  extractVisibility,

  isStatic(node) {
    if (node.type === 'singleton_method') return true;
    const parent = node.parent;
    if (!parent) return false;
    let methodIndex = -1;
    for (let i = 0; i < parent.namedChildCount; i++) {
      if (parent.namedChild(i) === node) {
        methodIndex = i;
        break;
      }
    }
    for (let i = methodIndex - 1; i >= 0; i--) {
      const sibling = parent.namedChild(i);
      if (!sibling) continue;
      if (sibling.type === 'identifier' && sibling.text === 'module_function') return true;
      if (sibling.type === 'identifier' && VISIBILITY_MODIFIERS.has(sibling.text)) return false;
    }
    return false;
  },

  isAbstract(_node, _ownerNode) {
    return false;
  },

  isFinal(_node) {
    return false;
  },
};
