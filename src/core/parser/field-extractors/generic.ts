/**
 * Generic table-driven field extractor factory.
 *
 * Instead of 14 separate 300-line files, define a config per language and
 * generate extractors from configs. The factory produces a plain object
 * implementing FieldExtractor — no class hierarchy needed.
 */

import type { SyntaxNode } from '../utils/ast-helpers.js';
import { SupportedLanguages } from '../../shared/index.js';
import type { FieldExtractor } from '../field-extractor.js';
import type {
  FieldExtractorContext,
  ExtractedFields,
  FieldInfo,
  FieldVisibility,
} from '../field-types.js';

// ---------------------------------------------------------------------------
// Config interface
// ---------------------------------------------------------------------------

export interface FieldExtractionConfig {
  language: SupportedLanguages;
  /** AST node types that are class/struct/interface declarations */
  typeDeclarationNodes: string[];
  /** AST node types that represent field/property declarations inside a body */
  fieldNodeTypes: string[];
  /** AST node type(s) for the class body container (e.g., 'class_body', 'declaration_list') */
  bodyNodeTypes: string[];
  /** Default visibility when no modifier is present */
  defaultVisibility: FieldVisibility;
  /**
   * Extract field name from a field declaration node.
   * Use this for nodes that declare exactly one field.
   */
  extractName: (node: SyntaxNode) => string | undefined;
  /**
   * Extract multiple field names from a single declaration node.
   * Optional override for languages where one AST node can declare
   * several fields (e.g. Ruby `attr_accessor :foo, :bar`).
   * When present, the factory uses this instead of `extractName`.
   */
  extractNames?: (node: SyntaxNode) => string[];
  /** Extract type annotation from a field declaration node */
  extractType: (node: SyntaxNode) => string | undefined;
  /** Extract visibility from a field declaration node */
  extractVisibility: (node: SyntaxNode) => FieldVisibility;
  /** Check if a field is static */
  isStatic: (node: SyntaxNode) => boolean;
  /** Check if a field is readonly/final/const */
  isReadonly: (node: SyntaxNode) => boolean;
  /** Extract fields from primary constructor parameters on the owner node itself
   *  (e.g. C# record positional parameters, C# 12 class primary constructors). */
  extractPrimaryFields?: (ownerNode: SyntaxNode, context: FieldExtractorContext) => FieldInfo[];

  // -----------------------------------------------------------------------
  // Optional hooks for TypeScript-style extraction
  // -----------------------------------------------------------------------

  /**
   * Extract fields from the value of a type declaration (e.g. TypeScript
   * `type Config = { host: string; }` — object type literals).
   * Called on the owner (type declaration) node when present.
   */
  extractFromValue?: (ownerNode: SyntaxNode, context: FieldExtractorContext) => FieldInfo[];

