/**
 * Method extraction golden-spec tests.
 *
 * These tests capture the CURRENT behavior of:
 *   - createMethodExtractor (generic factory)
 *   - Per-language method configs (TypeScript, Python, Go, Java, Rust)
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

import { createMethodExtractor } from '../../src/core/parser/method-extractors/generic.js';
import { typescriptMethodConfig } from '../../src/core/parser/method-extractors/configs/typescript-javascript.js';
import { pythonMethodConfig } from '../../src/core/parser/method-extractors/configs/python.js';
import { goMethodConfig } from '../../src/core/parser/method-extractors/configs/go.js';
import { javaMethodConfig } from '../../src/core/parser/method-extractors/configs/jvm.js';
import { rustMethodConfig } from '../../src/core/parser/method-extractors/configs/rust.js';
import { findEnclosingClassInfo, type SyntaxNode } from '../../src/core/parser/utils/ast-helpers.js';
import type { MethodExtractorContext } from '../../src/core/parser/method-types.js';
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

function findAllNodes(root: SyntaxNode, type: string): SyntaxNode[] {
  const results: SyntaxNode[] = [];
  if (root.type === type) results.push(root);
  for (let i = 0; i < root.namedChildCount; i++) {
    const child = root.namedChild(i);
    if (child) results.push(...findAllNodes(child, type));
  }
  return results;
}

function makeMethodContext(
  filePath = 'test.ts',
  language = SupportedLanguages.TypeScript,
): MethodExtractorContext {
  return { filePath, language };
}

// ---------------------------------------------------------------------------
// 1. Generic method factory with TypeScript config
// ---------------------------------------------------------------------------

describe('createMethodExtractor (generic factory)', () => {
  const tsParser = createParser(TypeScript);
  const extractor = createMethodExtractor(typescriptMethodConfig);

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
      const tree = parse(tsParser, 'interface IFoo {}');
      const ifaceNode = findNode(tree.rootNode as unknown as SyntaxNode, 'interface_declaration');
      expect(extractor.isTypeDeclaration(ifaceNode!)).toBe(true);
    });

    it('rejects non-type nodes', () => {
      const tree = parse(tsParser, 'function foo() {}');
      const funcNode = findNode(tree.rootNode as unknown as SyntaxNode, 'function_declaration');
      expect(extractor.isTypeDeclaration(funcNode!)).toBe(false);
    });
  });

  describe('extract from class', () => {
    it('extracts methods with name, returnType, parameters, visibility', () => {
      const source = `class UserService {
  getName(): string { return ""; }
  private setAge(age: number): void {}
  protected getEmail(): string | null { return null; }
}`;
      const tree = parse(tsParser, source);
      const classNode = findNode(tree.rootNode as unknown as SyntaxNode, 'class_declaration');
      const ctx = makeMethodContext();
      const result = extractor.extract(classNode!, ctx);

      expect(result).not.toBeNull();
      expect(result!.ownerName).toBe('UserService');
      expect(result!.methods.length).toBe(3);

      const getName = result!.methods.find((m) => m.name === 'getName');
      expect(getName).toBeDefined();
      expect(getName!.returnType).toBe('string');
      expect(getName!.visibility).toBe('public');
      expect(getName!.parameters.length).toBe(0);
      expect(getName!.isStatic).toBe(false);

      const setAge = result!.methods.find((m) => m.name === 'setAge');
      expect(setAge).toBeDefined();
      expect(setAge!.visibility).toBe('private');
      expect(setAge!.parameters.length).toBe(1);
      expect(setAge!.parameters[0].name).toBe('age');
      expect(setAge!.parameters[0].type).toBe('number');

      const getEmail = result!.methods.find((m) => m.name === 'getEmail');
      expect(getEmail).toBeDefined();
      expect(getEmail!.visibility).toBe('protected');
    });

    it('detects static methods', () => {
      const source = `class Utils {
  static create(): Utils { return new Utils(); }
  normal(): void {}
}`;
      const tree = parse(tsParser, source);
      const classNode = findNode(tree.rootNode as unknown as SyntaxNode, 'class_declaration');
      const ctx = makeMethodContext();
      const result = extractor.extract(classNode!, ctx);

      const createMethod = result!.methods.find((m) => m.name === 'create');
      expect(createMethod).toBeDefined();
      expect(createMethod!.isStatic).toBe(true);

      const normalMethod = result!.methods.find((m) => m.name === 'normal');
      expect(normalMethod).toBeDefined();
      expect(normalMethod!.isStatic).toBe(false);
    });

    it('detects async methods', () => {
      const source = `class Api {
  async fetchData(): Promise<string> { return ""; }
  sync(): void {}
}`;
      const tree = parse(tsParser, source);
      const classNode = findNode(tree.rootNode as unknown as SyntaxNode, 'class_declaration');
      const ctx = makeMethodContext();
      const result = extractor.extract(classNode!, ctx);

      const fetchData = result!.methods.find((m) => m.name === 'fetchData');
      expect(fetchData).toBeDefined();
      expect(fetchData!.isAsync).toBe(true);

      const sync = result!.methods.find((m) => m.name === 'sync');
      expect(sync).toBeDefined();
      expect(sync!.isAsync).toBeFalsy();
    });

    it('resolves owner name from name field', () => {
      const source = 'class MyClass { do(): void {} }';
      const tree = parse(tsParser, source);
      const classNode = findNode(tree.rootNode as unknown as SyntaxNode, 'class_declaration');
      const ctx = makeMethodContext();
      const result = extractor.extract(classNode!, ctx);
      expect(result).not.toBeNull();
      expect(result!.ownerName).toBe('MyClass');
    });
  });

  describe('extract from interface', () => {
    it('marks interface methods as abstract', () => {
      const source = `interface Repo {
  findById(id: string): User;
  save(user: User): void;
}`;
      const tree = parse(tsParser, source);
      const ifaceNode = findNode(tree.rootNode as unknown as SyntaxNode, 'interface_declaration');
      const ctx = makeMethodContext();
      const result = extractor.extract(ifaceNode!, ctx);

      expect(result).not.toBeNull();
      expect(result!.ownerName).toBe('Repo');
      expect(result!.methods.length).toBe(2);

      for (const method of result!.methods) {
        expect(method.isAbstract).toBe(true);
      }
    });
  });

  describe('parameter extraction', () => {
    it('extracts typed parameters', () => {
      const source = `class Foo {
  process(name: string, count: number): void {}
}`;
      const tree = parse(tsParser, source);
      const classNode = findNode(tree.rootNode as unknown as SyntaxNode, 'class_declaration');
      const ctx = makeMethodContext();
      const result = extractor.extract(classNode!, ctx);
      const method = result!.methods[0];

      expect(method.parameters.length).toBe(2);
      expect(method.parameters[0]).toMatchObject({
        name: 'name',
        type: 'string',
        isOptional: false,
        isVariadic: false,
      });
      expect(method.parameters[1]).toMatchObject({
        name: 'count',
        type: 'number',
        isOptional: false,
        isVariadic: false,
      });
    });

    it('extracts optional parameters', () => {
      const source = `class Foo {
  greet(name: string, greeting?: string): void {}
}`;
      const tree = parse(tsParser, source);
      const classNode = findNode(tree.rootNode as unknown as SyntaxNode, 'class_declaration');
      const ctx = makeMethodContext();
      const result = extractor.extract(classNode!, ctx);
      const method = result!.methods[0];

      expect(method.parameters.length).toBe(2);
      expect(method.parameters[0].isOptional).toBe(false);
      expect(method.parameters[1].isOptional).toBe(true);
    });

    it('extracts rest parameters', () => {
      const source = `class Foo {
  collect(...items: string[]): void {}
}`;
      const tree = parse(tsParser, source);
      const classNode = findNode(tree.rootNode as unknown as SyntaxNode, 'class_declaration');
      const ctx = makeMethodContext();
      const result = extractor.extract(classNode!, ctx);
      const method = result!.methods[0];

      expect(method.parameters.length).toBe(1);
      expect(method.parameters[0].isVariadic).toBe(true);
      expect(method.parameters[0].name).toBe('items');
    });

    it('extracts parameter with default value as optional', () => {
      const source = `class Foo {
  configure(timeout: number = 3000): void {}
}`;
      const tree = parse(tsParser, source);
      const classNode = findNode(tree.rootNode as unknown as SyntaxNode, 'class_declaration');
      const ctx = makeMethodContext();
      const result = extractor.extract(classNode!, ctx);
      const method = result!.methods[0];

      expect(method.parameters.length).toBe(1);
      expect(method.parameters[0].isOptional).toBe(true);
    });
  });

  describe('abstract methods', () => {
    it('detects abstract keyword on method', () => {
      const source = `abstract class Base {
  abstract process(): void;
  concrete(): void {}
}`;
      const tree = parse(tsParser, source);
      const classNode = findNode(
        tree.rootNode as unknown as SyntaxNode,
        'abstract_class_declaration',
      );
      const ctx = makeMethodContext();
      const result = extractor.extract(classNode!, ctx);

      expect(result).not.toBeNull();
      const abstractMethod = result!.methods.find((m) => m.name === 'process');
      const concreteMethod = result!.methods.find((m) => m.name === 'concrete');

      expect(abstractMethod).toBeDefined();
      expect(abstractMethod!.isAbstract).toBe(true);

      if (concreteMethod) {
        expect(concreteMethod.isAbstract).toBe(false);
      }
    });
  });

  describe('isFinal', () => {
    it('always returns false for TypeScript (no final keyword)', () => {
      const source = `class Foo {
  doSomething(): void {}
}`;
      const tree = parse(tsParser, source);
      const classNode = findNode(tree.rootNode as unknown as SyntaxNode, 'class_declaration');
      const ctx = makeMethodContext();
      const result = extractor.extract(classNode!, ctx);
      expect(result!.methods[0].isFinal).toBe(false);
    });
  });

  describe('extractFromNode', () => {
    it('extracts a single method from a method node', () => {
      const source = `class Foo {
  process(data: string): number { return 0; }
}`;
      const tree = parse(tsParser, source);
      const methodNode = findNode(tree.rootNode as unknown as SyntaxNode, 'method_definition');
      expect(methodNode).not.toBeNull();
      const ctx = makeMethodContext();
      const result = extractor.extractFromNode!(methodNode!, ctx);
      expect(result).not.toBeNull();
      expect(result!.name).toBe('process');
    });

    it('returns null for non-method node', () => {
      const tree = parse(tsParser, 'class Foo {}');
      const classNode = findNode(tree.rootNode as unknown as SyntaxNode, 'class_declaration');
      const ctx = makeMethodContext();
      const result = extractor.extractFromNode!(classNode!, ctx);
      expect(result).toBeNull();
    });
  });

  describe('constructor extraction', () => {
    it('extracts constructor as a method named constructor', () => {
      const source = `class Foo {
  constructor(private name: string) {}
}`;
      const tree = parse(tsParser, source);
      const classNode = findNode(tree.rootNode as unknown as SyntaxNode, 'class_declaration');
      const ctx = makeMethodContext();
      const result = extractor.extract(classNode!, ctx);
      expect(result).not.toBeNull();
      const ctor = result!.methods.find((m) => m.name === 'constructor');
      expect(ctor).toBeDefined();
    });
  });

  describe('source location', () => {
    it('records sourceFile and line from context and node position', () => {
      const source = `class Foo {
  doWork(): void {}
}`;
      const tree = parse(tsParser, source);
      const classNode = findNode(tree.rootNode as unknown as SyntaxNode, 'class_declaration');
      const ctx = makeMethodContext('src/foo.ts');
      const result = extractor.extract(classNode!, ctx);
      const method = result!.methods[0];
      expect(method.sourceFile).toBe('src/foo.ts');
      expect(typeof method.line).toBe('number');
      expect(method.line).toBeGreaterThan(0);
    });
  });

  describe('domain invariant: abstract methods cannot be final', () => {
    it('sets isFinal to false when isAbstract is true', () => {
      const source = `interface IFoo {
  process(): void;
}`;
      const tree = parse(tsParser, source);
      const ifaceNode = findNode(tree.rootNode as unknown as SyntaxNode, 'interface_declaration');
      const ctx = makeMethodContext();
      const result = extractor.extract(ifaceNode!, ctx);
      for (const method of result!.methods) {
        if (method.isAbstract) {
          expect(method.isFinal).toBe(false);
        }
      }
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Python method extraction (convention-based visibility)
// ---------------------------------------------------------------------------

describe('Python method extraction', () => {
  const pyParser = createParser(Python);
  const extractor = createMethodExtractor(pythonMethodConfig);

  it('has the correct language', () => {
    expect(extractor.language).toBe(SupportedLanguages.Python);
  });

  it('extracts methods from a class', () => {
    const source = `class UserService:
    def get_name(self) -> str:
        return ""

    def set_age(self, age: int) -> None:
        pass
`;
    const tree = parse(pyParser, source);
    const classNode = findNode(tree.rootNode as unknown as SyntaxNode, 'class_definition');
    const ctx = makeMethodContext('service.py', SupportedLanguages.Python);
    const result = extractor.extract(classNode!, ctx);

    expect(result).not.toBeNull();
    expect(result!.ownerName).toBeDefined();
    expect(result!.methods.length).toBe(2);

    const getName = result!.methods.find((m) => m.name === 'get_name');
    expect(getName).toBeDefined();
    expect(getName!.returnType).toBe('str');
    expect(getName!.parameters.length).toBe(0); // self is skipped

    const setAge = result!.methods.find((m) => m.name === 'set_age');
    expect(setAge).toBeDefined();
    expect(setAge!.parameters.length).toBe(1);
    expect(setAge!.parameters[0].name).toBe('age');
    expect(setAge!.parameters[0].type).toBe('int');
  });

  it('uses underscore convention for visibility', () => {
    const source = `class Foo:
    def public_method(self):
        pass

    def _protected_method(self):
        pass

    def __private_method(self):
        pass

    def __dunder__(self):
        pass
`;
    const tree = parse(pyParser, source);
    const classNode = findNode(tree.rootNode as unknown as SyntaxNode, 'class_definition');
    const ctx = makeMethodContext('foo.py', SupportedLanguages.Python);
    const result = extractor.extract(classNode!, ctx);

    expect(result).not.toBeNull();

    const pub = result!.methods.find((m) => m.name === 'public_method');
    expect(pub!.visibility).toBe('public');

    const prot = result!.methods.find((m) => m.name === '_protected_method');
    expect(prot!.visibility).toBe('protected');

    const priv = result!.methods.find((m) => m.name === '__private_method');
    expect(priv!.visibility).toBe('private');

    const dunder = result!.methods.find((m) => m.name === '__dunder__');
    expect(dunder!.visibility).toBe('public');
  });

  it('detects staticmethod and classmethod via decorator', () => {
    const source = `class Foo:
    @staticmethod
    def create() -> "Foo":
        return Foo()

    @classmethod
    def from_dict(cls, data: dict) -> "Foo":
        return Foo()

    def normal(self):
        pass
`;
    const tree = parse(pyParser, source);
    const classNode = findNode(tree.rootNode as unknown as SyntaxNode, 'class_definition');
    const ctx = makeMethodContext('foo.py', SupportedLanguages.Python);
    const result = extractor.extract(classNode!, ctx);

    expect(result).not.toBeNull();

    const createMethod = result!.methods.find((m) => m.name === 'create');
    expect(createMethod).toBeDefined();
    expect(createMethod!.isStatic).toBe(true);

    const fromDict = result!.methods.find((m) => m.name === 'from_dict');
    expect(fromDict).toBeDefined();
    expect(fromDict!.isStatic).toBe(true); // classmethod is treated as static

    const normal = result!.methods.find((m) => m.name === 'normal');
    expect(normal).toBeDefined();
    expect(normal!.isStatic).toBe(false);
  });

  it('detects abstractmethod via decorator', () => {
    const source = `from abc import abstractmethod

class Base:
    @abstractmethod
    def process(self) -> None:
        pass

    def concrete(self) -> str:
        return ""
`;
    const tree = parse(pyParser, source);
    const classNode = findNode(tree.rootNode as unknown as SyntaxNode, 'class_definition');
    const ctx = makeMethodContext('base.py', SupportedLanguages.Python);
    const result = extractor.extract(classNode!, ctx);

    expect(result).not.toBeNull();

    const process = result!.methods.find((m) => m.name === 'process');
    expect(process).toBeDefined();
    expect(process!.isAbstract).toBe(true);

    const concrete = result!.methods.find((m) => m.name === 'concrete');
    expect(concrete).toBeDefined();
    expect(concrete!.isAbstract).toBe(false);
  });

  it('skips self/cls first parameter', () => {
    const source = `class Foo:
    def method(self, x: int, y: int) -> int:
        return x + y

    @classmethod
    def class_method(cls, name: str) -> "Foo":
        return Foo()
`;
    const tree = parse(pyParser, source);
    const classNode = findNode(tree.rootNode as unknown as SyntaxNode, 'class_definition');
    const ctx = makeMethodContext('foo.py', SupportedLanguages.Python);
    const result = extractor.extract(classNode!, ctx);

    const method = result!.methods.find((m) => m.name === 'method');
    expect(method!.parameters.length).toBe(2); // self skipped
    expect(method!.parameters[0].name).toBe('x');

    const classMethod = result!.methods.find((m) => m.name === 'class_method');
    expect(classMethod!.parameters.length).toBe(1); // cls skipped
    expect(classMethod!.parameters[0].name).toBe('name');
  });

  it('extracts async methods', () => {
    const source = `class Api:
    async def fetch(self, url: str) -> str:
        return ""
`;
    const tree = parse(pyParser, source);
    const classNode = findNode(tree.rootNode as unknown as SyntaxNode, 'class_definition');
    const ctx = makeMethodContext('api.py', SupportedLanguages.Python);
    const result = extractor.extract(classNode!, ctx);

    const fetch = result!.methods.find((m) => m.name === 'fetch');
    expect(fetch).toBeDefined();
    expect(fetch!.isAsync).toBe(true);
  });

  it('extracts *args and **kwargs as variadic', () => {
    const source = `class Foo:
    def variadic(self, *args, **kwargs):
        pass
`;
    const tree = parse(pyParser, source);
    const classNode = findNode(tree.rootNode as unknown as SyntaxNode, 'class_definition');
    const ctx = makeMethodContext('foo.py', SupportedLanguages.Python);
    const result = extractor.extract(classNode!, ctx);

    const method = result!.methods.find((m) => m.name === 'variadic');
    expect(method).toBeDefined();
    // Both *args and **kwargs should be variadic
    expect(method!.parameters.length).toBe(2);
    expect(method!.parameters[0].isVariadic).toBe(true);
    expect(method!.parameters[0].name).toBe('args');
    expect(method!.parameters[1].isVariadic).toBe(true);
    expect(method!.parameters[1].name).toBe('kwargs');
  });

  it('extracts decorator annotations', () => {
    const source = `class Foo:
    @staticmethod
    def create():
        pass
`;
    const tree = parse(pyParser, source);
    const classNode = findNode(tree.rootNode as unknown as SyntaxNode, 'class_definition');
    const ctx = makeMethodContext('foo.py', SupportedLanguages.Python);
    const result = extractor.extract(classNode!, ctx);

    const method = result!.methods.find((m) => m.name === 'create');
    expect(method).toBeDefined();
    expect(method!.annotations.length).toBeGreaterThanOrEqual(1);
    expect(method!.annotations).toContain('@staticmethod');
  });

  it('isFinal is always false for Python', () => {
    const source = `class Foo:
    def method(self):
        pass
`;
    const tree = parse(pyParser, source);
    const classNode = findNode(tree.rootNode as unknown as SyntaxNode, 'class_definition');
    const ctx = makeMethodContext('foo.py', SupportedLanguages.Python);
    const result = extractor.extract(classNode!, ctx);
    expect(result!.methods[0].isFinal).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Go method extraction
// ---------------------------------------------------------------------------

describe('Go method extraction', () => {
  const goParser = createParser(Go);
  const extractor = createMethodExtractor(goMethodConfig);

  it('has the correct language', () => {
    expect(extractor.language).toBe(SupportedLanguages.Go);
  });

  it('recognizes method_declaration as type declaration', () => {
    // Go config uses method_declaration itself as a "type declaration"
    // because Go methods are top-level, not nested in a class body
    const source = `package main
func (r *Repo) FindById(id string) (*User, error) { return nil, nil }`;
    const tree = parse(goParser, source);
    const methodDecl = findNode(tree.rootNode as unknown as SyntaxNode, 'method_declaration');
    expect(methodDecl).not.toBeNull();
    expect(extractor.isTypeDeclaration(methodDecl!)).toBe(true);
  });

  it('extracts method with receiver type as owner', () => {
    const source = `package main
func (r *Repo) FindById(id string) (*User, error) { return nil, nil }`;
    const tree = parse(goParser, source);
    const methodDecl = findNode(tree.rootNode as unknown as SyntaxNode, 'method_declaration');
    const ctx = makeMethodContext('repo.go', SupportedLanguages.Go);
    const result = extractor.extract(methodDecl!, ctx);

    expect(result).not.toBeNull();
    // Owner name is derived from receiver type
    expect(result!.ownerName).toBe('Repo');
    expect(result!.methods.length).toBe(0);
    // Go methods are the "type declaration" themselves, so the method itself is the extract result
    // The method info is in the ownerName — the body is empty because there's no method body to recurse into
  });

  it('extracts method info via extractFromNode', () => {
    const source = `package main
func (r *Repo) FindById(id string) (*User, error) { return nil, nil }`;
    const tree = parse(goParser, source);
    const methodDecl = findNode(tree.rootNode as unknown as SyntaxNode, 'method_declaration');
    const ctx = makeMethodContext('repo.go', SupportedLanguages.Go);
    const result = extractor.extractFromNode!(methodDecl!, ctx);

    expect(result).not.toBeNull();
    expect(result!.name).toBe('FindById');
    expect(result!.receiverType).toBe('Repo');
    expect(result!.parameters.length).toBe(1);
    expect(result!.parameters[0].name).toBe('id');
    expect(result!.parameters[0].type).toBe('string');
  });

  it('finds receiver owner when called with the method_declaration node', () => {
    const source = `package main
func (r *Repo) FindById(id string) (*User, error) { return nil, nil }`;
    const tree = parse(goParser, source);
    const methodDecl = findNode(tree.rootNode as unknown as SyntaxNode, 'method_declaration');

    const owner = findEnclosingClassInfo(methodDecl!, 'repo.go');

    expect(owner).toEqual({
      classId: 'Struct:repo.go:Repo',
      className: 'Repo',
    });
  });

  it('uses capitalization for visibility', () => {
    const source = `package main
func (r *Repo) FindById(id string) (*User, error) { return nil, nil }`;
    const tree = parse(goParser, source);
    const methodDecl = findNode(tree.rootNode as unknown as SyntaxNode, 'method_declaration');
    const ctx = makeMethodContext('repo.go', SupportedLanguages.Go);
    const result = extractor.extractFromNode!(methodDecl!, ctx);

    // Uppercase = exported = public
    expect(result!.visibility).toBe('public');
  });

  it('returns private visibility for lowercase methods', () => {
    const source = `package main
func (r *Repo) findAll() []User { return nil }`;
    const tree = parse(goParser, source);
    const methodDecl = findNode(tree.rootNode as unknown as SyntaxNode, 'method_declaration');
    const ctx = makeMethodContext('repo.go', SupportedLanguages.Go);
    const result = extractor.extractFromNode!(methodDecl!, ctx);

    expect(result!.visibility).toBe('private');
  });

  it('marks function_declaration as static', () => {
    const source = `package main
func helper(x int) int { return x }`;
    const tree = parse(goParser, source);
    const funcDecl = findNode(tree.rootNode as unknown as SyntaxNode, 'function_declaration');
    const ctx = makeMethodContext('helper.go', SupportedLanguages.Go);
    const result = extractor.extractFromNode!(funcDecl!, ctx);

    expect(result).not.toBeNull();
    expect(result!.name).toBe('helper');
    expect(result!.isStatic).toBe(true); // Go functions without receiver are static
    expect(result!.receiverType).toBeNull();
  });

  it('extracts multi-name parameters', () => {
    const source = `package main
func (s *Svc) Process(a, b int, c string) {}`;
    const tree = parse(goParser, source);
    const methodDecl = findNode(tree.rootNode as unknown as SyntaxNode, 'method_declaration');
    const ctx = makeMethodContext('svc.go', SupportedLanguages.Go);
    const result = extractor.extractFromNode!(methodDecl!, ctx);

    expect(result).not.toBeNull();
    // Go allows multiple names for one type: func(a, b int)
    expect(result!.parameters.length).toBe(3);
    expect(result!.parameters[0].name).toBe('a');
    expect(result!.parameters[0].type).toBe('int');
    expect(result!.parameters[1].name).toBe('b');
    expect(result!.parameters[1].type).toBe('int');
    expect(result!.parameters[2].name).toBe('c');
    expect(result!.parameters[2].type).toBe('string');
  });

  it('extracts variadic parameters', () => {
    const source = `package main
func (s *Svc) Log(msgs ...string) {}`;
    const tree = parse(goParser, source);
    const methodDecl = findNode(tree.rootNode as unknown as SyntaxNode, 'method_declaration');
    const ctx = makeMethodContext('svc.go', SupportedLanguages.Go);
    const result = extractor.extractFromNode!(methodDecl!, ctx);

    expect(result).not.toBeNull();
    expect(result!.parameters.length).toBe(1);
    expect(result!.parameters[0].name).toBe('msgs');
    expect(result!.parameters[0].isVariadic).toBe(true);
  });

  it('extracts return type (single)', () => {
    const source = `package main
func (s *Svc) Count() int { return 0 }`;
    const tree = parse(goParser, source);
    const methodDecl = findNode(tree.rootNode as unknown as SyntaxNode, 'method_declaration');
    const ctx = makeMethodContext('svc.go', SupportedLanguages.Go);
    const result = extractor.extractFromNode!(methodDecl!, ctx);

    expect(result!.returnType).toBe('int');
  });

  it('isFinal is always false for Go', () => {
    const source = `package main
func (s *Svc) Do() {}`;
    const tree = parse(goParser, source);
    const methodDecl = findNode(tree.rootNode as unknown as SyntaxNode, 'method_declaration');
    const ctx = makeMethodContext('svc.go', SupportedLanguages.Go);
    const result = extractor.extractFromNode!(methodDecl!, ctx);
    expect(result!.isFinal).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Java method extraction (explicit modifiers)
// ---------------------------------------------------------------------------

describe('Java method extraction', () => {
  const javaParser = createParser(Java);
  const extractor = createMethodExtractor(javaMethodConfig);

  it('has the correct language', () => {
    expect(extractor.language).toBe(SupportedLanguages.Java);
  });

  it('extracts methods from a Java class', () => {
    const source = `class UserService {
    public String getName() { return ""; }
    private void setAge(int age) {}
    protected String getEmail() { return null; }
}`;
    const tree = parse(javaParser, source);
    const classNode = findNode(tree.rootNode as unknown as SyntaxNode, 'class_declaration');
    const ctx = makeMethodContext('UserService.java', SupportedLanguages.Java);
    const result = extractor.extract(classNode!, ctx);

    expect(result).not.toBeNull();
    expect(result!.ownerName).toBe('UserService');
    expect(result!.methods.length).toBe(3);

    const getName = result!.methods.find((m) => m.name === 'getName');
    expect(getName).toBeDefined();
    expect(getName!.returnType).toBe('String');
    expect(getName!.visibility).toBe('public');
    expect(getName!.parameters.length).toBe(0);

    const setAge = result!.methods.find((m) => m.name === 'setAge');
    expect(setAge).toBeDefined();
    expect(setAge!.visibility).toBe('private');
    expect(setAge!.parameters.length).toBe(1);
    expect(setAge!.parameters[0].name).toBe('age');

    const getEmail = result!.methods.find((m) => m.name === 'getEmail');
    expect(getEmail).toBeDefined();
    expect(getEmail!.visibility).toBe('protected');
  });

  it('defaults to package visibility', () => {
    const source = `class Foo {
    void process() {}
}`;
    const tree = parse(javaParser, source);
    const classNode = findNode(tree.rootNode as unknown as SyntaxNode, 'class_declaration');
    const ctx = makeMethodContext('Foo.java', SupportedLanguages.Java);
    const result = extractor.extract(classNode!, ctx);
    expect(result!.methods[0].visibility).toBe('package');
  });

  it('detects static methods via modifiers', () => {
    const source = `class Utils {
    public static Utils create() { return new Utils(); }
    public void normal() {}
}`;
    const tree = parse(javaParser, source);
    const classNode = findNode(tree.rootNode as unknown as SyntaxNode, 'class_declaration');
    const ctx = makeMethodContext('Utils.java', SupportedLanguages.Java);
    const result = extractor.extract(classNode!, ctx);

    const createMethod = result!.methods.find((m) => m.name === 'create');
    expect(createMethod!.isStatic).toBe(true);

    const normalMethod = result!.methods.find((m) => m.name === 'normal');
    expect(normalMethod!.isStatic).toBe(false);
  });

  it('detects abstract methods', () => {
    const source = `abstract class Base {
    public abstract void process();
    public void concrete() {}
}`;
    const tree = parse(javaParser, source);
    const classNode = findNode(tree.rootNode as unknown as SyntaxNode, 'class_declaration');
    const ctx = makeMethodContext('Base.java', SupportedLanguages.Java);
    const result = extractor.extract(classNode!, ctx);

    const process = result!.methods.find((m) => m.name === 'process');
    expect(process).toBeDefined();
    expect(process!.isAbstract).toBe(true);

    const concrete = result!.methods.find((m) => m.name === 'concrete');
    expect(concrete).toBeDefined();
    expect(concrete!.isAbstract).toBe(false);
  });

  it('detects final methods', () => {
    const source = `class Sealed {
    public final void locked() {}
    public void open() {}
}`;
    const tree = parse(javaParser, source);
    const classNode = findNode(tree.rootNode as unknown as SyntaxNode, 'class_declaration');
    const ctx = makeMethodContext('Sealed.java', SupportedLanguages.Java);
    const result = extractor.extract(classNode!, ctx);

    const locked = result!.methods.find((m) => m.name === 'locked');
    expect(locked).toBeDefined();
    expect(locked!.isFinal).toBe(true);

    const open = result!.methods.find((m) => m.name === 'open');
    expect(open).toBeDefined();
    expect(open!.isFinal).toBe(false);
  });

  it('abstract methods cannot be final (domain invariant)', () => {
    const source = `abstract class Base {
    public abstract void doWork();
}`;
    const tree = parse(javaParser, source);
    const classNode = findNode(tree.rootNode as unknown as SyntaxNode, 'class_declaration');
    const ctx = makeMethodContext('Base.java', SupportedLanguages.Java);
    const result = extractor.extract(classNode!, ctx);

    const method = result!.methods.find((m) => m.name === 'doWork');
    expect(method!.isAbstract).toBe(true);
    expect(method!.isFinal).toBe(false);
  });

  it('extracts interface methods as abstract (when no body)', () => {
    const source = `interface Repo {
    User findById(String id);
    void save(User user);
}`;
    const tree = parse(javaParser, source);
    const ifaceNode = findNode(tree.rootNode as unknown as SyntaxNode, 'interface_declaration');
    const ctx = makeMethodContext('Repo.java', SupportedLanguages.Java);
    const result = extractor.extract(ifaceNode!, ctx);

    expect(result).not.toBeNull();
    expect(result!.ownerName).toBe('Repo');
    for (const method of result!.methods) {
      expect(method.isAbstract).toBe(true);
    }
  });

  it('extracts constructor declarations', () => {
    const source = `class User {
    public User(String name, int age) {}
}`;
    const tree = parse(javaParser, source);
    const classNode = findNode(tree.rootNode as unknown as SyntaxNode, 'class_declaration');
    const ctx = makeMethodContext('User.java', SupportedLanguages.Java);
    const result = extractor.extract(classNode!, ctx);

    expect(result).not.toBeNull();
    const ctor = result!.methods.find((m) => m.name === 'User');
    expect(ctor).toBeDefined();
    expect(ctor!.parameters.length).toBe(2);
    expect(ctor!.parameters[0].name).toBe('name');
    expect(ctor!.parameters[1].name).toBe('age');
  });

  it('extracts annotations from modifiers', () => {
    const source = `class Foo {
    @Override
    public void toString() { return ""; }
}`;
    const tree = parse(javaParser, source);
    const classNode = findNode(tree.rootNode as unknown as SyntaxNode, 'class_declaration');
    const ctx = makeMethodContext('Foo.java', SupportedLanguages.Java);
    const result = extractor.extract(classNode!, ctx);

    const toString = result!.methods.find((m) => m.name === 'toString');
    expect(toString).toBeDefined();
    expect(toString!.annotations.length).toBeGreaterThanOrEqual(1);
    expect(toString!.annotations).toContain('@Override');
  });

  it('extracts varargs parameters', () => {
    const source = `class Logger {
    public void log(String format, Object... args) {}
}`;
    const tree = parse(javaParser, source);
    const classNode = findNode(tree.rootNode as unknown as SyntaxNode, 'class_declaration');
    const ctx = makeMethodContext('Logger.java', SupportedLanguages.Java);
    const result = extractor.extract(classNode!, ctx);

    const log = result!.methods.find((m) => m.name === 'log');
    expect(log).toBeDefined();
    expect(log!.parameters.length).toBe(2);
    expect(log!.parameters[0].isVariadic).toBe(false);
    expect(log!.parameters[1].isVariadic).toBe(true);
    expect(log!.parameters[1].name).toBe('args');
  });
});

// ---------------------------------------------------------------------------
// 5. Rust method extraction
// ---------------------------------------------------------------------------

describe('Rust method extraction', () => {
  const rustParser = createParser(Rust);
  const extractor = createMethodExtractor(rustMethodConfig);

  it('has the correct language', () => {
    expect(extractor.language).toBe(SupportedLanguages.Rust);
  });

  it('extracts methods from impl block', () => {
    const source = `struct User {
    name: String,
}

impl User {
    pub fn new(name: String) -> User {
        User { name }
    }

    pub fn get_name(&self) -> &str {
        &self.name
    }

    fn internal_helper(&self) -> bool {
        true
    }
}`;
    const tree = parse(rustParser, source);
    const implNode = findNode(tree.rootNode as unknown as SyntaxNode, 'impl_item');
    const ctx = makeMethodContext('user.rs', SupportedLanguages.Rust);
    const result = extractor.extract(implNode!, ctx);

    expect(result).not.toBeNull();
    expect(result!.ownerName).toBe('User');
    expect(result!.methods.length).toBe(3);

    const newMethod = result!.methods.find((m) => m.name === 'new');
    expect(newMethod).toBeDefined();
    expect(newMethod!.visibility).toBe('public');
    expect(newMethod!.isStatic).toBe(true); // no self parameter = static
    expect(newMethod!.returnType).toBe('User');
    expect(newMethod!.parameters.length).toBe(1);
    expect(newMethod!.parameters[0].name).toBe('name');
    expect(newMethod!.parameters[0].type).toBe('String');

    const getName = result!.methods.find((m) => m.name === 'get_name');
    expect(getName).toBeDefined();
    expect(getName!.visibility).toBe('public');
    expect(getName!.isStatic).toBe(false); // has &self
    expect(getName!.receiverType).toBe('&self');

    const helper = result!.methods.find((m) => m.name === 'internal_helper');
    expect(helper).toBeDefined();
    expect(helper!.visibility).toBe('private');
  });

  it('extracts methods from trait definitions', () => {
    const source = `trait Repository {
    fn find_by_id(&self, id: &str) -> Option<User>;
    fn save(&mut self, user: User) -> Result<(), Error>;
    fn count(&self) -> usize {
        0
    }
}`;
    const tree = parse(rustParser, source);
    const traitNode = findNode(tree.rootNode as unknown as SyntaxNode, 'trait_item');
    const ctx = makeMethodContext('repo.rs', SupportedLanguages.Rust);
    const result = extractor.extract(traitNode!, ctx);

    expect(result).not.toBeNull();
    expect(result!.ownerName).toBe('Repository');

    // function_signature_item (no body) should be abstract
    const findById = result!.methods.find((m) => m.name === 'find_by_id');
    expect(findById).toBeDefined();
    expect(findById!.isAbstract).toBe(true);
    expect(findById!.parameters.length).toBe(1); // self skipped
    expect(findById!.parameters[0].name).toBe('id');

    const save = result!.methods.find((m) => m.name === 'save');
    expect(save).toBeDefined();
    expect(save!.isAbstract).toBe(true);
    expect(save!.receiverType).toBe('&mut self');

    // function_item with body in trait = default implementation, not abstract
    const count = result!.methods.find((m) => m.name === 'count');
    expect(count).toBeDefined();
    expect(count!.isAbstract).toBe(false);
  });

  it('detects async methods', () => {
    const source = `impl Api {
    pub async fn fetch(&self, url: &str) -> String {
        String::new()
    }
}`;
    const tree = parse(rustParser, source);
    const implNode = findNode(tree.rootNode as unknown as SyntaxNode, 'impl_item');
    const ctx = makeMethodContext('api.rs', SupportedLanguages.Rust);
    const result = extractor.extract(implNode!, ctx);

    const fetch = result!.methods.find((m) => m.name === 'fetch');
    expect(fetch).toBeDefined();
    expect(fetch!.isAsync).toBe(true);
  });

  it('skips self parameter from extracted parameters', () => {
    const source = `impl Foo {
    fn method(&self, x: i32, y: i32) -> i32 {
        x + y
    }
}`;
    const tree = parse(rustParser, source);
    const implNode = findNode(tree.rootNode as unknown as SyntaxNode, 'impl_item');
    const ctx = makeMethodContext('foo.rs', SupportedLanguages.Rust);
    const result = extractor.extract(implNode!, ctx);

    const method = result!.methods.find((m) => m.name === 'method');
    expect(method!.parameters.length).toBe(2); // self is not included
    expect(method!.parameters[0].name).toBe('x');
    expect(method!.parameters[1].name).toBe('y');
  });

  it('resolves owner name for impl Trait for Struct', () => {
    const source = `impl Display for User {
    fn fmt(&self, f: &mut Formatter) -> Result {
        Ok(())
    }
}`;
    const tree = parse(rustParser, source);
    const implNode = findNode(tree.rootNode as unknown as SyntaxNode, 'impl_item');
    const ctx = makeMethodContext('user.rs', SupportedLanguages.Rust);
    const result = extractor.extract(implNode!, ctx);

    expect(result).not.toBeNull();
    // For `impl Trait for Struct`, owner should be Struct (after `for`)
    expect(result!.ownerName).toBe('User');
  });

  it('links trait impl methods to the actual enum owner label', () => {
    const source = `enum Expr {
    Name,
}

impl ruff_text_size::Ranged for Expr {
    fn range(&self) -> TextRange {
        match self {
            Self::Name => TextRange::default(),
        }
    }
}`;
    const tree = parse(rustParser, source);
    const functionNode = findNode(tree.rootNode as unknown as SyntaxNode, 'function_item');
    const owner = findEnclosingClassInfo(functionNode!, 'generated.rs');

    expect(owner).toEqual({
      classId: 'Enum:generated.rs:Expr',
      className: 'Expr',
    });
  });

  it('isFinal is always false for Rust', () => {
    const source = `impl Foo {
    fn method(&self) {}
}`;
    const tree = parse(rustParser, source);
    const implNode = findNode(tree.rootNode as unknown as SyntaxNode, 'impl_item');
    const ctx = makeMethodContext('foo.rs', SupportedLanguages.Rust);
    const result = extractor.extract(implNode!, ctx);
    expect(result!.methods[0].isFinal).toBe(false);
  });

  it('isStatic true for methods without self parameter', () => {
    const source = `impl Factory {
    pub fn create() -> Factory {
        Factory {}
    }
}`;
    const tree = parse(rustParser, source);
    const implNode = findNode(tree.rootNode as unknown as SyntaxNode, 'impl_item');
    const ctx = makeMethodContext('factory.rs', SupportedLanguages.Rust);
    const result = extractor.extract(implNode!, ctx);

    const create = result!.methods.find((m) => m.name === 'create');
    expect(create!.isStatic).toBe(true);
    expect(create!.receiverType).toBeNull();
  });

  it('abstract methods cannot be final (domain invariant)', () => {
    const source = `trait Processor {
    fn process(&self, data: &[u8]) -> Vec<u8>;
}`;
    const tree = parse(rustParser, source);
    const traitNode = findNode(tree.rootNode as unknown as SyntaxNode, 'trait_item');
    const ctx = makeMethodContext('proc.rs', SupportedLanguages.Rust);
    const result = extractor.extract(traitNode!, ctx);

    for (const method of result!.methods) {
      if (method.isAbstract) {
        expect(method.isFinal).toBe(false);
      }
    }
  });
});
