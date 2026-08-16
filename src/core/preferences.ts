/**
 * ~/.gbrain/preferences.json — user-facing agent-behavior flags (minion_mode, etc.).
 *
 * Separate from src/core/config.ts (engine config), written to its own file so
 * engine config and agent preferences can evolve independently. Atomic writes
 * via mktemp + rename; 0o600 perms; forward-compatible (preserves unknown keys).
 *
 * Also houses ~/.gbrain/migrations/completed.jsonl append helper.
 */

import { readFileSync, writeFileSync, renameSync, chmodSync, mkdtempSync, rmSync, existsSync, mkdirSync, appendFileSync, copyFileSync, linkSync } from 'fs';
import { join, dirname } from 'path';
import { gbrainPath } from './config.ts';

/**
 * GBRAIN_HOME-aware resolution of the .gbrain directory — delegates to
 * `src/core/config.ts:gbrainPath()` so preferences + the migration ledger
 * follow the SAME convention as config resolution: GBRAIN_HOME is a PARENT
 * dir and '.gbrain' is always appended (`GBRAIN_HOME=/tmp/x` →
 * `/tmp/x/.gbrain`). The previous local implementation returned GBRAIN_HOME
 * directly — while its own doc comment claimed to match gbrainPath — so
 * with GBRAIN_HOME set, config lived at `$GBRAIN_HOME/.gbrain/config.json`
 * but the migration ledger at `$GBRAIN_HOME/migrations/completed.jsonl`,
 * splitting one logical home across two roots.
 *
 * When unset, gbrainPath falls back to `<home>/.gbrain` so legacy callers
 * and doctor's filesystem-only checks keep working.
 */
function gbrainDir(): string {
  return gbrainPath();
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
  /**
   * - `complete`  — orchestrator finished cleanly. Terminal state; future
   *   runs no-op this version unless `retry` is appended.
   * - `partial`   — orchestrator ran but reported missed phases; re-run is
   *   expected. Attempt cap (3 consecutive partials without a `complete`
   *   or `retry` between them) triggers the "wedged" skip in the runner.
   * - `retry`     — explicit reset marker written by `--force-retry`.
   *   Clears a wedge without faking success; the next upgrade treats the
   *   version as fresh again.
   */
  status: 'complete' | 'partial' | 'retry';
  mode?: MinionMode;
  files_rewritten?: number;
  autopilot_installed?: boolean;
  install_target?: string;
  apply_migrations_pending?: boolean;
  phases?: Array<{ name: string; status: string; detail?: string }>;
  [key: string]: unknown;
}

const VALID_MODES: ReadonlyArray<MinionMode> = ['always', 'pain_triggered', 'off'];

// Route preferences + migration ledger paths through gbrainDir() so they
// honor GBRAIN_HOME for hermetic test isolation. Pre-v0.30.3 these used
// `$HOME/.gbrain` directly, which leaked the developer's local migration
// ledger into E2E tests and CI runs even when GBRAIN_HOME was set.
function prefsDir(): string { return gbrainDir(); }
function prefsPath(): string { return join(prefsDir(), 'preferences.json'); }
function migrationsDir(): string { return join(gbrainDir(), 'migrations'); }
function completedJsonlPath(): string { return join(migrationsDir(), 'completed.jsonl'); }

/**
 * One-time copy-forward from the pre-unification layout. Before gbrainDir()
 * delegated to gbrainPath(), an install running with GBRAIN_HOME set kept
 * these files at $GBRAIN_HOME/<relPath> directly (no '.gbrain' segment).
 * Losing them on upgrade would silently re-run completed migrations and —
 * worse — drop an explicit `minion_mode: off` opt-out back to the default.
 * COPY (not move) so a binary rollback still finds the legacy file. Only
 * fires when GBRAIN_HOME is set, the new path is absent, and the legacy
 * file exists. Returns the path the caller should READ: the canonical path
 * normally; the legacy path in place when a valid legacy file exists but
 * could not be copied (read-only home, ENOSPC) — so a transient failure
 * never drops an opt-out; an unparseable legacy prefs file is treated as
 * missing rather than poisoning the canonical path.
 *
 * Known limitation (accepted): the copy is one-shot. During a mixed-version
 * window (old binary still writing the legacy path after a new binary
 * snapshot), post-snapshot legacy writes are not merged — the canonical
 * path wins from then on. The exposed population (GBRAIN_HOME production
 * installs × concurrent mixed-version writers) is tiny, and a merge engine
 * here would cost more risk than the window it closes.
 */
/** One warning per (process, legacy path) — a persistently unmigratable file
 *  would otherwise spam every command until the operator intervenes. */
const migrateWarned = new Set<string>();

