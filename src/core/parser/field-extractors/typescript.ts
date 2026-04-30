/**
 * TypeScript-specific field extraction, unified into the generic factory.
 *
 * Uses optional hooks (extractFromValue, nestedTypeNodeTypes) on the
 * generic FieldExtractionConfig to handle:
 * 1. type_alias_declaration with object type literals
 * 2. Optional property detection (appends '| undefined')
 * 3. Nested type discovery within class/interface bodies
 *
 * JavaScript uses the simpler config from configs/typescript-javascript.ts
 * since it lacks type aliases and optional property syntax.
 */

import type { SyntaxNode } from '../utils/ast-helpers.js';
import { SupportedLanguages } from '../../shared/index.js';
import { createFieldExtractor, type FieldExtractionConfig } from './generic.js';
import type { FieldExtractor } from '../field-extractor.js';
import type {
  FieldExtractorContext,
  FieldInfo,
  FieldVisibility,
} from '../field-types.js';
import { hasKeyword, findVisibility, typeFromAnnotation } from './configs/helpers.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const VISIBILITY_KEYWORDS = new Set<FieldVisibility>(['public', 'private', 'protected']);

function extractName(node: SyntaxNode): string | undefined {
  const nameNode = node.childForFieldName('name') ?? node.childForFieldName('property');
  return nameNode?.text;
}

function extractType(node: SyntaxNode): string | undefined {
  const typeField = node.childForFieldName('type');
  if (typeField) {
    if (typeField.type === 'type_annotation') {
      const inner = typeField.firstNamedChild;
      return inner?.text?.trim();
    }
    return typeField.text?.trim();
  }
  return typeFromAnnotation(node);
}

function extractVisibility(node: SyntaxNode): FieldVisibility {
  // TypeScript accessibility_modifier
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && child.type === 'accessibility_modifier') {
      const t = child.text.trim() as FieldVisibility;
      if (VISIBILITY_KEYWORDS.has(t)) return t;
    }
  }
  return findVisibility(node, VISIBILITY_KEYWORDS, 'public', 'modifiers');
}

/**
 * Check if a property is optional (has ?: syntax).
 */
function isOptional(node: SyntaxNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && !child.isNamed && child.text === '?') return true;
  }
  const kind = node.childForFieldName('kind');
  if (kind && kind.text === '?') return true;
  return false;
}

/**
 * Normalize type text by collapsing redundant whitespace.
 */
function normalizeType(type: string | null): string | null {
  if (!type) return null;
  return type.trim().replace(/\s+/g, ' ');
}

/**
 * Resolve a type name through the type environment and symbol table.
 */
function resolveType(typeName: string, context: FieldExtractorContext): string | null {
  const fileBindings = context.typeEnv.fileScope();
  const resolved = fileBindings.get(typeName);
  if (resolved) return resolved;

  const matches = context.symbolTable.lookupExactAll(context.filePath, typeName);
  if (matches.length === 1) return matches[0].nodeId;

  return typeName;
}

/**
 * Extract the full type text from a type node, handling type_annotation unwrapping.
 */
function extractFullType(typeNode: SyntaxNode | null): string | null {
  if (!typeNode) return null;
  if (typeNode.type === 'type_annotation') {
    const innerType = typeNode.firstNamedChild;
    return innerType ? normalizeType(innerType.text) : null;
  }
  return normalizeType(typeNode.text);
}

/**
 * Build a FieldInfo from a property_signature in an object type,
 * including optional detection.
 */
function buildObjectField(node: SyntaxNode, context: FieldExtractorContext): FieldInfo | null {
  const nameNode = node.childForFieldName('name') ?? node.childForFieldName('property');
  if (!nameNode) return null;

  const name = nameNode.text;
  if (!name) return null;

  const typeNode = node.childForFieldName('type');
  let type: string | null = extractFullType(typeNode);

  if (type) {
    const resolved = resolveType(type, context);
    type = resolved ?? type;
  }

  // Append ' | undefined' for optional properties
  if (isOptional(node) && type) {
    type = type + ' | undefined';
  }

  return {
    name,
    type,
    visibility: extractVisibility(node),
    isStatic: hasKeyword(node, 'static'),
    isReadonly: hasKeyword(node, 'readonly'),
    sourceFile: context.filePath,
    line: node.startPosition.row + 1,
  };
}

// ---------------------------------------------------------------------------
// Config with TypeScript-specific hooks
// ---------------------------------------------------------------------------

export const typescriptFieldConfig: FieldExtractionConfig = {
  language: SupportedLanguages.TypeScript,
  typeDeclarationNodes: [
    'class_declaration',
    'abstract_class_declaration',
    'interface_declaration',
    'type_alias_declaration',
  ],
  fieldNodeTypes: ['public_field_definition', 'property_signature', 'field_definition'],
  bodyNodeTypes: ['class_body', 'interface_body', 'object_type'],
  defaultVisibility: 'public',

  extractName,
  extractType,
  extractVisibility,
  isStatic: (node) => hasKeyword(node, 'static'),
  isReadonly: (node) => hasKeyword(node, 'readonly'),

  // Hook: extract fields from type_alias_declaration value (object type literals)
  extractFromValue(ownerNode: SyntaxNode, context: FieldExtractorContext): FieldInfo[] {
    if (ownerNode.type !== 'type_alias_declaration') return [];
    const valueNode = ownerNode.childForFieldName('value');
    if (!valueNode || valueNode.type !== 'object_type') return [];

    const fields: FieldInfo[] = [];
    const propertySignatures = valueNode.descendantsOfType('property_signature');
    for (const propNode of propertySignatures) {
      const field = buildObjectField(propNode, context);
      if (field) fields.push(field);
    }
    return fields;
  },

  // Hook: discover nested types inside class/interface bodies
  nestedTypeNodeTypes: ['class_declaration', 'interface_declaration'],
};

// ---------------------------------------------------------------------------
// Singleton instance
// ---------------------------------------------------------------------------

export const typescriptFieldExtractor: FieldExtractor = createFieldExtractor(typescriptFieldConfig);
