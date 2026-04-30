import ignore, { type Ignore } from 'ignore';
import fs from 'fs/promises';
import nodePath from 'path';
import type { Path } from 'path-scurry';

const BARE_LITERAL_IGNORE_META = /[*?[\]{}]/;

const DEFAULT_IGNORE_LIST = new Set([
  // Version Control
  '.git',
  '.svn',
  '.hg',
  '.bzr',

  // IDEs & Editors
  '.idea',
  '.vscode',
  '.vs',
  '.eclipse',
  '.settings',
  '.DS_Store',
  'Thumbs.db',

  // Dependencies
  'node_modules',
  'bower_components',
  'jspm_packages',
  'vendor', // PHP/Go
  // 'packages' removed - commonly used for monorepo source code (lerna, pnpm, yarn workspaces)
  'venv',
  '.venv',
  'env',
  '.env',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  'site-packages',
  '.tox',
  'eggs',
  '.eggs',
  'lib64',
  'parts',
  'sdist',
  'wheels',

  // Build Outputs
  'dist',
  'build',
  'out',
  'output',
  'bin',
  'obj',
  'target', // Java/Rust
  '.next',
  '.nuxt',
  '.output',
  '.vercel',
  '.netlify',
  '.serverless',
  '_build',
  'public/build',
  '.parcel-cache',
  '.turbo',
  '.svelte-kit',
  '.cotx',

  // Test & Coverage
  'coverage',
  '.nyc_output',
  'htmlcov',
  '.coverage',
  '__tests__', // Often just test files
  '__mocks__',
  '.jest',

  // Logs & Temp
  'logs',
  'log',
  'tmp',
  'temp',
  'cache',
  '.cache',
  '.tmp',
  '.temp',

  // Generated/Compiled
  '.generated',
  'generated',
  'auto-generated',
  '.terraform',
  '.serverless',

  // Documentation (optional - might want to keep)
  // 'docs',
  // 'documentation',

  // Misc
  '.husky',
  '.github', // GitHub config, not code
  '.circleci',
  '.gitlab',
  'fixtures', // Test fixtures
  'snapshots', // Jest snapshots
  '__snapshots__',

  // Data / fixture / artifact directories — aligned with GitHub Linguist
  // vendor.yml, Semgrep's bundled ignore, and SourceGraph defaults. These
  // are NEVER the architecture you want to analyze; leaving them in
  // produces massive noisy graphs (seen on quantos: 249-dir corpus_staging
  // swamped the typed graph). NOTE: 'example'/'examples'/'samples' are
  // deliberately NOT here — too often contain real source (library usage
  // docs, React examples). Add them via .cotxignore if needed.
  'testdata', // Go convention
  'corpus',
  'corpora',
  'corpus_staging',
  'benchmarks',
  'benches', // Rust
  'artifacts',
  'datasets',
  'dataset',
  // NOTE: 'data' is NOT here — too many real projects put source under
  // `data/` (data pipelines, domain models). Add via .cotxignore if the
  // repo stores blobs/CSVs under that name.
]);

const IGNORED_EXTENSIONS = new Set([
  // Images
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.ico',
  '.webp',
  '.bmp',
  '.tiff',
  '.tif',
  '.psd',
  '.ai',
  '.sketch',
  '.fig',
  '.xd',

  // Archives
  '.zip',
  '.tar',
  '.gz',
  '.rar',
  '.7z',
  '.bz2',
  '.xz',
  '.tgz',

  // Binary/Compiled
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.a',
  '.lib',
  '.o',
  '.obj',
  '.class',
  '.jar',
  '.war',
  '.ear',
  '.pyc',
  '.pyo',
  '.pyd',
  '.beam', // Erlang
  '.wasm', // WebAssembly - important!
  '.node', // Native Node addons

  // Documents
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.odt',
  '.ods',
  '.odp',

  // Media
  '.mp4',
  '.mp3',
  '.wav',
  '.mov',
  '.avi',
  '.mkv',
  '.flv',
  '.wmv',
  '.ogg',
  '.webm',
  '.flac',
  '.aac',
  '.m4a',

  // Fonts
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.otf',

  // Databases
  '.db',
  '.sqlite',
  '.sqlite3',
  '.mdb',
  '.accdb',

  // Minified/Bundled files
  '.min.js',
  '.min.css',
  '.bundle.js',
  '.chunk.js',

  // Source maps (debug files, not source)
  '.map',

  // Lock files (handled separately, but also here)
  '.lock',

  // Certificates & Keys (security - don't index!)
  '.pem',
  '.key',
  '.crt',
  '.cer',
  '.p12',
  '.pfx',

  // Data files (often large/binary)
  '.csv',
  '.tsv',
  '.parquet',
  '.avro',
  '.feather',
  '.npy',
  '.npz',
  '.pkl',
  '.pickle',
  '.h5',
  '.hdf5',

  // Misc binary
  '.bin',
  '.dat',
  '.data',
  '.raw',
  '.iso',
  '.img',
  '.dmg',
]);

