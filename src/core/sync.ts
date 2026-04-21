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

/**
 * Filter a file path to determine if it should be synced to GBrain.
 */
export function isSyncable(path: string): boolean {
  // Must be .md or .mdx
  if (!path.endsWith('.md') && !path.endsWith('.mdx')) return false;

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
 * Convert a repo-relative file path to a GBrain page slug.
 */
export function pathToSlug(filePath: string, repoPrefix?: string): string {
  let slug = slugifyPath(filePath);
  if (repoPrefix) slug = `${repoPrefix}/${slug}`;
  return slug.toLowerCase();
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
import { homedir as _homedir } from 'os';
import { createHash as _createHash } from 'crypto';

export interface SyncFailure {
  path: string;
  error: string;
  commit: string;
  line?: number;
  ts: string;
  acknowledged?: boolean;
  acknowledged_at?: string;
}

function _failuresDir(): string {
  return _joinPath(_homedir(), '.gbrain');
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
      commit,
      line: f.line,
      ts: now,
    };
    if (seen.has(_dedupKey(entry))) continue;
    _appendFileSync(syncFailuresPath(), JSON.stringify(entry) + '\n');
    seen.add(_dedupKey(entry));
  }
}

/**
 * Mark all unacknowledged failures as acknowledged. Used by
 * `gbrain sync --skip-failed`. Returns the number newly acknowledged.
 *
 * We do not delete — acknowledged entries stay as historical record so
 * doctor can still show them under a "previously skipped" bucket.
 */
export function acknowledgeSyncFailures(): number {
  const entries = loadSyncFailures();
  if (entries.length === 0) return 0;
  const now = new Date().toISOString();
  let changed = 0;
  const updated = entries.map(e => {
    if (e.acknowledged) return e;
    changed++;
    return { ...e, acknowledged: true, acknowledged_at: now };
  });
  if (changed === 0) return 0;
  _mkdirSync(_failuresDir(), { recursive: true });
  const fd = require('fs').writeFileSync;
  fd(syncFailuresPath(), updated.map(e => JSON.stringify(e)).join('\n') + '\n');
  return changed;
}

/** Return only unacknowledged failures. */
export function unacknowledgedSyncFailures(): SyncFailure[] {
  return loadSyncFailures().filter(f => !f.acknowledged);
}
