import { SupportedLanguages } from '../../../shared/index.js';
import type {
  MethodExtractionConfig,
  ParameterInfo,
  MethodVisibility,
} from '../../method-types.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

// ---------------------------------------------------------------------------
// Dart helpers
// ---------------------------------------------------------------------------

const TYPE_NODE_TYPES = new Set([
  'type_identifier',
  'generic_type',
  'function_type',
  'nullable_type',
  'void_type',
  'record_type',
]);

function getInnerSignature(node: SyntaxNode): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (
      child &&
      (child.type === 'function_signature' ||
        child.type === 'constructor_signature' ||
        child.type === 'getter_signature' ||
        child.type === 'setter_signature' ||
        child.type === 'operator_signature' ||
        child.type === 'factory_constructor_signature')
    ) {
      return child;
    }
  }
  return null;
}

function extractName(node: SyntaxNode): string | undefined {
  const inner = getInnerSignature(node);
  if (!inner) return undefined;

  if (inner.type === 'operator_signature') {
    for (let i = 0; i < inner.namedChildCount; i++) {
      const child = inner.namedChild(i);
      if (child?.type === 'binary_operator') {
        return `operator ${child.text.trim()}`;
      }
    }
    for (let i = 0; i < inner.childCount; i++) {
      const child = inner.child(i);
      if (child && !child.isNamed && child.text.trim() !== 'operator') {
        const text = child.text.trim();
        if (text && !TYPE_NODE_TYPES.has(child.type)) {
          return `operator ${text}`;
        }
      }
    }
    return undefined;
  }

  if (inner.type === 'getter_signature') {
    return inner.childForFieldName('name')?.text;
  }

  if (inner.type === 'setter_signature') {
    const nameNode = inner.childForFieldName('name');
    return nameNode ? `set ${nameNode.text}` : undefined;
  }

  if (inner.type === 'factory_constructor_signature') {
    const parts: string[] = [];
    for (let i = 0; i < inner.childCount; i++) {
      const child = inner.child(i);
      if (child?.isNamed && child.type === 'identifier') parts.push(child.text);
    }
    return parts.length > 0 ? parts.join('.') : undefined;
  }

  const nameNode = inner.childForFieldName('name');
  return nameNode?.text;
}

function extractReturnType(node: SyntaxNode): string | undefined {
  const inner = getInnerSignature(node);
  if (!inner) return undefined;

  if (
    inner.type === 'constructor_signature' ||
    inner.type === 'setter_signature' ||
    inner.type === 'factory_constructor_signature'
  ) {
    return undefined;
  }

  for (let i = 0; i < inner.namedChildCount; i++) {
    const child = inner.namedChild(i);
    if (child && TYPE_NODE_TYPES.has(child.type)) {
      return child.text?.trim();
    }
  }

  return undefined;
}

function extractSingleParam(param: SyntaxNode, isOptionalBlock: boolean): ParameterInfo {
  const nameNode = param.childForFieldName('name');
  const name = nameNode?.text ?? '<unknown>';

  let typeName: string | null = null;
  for (let i = 0; i < param.namedChildCount; i++) {
    const child = param.namedChild(i);
    if (child && TYPE_NODE_TYPES.has(child.type)) {
      typeName = extractSimpleTypeName(child) ?? child.text?.trim() ?? null;
      break;
    }
    if (child?.type === 'type_identifier') {
      typeName = child.text?.trim() ?? null;
      break;
    }
  }

  let hasRequired = false;
  for (let i = 0; i < param.childCount; i++) {
    const child = param.child(i);
    if (child && child.text.trim() === 'required') {
      hasRequired = true;
      break;
    }
  }
  if (!hasRequired) {
    let prev = param.previousSibling;
    while (prev && !prev.isNamed && prev.text.trim() === ',') {
      prev = prev.previousSibling;
    }
    if (prev && !prev.isNamed && prev.text.trim() === 'required') {
      hasRequired = true;
    }
  }

  const isOptional = isOptionalBlock && !hasRequired;

  return {
    name,
    type: typeName,
    isOptional,
    isVariadic: false,
  };
}

