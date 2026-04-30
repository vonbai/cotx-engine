import { SupportedLanguages } from '../../../shared/index.js';
import type {
  MethodExtractionConfig,
  ParameterInfo,
  MethodVisibility,
} from '../../method-types.js';
import { extractSimpleTypeName } from '../../type-extractors/shared.js';
import type { SyntaxNode } from '../../utils/ast-helpers.js';

// ---------------------------------------------------------------------------
// PHP helpers
// ---------------------------------------------------------------------------

const PHPDOC_RETURN_RE = /@return\s+(\S+)/;

const PHPDOC_SKIP_NODE_TYPES: ReadonlySet<string> = new Set(['attribute_list', 'attribute']);

function normalizePhpReturnType(raw: string): string | undefined {
  let type = raw.startsWith('?') ? raw.slice(1) : raw;
  const parts = type
    .split('|')
    .filter((p) => p !== 'null' && p !== 'false' && p !== 'void' && p !== 'mixed');
  if (parts.length !== 1) return undefined;
  type = parts[0];
  const segments = type.split('\\');
  type = segments[segments.length - 1];
  if (
    type === 'mixed' ||
    type === 'void' ||
    type === 'self' ||
    type === 'static' ||
    type === 'object' ||
    type === 'array'
  )
    return undefined;
  if (/^\w+(\[\])?$/.test(type) || /^\w+\s*</.test(type)) return type;
  return undefined;
}

function extractPhpDocReturnType(node: SyntaxNode): string | undefined {
  let sibling = node.previousSibling;
  while (sibling) {
    if (sibling.type === 'comment') {
      const match = PHPDOC_RETURN_RE.exec(sibling.text);
      if (match) return normalizePhpReturnType(match[1]);
    } else if (sibling.isNamed && !PHPDOC_SKIP_NODE_TYPES.has(sibling.type)) {
      break;
    }
    sibling = sibling.previousSibling;
  }
  return undefined;
}

const PHP_VIS = new Set<MethodVisibility>(['public', 'private', 'protected']);

function findPhpVisibility(node: SyntaxNode): MethodVisibility {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'visibility_modifier') {
      const text = child.text.trim() as MethodVisibility;
      if (PHP_VIS.has(text)) return text;
    }
  }
  return 'public';
}

function hasModifierNode(node: SyntaxNode, modifierType: string): boolean {
  for (let i = 0; i < node.namedChildCount; i++) {
    if (node.namedChild(i)?.type === modifierType) return true;
  }
  return false;
}

function extractReturnType(node: SyntaxNode): string | undefined {
  const TYPE_NODE_TYPES = new Set([
    'primitive_type',
    'named_type',
    'union_type',
    'optional_type',
    'nullable_type',
    'intersection_type',
  ]);

  let astType: string | undefined;
  let seenParams = false;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === 'formal_parameters') {
      seenParams = true;
      continue;
    }
    if (seenParams && child.isNamed && TYPE_NODE_TYPES.has(child.type)) {
      astType = child.text?.trim();
      break;
    }
    if (child.type === 'compound_statement' || (!child.isNamed && child.text === ';')) {
      break;
    }
  }

  if (!astType || astType === 'array' || astType === 'iterable') {
    const docType = extractPhpDocReturnType(node);
    if (docType) return docType;
  }

  return astType;
}

function stripDollar(name: string): string {
  return name.startsWith('$') ? name.slice(1) : name;
}

function extractParameters(node: SyntaxNode): ParameterInfo[] {
  const paramList = node.childForFieldName('parameters');
  if (!paramList) return [];

  const params: ParameterInfo[] = [];

  for (let i = 0; i < paramList.namedChildCount; i++) {
    const param = paramList.namedChild(i);
    if (!param) continue;

    if (param.type === 'simple_parameter') {
      const nameNode = param.childForFieldName('name');
      if (!nameNode) continue;
      const typeNode = param.childForFieldName('type');
      const typeName = typeNode ? (extractSimpleTypeName(typeNode) ?? typeNode.text?.trim()) : null;

      let isOptional = false;
      for (let j = 0; j < param.childCount; j++) {
        const c = param.child(j);
        if (c && !c.isNamed && c.text === '=') {
          isOptional = true;
          break;
        }
      }

      params.push({
        name: stripDollar(nameNode.text),
        type: typeName ?? null,
        isOptional,
        isVariadic: false,
      });
    } else if (param.type === 'variadic_parameter') {
      const nameNode = param.childForFieldName('name');
      if (!nameNode) continue;
      const typeNode = param.childForFieldName('type');
      const typeName = typeNode ? (extractSimpleTypeName(typeNode) ?? typeNode.text?.trim()) : null;

      params.push({
        name: stripDollar(nameNode.text),
        type: typeName ?? null,
        isOptional: false,
        isVariadic: true,
      });
    } else if (param.type === 'property_promotion_parameter') {
      const nameNode = param.childForFieldName('name');
      if (!nameNode) continue;
      const typeNode = param.childForFieldName('type');
      const typeName = typeNode ? (extractSimpleTypeName(typeNode) ?? typeNode.text?.trim()) : null;

      let isVariadic = false;
      for (let j = 0; j < param.childCount; j++) {
        const c = param.child(j);
        if (c && (c.text === '...' || (c.type === 'ERROR' && c.text === '...'))) {
          isVariadic = true;
          break;
        }
      }

      params.push({
        name: stripDollar(nameNode.text),
        type: typeName ?? null,
        isOptional: false,
        isVariadic,
      });
    }
  }

  return params;
}

function extractAnnotations(node: SyntaxNode): string[] {
  const annotations: string[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child || child.type !== 'attribute_list') continue;
    for (let j = 0; j < child.namedChildCount; j++) {
      const group = child.namedChild(j);
      if (!group || group.type !== 'attribute_group') continue;
      for (let k = 0; k < group.namedChildCount; k++) {
        const attr = group.namedChild(k);
        if (!attr || attr.type !== 'attribute') continue;
        const nameNode = attr.firstNamedChild;
        if (nameNode && nameNode.type === 'name') {
          annotations.push('#' + nameNode.text);
        }
      }
    }
  }
  return annotations;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const phpMethodConfig: MethodExtractionConfig = {
  language: SupportedLanguages.PHP,
  typeDeclarationNodes: [
    'class_declaration',
    'interface_declaration',
    'trait_declaration',
    'enum_declaration',
  ],
  methodNodeTypes: ['method_declaration', 'function_definition'],
  bodyNodeTypes: ['declaration_list'],

  extractName(node) {
    return node.childForFieldName('name')?.text;
  },

  extractReturnType,
  extractParameters,
  extractVisibility: findPhpVisibility,

  isStatic(node) {
    return hasModifierNode(node, 'static_modifier');
  },

  isAbstract(node, ownerNode) {
    if (hasModifierNode(node, 'abstract_modifier')) return true;
    let isInterface = ownerNode.type === 'interface_declaration';
    if (!isInterface) {
      let p = node.parent;
      while (p) {
        if (p.type === 'interface_declaration') {
          isInterface = true;
          break;
        }
        p = p.parent;
      }
    }
    if (isInterface) {
      const body = node.childForFieldName('body');
      if (body) return false;
      for (let i = 0; i < node.namedChildCount; i++) {
        if (node.namedChild(i)?.type === 'compound_statement') return false;
      }
      return true;
    }
    return false;
  },

  isFinal(node) {
    return hasModifierNode(node, 'final_modifier');
  },

  extractAnnotations,
};