// Files to ignore by exact name
const IGNORED_FILES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'composer.lock',
  'Gemfile.lock',
  'poetry.lock',
  'Cargo.lock',
  'go.sum',
  '.gitignore',
  '.gitattributes',
  '.npmrc',
  '.yarnrc',
  '.editorconfig',
  '.prettierrc',
  '.prettierignore',
  '.eslintignore',
  '.dockerignore',
  'Thumbs.db',
  '.DS_Store',
  'LICENSE',
  'LICENSE.md',
  'LICENSE.txt',
  'CHANGELOG.md',
  'CHANGELOG',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'SECURITY.md',
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.test',
  '.env.example',
]);

// NOTE: Negation patterns in .cotxignore (e.g. `!vendor/`) cannot override
// entries in DEFAULT_IGNORE_LIST — this is intentional. The hardcoded list protects
// against indexing directories that are almost never source code (node_modules, .git, etc.).
// Users who need to include such directories should remove them from the hardcoded list.
export const shouldIgnorePath = (filePath: string): boolean => {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const parts = normalizedPath.split('/');
  const fileName = parts[parts.length - 1];
  const fileNameLower = fileName.toLowerCase();

  // Check if any path segment is in ignore list
  for (const part of parts) {
    if (DEFAULT_IGNORE_LIST.has(part)) {
      return true;
    }
  }

  // Check exact filename matches
  if (IGNORED_FILES.has(fileName) || IGNORED_FILES.has(fileNameLower)) {
    return true;
  }

  // Check extension
  const lastDotIndex = fileNameLower.lastIndexOf('.');
  if (lastDotIndex !== -1) {
    const ext = fileNameLower.substring(lastDotIndex);
    if (IGNORED_EXTENSIONS.has(ext)) return true;

    // Handle compound extensions like .min.js, .bundle.js
    const secondLastDot = fileNameLower.lastIndexOf('.', lastDotIndex - 1);
    if (secondLastDot !== -1) {
      const compoundExt = fileNameLower.substring(secondLastDot);
      if (IGNORED_EXTENSIONS.has(compoundExt)) return true;
    }
  }

  // Ignore hidden files (starting with .)
  if (fileName.startsWith('.') && fileName !== '.') {
    // But allow some important config files
    const allowedDotFiles = ['.env', '.gitignore']; // Already in IGNORED_FILES, so this is redundant
    // Actually, let's NOT ignore all dot files - many are important configs
    // Just rely on the explicit lists above
  }

  // Ignore files that look like generated/bundled code
  if (
    fileNameLower.includes('.bundle.') ||
    fileNameLower.includes('.chunk.') ||
    fileNameLower.includes('.generated.') ||
    fileNameLower.endsWith('.d.ts')
  ) {
    // TypeScript declaration files
    return true;
  }

  return false;
};

/** Check if a directory name is in the hardcoded ignore list */
export const isHardcodedIgnoredDirectory = (name: string): boolean => {
  return DEFAULT_IGNORE_LIST.has(name);
};

/**
 * Load .gitignore and .cotxignore rules from the repo root.
 * Returns an `ignore` instance with all patterns, or null if no files found.
 */
export interface IgnoreOptions {
  /** Skip .gitignore parsing, only read .cotxignore. Defaults to COTX_NO_GITIGNORE env var. */
  noGitignore?: boolean;
}

interface LoadedIgnoreRules {
  matcher: Ignore | null;
  gitignoreBareNames: Set<string>;
}