function extractParamsFromList(listNode: SyntaxNode, isOptionalBlock: boolean): ParameterInfo[] {
  const params: ParameterInfo[] = [];

  for (let i = 0; i < listNode.namedChildCount; i++) {
    const child = listNode.namedChild(i);
    if (!child) continue;

    if (child.type === 'formal_parameter') {
      params.push(extractSingleParam(child, isOptionalBlock));
    } else if (child.type === 'optional_formal_parameters') {
      params.push(...extractParamsFromList(child, true));
    }
  }

  return params;
}

function extractParameters(node: SyntaxNode): ParameterInfo[] {
  const inner = getInnerSignature(node);
  if (!inner) return [];

  if (inner.type === 'getter_signature') return [];

  let paramList: SyntaxNode | null = null;
  if (inner.type === 'constructor_signature' || inner.type === 'factory_constructor_signature') {
    paramList = inner.childForFieldName('parameters');
  }
  if (!paramList) {
    for (let i = 0; i < inner.namedChildCount; i++) {
      const child = inner.namedChild(i);
      if (child?.type === 'formal_parameter_list') {
        paramList = child;
        break;
      }
    }
  }
  if (!paramList) return [];

  return extractParamsFromList(paramList, false);
}

function extractVisibility(node: SyntaxNode): MethodVisibility {
  const name = extractName(node);
  if (!name) return 'public';

  const rawName = name.startsWith('set ')
    ? name.slice(4)
    : name.startsWith('operator ')
      ? name.slice(9)
      : name;

  return rawName.startsWith('_') ? 'private' : 'public';
}

function isStatic(node: SyntaxNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && !child.isNamed && child.text.trim() === 'static') return true;
    if (child?.isNamed) break;
  }
  let sibling = node.previousSibling;
  while (sibling) {
    if (sibling.isNamed && sibling.type !== 'annotation') break;
    if (!sibling.isNamed && sibling.text.trim() === 'static') return true;
    sibling = sibling.previousSibling;
  }
  return false;
}

function isAbstract(node: SyntaxNode, _ownerNode: SyntaxNode): boolean {
  if (node.type === 'declaration') return true;
  const next = node.nextNamedSibling;
  return !next || next.type !== 'function_body';
}

function isAsync(node: SyntaxNode): boolean {
  let sibling: SyntaxNode | null = node.nextSibling;
  let limit = 3;
  while (sibling && limit > 0) {
    if (!sibling.isNamed) {
      const text = sibling.text.trim();
      if (text === 'async' || text === 'async*' || text === 'sync*') return true;
    }
    if (sibling.isNamed && sibling.type === 'function_body') {
      for (let i = 0; i < sibling.childCount; i++) {
        const child = sibling.child(i);
        if (child) {
          const text = child.text.trim();
          if (text === 'async' || text === 'async*' || text === 'sync*') return true;
        }
        if (child?.isNamed) break;
      }
      break;
    }
    sibling = sibling.nextSibling;
    limit--;
  }
  return false;
}

function extractAnnotations(node: SyntaxNode): string[] {
  const annotations: string[] = [];
  let sibling = node.previousNamedSibling;
  while (sibling && sibling.type === 'annotation') {
    const text = sibling.text?.trim();
    if (text) {
      const match = text.match(/^@(\w+)/);
      if (match) {
        annotations.unshift('@' + match[1]);
      } else {
        annotations.unshift(text);
      }
    }
    sibling = sibling.previousNamedSibling;
  }
  return annotations;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const dartMethodConfig: MethodExtractionConfig = {
  language: SupportedLanguages.Dart,
  typeDeclarationNodes: ['class_definition', 'mixin_declaration', 'extension_declaration'],
  methodNodeTypes: ['method_signature', 'declaration'],
  bodyNodeTypes: ['class_body', 'extension_body'],

  extractName,
  extractReturnType,
  extractParameters,
  extractVisibility,

  isStatic,
  isAbstract,
  isFinal: () => false,
  isAsync,

  extractAnnotations,
};
