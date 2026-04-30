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
// C/C++ helpers
// ---------------------------------------------------------------------------

function findFunctionDeclarator(node: SyntaxNode): SyntaxNode | null {
  const declarator = node.childForFieldName('declarator');
  if (!declarator) return null;
  if (declarator.type === 'function_declarator') return declarator;
  let current: SyntaxNode | null = declarator;
  while (current) {
    for (let i = 0; i < current.namedChildCount; i++) {
      const child = current.namedChild(i);
      if (child?.type === 'function_declarator') return child;
    }
    const next: SyntaxNode | undefined = current.namedChildren.find(
      (c: SyntaxNode) => c.type === 'pointer_declarator' || c.type === 'reference_declarator',
    );
    current = next ?? null;
  }
  return null;
}

function isDeletedOrDefaulted(node: SyntaxNode): boolean {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'delete_method_clause' || child?.type === 'default_method_clause') {
      return true;
    }
  }
  return false;
}

function extractMethodName(node: SyntaxNode): string | undefined {
  const funcDecl = findFunctionDeclarator(node);
  if (!funcDecl) return undefined;
  if (isDeletedOrDefaulted(node)) return undefined;

  const nameNode = funcDecl.childForFieldName('declarator');
  if (!nameNode) return undefined;
  if (nameNode.type === 'destructor_name') return nameNode.text;
  if (nameNode.type === 'operator_name') return nameNode.text;
  return nameNode.text;
}

function extractReturnType(node: SyntaxNode): string | undefined {
  const typeNode = node.childForFieldName('type');
  if (typeNode) {
    const typeText = typeNode.text?.trim();
    if (typeText === 'auto') {
      const funcDecl = findFunctionDeclarator(node);
      if (funcDecl) {
        for (let i = 0; i < funcDecl.namedChildCount; i++) {
          const child = funcDecl.namedChild(i);
          if (child?.type === 'trailing_return_type') {
            const typeDesc = child.firstNamedChild;
            if (typeDesc) return typeDesc.text?.trim();
          }
        }
      }
    }
    return typeText;
  }
  const first = node.firstNamedChild;
  if (
    first &&
    (first.type === 'primitive_type' ||
      first.type === 'type_identifier' ||
      first.type === 'sized_type_specifier' ||
      first.type === 'template_type')
  ) {
    return first.text?.trim();
  }
  return undefined;
}

function extractParamName(declNode: SyntaxNode | null): string | undefined {
  if (!declNode) return undefined;
  if (declNode.type === 'identifier') return declNode.text;
  for (let i = 0; i < declNode.namedChildCount; i++) {
    const child = declNode.namedChild(i);
    if (!child) continue;
    if (child.type === 'identifier') return child.text;
    if (child.type === 'pointer_declarator' || child.type === 'reference_declarator') {
      return extractParamName(child);
    }
  }
  return undefined;
}

function extractParameters(node: SyntaxNode): ParameterInfo[] {
  const funcDecl = findFunctionDeclarator(node);
  if (!funcDecl) return [];
  const paramList = funcDecl.childForFieldName('parameters');
  if (!paramList) return [];
  const params: ParameterInfo[] = [];

  for (let i = 0; i < paramList.namedChildCount; i++) {
    const param = paramList.namedChild(i);
    if (!param) continue;

    switch (param.type) {
      case 'parameter_declaration': {
        const typeNode = param.childForFieldName('type');
        const declNode = param.childForFieldName('declarator');
        const name = extractParamName(declNode);
        params.push({
          name: name ?? typeNode?.text?.trim() ?? '?',
          type: typeNode
            ? (extractSimpleTypeName(typeNode) ?? typeNode.text?.trim() ?? null)
            : null,
          isOptional: false,
          isVariadic: false,
        });
        break;
      }
      case 'optional_parameter_declaration': {
        const typeNode = param.childForFieldName('type');
        const declNode = param.childForFieldName('declarator');
        const name = extractParamName(declNode);
        params.push({
          name: name ?? typeNode?.text?.trim() ?? '?',
          type: typeNode
            ? (extractSimpleTypeName(typeNode) ?? typeNode.text?.trim() ?? null)
            : null,
          isOptional: true,
          isVariadic: false,
        });
        break;
      }
      case 'variadic_parameter_declaration': {
        const typeNode = param.childForFieldName('type');
        const declNode = param.childForFieldName('declarator');
        const name = extractParamName(declNode);
        params.push({
          name: name ?? '...',
          type: typeNode
            ? (extractSimpleTypeName(typeNode) ?? typeNode.text?.trim() ?? null)
            : null,
          isOptional: false,
          isVariadic: true,
        });
        break;
      }
      case 'variadic_parameter': {
        params.push({
          name: '...',
          type: null,
          isOptional: false,
          isVariadic: true,
        });
        break;
      }
    }
  }

  if (!params.some((p) => p.isVariadic)) {
    for (let i = 0; i < paramList.childCount; i++) {
      const child = paramList.child(i);
      if (child && !child.isNamed && child.text === '...') {
        params.push({
          name: '...',
          type: null,
          isOptional: false,
          isVariadic: true,
        });
        break;
      }
    }
  }

  return params;
}

