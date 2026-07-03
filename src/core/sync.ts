/**
 * Sync utilities — pure functions for git diff parsing, filtering, and slug management.
 *
 * SYNC DATA FLOW:
 *   git diff --name-status -M LAST..HEAD
 *       │
 *   buildSyncManifest()  →  parse A/M/D/R lines
 *       │
 *   isSyncable()  →  filter to .md pages only
 *       │
 *   pathToSlug()  →  convert file paths to page slugs
 */

import { CJK_SLUG_CHARS } from './cjk.ts';
// v0.37.7.0 #1169 submodule-detection helpers. Bottom-of-file already
// aliases existsSync as `_existsSync` for other purposes; the top-of-file
// import keeps the pruneDir helper's deps near its callsite.
import { existsSync, statSync } from 'fs';
import { join as pathJoin } from 'path';

export interface SyncManifest {
  added: string[];
  modified: string[];
  deleted: string[];
  renamed: Array<{ from: string; to: string }>;
}

export interface RawManifestEntry {
  action: 'A' | 'M' | 'D' | 'R';
  path: string;
  oldPath?: string;
}

export type SyncStrategy = 'markdown' | 'code' | 'auto';

interface SyncableOptions {
  strategy?: SyncStrategy;
  include?: string[];
  exclude?: string[];
}

// v0.19.0 shipped a 9-extension allowlist (ts/tsx/js/jsx/mjs/cjs/py/rb/go). The
// chunker already supports ~35 extensions via detectCodeLanguage but the sync
// classifier dropped every other language on the floor — Rust/Java/C#/C++/etc.
// files never reached the chunker on a normal repo sync, making v0.19.0's
// "165 languages" claim aspirational (codex F1). v0.20.0 Layer 2 (1a) rewrites
// isCodeFilePath to delegate to detectCodeLanguage so the sync classifier
// matches the chunker's actual coverage.
//
// Kept as-is for now for `isAllowedByStrategy` fast-path + tests that
// structurally reference it. Derived from the chunker's language map at
// module load, not hardcoded.
const CODE_EXTENSIONS = new Set<string>([
  '.ts', '.tsx', '.mts', '.cts',
  '.js', '.jsx', '.mjs', '.cjs',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.cs',
  '.cpp', '.cc', '.cxx', '.hpp', '.hxx', '.hh',
  '.c', '.h',
  '.php',
  '.swift',
  '.kt', '.kts',
  '.scala', '.sc',
  '.lua',
  '.ex', '.exs',
  '.elm',
  '.ml', '.mli',
  '.dart',
  '.zig',
  '.sol',
  '.sh', '.bash',
  '.css',
  '.html', '.htm',
  '.vue',
  '.json',
  '.yaml', '.yml',
  '.toml',
  // v0.36.x #878: Terraform / HCL. Closes the silent-data-loss bug where
  // Terraform repos were invisible to `gbrain sync --strategy code`.
  // detectCodeLanguage() returns null for these so they chunk via the
  // recursive chunker (no tree-sitter grammar), which is the correct
  // fallback — same path as toml / yaml without language-specific AST.
  '.tf', '.tfvars', '.hcl',
  // v0.41 D2 wave (#1173): SQL via tree-sitter-sql. DerekStride grammar
  // chunks DDL (CREATE TABLE/FUNCTION/VIEW/INDEX) and DML (SELECT/INSERT/
  // UPDATE/DELETE) as one chunk per statement. DDL chunks carry
  // symbol_name + symbol_type populated for code-def; DML chunks emit
  // unnamed so they don't pollute symbol search.
  '.sql',
]);

/**
 * Parse the output of `git diff --name-status -M LAST..HEAD` into structured entries.
 *
 * Input format (tab-separated):
 *   A       path/to/new-file.md
 *   M       path/to/modified-file.md
 *   D       path/to/deleted-file.md
 *   R100    old/path.md     new/path.md
 */
