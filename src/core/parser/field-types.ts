import type { TypeEnvironment } from './type-env.js';
import type { SymbolTable } from './symbol-table.js';
import { SupportedLanguages } from '../shared/index.js';

/**
 * Access-level modifiers for class/struct fields across supported languages.
 *
 * Covers standard OOP visibility (public, private, protected) plus
 * language-specific modifiers: C# internal/protected internal/private protected,
 * Java package-private, Swift fileprivate/open.
 */
export type FieldVisibility =
  | 'public'
  | 'private'
  | 'protected'
  | 'internal'
  | 'protected internal'
  | 'private protected'
  | 'package'
  | 'fileprivate'
  | 'open';

/**
 * Describes a single field or property declared inside a class, struct,
 * interface, or similar type container.
 */
export interface FieldInfo {
  name: string;
  type: string | null;
  visibility: FieldVisibility;
  isStatic: boolean;
  isReadonly: boolean;
  sourceFile: string;
  line: number;
}

/**
 * Association from a fully-qualified owner type name to its extracted fields.
 */
export type FieldTypeMap = Map<string, FieldInfo[]>;

/**
 * Runtime context passed into field extraction routines, providing access to
 * type resolution infrastructure and file metadata.
 */
export interface FieldExtractorContext {
  typeEnv: TypeEnvironment;
  symbolTable: SymbolTable;
  filePath: string;
  language: SupportedLanguages;
}

/**
 * The output produced by extracting fields from a single type declaration node.
 */
export interface ExtractedFields {
  ownerFqn: string;
  fields: FieldInfo[];
  nestedTypes: string[];
}