function extractVisibility(node: SyntaxNode): MethodVisibility {
  const startNode = node.parent?.type === 'template_declaration' ? node.parent : node;

  let sibling = startNode.previousNamedSibling;
  while (sibling) {
    if (sibling.type === 'access_specifier') {
      const text = sibling.text.replace(':', '').trim();
      if (text === 'public' || text === 'private' || text === 'protected') return text;
    }
    sibling = sibling.previousNamedSibling;
  }
  const parent = startNode.parent?.parent;
  return parent?.type === 'struct_specifier' || parent?.type === 'union_specifier'
    ? 'public'
    : 'private';
}

function isPureVirtual(node: SyntaxNode): boolean {
  let foundEquals = false;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.text === '=') {
      foundEquals = true;
    } else if (foundEquals && child.type === 'number_literal' && child.text === '0') {
      return true;
    } else if (foundEquals) {
      foundEquals = false;
    }
  }
  return false;
}

function hasVirtualSpecifier(node: SyntaxNode, keyword: string): boolean {
  const funcDecl = findFunctionDeclarator(node);
  if (!funcDecl) return false;
  for (let i = 0; i < funcDecl.namedChildCount; i++) {
    const child = funcDecl.namedChild(i);
    if (child?.type === 'virtual_specifier' && child.text === keyword) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// C++ config
// ---------------------------------------------------------------------------

export const cppMethodConfig: MethodExtractionConfig = {
  language: SupportedLanguages.CPlusPlus,
  typeDeclarationNodes: ['class_specifier', 'struct_specifier', 'union_specifier'],
  methodNodeTypes: ['field_declaration', 'function_definition', 'declaration'],
  bodyNodeTypes: ['field_declaration_list'],

  extractName: extractMethodName,
  extractReturnType,
  extractParameters,
  extractVisibility,

  isStatic(node) {
    return hasKeyword(node, 'static');
  },

  isAbstract(node) {
    return isPureVirtual(node);
  },

  isFinal(node) {
    return hasVirtualSpecifier(node, 'final');
  },

  isVirtual(node) {
    return (
      hasKeyword(node, 'virtual') ||
      hasVirtualSpecifier(node, 'override') ||
      hasVirtualSpecifier(node, 'final')
    );
  },

  isOverride(node) {
    return hasVirtualSpecifier(node, 'override');
  },
};

// ---------------------------------------------------------------------------
// C config
// ---------------------------------------------------------------------------

export const cMethodConfig: MethodExtractionConfig = {
  language: SupportedLanguages.C,
  typeDeclarationNodes: ['struct_specifier'],
  methodNodeTypes: ['function_definition'],
  bodyNodeTypes: ['field_declaration_list'],

  extractName: extractMethodName,
  extractReturnType,
  extractParameters,

  extractVisibility() {
    return 'public';
  },

  isStatic(node) {
    return hasKeyword(node, 'static');
  },

  isAbstract() {
    return false;
  },

  isFinal() {
    return false;
  },
};
