/**
 * Generic table-driven method extractor factory.
 *
 * Mirrors field-extractors/generic.ts — define a config per language and
 * generate extractors from configs. No class hierarchy needed.
 */

import type { SyntaxNode } from '../utils/ast-helpers.js';
import type {
  MethodExtractor,
  MethodExtractorContext,
  MethodExtractionConfig,
  ExtractedMethods,
  MethodInfo,
} from '../method-types.js';

/** Owner node types where member functions are effectively static (JVM/Ruby semantics). */
const STATIC_OWNER_TYPES = new Set(['companion_object', 'object_declaration', 'singleton_class']);

/**
 * Create a MethodExtractor from a declarative config.
 */
export function createMethodExtractor(config: MethodExtractionConfig): MethodExtractor {
  const typeDeclarationSet = new Set(config.typeDeclarationNodes);
  const methodNodeSet = new Set(config.methodNodeTypes);
  const bodyNodeSet = new Set(config.bodyNodeTypes);

  // -- helpers (closures) -------------------------------------------------

  function findBodies(node: SyntaxNode): SyntaxNode[] {
    const result: SyntaxNode[] = [];
    const bodyField = node.childForFieldName('body');
    if (bodyField && bodyNodeSet.has(bodyField.type)) {
      result.push(bodyField);
      addNestedBodies(bodyField, result);
      return result;
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child && bodyNodeSet.has(child.type)) {
        result.push(child);
      }
    }
    if (result.length === 0 && bodyField) {
      result.push(bodyField);
      addNestedBodies(bodyField, result);
    }
    return result;
  }

  function addNestedBodies(parent: SyntaxNode, out: SyntaxNode[], seen?: Set<SyntaxNode>): void {
    const visited = seen ?? new Set(out);
    for (let i = 0; i < parent.namedChildCount; i++) {
      const child = parent.namedChild(i);
      if (child && bodyNodeSet.has(child.type) && !visited.has(child)) {
        visited.add(child);
        out.push(child);
      }
    }
  }

  function buildMethod(
    node: SyntaxNode,
    ownerNode: SyntaxNode,
    context: MethodExtractorContext,
  ): MethodInfo | null {
    const name = config.extractName(node);
    if (!name) return null;

    const isAbstract = config.isAbstract(node, ownerNode);
    // Domain invariant: abstract methods cannot be final
    let isFinal = config.isFinal(node);
    if (isAbstract) isFinal = false;

    // companion_object / object_declaration members are effectively static on JVM
    const isStatic = STATIC_OWNER_TYPES.has(ownerNode.type) || config.isStatic(node);

    return {
      name,
      receiverType: config.extractReceiverType?.(node) ?? null,
      returnType: config.extractReturnType(node) ?? null,
      parameters: config.extractParameters(node),
      visibility: config.extractVisibility(node),
      isStatic,
      isAbstract,
      isFinal,
      ...(config.isVirtual?.(node) ? { isVirtual: true } : {}),
      ...(config.isOverride?.(node) ? { isOverride: true } : {}),
      ...(config.isAsync?.(node) ? { isAsync: true } : {}),
      ...(config.isPartial?.(node) ? { isPartial: true } : {}),
      annotations: config.extractAnnotations?.(node) ?? [],
      sourceFile: context.filePath,
      line: node.startPosition.row + 1,
    };
  }

  function extractMethodsFromBody(
    body: SyntaxNode,
    ownerNode: SyntaxNode,
    context: MethodExtractorContext,
    out: MethodInfo[],
  ): void {
    for (let i = 0; i < body.namedChildCount; i++) {
      let child = body.namedChild(i);
      if (!child) continue;

      // C++ template methods are wrapped in template_declaration — unwrap to the inner node
      if (child.type === 'template_declaration') {
        const inner = child.namedChildren.find((c) => methodNodeSet.has(c.type));
        if (inner) child = inner;
      }

      if (methodNodeSet.has(child.type)) {
        const method = buildMethod(child, ownerNode, context);
        if (method) out.push(method);
      }

      // Recurse into enum constant anonymous class bodies
      if (child.type === 'enum_constant') {
        for (let j = 0; j < child.namedChildCount; j++) {
          const innerBody = child.namedChild(j);
          if (innerBody && innerBody.type === 'class_body') {
            extractMethodsFromBody(innerBody, ownerNode, context, out);
          }
        }
      }
    }
  }

  function resolveOwnerName(node: SyntaxNode): string | undefined {
    // Config hook first
    if (config.extractOwnerName) {
      const name = config.extractOwnerName(node);
      if (name) return name;
    }

    // Field-based name
    const nameField = node.childForFieldName('name');
    if (nameField) return nameField.text;

    // Fallback: type_identifier / simple_identifier / identifier child
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (
        child &&
        (child.type === 'type_identifier' ||
          child.type === 'simple_identifier' ||
          child.type === 'identifier')
      ) {
        return child.text;
      }
    }

    // Unnamed companion objects use "Companion" (Kotlin convention)
    if (node.type === 'companion_object') return 'Companion';

    return undefined;
  }

  // -- public interface (plain object) ------------------------------------

  return {
    language: config.language,

    isTypeDeclaration(node: SyntaxNode): boolean {
      return typeDeclarationSet.has(node.type);
    },

    extract(node: SyntaxNode, context: MethodExtractorContext): ExtractedMethods | null {
      if (!typeDeclarationSet.has(node.type)) return null;

      const ownerName = resolveOwnerName(node);
      if (!ownerName) return null;

      const methods: MethodInfo[] = [];
      const bodies = findBodies(node);
      for (const body of bodies) {
        extractMethodsFromBody(body, node, context, methods);
      }

      // Extract primary constructor from the owner node itself (e.g. C# 12)
      if (config.extractPrimaryConstructor) {
        const primaryCtor = config.extractPrimaryConstructor(node, context);
        if (primaryCtor) methods.push(primaryCtor);
      }

      return { ownerName, methods };
    },

    extractFromNode(node: SyntaxNode, context: MethodExtractorContext): MethodInfo | null {
      if (!methodNodeSet.has(node.type)) return null;
      return buildMethod(node, node, context);
    },

    ...(config.extractFunctionName ? { extractFunctionName: config.extractFunctionName } : {}),
  };
}
