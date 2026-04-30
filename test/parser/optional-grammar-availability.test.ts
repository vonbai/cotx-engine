import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandCompile } from '../../src/commands/compile.js';
import { SupportedLanguages } from '../../src/core/shared/index.js';
import { isLanguageAvailable } from '../../src/core/tree-sitter/parser-loader.js';

describe('optional grammar availability', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotx-optional-grammar-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('warns when supported-language files are skipped because optional parsers are missing', async () => {
    const optionalFiles: Array<{ language: SupportedLanguages; filePath: string; content: string }> = [
      {
        language: SupportedLanguages.Kotlin,
        filePath: 'src/Main.kt',
        content: 'class User { fun name(): String = "user" }\n',
      },
      {
        language: SupportedLanguages.Swift,
        filePath: 'Sources/main.swift',
        content: 'struct User { func name() -> String { "user" } }\n',
      },
      {
        language: SupportedLanguages.Dart,
        filePath: 'lib/main.dart',
        content: 'class User { String name() => "user"; }\n',
      },
    ];
    const missing = optionalFiles.filter((item) => !isLanguageAvailable(item.language));
    if (missing.length === 0) return;

    for (const item of missing) {
      const filePath = path.join(tmpDir, item.filePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, item.content);
    }

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await commandCompile(tmpDir, { silent: true });

    const warnings = warn.mock.calls.map((args) => args.join(' ')).join('\n');
    for (const item of missing) {
      expect(warnings).toContain(`Skipping 1 ${item.language} file(s)`);
      expect(warnings).toContain(`${item.language} parser not available`);
    }
  });
});
