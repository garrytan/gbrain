/**
 * backup/status-file.ts — ENGINE-FREE core of the monthly backup-coverage
 * check: the cached verdict file, the notice renderer, and the bounded nag
 * gate shared by every render channel.
 *
 * ENGINE-FREE BY CONSTRUCTION: this module is imported by `gbrain hook`
 * (which must never touch the engine — serve holds the PGLite single-writer
 * lock) and by cli.ts's startup rail. Imports are fs/path, config file-plane
 * helpers, and the PURE policy functions from skillpack/nag-state.ts only.
 * Compute lives in backup/coverage.ts (engine-side).
 *
 * Two machine-owned files under the gbrain home (atomic tmp+rename, 0600,
 * fail-open on corrupt — a broken state file must never break a session):
 *
 *   backup-status.json    the cached BackupStatus verdict. Written ONLY by a
 *                         successful probed compute (coverage.ts); deleted by
 *                         invalidateBackupStatus() on fix paths (bootstrap
 *                         repo / sources harden / sources push success).
 *   backup-nag-state.json bounded-nag state. OWN schema (gbrain-backup-nag-v1)
 *                         — NOT skillpack's: loadNagState() reconstructs only
 *                         {schema_version, entries} on load, so the dampener /
 *                         global-cap fields here would be silently dropped on
 *                         round-trip. We reuse ONLY the pure policy functions
 *                         (decideNagAction / recordNagDisplay).
 *
 * Nag semantics (per channel, composed as an AND):
 *   - per-channel ceiling 3 per pseudo-version, where pack_version =
 *     YYYY-MM(checked_at) + verdict fingerprint — a new month or a CHANGED
 *     verdict re-surfaces; a same-month recompute with an unchanged verdict
 *     stays quiet.
 *   - cross-channel 24h dampener (top-level last_shown_at).
 *   - global cap: 3 RECORDED impressions per month-bucket across all
 *     recording channels (global_shown_count anchored by global_month).
 *   record() is DEFERRED — call it only after the text actually reached the
 *   wire (the hook.ts banner discipline); cross-process last-writer-wins on
 *   this file is acceptable (worst case: one extra display).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { gbrainPath, loadConfigFileOnly } from '../config.ts';
import {
  decideNagAction,
  recordNagDisplay,
  type NagEntry,
} from '../skillpack/nag-state.ts';

// ── Verdict types ───────────────────────────────────────────────────────────

export const BACKUP_STATUS_SCHEMA_VERSION = 'gbrain-backup-status-v1' as const;
export const BACKUP_NAG_SCHEMA_VERSION = 'gbrain-backup-nag-v1' as const;

export type BackupAssetKind = 'source_repo' | 'bootstrap_workspace' | 'harness_skills' | 'db_only' | 'db_content';
export type BackupAssetState = 'ok' | 'no_remote' | 'unpushed' | 'dirty' | 'failing' | 'info' | 'unknown';
export type BackupComputedBy = 'cli' | 'advisor' | 'doctor' | 'serve' | 'spawn' | 'sync';

export interface BackupAssetVerdict {
  kind: BackupAssetKind;
  /** Source id / workspace root / label. LOCAL surfaces only — aggregate
   * remote wording never includes this field. */
  id: string;
  state: BackupAssetState;
  /** Sanitized detail codes/counts only — never raw git stderr. */
  detail?: string;
  /** Commits ahead of origin (when probed). */
  ahead?: number;
  /** Structured fix argv (AdvisorFix discipline) or null when no single
   * mechanical fix exists. */
  fix_argv?: string[] | null;
}

export interface BackupTotals {
  assets: number;
  no_remote: number;
  unpushed: number;
  failing: number;
  /** Git-backed assets that would survive a disk loss (recovery statement). */
  recoverable_repos: number;
  /** Pages at risk on disk loss (db_only + undeclared DB-only signal). */
  pages_at_risk: number;
}

export interface BackupStatus {
  schema_version: typeof BACKUP_STATUS_SCHEMA_VERSION;
  /** ISO 8601 UTC of the completed compute. */
  checked_at: string;
  gbrain_version: string;
  interval_days: number;
  computed_by: BackupComputedBy;
  overall: 'ok' | 'warn';
  totals: BackupTotals;
  assets: BackupAssetVerdict[];
  /**
   * True when the compute could not read sources/pages (engine down mid-run).
   * A degraded verdict is never persisted over a probed cache
   * (coverage.ts getBackupStatus) — it would silence or fabricate a warn.
   */
  degraded?: boolean;
}