  /**
   * AST node types to scan for when discovering nested types inside a
   * type declaration body. E.g. `['class_declaration', 'interface_declaration']`.
   * When omitted, nestedTypes is always empty.
   */
  nestedTypeNodeTypes?: string[];
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a FieldExtractor from a declarative config.
 */
export function createFieldExtractor(config: FieldExtractionConfig): FieldExtractor {
  const typeDeclarationSet = new Set(config.typeDeclarationNodes);
  const fieldNodeSet = new Set(config.fieldNodeTypes);
  const bodyNodeSet = new Set(config.bodyNodeTypes);

  // -- helpers (closures, no class needed) --------------------------------

  function normalizeType(type: string | null): string | null {
    if (!type) return null;
    return type.trim().replace(/\s+/g, ' ');
  }

  function resolveType(typeName: string, context: FieldExtractorContext): string | null {
    const fileBindings = context.typeEnv.fileScope();
    const resolved = fileBindings.get(typeName);
    if (resolved) return resolved;

    const matches = context.symbolTable.lookupExactAll(context.filePath, typeName);
    if (matches.length === 1) {
      return matches[0].nodeId;
    }

    return typeName;
  }

  function findBodies(node: SyntaxNode): SyntaxNode[] {
    const result: SyntaxNode[] = [];
    // Try named 'body' field first
    const bodyField = node.childForFieldName('body');
    if (bodyField && bodyNodeSet.has(bodyField.type)) {
      result.push(bodyField);
      return result;
    }
    // Walk immediate children for matching body node types
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child && bodyNodeSet.has(child.type)) {
        result.push(child);
      }
    }
    // Fallback: use the body field even if its type is not in bodyNodeSet
    if (result.length === 0 && bodyField) {
      result.push(bodyField);
    }
    return result;
  }

  function buildField(
    node: SyntaxNode,
    name: string,
    context: FieldExtractorContext,
  ): FieldInfo | null {
    if (!name) return null;

    let type: string | null = config.extractType(node) ?? null;
    if (type) {
      type = normalizeType(type);
      if (type) {
        const resolved = resolveType(type, context);
        if (resolved) type = resolved;
      }
    }

    return {
      name,
      type,
      visibility: config.extractVisibility(node),
      isStatic: config.isStatic(node),
      isReadonly: config.isReadonly(node),
      sourceFile: context.filePath,
      line: node.startPosition.row + 1,
    };
  }

  function extractFieldsFromBody(
    body: SyntaxNode,
    context: FieldExtractorContext,
    out: FieldInfo[],
  ): void {
    for (let i = 0; i < body.namedChildCount; i++) {
      const child = body.namedChild(i);
      if (!child) continue;

      if (fieldNodeSet.has(child.type)) {
        if (config.extractNames) {
          // Multi-name path: one node may declare several fields (e.g. Ruby attr_accessor)
          const names = config.extractNames(child);
          for (const name of names) {
            const field = buildField(child, name, context);
            if (field) out.push(field);
          }
        } else {
          const name = config.extractName(child);
          if (name) {
            const field = buildField(child, name, context);
            if (field) out.push(field);
          }
        }
      }
    }
  }

  function findNestedTypes(node: SyntaxNode): string[] {
    if (!config.nestedTypeNodeTypes || config.nestedTypeNodeTypes.length === 0) {
      return [];
    }
    const nestedTypes: string[] = [];
    const nestedNodeSet = new Set(config.nestedTypeNodeTypes);

    // Use descendantsOfType for each nested type kind
    for (const nodeType of nestedNodeSet) {
      const descendants = node.descendantsOfType(nodeType);
      for (const nested of descendants) {
        // Skip the node itself
        if (nested === node) continue;
        const nestedName = nested.childForFieldName('name');
        if (nestedName) {
          nestedTypes.push(nestedName.text);
        }
      }
    }

    return nestedTypes;
  }

  // -- public interface (plain object) ------------------------------------

  return {
    language: config.language,

    isTypeDeclaration(node: SyntaxNode): boolean {
      return typeDeclarationSet.has(node.type);
    },

    extract(node: SyntaxNode, context: FieldExtractorContext): ExtractedFields | null {
      if (!typeDeclarationSet.has(node.type)) return null;

      const nameNode = node.childForFieldName('name');
      if (!nameNode) return null;

      const ownerFqn = nameNode.text;
      const fields: FieldInfo[] = [];

      // Extract fields from value (e.g. TypeScript type alias with object type).
      // When the hook handles extraction, skip body-based extraction to avoid
      // double-counting (the value node may also match a bodyNodeType).
      let handledByValueHook = false;
      if (config.extractFromValue) {
        const valueFields = config.extractFromValue(node, context);
        if (valueFields.length > 0) {
          for (const f of valueFields) fields.push(f);
          handledByValueHook = true;
        }
      }

      // Find body container(s) and extract fields
      if (!handledByValueHook) {
        const bodies = findBodies(node);
        for (const body of bodies) {
          extractFieldsFromBody(body, context, fields);
        }
      }

      // Extract fields from primary constructor parameters (e.g. C# records)
      if (config.extractPrimaryFields) {
        const primaryFields = config.extractPrimaryFields(node, context);
        for (const f of primaryFields) fields.push(f);
      }

      // Discover nested types
      const nestedTypes = findNestedTypes(node);

      return { ownerFqn, fields, nestedTypes };
    },
  };
}
