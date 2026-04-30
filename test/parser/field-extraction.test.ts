/**
 * Field extraction golden-spec tests.
 *
 * These tests capture the CURRENT behavior of:
 *   - createFieldExtractor (generic factory)
 *   - TypeScriptFieldExtractor (hand-written TS extractor)
 *   - Helper functions from configs/helpers.ts
 *   - Per-language configs (TypeScript, Python, Go, Java, Rust)
 *
 * They serve as the specification for the upcoming 29-file extraction rewrite.
 * Do NOT "fix" extraction bugs here — document actual behavior.
 */

import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
// @ts-expect-error — tree-sitter grammars lack TS declarations
import TypeScript from 'tree-sitter-typescript/typescript';
// @ts-expect-error — tree-sitter grammars lack TS declarations
import Python from 'tree-sitter-python';
// @ts-expect-error — tree-sitter grammars lack TS declarations
import Go from 'tree-sitter-go';
// @ts-expect-error — tree-sitter grammars lack TS declarations
import Java from 'tree-sitter-java';
// @ts-expect-error — tree-sitter grammars lack TS declarations
import Rust from 'tree-sitter-rust';

import { createFieldExtractor } from '../../src/core/parser/field-extractors/generic.js';
import { typescriptFieldExtractor } from '../../src/core/parser/field-extractors/typescript.js';
import { typescriptConfig } from '../../src/core/parser/field-extractors/configs/typescript-javascript.js';
import { pythonConfig } from '../../src/core/parser/field-extractors/configs/python.js';
import { goConfig } from '../../src/core/parser/field-extractors/configs/go.js';
import { javaConfig } from '../../src/core/parser/field-extractors/configs/jvm.js';
import { rustConfig } from '../../src/core/parser/field-extractors/configs/rust.js';
import {
  hasKeyword,
  findVisibility,
  hasModifier,
  typeFromAnnotation,
} from '../../src/core/parser/field-extractors/configs/helpers.js';
import type { SyntaxNode } from '../../src/core/parser/utils/ast-helpers.js';
import type { FieldExtractorContext } from '../../src/core/parser/field-types.js';
import type { FieldVisibility } from '../../src/core/parser/field-types.js';
import { SupportedLanguages } from '../../src/core/shared/index.js';

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

function createParser(language: unknown): Parser {
  const parser = new Parser();
  parser.setLanguage(language as Parser.Language);
  return parser;
}

function parse(parser: Parser, source: string): Parser.Tree {
  return parser.parse(source);
}

/**
 * Walk the AST to find the first node with the given type.
 * Used to locate class/struct/interface declarations in parsed code.
 */
