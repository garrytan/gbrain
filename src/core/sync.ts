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

function isMarkdownFilePath(path: string): boolean {
  return path.endsWith('.md') || path.endsWith('.mdx');
}

function isAllowedByStrategy(path: string, strategy: SyncStrategy): boolean {
  if (strategy === 'markdown') return isMarkdownFilePath(path);
  if (strategy === 'code') return isCodeFilePath(path);
  return isMarkdownFilePath(path) || isCodeFilePath(path);
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
 * Filter a file path to determine if it should be synced to GBrain.
 * Strategy-aware: 'markdown' (default) = .md/.mdx only, 'code' = code files only, 'auto' = both.
 */
export function isSyncable(path: string, opts: SyncableOptions = {}): boolean {
  const strategy = opts.strategy || 'markdown';

  if (!isAllowedByStrategy(path, strategy)) return false;

  // Skip hidden directories
  if (path.split('/').some(p => p.startsWith('.'))) return false;

  // Skip .raw/ sidecar directories
  if (path.includes('.raw/')) return false;

  // Skip meta files that aren't pages
  const skipFiles = ['schema.md', 'index.md', 'log.md', 'README.md'];
  const basename = path.split('/').pop() || '';
  if (skipFiles.includes(basename)) return false;

  // Skip ops/ directory
  if (path.startsWith('ops/')) return false;

  if (opts.include && opts.include.length > 0 && !matchesAnyGlob(path, opts.include)) return false;
  if (opts.exclude && opts.exclude.length > 0 && matchesAnyGlob(path, opts.exclude)) return false;

  return true;
}

/**
 * Slugify a single path segment: lowercase, strip special chars, spaces → hyphens.
 */
export function slugifySegment(segment: string): string {
  return segment
    .normalize('NFD')                     // Decompose accented chars
    .replace(/[\u0300-\u036f]/g, '')      // Strip accent marks
    .toLowerCase()
    .replace(/[^a-z0-9.\s_-]/g, '')      // Keep alphanumeric, dots, spaces, underscores, hyphens
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
// Sync failure tracking — Bug 9
// ─────────────────────────────────────────────────────────────────
//
// When a sync run catches a per-file parse error (YAML with unquoted
// colons, malformed frontmatter, etc.), we record it here instead of just
// logging and moving on. Three goals:
//   1. Gate the sync.last_commit bookmark advance in all three sync paths
//      (incremental, full/runImport, `gbrain import` git continuity).
//   2. Give users a visible record of what failed, with the commit hash
//      they can use to re-attempt after fixing the source file.
//   3. Let `gbrain sync --skip-failed` acknowledge a known-bad set so
//      repos with many broken files aren't permanently stuck.

import { existsSync as _existsSync, readFileSync as _readFileSync, appendFileSync as _appendFileSync, mkdirSync as _mkdirSync } from 'fs';
import { join as _joinPath } from 'path';
import { gbrainPath as _gbrainPath } from './config.ts';
import { createHash as _createHash } from 'crypto';

export interface SyncFailure {
  path: string;
  error: string;
  /** Structured error code extracted from the error message. */
  code?: string;
  commit: string;
  line?: number;
  ts: string;
  acknowledged?: boolean;
  acknowledged_at?: string;
}

/**
 * Best-effort extraction of a structured error code from a sync failure
 * message. Matches known ParseValidationCode patterns (SLUG_MISMATCH,
 * YAML_PARSE, etc.) and common DB / timeout errors. Returns 'UNKNOWN'
 * when no pattern matches.
 *
 * Order matters: DB-layer errors are checked BEFORE YAML-layer ones so
 * Postgres `duplicate key value violates unique constraint` doesn't get
 * mislabeled as a YAML duplicate-key. Frontmatter patterns key off the
 * canonical messages emitted by `collectValidationErrors()` in markdown.ts.
 */
export function classifyErrorCode(errorMsg: string): string {
  // SLUG_MISMATCH: thrown by importFromFile() at src/core/import-file.ts:374.
  if (/slug.*does not match|SLUG_MISMATCH/i.test(errorMsg)) return 'SLUG_MISMATCH';

  // DB-layer errors come BEFORE the YAML duplicate-key check. Postgres unique-
  // constraint violations contain "duplicate key" but are not a YAML problem.
  if (/duplicate key value violates unique constraint|DB_DUPLICATE_KEY/i.test(errorMsg)) {
    return 'DB_DUPLICATE_KEY';
  }
  if (/canceling statement due to statement timeout|STATEMENT_TIMEOUT/i.test(errorMsg)) {
    return 'STATEMENT_TIMEOUT';
  }

  // YAML / frontmatter patterns. These match either the canonical message
  // strings in src/core/markdown.ts (collectValidationErrors) or the literal
  // ParseValidationCode token, so they fire whether the caller stores the
  // message or just the code.
  if (/YAML parse failed|YAML_PARSE/i.test(errorMsg)) return 'YAML_PARSE';
  if (/YAMLException|duplicated mapping key|YAML_DUPLICATE_KEY/i.test(errorMsg)) {
    return 'YAML_DUPLICATE_KEY';
  }
  if (/File is empty or whitespace-only|Frontmatter must start with ---|MISSING_OPEN/i.test(errorMsg)) {
    return 'MISSING_OPEN';
  }
  if (/No closing --- delimiter|Heading at line .* found inside frontmatter|MISSING_CLOSE/i.test(errorMsg)) {
    return 'MISSING_CLOSE';
  }
  if (/Frontmatter block is empty|EMPTY_FRONTMATTER/i.test(errorMsg)) return 'EMPTY_FRONTMATTER';
  if (/Content contains null bytes|NULL_BYTES|null byte/i.test(errorMsg)) return 'NULL_BYTES';
  if (/Nested double quotes|NESTED_QUOTES/i.test(errorMsg)) return 'NESTED_QUOTES';

  // Generic fallbacks.
  if (/invalid UTF-?8|INVALID_UTF8/i.test(errorMsg)) return 'INVALID_UTF8';

  // v0.22.12 additions: covers the four real production sites in src/core/import-file.ts
  // (lines 199, 347, 352, 401) that previously bucketed to UNKNOWN.
  if (/file too large|content too large|FILE_TOO_LARGE/i.test(errorMsg)) return 'FILE_TOO_LARGE';
  if (/skipping symlink|symlink|SYMLINK_NOT_ALLOWED/i.test(errorMsg)) return 'SYMLINK_NOT_ALLOWED';
  return 'UNKNOWN';
}

/** Group failures by error code and return a sorted summary. */
export function summarizeFailuresByCode(
  failures: Array<{ error: string; code?: string }>,
): Array<{ code: string; count: number }> {
  const counts: Record<string, number> = {};
  for (const f of failures) {
    const code = f.code ?? classifyErrorCode(f.error);
    counts[code] = (counts[code] ?? 0) + 1;
  }
  return Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .map(([code, count]) => ({ code, count }));
}

/**
 * Format a code-grouped summary as a human-readable multi-line string for
 * stderr / doctor output. Accepts either raw failures (which are summarized
 * internally) or an already-summarized `{code, count}[]` shape (the return
 * value of `summarizeFailuresByCode` or `AcknowledgeResult.summary`).
 * Returns an empty string when the input is empty.
 */
export function formatCodeBreakdown(
  input: Array<{ error: string; code?: string }> | Array<{ code: string; count: number }>,
): string {
  // Distinguish by shape: summary entries have a numeric `count`. Empty array
  // returns '' from either branch — both paths produce a 0-length join.
  const summary =
    input.length > 0 && typeof (input[0] as { count?: unknown }).count === 'number'
      ? (input as Array<{ code: string; count: number }>)
      : summarizeFailuresByCode(input as Array<{ error: string; code?: string }>);
  return summary.map(s => `  ${s.code}: ${s.count}`).join('\n');
}

function _failuresDir(): string {
  return _gbrainPath();
}

export function syncFailuresPath(): string {
  return _joinPath(_failuresDir(), 'sync-failures.jsonl');
}

function _hashError(msg: string): string {
  return _createHash('sha256').update(msg).digest('hex').slice(0, 12);
}

function _dedupKey(f: { path: string; commit: string; error: string }): string {
  return `${f.path}|${f.commit}|${_hashError(f.error)}`;
}

/**
 * Read the failures JSONL, skipping malformed lines with a warning to stderr.
 * Returns empty array if the file doesn't exist.
 */
export function loadSyncFailures(): SyncFailure[] {
  const path = syncFailuresPath();
  if (!_existsSync(path)) return [];
  const raw = _readFileSync(path, 'utf-8');
  const out: SyncFailure[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as SyncFailure);
    } catch {
      console.warn(`[sync-failures] skipping malformed line: ${trimmed.slice(0, 120)}`);
    }
  }
  return out;
}