// ── Paths (test seams follow the nag-state.ts idiom) ────────────────────────

let statusPathOverride: string | null = null;
let nagStatePathOverride: string | null = null;
let intervalOverrideMs: number | null = null;

export function backupStatusPath(): string {
  return statusPathOverride ?? gbrainPath('backup-status.json');
}
export function __setBackupStatusPathForTests(p: string | null): void {
  statusPathOverride = p;
}

export function backupNagStatePath(): string {
  return nagStatePathOverride ?? gbrainPath('backup-nag-state.json');
}
export function __setBackupNagStatePathForTests(p: string | null): void {
  nagStatePathOverride = p;
}

export function __setBackupIntervalForTests(ms: number | null): void {
  intervalOverrideMs = ms;
}

// ── Config / kill switches ──────────────────────────────────────────────────

/** Default automatic-compute window: 30 days ("once a month"). */
export const BACKUP_INTERVAL_DAYS_DEFAULT = 30;
/** Human notice budget (the push-banner discipline). */
export const BACKUP_BANNER_MAX_CHARS = 300;
/** Cross-channel dampener: at most one recorded impression per day. */
export const BACKUP_DAMPENER_MS = 24 * 60 * 60 * 1000;
/** Recorded impressions allowed per month-bucket across ALL channels. */
export const BACKUP_GLOBAL_CEILING = 3;

function configBackup(): { check_enabled?: unknown; check_interval_days?: unknown } {
  try {
    const cfg = loadConfigFileOnly() as { backup?: { check_enabled?: unknown; check_interval_days?: unknown } };
    return cfg.backup ?? {};
  } catch {
    return {};
  }
}

/**
 * Hard off-switches. Default ON — the whole point is protecting users who
 * never opted in. `GBRAIN_BACKUP_CHECK=0` is the env kill switch; the
 * file-plane key `backup.check_enabled` accepts 'false'/'0'/'off'/false.
 * Render sites AND compute sites both consult this, so a stale warn cache
 * goes silent the moment the feature is disabled.
 */
export function backupCheckDisabled(): boolean {
  const env = process.env.GBRAIN_BACKUP_CHECK?.trim().toLowerCase();
  if (env === '0' || env === 'false' || env === 'off') return true;
  const raw = configBackup().check_enabled;
  if (raw === undefined || raw === null) return false;
  if (raw === false) return true;
  const s = String(raw).trim().toLowerCase();
  return s === 'false' || s === '0' || s === 'off';
}

/**
 * Automatic-compute window in ms. env GBRAIN_BACKUP_CHECK_DAYS > config >
 * default 30. Clamped to ≥1 day (a leftover DAYS=0 must not re-probe up to
 * 500 git roots on every dispatch) — forcing a recompute is `gbrain backup
 * check` or the test seam, never DAYS=0.
 */
export function backupIntervalMs(): number {
  if (intervalOverrideMs !== null) return intervalOverrideMs;
  const day = 24 * 60 * 60 * 1000;
  const env = process.env.GBRAIN_BACKUP_CHECK_DAYS;
  const cfgRaw = configBackup().check_interval_days;
  const raw = env !== undefined && env !== '' ? Number(env) : cfgRaw !== undefined ? Number(cfgRaw) : NaN;
  const days = Number.isFinite(raw) && raw >= 1 ? raw : BACKUP_INTERVAL_DAYS_DEFAULT;
  return days * day;
}

// ── Cached verdict I/O ──────────────────────────────────────────────────────

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {}
    throw err;
  }
}