const extractBareLiteralIgnoreNames = (content: string): Set<string> => {
  const names = new Set<string>();
  for (const rawLine of content.split(/\r?\n/u)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    if (line.startsWith('\\#') || line.startsWith('\\!')) {
      line = line.slice(1);
    }
    if (line.endsWith('/')) {
      line = line.slice(0, -1);
    }
    if (!line || line.includes('/') || BARE_LITERAL_IGNORE_META.test(line)) continue;
    names.add(line);
  }
  return names;
};

const normalizeRelativePath = (relativePath: string): string => {
  return relativePath.replace(/\\/g, '/').replace(/\/+$/u, '');
};

const shouldPreserveGoCommandSourcePath = (
  relativePath: string,
  gitignoreBareNames: Set<string>,
): boolean => {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized.startsWith('cmd/')) return false;

  const parts = normalized.split('/');
  if (parts.length < 2) return false;

  const commandName = parts[1];
  if (!commandName || !gitignoreBareNames.has(commandName)) return false;

  if (parts.length === 2) return true;
  return normalized.endsWith('.go');
};

export const loadIgnoreRules = async (
  repoPath: string,
  options?: IgnoreOptions,
): Promise<LoadedIgnoreRules> => {
  const ig = ignore();
  let hasRules = false;
  const gitignoreBareNames = new Set<string>();

  // Allow users to bypass .gitignore parsing (e.g. when .gitignore accidentally excludes source files)
  const skipGitignore = options?.noGitignore ?? !!process.env.COTX_NO_GITIGNORE;
  const filenames = skipGitignore ? ['.cotxignore'] : ['.gitignore', '.cotxignore'];

  for (const filename of filenames) {
    try {
      const content = await fs.readFile(nodePath.join(repoPath, filename), 'utf-8');
      ig.add(content);
      if (filename === '.gitignore') {
        for (const name of extractBareLiteralIgnoreNames(content)) {
          gitignoreBareNames.add(name);
        }
      }
      hasRules = true;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        console.warn(`  Warning: could not read ${filename}: ${(err as Error).message}`);
      }
    }
  }

  return { matcher: hasRules ? ig : null, gitignoreBareNames };
};

/**
 * Create a glob-compatible ignore filter combining:
 * - .gitignore / .cotxignore patterns (via `ignore` package)
 * - Hardcoded DEFAULT_IGNORE_LIST, IGNORED_EXTENSIONS, IGNORED_FILES
 *
 * Returns an IgnoreLike object for glob's `ignore` option,
 * enabling directory-level pruning during traversal.
 */
export const createIgnoreFilter = async (repoPath: string, options?: IgnoreOptions) => {
  const { matcher: ig, gitignoreBareNames } = await loadIgnoreRules(repoPath, options);

  return {
    ignored(p: Path): boolean {
      // path-scurry's Path.relative() returns POSIX paths on all platforms,
      // which is what the `ignore` package expects. No explicit normalization needed.
      const rel = p.relative();
      if (!rel) return false;
      // Check .gitignore / .cotxignore patterns
      if (ig && ig.ignores(rel) && !shouldPreserveGoCommandSourcePath(rel, gitignoreBareNames)) {
        return true;
      }
      // Fall back to hardcoded rules
      return shouldIgnorePath(rel);
    },
    childrenIgnored(p: Path): boolean {
      // Fast path: check directory name against hardcoded list.
      // Note: dot-directories (.git, .vscode, etc.) are primarily excluded by
      // glob's `dot: false` option in filesystem-walker.ts. This check is
      // defense-in-depth — do not remove `dot: false` assuming this covers it.
      if (DEFAULT_IGNORE_LIST.has(p.name)) return true;
      // Check against .gitignore / .cotxignore patterns.
      // Test both bare path and path with trailing slash to handle
      // bare-name patterns (e.g. `local`) and dir-only patterns (e.g. `local/`).
      if (ig) {
        const rel = p.relative();
        if (
          rel &&
          (ig.ignores(rel) || ig.ignores(rel + '/')) &&
          !shouldPreserveGoCommandSourcePath(rel, gitignoreBareNames)
        ) {
          return true;
        }
      }
      return false;
    },
  };
};
