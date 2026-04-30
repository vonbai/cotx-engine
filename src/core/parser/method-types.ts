import type { SupportedLanguages } from '../shared/index.js';
import type { FieldVisibility } from './field-types.js';
import type { SyntaxNode } from './utils/ast-helpers.js';

/**
 * Visibility for methods reuses the same set of access modifiers as fields.
 */
export type MethodVisibility = FieldVisibility;

/**
 * A single parameter in a method or function signature.
 */
export interface ParameterInfo {
  name: string;
  type: string | null;
  isOptional: boolean;
  isVariadic: boolean;
}

/**
 * Complete description of a method, constructor, or member function
 * extracted from a type declaration AST node.
 */
export interface MethodInfo {
  name: string;
  receiverType: string | null;
  returnType: string | null;
  parameters: ParameterInfo[];
  visibility: MethodVisibility;
  isStatic: boolean;
  isAbstract: boolean;
  isFinal: boolean;
  isVirtual?: boolean;
  isOverride?: boolean;
  isAsync?: boolean;
  isPartial?: boolean;
  annotations: string[];
  sourceFile: string;
  line: number;
}

/**
 * Minimal context carried through method extraction, identifying the
 * source file and its language.
 */
export interface MethodExtractorContext {
  filePath: string;
  language: SupportedLanguages;
}

/**
 * Output of extracting methods from a single type declaration.
 */
export interface ExtractedMethods {
  ownerName: string;
  methods: MethodInfo[];
}

/**
 * Language-specific method extractor capable of pulling methods from
 * type declarations and recognising relevant AST node types.
 */
export interface MethodExtractor {
  language: SupportedLanguages;

  /** Pull all methods from a type declaration node. */
  extract(node: SyntaxNode, context: MethodExtractorContext): ExtractedMethods | null;

  /** Determine whether a given AST node represents a type declaration. */
  isTypeDeclaration(node: SyntaxNode): boolean;

  /** Optionally extract a standalone method not nested in a type (e.g. Go receiver methods). */
  extractFromNode?(node: SyntaxNode, context: MethodExtractorContext): MethodInfo | null;

  /**
   * Optionally derive a function name and graph label from an AST node
   * during upward parent traversal. Languages with unusual AST shapes
   * (C/C++ declarators, Swift init/deinit, Rust impl items) supply this
   * hook; returning null falls back to the generic name-field lookup.
   */
  extractFunctionName?(
    node: SyntaxNode,
  ): { funcName: string | null; label: import('../shared/index.js').NodeLabel } | null;
}

/**
 * Declarative configuration consumed by the generic method-extractor factory
 * to produce a concrete MethodExtractor for a given language.
 */
export interface MethodExtractionConfig {
  language: SupportedLanguages;
  typeDeclarationNodes: string[];
  methodNodeTypes: string[];
  bodyNodeTypes: string[];

  extractName: (node: SyntaxNode) => string | undefined;
  extractReturnType: (node: SyntaxNode) => string | undefined;
  extractParameters: (node: SyntaxNode) => ParameterInfo[];
  extractVisibility: (node: SyntaxNode) => MethodVisibility;
  isStatic: (node: SyntaxNode) => boolean;
  isAbstract: (node: SyntaxNode, ownerNode: SyntaxNode) => boolean;
  isFinal: (node: SyntaxNode) => boolean;

  extractAnnotations?: (node: SyntaxNode) => string[];
  extractReceiverType?: (node: SyntaxNode) => string | undefined;
  isVirtual?: (node: SyntaxNode) => boolean;
  isOverride?: (node: SyntaxNode) => boolean;
  isAsync?: (node: SyntaxNode) => boolean;
  isPartial?: (node: SyntaxNode) => boolean;

  /** Resolve the owner name from a standalone method node (e.g. Go receiver type). */
  extractOwnerName?: (node: SyntaxNode) => string | undefined;

  /** Extract a primary constructor from the owner node itself (e.g. C# 12 record positional params). */
  extractPrimaryConstructor?: (
    ownerNode: SyntaxNode,
    context: MethodExtractorContext,
  ) => MethodInfo | null;

  /**
   * Derive function name and label from an AST node during parent-walk.
   * Forwarded to the produced MethodExtractor by the factory.
   */
  extractFunctionName?: (
    node: SyntaxNode,
  ) => { funcName: string | null; label: import('../shared/index.js').NodeLabel } | null;
}