/** Missing / corrupt / unknown-schema → null (fail-open). */
export function loadBackupStatus(): BackupStatus | null {
  const path = backupStatusPath();
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<BackupStatus>;
    if (raw.schema_version !== BACKUP_STATUS_SCHEMA_VERSION) return null;
    if (typeof raw.checked_at !== 'string' || !Array.isArray(raw.assets)) return null;
    if (raw.overall !== 'ok' && raw.overall !== 'warn') return null;
    // Renderers dereference totals un-guarded — a truncated-but-schema-valid
    // cache must read as absent, not crash `gbrain backup status`.
    const t = raw.totals;
    if (
      !t ||
      typeof t.assets !== 'number' ||
      typeof t.no_remote !== 'number' ||
      typeof t.recoverable_repos !== 'number' ||
      typeof t.pages_at_risk !== 'number'
    ) {
      return null;
    }
    return raw as BackupStatus;
  } catch {
    return null;
  }
}

export function saveBackupStatus(s: BackupStatus): void {
  atomicWriteJson(backupStatusPath(), s);
}

/**
 * Fix-path invalidation: called on `bootstrap repo` / `sources harden` /
 * `sources push` success so a fixed repo stops nagging immediately instead of
 * at the next 30-day recompute. Best-effort — never throws.
 */
export function invalidateBackupStatus(): void {
  try {
    rmSync(backupStatusPath(), { force: true });
  } catch {}
}

/**
 * Absent cache counts as stale (cold start computes on the first trigger).
 * A checked_at more than 24h in the FUTURE is stale/invalid (clock skew).
 */
export function isBackupStatusStale(s: BackupStatus | null, now: number = Date.now()): boolean {
  if (!s) return true;
  const t = Date.parse(s.checked_at);
  if (!Number.isFinite(t)) return true;
  if (t > now + 24 * 60 * 60 * 1000) return true;
  return now - t > backupIntervalMs();
}

// ── Notice rendering ────────────────────────────────────────────────────────

/** Cache age as a short human phrase ("2h ago", "12d ago"). */
export function backupCacheAge(s: BackupStatus, now: number = Date.now()): string {
  const t = Date.parse(s.checked_at);
  if (!Number.isFinite(t)) return 'unknown age';
  const ms = Math.max(0, now - t);
  const h = Math.floor(ms / (60 * 60 * 1000));
  if (h < 1) return 'under an hour ago';
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * The user-facing warning line. Returns null when overall is ok.
 *
 * 'human' (trusted local surfaces: hook banner, CLI rail, backup status):
 * names up to two assets, second person, concrete numbers, never preachy
 * (DESIGN.md voice), capped at BACKUP_BANNER_MAX_CHARS.
 *
 * 'aggregate' (remote/MCP surfaces): counts ONLY — never a local path or
 * source id (remote-privacy-sweep is the backstop).
 */
export function backupNoticeText(s: BackupStatus, surface: 'human' | 'aggregate'): string | null {
  if (s.overall !== 'warn') return null;
  const n = s.totals.no_remote;
  const total = s.totals.assets;
  if (surface === 'aggregate') {
    return (
      `gbrain monthly backup check: ${n} of ${total} knowledge assets have no git remote ` +
      `(local-only). A disk loss loses them. Run 'gbrain backup status' on the brain host for fix commands.`
    );
  }
  const names = s.assets
    .filter((a) => a.state === 'no_remote')
    .slice(0, 2)
    .map((a) => a.id);
  const which = names.length > 0 ? ` (${names.join(', ')}${n > names.length ? ', …' : ''})` : '';
  const text =
    `${n} of your ${total} knowledge assets aren't on any git remote${which}. ` +
    `A disk loss loses them. Run: gbrain backup status`;
  return text.length > BACKUP_BANNER_MAX_CHARS ? `${text.slice(0, BACKUP_BANNER_MAX_CHARS - 1)}…` : text;
}

// ── Nag state (own schema; reuses ONLY nag-state.ts pure policy fns) ────────

export interface BackupNagState {
  schema_version: typeof BACKUP_NAG_SCHEMA_VERSION;
  entries: NagEntry[];
  /** Cross-channel dampener: ISO of the last RECORDED impression anywhere. */
  last_shown_at?: string;
  /** Recorded impressions in global_month (cap BACKUP_GLOBAL_CEILING). */
  global_shown_count?: number;
  /** YYYY-MM anchor for global_shown_count; rollover resets the count. */
  global_month?: string;
  /** Session-end detached-spawn debounce (no separate sidecar file). */
  last_spawn_at?: string;
}

const EMPTY_NAG: BackupNagState = { schema_version: BACKUP_NAG_SCHEMA_VERSION, entries: [] };

export function loadBackupNagState(): BackupNagState {
  const path = backupNagStatePath();
  if (!existsSync(path)) return { ...EMPTY_NAG, entries: [] };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<BackupNagState>;
    if (raw.schema_version !== BACKUP_NAG_SCHEMA_VERSION || !Array.isArray(raw.entries)) {
      return { ...EMPTY_NAG, entries: [] };
    }
    return {
      schema_version: BACKUP_NAG_SCHEMA_VERSION,
      entries: raw.entries as NagEntry[],
      last_shown_at: typeof raw.last_shown_at === 'string' ? raw.last_shown_at : undefined,
      global_shown_count: typeof raw.global_shown_count === 'number' ? raw.global_shown_count : undefined,
      global_month: typeof raw.global_month === 'string' ? raw.global_month : undefined,
      last_spawn_at: typeof raw.last_spawn_at === 'string' ? raw.last_spawn_at : undefined,
    };
  } catch {
    return { ...EMPTY_NAG, entries: [] };
  }
}