export function buildSyncManifest(gitDiffOutput: string): SyncManifest {
  const manifest: SyncManifest = {
    added: [],
    modified: [],
    deleted: [],
    renamed: [],
  };

  const lines = gitDiffOutput.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const parts = trimmed.split('\t');
    if (parts.length < 2) continue;

    const action = parts[0];
    const path = parts[parts.length === 3 ? 2 : 1]; // For renames, new path is 3rd column

    if (action === 'A') {
      manifest.added.push(path);
    } else if (action === 'M') {
      manifest.modified.push(path);
    } else if (action === 'D') {
      manifest.deleted.push(parts[1]);
    } else if (action.startsWith('R')) {
      // Rename: R100\told-path\tnew-path
      const oldPath = parts[1];
      const newPath = parts[2];
      if (oldPath && newPath) {
        manifest.renamed.push({ from: oldPath, to: newPath });
      }
    }
  }

  return manifest;
}

export function isCodeFilePath(path: string): boolean {
  const lower = path.toLowerCase();
  for (const ext of CODE_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

/**
 * v0.27.1: image extensions are admitted only when the multimodal config
 * gate is on. The runtime gate flips through `process.env.GBRAIN_EMBEDDING_MULTIMODAL`
 * which loadConfigWithEngine populates from the DB plane after engine connect
 * (or env directly when the operator overrides). When the gate is off,
 * existing brains keep their current "markdown + code only" sync behavior.
 */
export function isImageFilePath(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    lower.endsWith('.png') ||
    lower.endsWith('.jpg') ||
    lower.endsWith('.jpeg') ||
    lower.endsWith('.gif') ||
    lower.endsWith('.webp') ||
    lower.endsWith('.heic') ||
    lower.endsWith('.heif') ||
    lower.endsWith('.avif')
  );
}

export function isMarkdownFilePath(path: string): boolean {
  return path.endsWith('.md') || path.endsWith('.mdx');
}

function isMultimodalEnabled(): boolean {
  return process.env.GBRAIN_EMBEDDING_MULTIMODAL === 'true';
}

function isAllowedByStrategy(path: string, strategy: SyncStrategy): boolean {
  if (strategy === 'markdown') return isMarkdownFilePath(path);
  if (strategy === 'code') return isCodeFilePath(path);
  // 'auto' / default: markdown + code, plus images when multimodal is on.
  return (
    isMarkdownFilePath(path) ||
    isCodeFilePath(path) ||
    (isMultimodalEnabled() && isImageFilePath(path))
  );
}

function globToRegex(pattern: string): RegExp {
  let regex = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      const next = pattern[i + 1];
      if (next === '*') {
        // `**/` matches zero or more path segments (including zero, so `src/**/*.ts`
        // matches `src/foo.ts` as well as `src/a/b/foo.ts`). Collapse `**/` →
        // `(?:.*/)?`. A bare `**` not followed by `/` matches any chars.
        if (pattern[i + 2] === '/') {
          regex += '(?:.*/)?';
          i += 2;
        } else {
          regex += '.*';
          i++;
        }
      } else {
        regex += '[^/]*';
      }
      continue;
    }
    if (ch === '?') { regex += '[^/]'; continue; }
    if ('\\.[]{}()+-^$|'.includes(ch)) { regex += `\\${ch}`; continue; }
    regex += ch;
  }
  regex += '$';
  return new RegExp(regex);
}

function matchesAnyGlob(path: string, patterns?: string[]): boolean {
  if (!patterns || patterns.length === 0) return false;
  const normalized = path.replace(/\\/g, '/');
  return patterns.some((pattern) => globToRegex(pattern).test(normalized));
}

/**
 * Directory names that walkers must NEVER descend into. Used at descent
 * time (before recursion) to prune entire subtrees — saves the IO cost of
 * walking thousands of vendor / generated / hidden files only to filter
 * them at file-emit time. Used by every walker in gbrain (sync, extract,
 * transcript-discovery, etc.).
 *
 * Pattern: dirname matching at single path-segment granularity. Walkers
 * call `pruneDir(entry.name)` on each subdirectory before recursing.
 *
 * `node_modules` lacks a leading dot so the dot-prefix exclusion in
 * isSyncable below doesn't catch it; explicit entry here closes the
 * latent walker bug (#923, #202).
 */
