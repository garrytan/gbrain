import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * Storage tier configuration loaded from gbrain.yml.
 *
 * The canonical key names are `db_tracked` and `db_only` (engine-agnostic).
 * The deprecated keys `git_tracked` and `supabase_only` are still read for
 * backward compatibility but emit a once-per-process deprecation warning.
 * Sunset: future release will reject the deprecated names.
 */
export interface StorageConfig {
  db_tracked: string[];
  db_only: string[];
}

export type StorageTier = 'db_tracked' | 'db_only' | 'unspecified';

/** Recognized YAML keys (canonical and deprecated). */
const STORAGE_KEYS = new Set([
  'db_tracked', 'db_only',
  'git_tracked', 'supabase_only', // deprecated aliases
]);

/**
 * Parse the gbrain.yml shape: a top-level `storage:` section with up to four
 * array-valued nested keys (canonical `db_tracked` / `db_only` plus the
 * deprecated aliases `git_tracked` / `supabase_only`).
 *
 * Intentionally narrow. Does NOT handle the full YAML spec — only the file
 * shape gbrain controls. Trades expressiveness for zero-dep parsing and
 * predictable behavior. Returns null if the file has no `storage:` section
 * (so callers can distinguish "no config" from "empty config").
 *
 * Replaces gray-matter, which silently returned `{data: {}}` on
 * delimiter-less YAML and broke the entire feature on every install.
 * The defect that prompted this rewrite: storage-config.ts:24 in the
 * pre-v0.22.3 implementation.
 *
 * Returns the raw key map. The caller (loadStorageConfig) is responsible
 * for normalizing deprecated keys → canonical, emitting deprecation
 * warnings, and merging if both old and new keys appear.
 */
type RawStorage = {
  db_tracked?: string[];
  db_only?: string[];
  git_tracked?: string[];
  supabase_only?: string[];
};