export function saveBackupNagState(state: BackupNagState): void {
  try {
    atomicWriteJson(backupNagStatePath(), state);
  } catch {
    // Fail-open: a nag-state write failure must never break the caller.
  }
}

function monthBucket(iso: string): string {
  return iso.slice(0, 7); // YYYY-MM
}

/**
 * Pseudo-version: month bucket of the verdict's checked_at + a fingerprint of
 * the no-remote set. A new month or a CHANGED verdict reads as a version bump
 * (re-surfaces, count resets via recordNagDisplay); a same-month forced
 * recompute with an unchanged verdict keeps the same pseudo-version and stays
 * suppressed once the ceiling is hit.
 */
export function backupVerdictVersion(s: BackupStatus): string {
  const ids = s.assets
    .filter((a) => a.state === 'no_remote')
    .map((a) => a.id)
    .sort()
    .join(',');
  const t = s.totals;
  return `${monthBucket(s.checked_at)}:${t.no_remote}/${t.assets}:${ids}`;
}

const NAG_KEY_BASE = { brain_id: 'host', source_id: 'backup' } as const;

/**
 * True when `iso` marks an event within the trailing dampener window. One
 * helper for every consumer (gate, read-only consult, spawn debounce) so the
 * future-skew guard cannot diverge: a far-future timestamp (clock jump /
 * corrupt write) is ignored rather than suppressing forever.
 */
function withinDampener(iso: string | undefined, now: number): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && now - t < BACKUP_DAMPENER_MS && t <= now + BACKUP_DAMPENER_MS;
}

export interface BackupNagDecision {
  show: boolean;
  /** Deferred — invoke only AFTER the text reached the wire. No-op when
   * show=false or for read-only consults. */
  record: () => void;
}

const NOOP_DECISION: BackupNagDecision = { show: false, record: () => {} };

/**
 * The bounded-nag gate every RECORDING channel routes through
 * ('hook-banner' | 'hook-note' | 'cli' | 'mcp' | 'status' | 'advisor' | …).
 * The global cap and dampener are enforced HERE, uniformly, so any future
 * channel inherits them.
 */
export function backupNagGate(channel: string, s: BackupStatus, now: number = Date.now()): BackupNagDecision {
  try {
    if (s.overall !== 'warn' || backupCheckDisabled()) return NOOP_DECISION;
    const state = loadBackupNagState();
    const nowIso = new Date(now).toISOString();
    const month = monthBucket(nowIso);

    // Cross-channel 24h dampener.
    if (withinDampener(state.last_shown_at, now)) return NOOP_DECISION;
    // Global per-month-bucket cap (count resets on rollover).
    const globalCount = state.global_month === month ? (state.global_shown_count ?? 0) : 0;
    if (globalCount >= BACKUP_GLOBAL_CEILING) return NOOP_DECISION;

    const key = { ...NAG_KEY_BASE, pack_name: channel };
    const packVersion = backupVerdictVersion(s);
    const prior = state.entries.find(
      (e) => e.brain_id === key.brain_id && e.source_id === key.source_id && e.pack_name === key.pack_name,
    );
    const decision = decideNagAction(prior, { pack_version: packVersion });
    if (!decision.show) return NOOP_DECISION;

    return {
      show: true,
      record: () => {
        try {
          // Re-load for last-writer-wins freshness; races are acceptable
          // (worst case one extra display, documented).
          const fresh = loadBackupNagState();
          const freshPrior = fresh.entries.find(
            (e) => e.brain_id === key.brain_id && e.source_id === key.source_id && e.pack_name === key.pack_name,
          );
          const entry = recordNagDisplay(freshPrior, key, { pack_version: packVersion, nowIso });
          const others = fresh.entries.filter(
            (e) => !(e.brain_id === key.brain_id && e.source_id === key.source_id && e.pack_name === key.pack_name),
          );
          const freshGlobal = fresh.global_month === month ? (fresh.global_shown_count ?? 0) : 0;
          saveBackupNagState({
            ...fresh,
            entries: [...others, entry],
            last_shown_at: nowIso,
            global_month: month,
            global_shown_count: freshGlobal + 1,
          });
        } catch {
          // Fail-open.
        }
      },
    };
  } catch {
    return NOOP_DECISION;
  }
}