const PRUNE_DIR_NAMES = new Set<string>([
  'node_modules',
  // Dependency / build-output trees that are git-ignored on virtually every
  // repo and never contain hand-authored source worth indexing. `vendor`
  // (PHP Composer / Go / Ruby bundle), `dist` + `build` (compiled output).
  // Closes the silent-pollution bug where a Laravel/PHP repo's full code sync
  // walked ~50k `vendor/` files (#1483 / #1159 / maintainer #1942).
  'vendor',
  'dist',
  'build',
  // Python venv: vendored dependency tree, the `node_modules` analogue (#2020).
  // Like `node_modules` it lacks a leading dot so isSyncable's dot-prefix
  // exclusion misses it; explicit entry keeps incremental sync consistent
  // with the first-sync walker in commands/import.ts.
  'venv',
  '.raw',
  'ops',
]);

/**
 * Should this directory be descended into? Returns `false` for vendor / hidden /
 * generated dirs that walkers should skip BEFORE recursing. Catches
 * `node_modules` (latent bug — no leading dot), dot-prefix dirs (`.git`,
 * `.obsidian`, `.raw`, `.cache`, etc. via the leading-dot heuristic), and the
 * explicit `PRUNE_DIR_NAMES` set above.
 *
 * `name` is a single path segment (basename of the directory entry), NOT a
 * full path. Walkers consult this on each subdirectory entry during recursion.
 *
 * v0.37.7.0 #1169: when callers pass `parentDir`, ALSO skip git submodule
 * directories (detected by the presence of `.git` as a FILE — not a
 * directory — inside the candidate dir). The `parentDir` arg is optional so
 * existing callers stay back-compat; new callers (sync walker, extract
 * walker) thread it through.
 */
export function pruneDir(name: string, parentDir?: string): boolean {
  if (!name) return true;
  if (name.startsWith('.')) return false;
  if (PRUNE_DIR_NAMES.has(name)) return false;
  // `.raw` is the literal directory name; `*.raw` is the gbrain sidecar
  // convention (e.g. `people/pedro.raw/` holds raw source for pedro.md).
  // Both forms should be skipped at descent time.
  if (name.endsWith('.raw')) return false;
  // Submodule detection: a git submodule directory contains `.git` as
  // a FILE (a "gitfile" pointing into the parent's .git/modules/...),
  // not a directory. Best-effort: if we can't stat (e.g. cross-platform
  // permission edge), fall through and treat as a normal dir.
  if (parentDir) {
    try {
      const gitPath = pathJoin(parentDir, name, '.git');
      if (existsSync(gitPath) && statSync(gitPath).isFile()) {
        return false;
      }
    } catch {
      // Stat failed — descend normally rather than silently exclude.
    }
  }
  return true;
}

/**
 * Discriminator for WHY a path is not syncable. Returned by `unsyncableReason`
 * so the sync cleanup loop in `commands/sync.ts` can distinguish "metafile we
 * intentionally exclude" from "user removed this file from the strategy".
 *
 * v0.41.13 (#1433): pre-fix, the cleanup loop in performSync treated all
 * unsyncable-modified paths the same and DELETED any pre-existing page for
 * them. That silently dropped `log.md` / `schema.md` / `README.md` pages
 * that had been indexed by older gbrain versions (or via direct put_page).
 * The fix guards that loop on `unsyncableReason(...) === 'metafile'` and
 * preserves those rows.
 */
export type SyncableReason =
  | 'metafile'
  | 'strategy'
  | 'pruned-dir'
  | 'include-glob-miss'
  | 'exclude-glob-hit';

/**
 * Canonical metafile basenames the markdown sync strategy intentionally
 * skips. Exported so the cleanup-loop guard in `commands/sync.ts` can
 * surface them in user-facing logs / docs without re-declaring the list.
 *
 * These files are append-only domain logs / index pages / boilerplate
 * READMEs — not typed brain pages — by convention. A user who genuinely
 * wants to index one of these basenames as a page should rename it.
 */
export const SYNC_SKIP_FILES = ['schema.md', 'index.md', 'log.md', 'README.md'] as const;

/**
 * Internal classifier. Returns null when the path IS syncable, or a tagged
 * SyncableReason explaining why it isn't. The single source of truth that
 * both `isSyncable` (boolean) and `unsyncableReason` (tagged) call.
 *
 * Codex review caught the drift risk if `unsyncableReason` were an independent
 * re-implementation. Funnelling both public APIs through `classifySync` means
 * TypeScript enforces consistency at the compiler level.
 */