function copyForwardLegacyFile(
  newPath: string,
  relPath: string,
  opts?: { validateJson?: boolean },
): string {
  const override = process.env.GBRAIN_HOME?.trim();
  if (!override || existsSync(newPath)) return newPath;
  const legacyPath = join(override, relPath);
  if (legacyPath === newPath || !existsSync(legacyPath)) return newPath;
  let tmpDir: string | null = null;
  try {
    // A foreign/corrupted legacy preferences.json must not poison the
    // canonical path forever (loadPreferences JSON.parse throws and callers
    // like autopilot boot unguarded); treat unparseable as missing. The
    // ledger needs no validation — its reader skips malformed lines.
    if (opts?.validateJson) {
      JSON.parse(readFileSync(legacyPath, 'utf-8'));
    }
    mkdirSync(dirname(newPath), { recursive: true });
    // Atomic install, matching savePreferences' discipline: copy into a
    // sibling temp dir, then LINK into place. linkSync fails EEXIST if a
    // concurrent process migrated (or appended) first — never truncates a
    // reader's view mid-copy, never clobbers a concurrent append.
    tmpDir = mkdtempSync(join(dirname(newPath), '.migrate-tmp-'));
    const tmpFile = join(tmpDir, 'file');
    copyFileSync(legacyPath, tmpFile);
    try { chmodSync(tmpFile, 0o600); } catch { /* best-effort on exotic FS */ }
    try {
      linkSync(tmpFile, newPath);
      console.error(`[preferences] migrated ${relPath} from legacy $GBRAIN_HOME layout (${legacyPath} → ${newPath}); legacy copy kept for rollback`);
    } catch (linkErr) {
      if ((linkErr as NodeJS.ErrnoException).code !== 'EEXIST') throw linkErr;
      // Another process won the migration race — its copy stands.
    }
    return newPath;
  } catch (err) {
    // Copy failed (read-only $GBRAIN_HOME, ENOSPC, foreign JSON). Never
    // silent, but warn once per process — and for a VALID-but-uncopyable
    // legacy file, hand the caller the legacy path to READ IN PLACE so a
    // transient failure can't silently drop an opt-out or migration
    // history (the pre-change code read this path with no write needed).
    const code = (err as NodeJS.ErrnoException).code ?? (err instanceof SyntaxError ? 'invalid-json' : 'error');
    if (!migrateWarned.has(legacyPath)) {
      migrateWarned.add(legacyPath);
      console.error(`[preferences] found legacy ${relPath} at ${legacyPath} but could not migrate it (${code}); ${err instanceof SyntaxError ? 'treating as missing' : 'reading it in place'}`);
    }
    return err instanceof SyntaxError ? newPath : legacyPath;
  } finally {
    if (tmpDir) { try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ } }
  }
}

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
  const path = copyForwardLegacyFile(prefsPath(), 'preferences.json', { validateJson: true });
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

  // No-op when the new path already exists; otherwise ensures a fresh save
  // doesn't shadow un-migrated legacy prefs (the save below would win, but
  // the migration log line should still fire once for observability).
  copyForwardLegacyFile(prefsPath(), 'preferences.json', { validateJson: true });
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
  // Copy-forward BEFORE any append: a partial/retry append that skipped the
  // guard below would otherwise create a fresh ledger at the new path and
  // permanently shadow the un-migrated legacy history. Appends target the
  // SAME path reads resolve to — when copy-forward degraded to
  // read-legacy-in-place (linkless FS), appending to the canonical path
  // would split the ledger and hide the legacy history from readers.
  const ledgerPath = copyForwardLegacyFile(completedJsonlPath(), join('migrations', 'completed.jsonl'));
  if (entry.status !== 'complete' && entry.status !== 'partial' && entry.status !== 'retry') {
    throw new Error(`appendCompletedMigration: status must be 'complete', 'partial', or 'retry', got "${entry.status}"`);
  }
  // Bug 3 — idempotency guard. If the most recent existing entry for this
  // version is already 'complete' and we're about to write another
  // 'complete', skip. This protects against accidental double-writes
  // during the Bug 3 runner-owned-ledger transition (old orchestrator
  // code paths and new runner path shouldn't both write).
  if (entry.status === 'complete') {
    const existing = loadCompletedMigrations();
    const prior = existing.filter(e => e.version === entry.version);
    if (prior.length > 0 && prior[prior.length - 1].status === 'complete') {
      return; // no-op — already terminal
    }
  }
  const full: CompletedMigrationEntry = {
    ts: new Date().toISOString(),
    ...entry,
  };
  mkdirSync(dirname(ledgerPath), { recursive: true });
  // The top-of-function copy-forward is load-bearing for partial/retry
  // appends (the 'complete' idempotency guard also routes through
  // loadCompletedMigrations, but that guard is status-gated).
  appendFileSync(ledgerPath, JSON.stringify(full) + '\n');
}

/** Read the completed.jsonl file, skipping malformed lines with a warning to stderr. */
export function loadCompletedMigrations(): CompletedMigrationEntry[] {
  const path = copyForwardLegacyFile(completedJsonlPath(), join('migrations', 'completed.jsonl'));
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