function parseStorageYaml(content: string): RawStorage | null {
  const lines = content.split('\n').map((line) => line.replace(/\r$/, ''));

  let inStorage = false;
  let currentList: keyof RawStorage | null = null;
  const raw: RawStorage = {};
  let sawStorage = false;

  for (const line of lines) {
    // Strip comments. Conservative: drop trailing `# ...` and full-line `#`.
    const noComment = line.replace(/\s+#.*$/, '').replace(/^#.*$/, '');
    if (noComment.trim() === '') continue;

    // Top-level key (no leading whitespace).
    if (!noComment.startsWith(' ') && !noComment.startsWith('\t')) {
      const colon = noComment.indexOf(':');
      if (colon === -1) continue;
      const key = noComment.slice(0, colon).trim();
      if (key === 'storage') {
        inStorage = true;
        sawStorage = true;
        currentList = null;
        continue;
      }
      inStorage = false;
      currentList = null;
      continue;
    }

    if (!inStorage) continue;

    const indented = noComment.replace(/^\s+/, '');

    if (indented.startsWith('-')) {
      if (!currentList) continue;
      const value = indented.slice(1).trim().replace(/^["']|["']$/g, '');
      if (value) {
        if (!raw[currentList]) raw[currentList] = [];
        raw[currentList]!.push(value);
      }
      continue;
    }

    const colon = indented.indexOf(':');
    if (colon === -1) continue;
    const key = indented.slice(0, colon).trim();
    if (STORAGE_KEYS.has(key)) {
      currentList = key as keyof RawStorage;
      // Inline empty list: `db_only: []`.
      const remainder = indented.slice(colon + 1).trim();
      if (remainder === '[]' && !raw[currentList]) {
        raw[currentList] = [];
      }
      continue;
    }
    currentList = null;
  }

  if (!sawStorage) return null;
  return raw;
}

/**
 * Normalize raw parsed keys into canonical StorageConfig shape.
 *
 * Resolution order (per plan eng-review pass 2 finding #2):
 *   1. If canonical keys present, use them.
 *   2. Else if deprecated keys present, map to canonical AND emit a
 *      once-per-process deprecation warning suggesting `gbrain doctor --fix`.
 *   3. If both are present, canonical wins. Deprecated keys are ignored
 *      with a stronger warning (the user is mid-migration).
 *
 * Validation (validateStorageConfig) always runs against the canonical
 * shape, so error messages reference `db_only` / `db_tracked` regardless
 * of which keys the user wrote.
 */
let _deprecationWarned = false;

function normalizeStorageConfig(raw: RawStorage): StorageConfig {
  const hasCanonical = Boolean(raw.db_tracked || raw.db_only);
  const hasDeprecated = Boolean(raw.git_tracked || raw.supabase_only);

  if (hasDeprecated && !_deprecationWarned) {
    _deprecationWarned = true;
    const which = [
      raw.git_tracked ? '`git_tracked`' : null,
      raw.supabase_only ? '`supabase_only`' : null,
    ].filter(Boolean).join(' and ');
    if (hasCanonical) {
      console.warn(
        `Warning: ${which} in gbrain.yml is deprecated and ignored ` +
          `(canonical keys db_tracked/db_only are present). ` +
          `Remove the deprecated keys, or run \`gbrain doctor --fix\`.`,
      );
    } else {
      console.warn(
        `Warning: ${which} in gbrain.yml is deprecated. ` +
          `Rename to db_tracked / db_only — see docs/storage-tiering.md. ` +
          `Run \`gbrain doctor --fix\` for an automated rename.`,
      );
    }
  }

  if (hasCanonical) {
    return {
      db_tracked: raw.db_tracked ?? [],
      db_only: raw.db_only ?? [],
    };
  }

  return {
    db_tracked: raw.git_tracked ?? [],
    db_only: raw.supabase_only ?? [],
  };
}

/**
 * Load gbrain.yml configuration from the brain repository root.
 *
 * Returns null when:
 *   - repoPath is null/undefined
 *   - gbrain.yml doesn't exist at the repo root
 *   - gbrain.yml exists but has no `storage:` section (with sanity warning)
 *
 * Throws when:
 *   - gbrain.yml exists but is unreadable (permission denied, etc.) — D36 lock:
 *     fail loud rather than silently disable the feature.
 *
 * Logs a console.warn (once per process) when:
 *   - File parses but `storage:` section is empty or missing — Issue #1 lock:
 *     surface "your config didn't take" rather than silently no-op.
 */
let _missingStorageWarned = false;

export function loadStorageConfig(repoPath?: string | null): StorageConfig | null {
  if (!repoPath) return null;

  const yamlPath = join(repoPath, 'gbrain.yml');
  if (!existsSync(yamlPath)) return null;

  // Read failure is a real error (not a "feature not configured" signal).
  // Throwing here lets the caller decide whether to crash or fall back.
  const content = readFileSync(yamlPath, 'utf-8');

  let raw: RawStorage | null;
  try {
    raw = parseStorageYaml(content);
  } catch (error) {
    console.warn(
      `Warning: Failed to parse gbrain.yml: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }

  // No storage section at all → null (with sanity warning).
  if (raw === null) {
    if (!_missingStorageWarned) {
      _missingStorageWarned = true;
      console.warn(
        `Warning: ${yamlPath} exists but has no storage configuration. ` +
          `Add a "storage:" section with db_tracked / db_only arrays, ` +
          `or remove gbrain.yml to suppress this warning.`,
      );
    }
    return null;
  }

  const merged = normalizeStorageConfig(raw);

  // Empty storage section → return as-is but warn.
  if (merged.db_tracked.length === 0 && merged.db_only.length === 0) {
    if (!_missingStorageWarned) {
      _missingStorageWarned = true;
      console.warn(
        `Warning: ${yamlPath} exists but has no storage configuration. ` +
          `Add a "storage:" section with db_tracked / db_only arrays, ` +
          `or remove gbrain.yml to suppress this warning.`,
      );
    }
    return merged;
  }

  // Normalize cosmetic issues + throw on semantic overlap (D7).
  // Throws StorageConfigError on overlap — propagates to the caller.
  return normalizeAndValidateStorageConfig(merged);
}

export class StorageConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageConfigError';
  }
}

/**
 * Validate storage configuration for conflicts and issues.
 * Returns warning strings; callers decide how to surface them.
 *
 * Always runs against the canonical (db_tracked / db_only) shape — error
 * messages reference canonical names regardless of which keys the user
 * wrote in gbrain.yml.
 *
 * Pure: does not mutate. For the auto-normalize behavior (D7), see
 * `normalizeAndValidateStorageConfig` below.
 */
export function validateStorageConfig(config: StorageConfig): string[] {
  const warnings: string[] = [];

  const trackedSet = new Set(config.db_tracked);
  for (const path of config.db_only) {
    if (trackedSet.has(path)) {
      warnings.push(`Directory "${path}" appears in both db_tracked and db_only`);
    }
  }

  const allPaths = [...config.db_tracked, ...config.db_only];
  for (const path of allPaths) {
    if (!path.endsWith('/')) {
      warnings.push(`Directory path "${path}" should end with "/" for consistency`);
    }
  }

  return warnings;
}

/**
 * Auto-normalize and strict-validate per D7+D8.
 *
 *   1. Cosmetic fixups are applied silently with a one-time info message
 *      naming what changed:
 *        - missing trailing `/` is added
 *      The message helps the user learn the canonical form without nagging.
 *   2. Semantic problems THROW (don't return warnings):
 *        - same directory in both tiers (ambiguous routing)
 *
 * Caller passes a fresh raw config; this returns the normalized shape that
 * the rest of the code (matcher, sync, etc.) sees.
 */
let _normalizationInfoEmitted = false;

export function normalizeAndValidateStorageConfig(input: StorageConfig): StorageConfig {
  const normalize = (paths: string[]): { normalized: string[]; changed: string[] } => {
    const normalized: string[] = [];
    const changed: string[] = [];
    for (const p of paths) {
      if (p.endsWith('/')) {
        normalized.push(p);
      } else {
        normalized.push(p + '/');
        changed.push(`"${p}" → "${p}/"`);
      }
    }
    return { normalized, changed };
  };

  const tracked = normalize(input.db_tracked);
  const dbonly = normalize(input.db_only);
  const allChanged = [...tracked.changed, ...dbonly.changed];

  if (allChanged.length > 0 && !_normalizationInfoEmitted) {
    _normalizationInfoEmitted = true;
    console.warn(
      `Note: normalized ${allChanged.length} storage path(s) in gbrain.yml — ` +
        `${allChanged.join(', ')}. Add trailing "/" to suppress this note.`,
    );
  }

  // Semantic check: overlap between tiers throws. Ambiguous routing.
  const trackedSet = new Set(tracked.normalized);
  for (const path of dbonly.normalized) {
    if (trackedSet.has(path)) {
      throw new StorageConfigError(
        `gbrain.yml: directory "${path}" appears in both db_tracked and db_only — ` +
          `pick one tier. Edit gbrain.yml to remove the overlap.`,
      );
    }
  }

  return { db_tracked: tracked.normalized, db_only: dbonly.normalized };
}

/**
 * Path-segment match: a slug belongs to a tier directory iff the directory
 * is a complete path-segment ancestor of the slug. `media/x/` matches
 * `media/x/foo` but NOT `media/xerox/foo` — eliminates the prefix-collision
 * class of bug (Issue #5 of the eng review, D6 lock).
 *
 * Strict: requires the configured directory to end with `/`. The validator
 * (per D7+D8) auto-normalizes input so the matcher only ever sees canonical
 * trailing-`/` directories.
 */
function matchesTierDir(slug: string, dir: string): boolean {
  if (!dir.endsWith('/')) return false; // not normalized — matcher refuses
  // slug must equal dir's bare prefix OR start with the trailing-slash form.
  // Example: dir = 'media/x/' matches 'media/x/anything' but not 'media/x'
  // or 'media/xerox'. (A slug that exactly equals 'media/x' is a directory-
  // level entry the brain doesn't write.)
  return slug.startsWith(dir);
}

export function isDbTracked(slug: string, config: StorageConfig): boolean {
  return config.db_tracked.some((dir) => matchesTierDir(slug, dir));
}

export function isDbOnly(slug: string, config: StorageConfig): boolean {
  return config.db_only.some((dir) => matchesTierDir(slug, dir));
}

export function getStorageTier(slug: string, config: StorageConfig): StorageTier {
  if (isDbTracked(slug, config)) return 'db_tracked';
  if (isDbOnly(slug, config)) return 'db_only';
  return 'unspecified';
}

// ── Deprecated aliases — to be removed in a future release ────────
// Kept so existing callers (storage.ts, export.ts) compile during the
// step-by-step refactor. Will be deleted once those call sites migrate
// to the canonical names.
export const isGitTracked = isDbTracked;
export const isSupabaseOnly = isDbOnly;

/** Reset once-per-process warning flags. Test-only. */
export function __resetMissingStorageWarning(): void {
  _missingStorageWarned = false;
  _deprecationWarned = false;
  _normalizationInfoEmitted = false;
}
