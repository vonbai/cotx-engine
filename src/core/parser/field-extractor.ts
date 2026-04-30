import type { SyntaxNode } from './utils/ast-helpers.js';
import { SupportedLanguages } from '../shared/index.js';
import type { FieldExtractorContext, ExtractedFields, FieldVisibility } from './field-types.js';

/**
 * Contract for language-specific field extraction from type declarations.
 */
export interface FieldExtractor {
  language: SupportedLanguages;

  /** Parse fields out of a class/struct/interface AST node. */
  extract(node: SyntaxNode, context: FieldExtractorContext): ExtractedFields | null;

  /** Return true when the given AST node is a type declaration that can contain fields. */
  isTypeDeclaration(node: SyntaxNode): boolean;
}

/**
 * Shared foundation for language-specific field extractors.
 * Provides type normalisation and resolution helpers that most
 * concrete implementations rely on.
 */
export abstract class BaseFieldExtractor implements FieldExtractor {
  abstract language: SupportedLanguages;

  abstract extract(node: SyntaxNode, context: FieldExtractorContext): ExtractedFields | null;
  abstract isTypeDeclaration(node: SyntaxNode): boolean;

  /**
   * Collapse redundant whitespace in a type string.
   * Returns null when the input is null/empty.
   */
  protected normalizeType(type: string | null): string | null {
    if (!type) return null;
    return type.trim().replace(/\s+/g, ' ');
  }

  /**
   * Attempt to resolve a type name through the type environment and symbol table.
   * Falls back to the raw name when no unique resolution is found.
   */
  protected resolveType(typeName: string, context: FieldExtractorContext): string | null {
    const { typeEnv, symbolTable, filePath } = context;

    const fileBindings = typeEnv.fileScope();
    const resolved = fileBindings.get(typeName);
    if (resolved) return resolved;

    const matches = symbolTable.lookupExactAll(filePath, typeName);
    if (matches.length === 1) {
      return matches[0].nodeId;
    }

    return typeName;
  }

  protected abstract extractVisibility(node: SyntaxNode): FieldVisibility;
}
