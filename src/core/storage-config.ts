import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export interface StorageConfig {
  git_tracked: string[];
  supabase_only: string[];
}

export type StorageTier = 'git_tracked' | 'supabase_only' | 'unspecified';

/**
 * Parse the gbrain.yml shape: a top-level `storage:` section with two
 * array-valued keys (`git_tracked:` and `supabase_only:`).
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
 */
function parseStorageYaml(content: string): StorageConfig | null {
  const lines = content.split('\n').map((line) => line.replace(/\r$/, ''));

  let inStorage = false;
  let currentList: 'git_tracked' | 'supabase_only' | null = null;
  const config: StorageConfig = { git_tracked: [], supabase_only: [] };
  let sawStorage = false;

  for (const raw of lines) {
    // Strip comments. Conservative: only strip `#` not preceded by anything
    // (since values shouldn't contain `#` for this shape).
    const noComment = raw.replace(/\s+#.*$/, '').replace(/^#.*$/, '');
    if (noComment.trim() === '') continue;

    // Top-level key (no leading space).
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
      // Other top-level keys end the storage section.
      inStorage = false;
      currentList = null;
      continue;
    }

    if (!inStorage) continue;

    const indented = noComment.replace(/^\s+/, '');
    const indent = noComment.length - indented.length;

    // Indent 2 (or any single-level indent inside storage): a nested key.
    // Indent > 2 (typically 4): a list item (- value).
    if (indented.startsWith('-')) {
      // Array item.
      if (!currentList) continue;
      const value = indented.slice(1).trim().replace(/^["']|["']$/g, '');
      if (value) config[currentList].push(value);
      continue;
    }

    // Nested key.
    const colon = indented.indexOf(':');
    if (colon === -1) continue;
    const key = indented.slice(0, colon).trim();
    if (key === 'git_tracked' || key === 'supabase_only') {
      currentList = key;
      continue;
    }
    // Unrecognized nested key — ignore but reset list context.
    currentList = null;
    void indent; // indent is informational; we infer structure from `-` prefix.
  }

  if (!sawStorage) return null;
  return config;
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

  let parsed: StorageConfig | null;
  try {
    parsed = parseStorageYaml(content);
  } catch (error) {
    console.warn(
      `Warning: Failed to parse gbrain.yml: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }

  // Sanity warning: file exists but `storage:` section is missing OR empty.
  // Catches the silent-no-op failure mode that was the original P0 bug.
  if (parsed === null || (parsed.git_tracked.length === 0 && parsed.supabase_only.length === 0)) {
    if (!_missingStorageWarned) {
      _missingStorageWarned = true;
      console.warn(
        `Warning: ${yamlPath} exists but has no storage configuration. ` +
          `Add a "storage:" section with git_tracked / supabase_only arrays, ` +
          `or remove gbrain.yml to suppress this warning.`,
      );
    }
    return parsed; // null OR empty — either way the feature is effectively off.
  }

  return parsed;
}

/**
 * Validate storage configuration for conflicts and issues.
 * Returns warning strings; callers decide how to surface them.
 */
export function validateStorageConfig(config: StorageConfig): string[] {
  const warnings: string[] = [];

  // Overlap between tiers: ambiguous semantics — does `media/` win as
  // git-tracked or supabase-only? Caller treats this as an error per D7.
  const gitSet = new Set(config.git_tracked);
  for (const path of config.supabase_only) {
    if (gitSet.has(path)) {
      warnings.push(`Directory "${path}" appears in both git_tracked and supabase_only`);
    }
  }

  // Trailing slash is canonical. Caller may auto-normalize per D7+D8.
  const allPaths = [...config.git_tracked, ...config.supabase_only];
  for (const path of allPaths) {
    if (!path.endsWith('/')) {
      warnings.push(`Directory path "${path}" should end with "/" for consistency`);
    }
  }

  return warnings;
}

export function isGitTracked(slug: string, config: StorageConfig): boolean {
  return config.git_tracked.some((dir) => slug.startsWith(dir));
}

export function isSupabaseOnly(slug: string, config: StorageConfig): boolean {
  return config.supabase_only.some((dir) => slug.startsWith(dir));
}

export function getStorageTier(slug: string, config: StorageConfig): StorageTier {
  if (isGitTracked(slug, config)) return 'git_tracked';
  if (isSupabaseOnly(slug, config)) return 'supabase_only';
  return 'unspecified';
}

/** Reset the once-per-process warning flag. Test-only. */
export function __resetMissingStorageWarning(): void {
  _missingStorageWarned = false;
}