function classifySync(path: string, opts: SyncableOptions = {}): SyncableReason | null {
  const strategy = opts.strategy || 'markdown';

  if (!isAllowedByStrategy(path, strategy)) return 'strategy';

  // Skip every path segment that pruneDir would block walkers from descending
  // into. Catches hidden dirs (`.git`, `.obsidian`), `.raw/` sidecars,
  // `node_modules/` (latent bug fix), and `ops/` at any depth.
  const segments = path.split('/');
  if (segments.some(p => !pruneDir(p))) return 'pruned-dir';

  // Skip meta files that aren't pages
  const basename = segments[segments.length - 1] || '';
  if ((SYNC_SKIP_FILES as readonly string[]).includes(basename)) return 'metafile';

  if (opts.include && opts.include.length > 0 && !matchesAnyGlob(path, opts.include)) return 'include-glob-miss';
  if (opts.exclude && opts.exclude.length > 0 && matchesAnyGlob(path, opts.exclude)) return 'exclude-glob-hit';

  return null;
}

/**
 * Filter a file path to determine if it should be synced to GBrain.
 * Strategy-aware: 'markdown' (default) = .md/.mdx only, 'code' = code files only, 'auto' = both.
 */
export function isSyncable(path: string, opts: SyncableOptions = {}): boolean {
  return classifySync(path, opts) === null;
}

/**
 * Companion to `isSyncable`. Returns null when the path IS syncable, or a
 * tagged `SyncableReason` explaining why it isn't. Used by the v0.41.13
 * #1433 cleanup guard in `commands/sync.ts` to distinguish metafile
 * exclusions (preserve any pre-existing page) from genuine "file removed
 * from the strategy" cases (delete the now-stale page).
 *
 * Routes through the same `classifySync` as `isSyncable` so the two cannot
 * drift. Identical opts contract — callers pass whatever they pass `isSyncable`.
 */
export function unsyncableReason(path: string, opts: SyncableOptions = {}): SyncableReason | null {
  return classifySync(path, opts);
}

/**
 * Character class for the lowercase-canonical form of a slug segment after
 * slugifySegment() has run. Lowercase letters, digits, dots, underscores,
 * hyphens. Exposed so adjacent code (e.g. takes-fence holder validation,
 * v0.32 EXP-4) can reuse the actual repo slug grammar instead of inventing
 * a stricter parallel one and emitting false-positive warnings on legitimate
 * `companies/acme.io` / `people/foo_bar` slugs (codex review #3).
 *
 * Pattern is the inner character class only (no anchors); callers wrap it
 * in `^...$` or compose it with prefixes like `(?:people|companies)/...`.
 */
export const SLUG_SEGMENT_PATTERN = new RegExp(`[a-z0-9._\\-${CJK_SLUG_CHARS}]+`);

/**
 * Slugify a single path segment: lowercase, strip special chars, spaces → hyphens.
 * CJK ranges (Han / Hiragana / Katakana / Hangul Syllables) are preserved (v0.32.7).
 * NFC re-normalize after the NFD-strip-accents pass so Hangul Jamo recomposes back
 * into precomposed syllables that fall inside the whitelist.
 */
const SLUGIFY_KEEP_RE = new RegExp(`[^a-z0-9.\\s_\\-${CJK_SLUG_CHARS}]`, 'g');

export function slugifySegment(segment: string): string {
  return segment
    .normalize('NFD')                     // Decompose accented chars
    .replace(/[\u0300-\u036f]/g, '')      // Strip accent marks
    .normalize('NFC')                     // Recompose Hangul Jamo back to Syllables (v0.32.7)
    .toLowerCase()
    .replace(SLUGIFY_KEEP_RE, '')         // Keep alnum, dots, spaces, _-, and CJK (v0.32.7)
    .replace(/[\s]+/g, '-')              // Spaces → hyphens
    .replace(/-+/g, '-')                 // Collapse multiple hyphens
    .replace(/^-|-$/g, '');              // Strip leading/trailing hyphens
}

