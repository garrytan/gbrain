/**
 * ~/.gbrain/preferences.json — user-facing agent-behavior flags (minion_mode, etc.).
 *
 * Separate from src/core/config.ts (engine config), written to its own file so
 * engine config and agent preferences can evolve independently. Atomic writes
 * via mktemp + rename; 0o600 perms; forward-compatible (preserves unknown keys).
 *
 * Also houses ~/.gbrain/migrations/completed.jsonl append helper.
 */

import { readFileSync, writeFileSync, renameSync, chmodSync, mkdtempSync, rmSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

function home(): string {
  // `os.homedir()` in Bun caches its initial value and ignores later
  // `process.env.HOME` mutations, which breaks test isolation and any
  // workflow that needs to run against a specific $HOME (CI, scripted installs).
  // Prefer the env var; fall back to the cached OS value. Matches the existing
  // `src/commands/upgrade.ts` pattern.
  return process.env.HOME || homedir();
}

export type MinionMode = 'always' | 'pain_triggered' | 'off';

export interface Preferences {
  minion_mode?: MinionMode;
  set_at?: string;
  set_in_version?: string;
  [key: string]: unknown;
}

export interface CompletedMigrationEntry {
  version: string;
  ts?: string;
  status: 'complete' | 'partial';
  mode?: MinionMode;
  files_rewritten?: number;
  autopilot_installed?: boolean;
  install_target?: string;
  apply_migrations_pending?: boolean;
  [key: string]: unknown;
}

const VALID_MODES: ReadonlyArray<MinionMode> = ['always', 'pain_triggered', 'off'];

function prefsDir(): string { return join(home(), '.gbrain'); }
function prefsPath(): string { return join(prefsDir(), 'preferences.json'); }
function migrationsDir(): string { return join(home(), '.gbrain', 'migrations'); }
function completedJsonlPath(): string { return join(migrationsDir(), 'completed.jsonl'); }

/** Validate that a value is a recognized minion mode. Throws with the allowed list. */
export function validateMinionMode(value: unknown): asserts value is MinionMode {
  if (typeof value !== 'string' || !VALID_MODES.includes(value as MinionMode)) {
    throw new Error(`Invalid minion_mode "${String(value)}". Allowed: ${VALID_MODES.join(', ')}.`);
  }
}

/**
 * Load preferences. Returns {} when the file is missing (not null — callers
 * can always treat the result as a Preferences object).
 *
 * Malformed JSON throws; caller can catch if they want graceful fallback.
 */
export function loadPreferences(): Preferences {
  const path = prefsPath();
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw) as Preferences;
  return parsed;
}

/**
 * Save preferences atomically (mktemp on same filesystem + rename). Preserves
 * any unknown keys passed in. Chmods 0o600 after write.
 */
export function savePreferences(prefs: Preferences): void {
  if (prefs.minion_mode !== undefined) validateMinionMode(prefs.minion_mode);

  const dir = prefsDir();
  mkdirSync(dir, { recursive: true });

  // Write via a tempfile on the same filesystem, then rename. Avoids the
  // "reader sees a half-written file" window that write-in-place has.
  const tmpDirForWrite = mkdtempSync(join(dir, '.prefs-tmp-'));
  const tmpPath = join(tmpDirForWrite, 'preferences.json');
  try {
    writeFileSync(tmpPath, JSON.stringify(prefs, null, 2) + '\n', { mode: 0o600 });
    try { chmodSync(tmpPath, 0o600); } catch { /* chmod may fail on some platforms */ }
    renameSync(tmpPath, prefsPath());
  } finally {
    try { rmSync(tmpDirForWrite, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  try { chmodSync(prefsPath(), 0o600); } catch { /* best-effort */ }
}

/**
 * Append one line to ~/.gbrain/migrations/completed.jsonl. Creates the
 * directory if missing. Does not read existing lines (append is cheap and
 * the reader tolerates malformed lines by skipping them).
 *
 * Writes `ts` as the current ISO timestamp if not provided.
 */
export function appendCompletedMigration(entry: CompletedMigrationEntry): void {
  if (!entry.version) throw new Error('appendCompletedMigration: version required');
  if (entry.status !== 'complete' && entry.status !== 'partial') {
    throw new Error(`appendCompletedMigration: status must be 'complete' or 'partial', got "${entry.status}"`);
  }
  const full: CompletedMigrationEntry = {
    ts: new Date().toISOString(),
    ...entry,
  };
  const dir = migrationsDir();
  mkdirSync(dir, { recursive: true });
  appendFileSync(completedJsonlPath(), JSON.stringify(full) + '\n');
}

/** Read the completed.jsonl file, skipping malformed lines with a warning to stderr. */
export function loadCompletedMigrations(): CompletedMigrationEntry[] {
  const path = completedJsonlPath();
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf-8');
  const out: CompletedMigrationEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as CompletedMigrationEntry);
    } catch (err) {
      console.warn(`[preferences] skipping malformed completed.jsonl line: ${trimmed.slice(0, 120)}`);
    }
  }
  return out;
}

/** Paths — exported for tests and rare consumers. */
export const preferencesPaths = {
  dir: prefsDir,
  file: prefsPath,
  migrationsDir,
  completedJsonl: completedJsonlPath,
};