/**
 * Read-only consult for the OpenClaw context-engine line: `assemble()`
 * composes server-side and cannot know delivery, so it never writes nag
 * state. Shows only when the shared dampener has aged out AND the recording
 * channels' global budget is not exhausted — bounded by their budget without
 * ever spending it. (The caller adds its own in-process 24h latch.)
 */
export function backupNagReadOnlyConsult(s: BackupStatus, now: number = Date.now()): boolean {
  try {
    if (s.overall !== 'warn' || backupCheckDisabled()) return false;
    const state = loadBackupNagState();
    if (withinDampener(state.last_shown_at, now)) return false;
    const month = monthBucket(new Date(now).toISOString());
    const globalCount = state.global_month === month ? (state.global_shown_count ?? 0) : 0;
    return globalCount < BACKUP_GLOBAL_CEILING;
  } catch {
    return false;
  }
}

// ── Session-end spawn debounce (folded into the nag file — no sidecar) ──────

/** True when a detached `gbrain backup check --quiet` may be spawned. */
export function backupSpawnDue(now: number = Date.now()): boolean {
  try {
    return !withinDampener(loadBackupNagState().last_spawn_at, now);
  } catch {
    return true;
  }
}

export function recordBackupSpawn(now: number = Date.now()): void {
  try {
    const state = loadBackupNagState();
    saveBackupNagState({ ...state, last_spawn_at: new Date(now).toISOString() });
  } catch {}
}

// ── CLI startup rail helper (keeps the cli.ts diff tiny) ────────────────────

/** Commands that must never host the backup nag on the CLI rail. `serve`
 * especially: a harness-spawned MCP server must not burn the shared budget
 * into a log nobody reads. */
export const BACKUP_CLI_NAG_SKIP = new Set([
  'upgrade',
  'post-upgrade',
  'check-update',
  'self-upgrade',
  'hook',
  'backup',
  'doctor',
  'advisor',
  'serve',
  'call',
  'jobs',
]);

/**
 * The cli.ts startup-rail body (called right after maybeEmitUpdateMarker).
 * Guards live here — one place, every call site covered. Fail-open.
 */
export function maybeEmitBackupNag(
  command: string | undefined,
  opts: { quiet?: boolean } = {},
  write: (line: string) => void = (line) => process.stderr.write(line),
): void {
  try {
    if (process.env.NODE_ENV === 'test' && process.env.GBRAIN_FORCE_BACKUP_NAG !== '1') return;
    if (process.env.GBRAIN_SKIP_STARTUP_HOOKS) return;
    if (opts.quiet) return;
    if (!command || BACKUP_CLI_NAG_SKIP.has(command)) return;
    if (backupCheckDisabled()) return;
    const s = loadBackupStatus();
    if (!s || s.overall !== 'warn') return;
    const gate = backupNagGate('cli', s);
    if (!gate.show) return;
    const text = backupNoticeText(s, 'human');
    if (!text) return;
    if (!process.stderr.isTTY) {
      write(`BACKUP_LOCAL_ONLY ${s.totals.no_remote}\n`);
    }
    write(`gbrain backup check: ${text}\n`);
    gate.record();
  } catch {
    // Never break a CLI invocation over a notice.
  }
}