/**
 * Append failure entries to the JSONL. Dedups by (path, commit, error-hash) —
 * the same file failing with the same error on the same commit writes ONCE
 * to the log, not once per sync run.
 */
export function recordSyncFailures(
  failures: Array<{ path: string; error: string; line?: number }>,
  commit: string,
): void {
  if (failures.length === 0) return;
  const existing = loadSyncFailures();
  const seen = new Set(existing.map(f => _dedupKey(f)));

  _mkdirSync(_failuresDir(), { recursive: true });
  const now = new Date().toISOString();
  for (const f of failures) {
    const entry: SyncFailure = {
      path: f.path,
      error: f.error,
      code: classifyErrorCode(f.error),
      commit,
      line: f.line,
      ts: now,
    };
    if (seen.has(_dedupKey(entry))) continue;
    _appendFileSync(syncFailuresPath(), JSON.stringify(entry) + '\n');
    seen.add(_dedupKey(entry));
  }
}

export interface AcknowledgeResult {
  count: number;
  summary: Array<{ code: string; count: number }>;
}

/**
 * Mark all unacknowledged failures as acknowledged. Used by
 * `gbrain sync --skip-failed`. Returns count and a structured summary
 * grouped by error code so the operator can see *why* files were skipped.
 *
 * We do not delete — acknowledged entries stay as historical record so
 * doctor can still show them under a "previously skipped" bucket.
 */
export function acknowledgeSyncFailures(): AcknowledgeResult {
  const entries = loadSyncFailures();
  if (entries.length === 0) return { count: 0, summary: [] };
  const now = new Date().toISOString();
  let changed = 0;
  const newlyAcked: SyncFailure[] = [];
  const updated = entries.map(e => {
    if (e.acknowledged) return e;
    changed++;
    // Backfill code for entries that predate the code field.
    const code = e.code ?? classifyErrorCode(e.error);
    const acked = { ...e, code, acknowledged: true, acknowledged_at: now };
    newlyAcked.push(acked);
    return acked;
  });
  if (changed === 0) return { count: 0, summary: [] };
  _mkdirSync(_failuresDir(), { recursive: true });
  const fd = require('fs').writeFileSync;
  fd(syncFailuresPath(), updated.map(e => JSON.stringify(e)).join('\n') + '\n');
  return {
    count: changed,
    summary: summarizeFailuresByCode(newlyAcked),
  };
}

/** Return only unacknowledged failures. */
export function unacknowledgedSyncFailures(): SyncFailure[] {
  return loadSyncFailures().filter(f => !f.acknowledged);
}