/**
 * Slugify a file path: strip .md, normalize separators, slugify each segment.
 *
 * Examples:
 *   Apple Notes/2017-05-03 ohmygreen.md → apple-notes/2017-05-03-ohmygreen
 *   people/alice-smith.md → people/alice-smith
 *   notes/v1.0.0.md → notes/v1.0.0
 */
export function slugifyPath(filePath: string): string {
  let path = filePath.replace(/\.mdx?$/i, '');
  path = path.replace(/\\/g, '/');
  path = path.replace(/^\.?\//, '');
  return path.split('/').map(slugifySegment).filter(Boolean).join('/');
}

/**
 * Slugify a code file path: flatten into a single slug segment with dots → hyphens.
 * e.g. 'src/core/chunkers/code.ts' → 'src-core-chunkers-code-ts'
 */
export function slugifyCodePath(filePath: string): string {
  let path = filePath.replace(/\\/g, '/');
  path = path.replace(/^\.?\//, '');
  return path
    .split('/')
    .map(segment => slugifySegment(segment.replace(/\./g, '-')))
    .filter(Boolean)
    .join('-');
}

/**
 * Convert a repo-relative file path to a GBrain page slug.
 */
export function pathToSlug(
  filePath: string,
  repoPrefix?: string,
  options: { pageKind?: 'markdown' | 'code' } = {},
): string {
  const pageKind = options.pageKind || 'markdown';
  let slug = pageKind === 'code' ? slugifyCodePath(filePath) : slugifyPath(filePath);
  if (repoPrefix) slug = `${repoPrefix}/${slug}`;
  return slug.toLowerCase();
}

/**
 * v0.20.0 Cathedral II Layer 1a (SP-5 fix) — centralized slug dispatcher.
 *
 * Before Cathedral II, `importFromFile` / `importCodeFile` chose between
 * `slugifyPath` and `slugifyCodePath` inline, but the sync delete/rename
 * paths in `performSync` always called `pathToSlug(path)` with the default
 * pageKind='markdown'. For a 9-extension-wide code classifier this was
 * mostly correct (code files were rare), but Layer 1a widens the classifier
 * to ~35 extensions and without this dispatcher, deleting or renaming a
 * Rust/Java/Ruby/etc. file would try to delete the wrong slug (the
 * markdown-style slug) and leave the real code-slug page orphaned forever.
 *
 * Every sync-path caller that used to pick a pageKind manually should now
 * call resolveSlugForPath — it derives the right slug shape from
 * isCodeFilePath(), which in turn derives from the chunker's language map.
 * Central dispatch means new extensions added to the chunker automatically
 * flow through without touching the sync code path.
 */
export function resolveSlugForPath(filePath: string, repoPrefix?: string): string {
  const pageKind = isCodeFilePath(filePath) ? 'code' : 'markdown';
  return pathToSlug(filePath, repoPrefix, { pageKind });
}

// ─────────────────────────────────────────────────────────────────
// Sync failure ledger — moved to ./sync-failure-ledger.ts (issue #1939)
// ─────────────────────────────────────────────────────────────────
//
// The failure store + bounded auto-skip valve now live in a leaf module so
// they can be unit-tested in isolation and shared by both sync gates without
// a circular import. Re-exported here so existing callers that
// `await import('../core/sync.ts')` for these symbols keep working.
export {
  classifyErrorCode,
  summarizeFailuresByCode,
  formatCodeBreakdown,
  syncFailuresPath,
  loadSyncFailures,
  unacknowledgedSyncFailures,
  recordSyncFailures,
  acknowledgeSyncFailures,
  recordFailures,
  clearFailures,
  acknowledgeFailures,
  autoSkipFailures,
  withLedgerLock,
  resolveAutoSkipThreshold,
  isSkippablePath,
  decideGateAction,
  decideSyncFailureSeverity,
  applySyncFailureGate,
  DEFAULT_SOURCE_ID,
  SENTINEL_PREFIX,
  DEFAULT_AUTOSKIP_AFTER,
} from './sync-failure-ledger.ts';
export type {
  SyncFailure,
  SyncFailureState,
  AcknowledgeResult,
  GateDecision,
  SeverityResult,
  SyncGateInput,
  SyncGateOutcome,
} from './sync-failure-ledger.ts';