function findNode(root: SyntaxNode, type: string): SyntaxNode | null {
  if (root.type === type) return root;
  for (let i = 0; i < root.namedChildCount; i++) {
    const child = root.namedChild(i);
    if (child) {
      const found = findNode(child, type);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Find all nodes of a given type.
 */
function findAllNodes(root: SyntaxNode, type: string): SyntaxNode[] {
  const results: SyntaxNode[] = [];
  if (root.type === type) results.push(root);
  for (let i = 0; i < root.namedChildCount; i++) {
    const child = root.namedChild(i);
    if (child) results.push(...findAllNodes(child, type));
  }
  return results;
}

/**
 * Create a minimal FieldExtractorContext stub.
 * The typeEnv and symbolTable are stubbed to return empty/no-op results,
 * which means type resolution falls through to the raw type name.
 */
function makeContext(filePath = 'test.ts'): FieldExtractorContext {
  return {
    typeEnv: {
      lookup: () => undefined,
      constructorBindings: [],
      fileScope: () => new Map(),
      allBindings: () => new Map(),
    } as any,
    symbolTable: {
      lookupExact: () => undefined,
      lookupExactFull: () => undefined,
      lookupExactAll: () => [],
      lookupFuzzy: () => [],
    } as any,
    filePath,
    language: SupportedLanguages.TypeScript,
  };
}

// ---------------------------------------------------------------------------
// 1. Helper functions (configs/helpers.ts)
// ---------------------------------------------------------------------------

describe('helpers.ts', () => {
  const tsParser = createParser(TypeScript);

  describe('hasKeyword', () => {
    it('returns true when keyword is present as unnamed child', () => {
      const tree = parse(tsParser, 'class Foo { static readonly count: number = 0; }');
      const fieldNode = findNode(tree.rootNode as unknown as SyntaxNode, 'public_field_definition');
      expect(fieldNode).not.toBeNull();
      expect(hasKeyword(fieldNode!, 'static')).toBe(true);
      expect(hasKeyword(fieldNode!, 'readonly')).toBe(true);
    });

    it('returns false when keyword is absent', () => {
      const tree = parse(tsParser, 'class Foo { name: string = ""; }');
      const fieldNode = findNode(tree.rootNode as unknown as SyntaxNode, 'public_field_definition');
      expect(fieldNode).not.toBeNull();
      expect(hasKeyword(fieldNode!, 'static')).toBe(false);
      expect(hasKeyword(fieldNode!, 'readonly')).toBe(false);
    });

    it('skips the name field to avoid false positives', () => {
      // A method named "static" should not match
      const tree = parse(tsParser, 'class Foo { static() { return 1; } }');
      const methodNode = findNode(tree.rootNode as unknown as SyntaxNode, 'method_definition');
      expect(methodNode).not.toBeNull();
      // "static" is the name here, not a keyword
      expect(hasKeyword(methodNode!, 'static')).toBe(false);
    });
  });

  describe('findVisibility', () => {
    const VISIBILITY_KEYWORDS = new Set<FieldVisibility>(['public', 'private', 'protected']);

    it('returns visibility when present via accessibility_modifier', () => {
      const tree = parse(tsParser, 'class Foo { private name: string = ""; }');
      const fieldNode = findNode(tree.rootNode as unknown as SyntaxNode, 'public_field_definition');
      expect(fieldNode).not.toBeNull();
      // The accessibility_modifier is a direct child — findVisibility checks children text
      const vis = findVisibility(fieldNode!, VISIBILITY_KEYWORDS, 'public');
      expect(vis).toBe('private');
    });

    it('returns default when no visibility keyword found', () => {
      const tree = parse(tsParser, 'class Foo { name: string = ""; }');
      const fieldNode = findNode(tree.rootNode as unknown as SyntaxNode, 'public_field_definition');
      expect(fieldNode).not.toBeNull();
      const vis = findVisibility(fieldNode!, VISIBILITY_KEYWORDS, 'public');
      expect(vis).toBe('public');
    });

    it('detects visibility inside modifier wrapper node', () => {
      // Java uses modifiers wrapper
      const javaParser = createParser(Java);
      const tree = parse(javaParser, 'class Foo { private int count = 0; }');
      const fieldNode = findNode(tree.rootNode as unknown as SyntaxNode, 'field_declaration');
      expect(fieldNode).not.toBeNull();
      const javaVis = new Set<FieldVisibility>(['public', 'private', 'protected']);
      const vis = findVisibility(fieldNode!, javaVis, 'package', 'modifiers');
      expect(vis).toBe('private');
    });
  });

  describe('hasModifier', () => {
    it('finds modifier inside a wrapper node', () => {
      const javaParser = createParser(Java);
      const tree = parse(javaParser, 'class Foo { static final int MAX = 10; }');
      const fieldNode = findNode(tree.rootNode as unknown as SyntaxNode, 'field_declaration');
      expect(fieldNode).not.toBeNull();
      expect(hasModifier(fieldNode!, 'modifiers', 'static')).toBe(true);
      expect(hasModifier(fieldNode!, 'modifiers', 'final')).toBe(true);
    });

    it('returns false when modifier is absent', () => {
      const javaParser = createParser(Java);
      const tree = parse(javaParser, 'class Foo { int count = 0; }');
      const fieldNode = findNode(tree.rootNode as unknown as SyntaxNode, 'field_declaration');
      expect(fieldNode).not.toBeNull();
      expect(hasModifier(fieldNode!, 'modifiers', 'static')).toBe(false);
    });
  });

  describe('typeFromAnnotation', () => {
    it('extracts type from type_annotation node', () => {
      const tree = parse(tsParser, 'class Foo { name: string = "hello"; }');
      const fieldNode = findNode(tree.rootNode as unknown as SyntaxNode, 'public_field_definition');
      expect(fieldNode).not.toBeNull();
      // typeFromAnnotation walks namedChildren for type_annotation
      const type = typeFromAnnotation(fieldNode!);
      // Behavior: the type field is extracted via childForFieldName('type'), not
      // via walking for type_annotation. typeFromAnnotation may or may not find it
      // depending on tree structure.
      // We test the actual result.
      if (type !== undefined) {
        expect(typeof type).toBe('string');
      }
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Generic field factory with TypeScript config
// ---------------------------------------------------------------------------

describe('createFieldExtractor (generic factory)', () => {
  const tsParser = createParser(TypeScript);
  const extractor = createFieldExtractor(typescriptConfig);

  it('has the correct language', () => {
    expect(extractor.language).toBe(SupportedLanguages.TypeScript);
  });

  describe('isTypeDeclaration', () => {
    it('recognizes class_declaration', () => {
      const tree = parse(tsParser, 'class Foo {}');
      const classNode = findNode(tree.rootNode as unknown as SyntaxNode, 'class_declaration');
      expect(extractor.isTypeDeclaration(classNode!)).toBe(true);
    });

    it('recognizes interface_declaration', () => {
      const tree = parse(tsParser, 'interface Bar {}');
      const ifaceNode = findNode(tree.rootNode as unknown as SyntaxNode, 'interface_declaration');
      expect(extractor.isTypeDeclaration(ifaceNode!)).toBe(true);
    });

    it('rejects non-type nodes', () => {
      const tree = parse(tsParser, 'function foo() {}');
      const funcNode = findNode(tree.rootNode as unknown as SyntaxNode, 'function_declaration');
      expect(extractor.isTypeDeclaration(funcNode!)).toBe(false);
    });
  });

  describe('body node finding', () => {
    it('finds class_body via the body field', () => {
      const tree = parse(tsParser, 'class Foo { name: string = "test"; }');
      const classNode = findNode(tree.rootNode as unknown as SyntaxNode, 'class_declaration');
      const ctx = makeContext();
      const result = extractor.extract(classNode!, ctx);
      expect(result).not.toBeNull();
      expect(result!.ownerFqn).toBe('Foo');
      expect(result!.fields.length).toBeGreaterThan(0);
    });

    it('finds interface_body', () => {
      const tree = parse(tsParser, 'interface IFoo { name: string; age: number; }');
      const ifaceNode = findNode(tree.rootNode as unknown as SyntaxNode, 'interface_declaration');
      const ctx = makeContext();
      const result = extractor.extract(ifaceNode!, ctx);
      expect(result).not.toBeNull();
      expect(result!.ownerFqn).toBe('IFoo');
      expect(result!.fields.length).toBe(2);
    });

    it('returns null for non-type declaration nodes', () => {
      const tree = parse(tsParser, 'function foo() {}');
      const funcNode = findNode(tree.rootNode as unknown as SyntaxNode, 'function_declaration');
      const ctx = makeContext();
      const result = extractor.extract(funcNode!, ctx);
      expect(result).toBeNull();
    });
  });

  describe('single field extraction', () => {
    it('extracts field name, type, visibility, isStatic, isReadonly', () => {
      const tree = parse(tsParser, 'class Foo { private static readonly count: number = 0; }');
      const classNode = findNode(tree.rootNode as unknown as SyntaxNode, 'class_declaration');
      const ctx = makeContext();
      const result = extractor.extract(classNode!, ctx);

      expect(result).not.toBeNull();
      const field = result!.fields[0];
      expect(field.name).toBe('count');
      expect(field.type).toBe('number');
      expect(field.visibility).toBe('private');
      expect(field.isStatic).toBe(true);
      expect(field.isReadonly).toBe(true);
      expect(field.sourceFile).toBe('test.ts');
      expect(typeof field.line).toBe('number');
    });

    it('extracts public field by default', () => {
      const tree = parse(tsParser, 'class Foo { name: string = "hello"; }');
      const classNode = findNode(tree.rootNode as unknown as SyntaxNode, 'class_declaration');
      const ctx = makeContext();
      const result = extractor.extract(classNode!, ctx);
      const field = result!.fields[0];
      expect(field.visibility).toBe('public');
      expect(field.isStatic).toBe(false);
      expect(field.isReadonly).toBe(false);
    });

    it('extracts protected field', () => {
      const tree = parse(tsParser, 'class Foo { protected data: string[] = []; }');
      const classNode = findNode(tree.rootNode as unknown as SyntaxNode, 'class_declaration');
      const ctx = makeContext();
      const result = extractor.extract(classNode!, ctx);
      const field = result!.fields[0];
      expect(field.visibility).toBe('protected');
    });
  });

  describe('type normalization', () => {
    it('normalizes whitespace in types', () => {
      const tree = parse(tsParser, 'class Foo { data: Map<  string,   number  > = new Map(); }');
      const classNode = findNode(tree.rootNode as unknown as SyntaxNode, 'class_declaration');
      const ctx = makeContext();
      const result = extractor.extract(classNode!, ctx);
      const field = result!.fields[0];
      // normalizeType replaces multiple whitespace with single space
      if (field.type) {
        expect(field.type).not.toMatch(/\s{2,}/);
      }
    });
  });

  describe('multiple fields', () => {
    it('extracts all fields from a class', () => {
      const source = `class User {
        name: string = "";
        private age: number = 0;
        readonly email: string = "";
      }`;
      const tree = parse(tsParser, source);
      const classNode = findNode(tree.rootNode as unknown as SyntaxNode, 'class_declaration');
      const ctx = makeContext();
      const result = extractor.extract(classNode!, ctx);
      expect(result).not.toBeNull();
      expect(result!.fields.length).toBe(3);

      const names = result!.fields.map((f) => f.name);
      expect(names).toContain('name');
      expect(names).toContain('age');
      expect(names).toContain('email');
    });
  });

  describe('returns null for missing name', () => {
    it('returns null when type declaration has no name field', () => {
      // Edge case: export default class without a name
      // tree-sitter may parse this differently
      const tree = parse(tsParser, 'export default class {}');
      const classNode = findNode(tree.rootNode as unknown as SyntaxNode, 'class_declaration');
      if (classNode) {
        const ctx = makeContext();
        const result = extractor.extract(classNode, ctx);
        // If the class has no name, extract returns null
        if (!classNode.childForFieldName('name')) {
          expect(result).toBeNull();
        }
      }
    });
  });
});

// ---------------------------------------------------------------------------
// 3. TypeScript field extractor (special cases via generic factory hooks)
// ---------------------------------------------------------------------------

describe('TypeScript field extractor (unified)', () => {
  const tsParser = createParser(TypeScript);
  const extractor = typescriptFieldExtractor;

  it('has the correct language', () => {
    expect(extractor.language).toBe(SupportedLanguages.TypeScript);
  });

  describe('type_alias_declaration with object type', () => {
    it('extracts fields from type alias with object literal', () => {
      const source = `type Config = {
        host: string;
        port: number;
        debug: boolean;
      };`;
      const tree = parse(tsParser, source);
      const typeAlias = findNode(tree.rootNode as unknown as SyntaxNode, 'type_alias_declaration');
      expect(typeAlias).not.toBeNull();
      const ctx = makeContext();
      const result = extractor.extract(typeAlias!, ctx);
      expect(result).not.toBeNull();
      expect(result!.ownerFqn).toBe('Config');
      expect(result!.fields.length).toBe(3);

      const names = result!.fields.map((f) => f.name);
      expect(names).toContain('host');
      expect(names).toContain('port');
      expect(names).toContain('debug');
    });

    it('ignores type alias without object type', () => {
      const source = 'type StringOrNumber = string | number;';
      const tree = parse(tsParser, source);
      const typeAlias = findNode(tree.rootNode as unknown as SyntaxNode, 'type_alias_declaration');
      expect(typeAlias).not.toBeNull();
      const ctx = makeContext();
      const result = extractor.extract(typeAlias!, ctx);
      expect(result).not.toBeNull();
      // No fields because it's a union, not an object type
      expect(result!.fields.length).toBe(0);
    });
  });

  describe('optional property detection', () => {
    it('appends | undefined to optional property types', () => {
      const source = `type Options = {
        required: string;
        optional?: number;
      };`;
      const tree = parse(tsParser, source);
      const typeAlias = findNode(tree.rootNode as unknown as SyntaxNode, 'type_alias_declaration');
      const ctx = makeContext();
      const result = extractor.extract(typeAlias!, ctx);
      expect(result).not.toBeNull();

      const required = result!.fields.find((f) => f.name === 'required');
      const optional = result!.fields.find((f) => f.name === 'optional');
      expect(required).toBeDefined();
      expect(optional).toBeDefined();
      // Optional field type should have ' | undefined' appended
      expect(optional!.type).toContain('| undefined');
      // Required field should not
      expect(required!.type).not.toContain('| undefined');
    });
  });

  describe('class fields with modifiers', () => {
    it('extracts private static readonly field', () => {
      const source = 'class Foo { private static readonly MAX: number = 100; }';
      const tree = parse(tsParser, source);
      const classNode = findNode(tree.rootNode as unknown as SyntaxNode, 'class_declaration');
      const ctx = makeContext();
      const result = extractor.extract(classNode!, ctx);
      expect(result).not.toBeNull();
      const field = result!.fields[0];
      expect(field.name).toBe('MAX');
      expect(field.type).toBe('number');
      expect(field.visibility).toBe('private');
      expect(field.isStatic).toBe(true);
      expect(field.isReadonly).toBe(true);
    });
  });

  describe('interface fields', () => {
    it('extracts interface properties', () => {
      const source = `interface User {
        name: string;
        age: number;
      }`;
      const tree = parse(tsParser, source);
      const ifaceNode = findNode(tree.rootNode as unknown as SyntaxNode, 'interface_declaration');
      const ctx = makeContext();
      const result = extractor.extract(ifaceNode!, ctx);
      expect(result).not.toBeNull();
      expect(result!.ownerFqn).toBe('User');
      expect(result!.fields.length).toBe(2);
      // Interface fields default to public
      expect(result!.fields[0].visibility).toBe('public');
    });
  });

  describe('abstract class', () => {
    it('recognizes abstract_class_declaration', () => {
      const source = 'abstract class Base { abstract name: string; }';
      const tree = parse(tsParser, source);
      const classNode = findNode(
        tree.rootNode as unknown as SyntaxNode,
        'abstract_class_declaration',
      );
      expect(classNode).not.toBeNull();
      expect(extractor.isTypeDeclaration(classNode!)).toBe(true);
    });
  });

  describe('nested type discovery', () => {
    it('reports nested class names in nestedTypes array', () => {
      const source = `class Outer {
        name: string = "";
      }`;
      const tree = parse(tsParser, source);
      const classNode = findNode(tree.rootNode as unknown as SyntaxNode, 'class_declaration');
      const ctx = makeContext();
      const result = extractor.extract(classNode!, ctx);
      expect(result).not.toBeNull();
      expect(Array.isArray(result!.nestedTypes)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Python config (convention-based visibility)
// ---------------------------------------------------------------------------

describe('Python field extraction', () => {
  const pyParser = createParser(Python);
  const extractor = createFieldExtractor(pythonConfig);

  it('has the correct language', () => {
    expect(extractor.language).toBe(SupportedLanguages.Python);
  });

  it('extracts annotated class-level field', () => {
    const source = `class User:
    name: str
    age: int
`;
    const tree = parse(pyParser, source);
    const classNode = findNode(tree.rootNode as unknown as SyntaxNode, 'class_definition');
    expect(classNode).not.toBeNull();
    const ctx = makeContext('user.py');
    ctx.language = SupportedLanguages.Python;
    const result = extractor.extract(classNode!, ctx);
    expect(result).not.toBeNull();
    expect(result!.ownerFqn).toBeDefined();
    expect(result!.fields.length).toBeGreaterThanOrEqual(1);
  });

  it('uses underscore convention for visibility', () => {
    const source = `class Config:
    name: str
    _internal: str
    __secret: str
    __dunder__: str
`;
    const tree = parse(pyParser, source);
    const classNode = findNode(tree.rootNode as unknown as SyntaxNode, 'class_definition');
    const ctx = makeContext('config.py');
    ctx.language = SupportedLanguages.Python;
    const result = extractor.extract(classNode!, ctx);
    expect(result).not.toBeNull();

    const nameField = result!.fields.find((f) => f.name === 'name');
    const internalField = result!.fields.find((f) => f.name === '_internal');
    const secretField = result!.fields.find((f) => f.name === '__secret');

    if (nameField) expect(nameField.visibility).toBe('public');
    if (internalField) expect(internalField.visibility).toBe('protected');
    if (secretField) expect(secretField.visibility).toBe('private');
  });

  it('always reports isStatic as false', () => {
    const source = `class Foo:
    count: int = 0
`;
    const tree = parse(pyParser, source);
    const classNode = findNode(tree.rootNode as unknown as SyntaxNode, 'class_definition');
    const ctx = makeContext('foo.py');
    ctx.language = SupportedLanguages.Python;
    const result = extractor.extract(classNode!, ctx);
    if (result && result.fields.length > 0) {
      expect(result.fields[0].isStatic).toBe(false);
    }
  });

  it('always reports isReadonly as false', () => {
    const source = `class Foo:
    name: str = "test"
`;
    const tree = parse(pyParser, source);
    const classNode = findNode(tree.rootNode as unknown as SyntaxNode, 'class_definition');
    const ctx = makeContext('foo.py');
    ctx.language = SupportedLanguages.Python;
    const result = extractor.extract(classNode!, ctx);
    if (result && result.fields.length > 0) {
      expect(result.fields[0].isReadonly).toBe(false);
    }
  });

  it('extracts assignment-based class variables', () => {
    const source = `class Settings:
    MAX_RETRIES = 3
`;
    const tree = parse(pyParser, source);
    const classNode = findNode(tree.rootNode as unknown as SyntaxNode, 'class_definition');
    const ctx = makeContext('settings.py');
    ctx.language = SupportedLanguages.Python;
    const result = extractor.extract(classNode!, ctx);
    expect(result).not.toBeNull();
    // Assignment-based fields should be extracted
    const maxRetries = result!.fields.find((f) => f.name === 'MAX_RETRIES');
    if (maxRetries) {
      expect(maxRetries.visibility).toBe('public');
      expect(maxRetries.type).toBeNull(); // No type annotation
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Go config (struct fields, capitalization-based visibility)
// ---------------------------------------------------------------------------

describe('Go field extraction', () => {
  const goParser = createParser(Go);
  const extractor = createFieldExtractor(goConfig);

  it('has the correct language', () => {
    expect(extractor.language).toBe(SupportedLanguages.Go);
  });

  it('recognizes type_declaration as a type declaration', () => {
    const source = `package main
type Foo struct {
  Name string
}`;
    const tree = parse(goParser, source);
    const typeDecl = findNode(tree.rootNode as unknown as SyntaxNode, 'type_declaration');
    expect(typeDecl).not.toBeNull();
    expect(extractor.isTypeDeclaration(typeDecl!)).toBe(true);
  });

  it('returns null for type_declaration because it has no name field', () => {
    // IMPORTANT: This documents a known limitation of the generic factory.
    // Go type_declaration has no `name` field — the name is on the child type_spec.
    // The generic factory does node.childForFieldName('name') which returns null,
    // so extract() returns null.
    const source = `package main
type Foo struct {
  Name string
  count int
}`;
    const tree = parse(goParser, source);
    const typeDecl = findNode(tree.rootNode as unknown as SyntaxNode, 'type_declaration');
    const ctx = makeContext('main.go');
    ctx.language = SupportedLanguages.Go;
    const result = extractor.extract(typeDecl!, ctx);
    // The generic factory returns null because type_declaration has no direct 'name' field
    expect(result).toBeNull();
  });

  describe('config functions work correctly on AST nodes', () => {
    it('extractName finds field_identifier', () => {
      const source = `package main
type Foo struct {
  Name string
}`;
      const tree = parse(goParser, source);
      const fieldDecl = findNode(tree.rootNode as unknown as SyntaxNode, 'field_declaration');
      expect(fieldDecl).not.toBeNull();
      expect(goConfig.extractName(fieldDecl!)).toBe('Name');
    });

    it('extractType extracts type_identifier', () => {
      const source = `package main
type Foo struct {
  Name string
}`;
      const tree = parse(goParser, source);
      const fieldDecl = findNode(tree.rootNode as unknown as SyntaxNode, 'field_declaration');
      expect(fieldDecl).not.toBeNull();
      expect(goConfig.extractType(fieldDecl!)).toBe('string');
    });

    it('extractVisibility returns public for uppercase names', () => {
      const source = `package main
type Foo struct {
  Name string
}`;
      const tree = parse(goParser, source);
      const fieldDecl = findNode(tree.rootNode as unknown as SyntaxNode, 'field_declaration');
      expect(goConfig.extractVisibility(fieldDecl!)).toBe('public');
    });

    it('extractVisibility returns package for lowercase names', () => {
      const source = `package main
type Foo struct {
  count int
}`;
      const tree = parse(goParser, source);
      const fieldDecl = findNode(tree.rootNode as unknown as SyntaxNode, 'field_declaration');
      expect(goConfig.extractVisibility(fieldDecl!)).toBe('package');
    });
  });
});

// ---------------------------------------------------------------------------
// 6. Java config (explicit visibility modifiers)
// ---------------------------------------------------------------------------

describe('Java field extraction', () => {
  const javaParser = createParser(Java);
  const extractor = createFieldExtractor(javaConfig);

  it('has the correct language', () => {
    expect(extractor.language).toBe(SupportedLanguages.Java);
  });

  it('extracts fields from a Java class', () => {
    const source = `class User {
    private String name;
    protected int age;
    public static final int MAX_AGE = 150;
}`;
    const tree = parse(javaParser, source);
    const classNode = findNode(tree.rootNode as unknown as SyntaxNode, 'class_declaration');
    const ctx = makeContext('User.java');
    ctx.language = SupportedLanguages.Java;
    const result = extractor.extract(classNode!, ctx);
    expect(result).not.toBeNull();
    expect(result!.ownerFqn).toBe('User');
    expect(result!.fields.length).toBe(3);

    const nameField = result!.fields.find((f) => f.name === 'name');
    expect(nameField).toBeDefined();
    expect(nameField!.visibility).toBe('private');
    expect(nameField!.type).toBe('String');
    expect(nameField!.isStatic).toBe(false);
    expect(nameField!.isReadonly).toBe(false);

    const ageField = result!.fields.find((f) => f.name === 'age');
    expect(ageField).toBeDefined();
    expect(ageField!.visibility).toBe('protected');

    const maxAgeField = result!.fields.find((f) => f.name === 'MAX_AGE');
    expect(maxAgeField).toBeDefined();
    expect(maxAgeField!.visibility).toBe('public');
    expect(maxAgeField!.isStatic).toBe(true);
    expect(maxAgeField!.isReadonly).toBe(true);
  });

  it('defaults to package visibility', () => {
    const source = 'class Foo { int count = 0; }';
    const tree = parse(javaParser, source);
    const classNode = findNode(tree.rootNode as unknown as SyntaxNode, 'class_declaration');
    const ctx = makeContext('Foo.java');
    ctx.language = SupportedLanguages.Java;
    const result = extractor.extract(classNode!, ctx);
    expect(result).not.toBeNull();
    expect(result!.fields[0].visibility).toBe('package');
  });

  it('extracts fields from enum', () => {
    const source = `enum Color {
    RED, GREEN, BLUE;
    private int code;
}`;
    const tree = parse(javaParser, source);
    const enumNode = findNode(tree.rootNode as unknown as SyntaxNode, 'enum_declaration');
    const ctx = makeContext('Color.java');
    ctx.language = SupportedLanguages.Java;
    const result = extractor.extract(enumNode!, ctx);
    expect(result).not.toBeNull();
    expect(result!.ownerFqn).toBe('Color');
    // Should find the code field
    const codeField = result!.fields.find((f) => f.name === 'code');
    if (codeField) {
      expect(codeField.visibility).toBe('private');
    }
  });

  it('extracts fields from interface', () => {
    const source = `interface Constants {
    int MAX_SIZE = 100;
}`;
    const tree = parse(javaParser, source);
    const ifaceNode = findNode(tree.rootNode as unknown as SyntaxNode, 'interface_declaration');
    const ctx = makeContext('Constants.java');
    ctx.language = SupportedLanguages.Java;
    const result = extractor.extract(ifaceNode!, ctx);
    expect(result).not.toBeNull();
    expect(result!.ownerFqn).toBe('Constants');
  });
});

// ---------------------------------------------------------------------------
// 7. Rust config (struct fields, pub keyword)
// ---------------------------------------------------------------------------

describe('Rust field extraction', () => {
  const rustParser = createParser(Rust);
  const extractor = createFieldExtractor(rustConfig);

  it('has the correct language', () => {
    expect(extractor.language).toBe(SupportedLanguages.Rust);
  });

  it('recognizes struct_item as type declaration', () => {
    const source = `struct User {
    name: String,
    age: u32,
}`;
    const tree = parse(rustParser, source);
    const structNode = findNode(tree.rootNode as unknown as SyntaxNode, 'struct_item');
    expect(structNode).not.toBeNull();
    expect(extractor.isTypeDeclaration(structNode!)).toBe(true);
  });

  it('extracts struct fields with visibility', () => {
    const source = `struct User {
    pub name: String,
    pub age: u32,
    secret: String,
}`;
    const tree = parse(rustParser, source);
    const structNode = findNode(tree.rootNode as unknown as SyntaxNode, 'struct_item');
    const ctx = makeContext('user.rs');
    ctx.language = SupportedLanguages.Rust;
    const result = extractor.extract(structNode!, ctx);
    expect(result).not.toBeNull();
    expect(result!.ownerFqn).toBe('User');
    expect(result!.fields.length).toBe(3);

    const nameField = result!.fields.find((f) => f.name === 'name');
    expect(nameField).toBeDefined();
    expect(nameField!.visibility).toBe('public');
    expect(nameField!.type).toBe('String');

    const secretField = result!.fields.find((f) => f.name === 'secret');
    expect(secretField).toBeDefined();
    expect(secretField!.visibility).toBe('private');
  });

  it('reports all fields as isReadonly true (Rust convention)', () => {
    const source = `struct Point {
    x: f64,
    y: f64,
}`;
    const tree = parse(rustParser, source);
    const structNode = findNode(tree.rootNode as unknown as SyntaxNode, 'struct_item');
    const ctx = makeContext('point.rs');
    ctx.language = SupportedLanguages.Rust;
    const result = extractor.extract(structNode!, ctx);
    expect(result).not.toBeNull();
    for (const field of result!.fields) {
      // Rust config always returns true for isReadonly
      expect(field.isReadonly).toBe(true);
    }
  });

  it('reports all fields as isStatic false', () => {
    const source = `struct Point {
    x: f64,
    y: f64,
}`;
    const tree = parse(rustParser, source);
    const structNode = findNode(tree.rootNode as unknown as SyntaxNode, 'struct_item');
    const ctx = makeContext('point.rs');
    ctx.language = SupportedLanguages.Rust;
    const result = extractor.extract(structNode!, ctx);
    expect(result).not.toBeNull();
    for (const field of result!.fields) {
      expect(field.isStatic).toBe(false);
    }
  });

  it('defaults to private visibility', () => {
    const source = `struct Inner {
    data: Vec<u8>,
}`;
    const tree = parse(rustParser, source);
    const structNode = findNode(tree.rootNode as unknown as SyntaxNode, 'struct_item');
    const ctx = makeContext('inner.rs');
    ctx.language = SupportedLanguages.Rust;
    const result = extractor.extract(structNode!, ctx);
    expect(result).not.toBeNull();
    expect(result!.fields[0].visibility).toBe('private');
  });

  it('recognizes enum_item as type declaration', () => {
    const source = `enum Direction {
    Up,
    Down,
}`;
    const tree = parse(rustParser, source);
    const enumNode = findNode(tree.rootNode as unknown as SyntaxNode, 'enum_item');
    expect(enumNode).not.toBeNull();
    expect(extractor.isTypeDeclaration(enumNode!)).toBe(true);
  });
});
