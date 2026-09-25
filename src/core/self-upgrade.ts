/**
 * Self-upgrade decision + state foundation (v0.42 self-upgrading-gbrain wave).
 *
 * Mirrors gstack's invocation-riding update mechanism for gbrain: a throttled
 * check that rides every `gbrain` invocation (CLI / MCP), emits a marker, and
 * either prompts (mode=notify) or silently upgrades (mode=auto, opt-in). A
 * second silent channel lives in the autopilot daemon. Both channels share the
 * cache + snooze + lock state defined here so they can never double-upgrade.
 *
 * This module is the PURE + state foundation:
 *   - `decideSelfUpgrade()` — pure decision over already-resolved inputs.
 *   - cache helpers — atomic temp+rename writes, strict parse, mtime-TTL.
 *   - snooze helpers — escalating 24h/48h/7d, version-reset.
 *   - `formatMarker` / `parseMarker` — ONE marker grammar shared by the CLI
 *     emit, the MCP emit, and the agent skill (no drift; forged markers
 *     rejected via the version regex).
 *
 * Hot-path contract: the CLI startup read is cache-read-only (statSync + read,
 * sub-ms). Network refresh is detached + single-flighted; it NEVER blocks a
 * command. The version string is regex-validated AND monotonic-checked before
 * it reaches the agent's context (a malicious brain page / MCP response can
 * neither forge a "downgrade-as-upgrade" nor change the action — the action is
 * always the hardcoded `gbrain upgrade` / `gbrain self-upgrade`).
 *
 * NO DB. The hot path runs before `connectEngine()` and thin clients have no
 * local DB, so all state is file-based under `~/.gbrain/` (honors GBRAIN_HOME).
 */

import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gbrainPath, isConfigTruthy } from './config.ts';
import { isValidTimeZone } from './cycle/cycle-date.ts';
import { isValidConfig as isValidQuietHoursWindow } from './minions/quiet-hours.ts';
import { acquirePackLock, type PackLockOpts } from './schema-pack/pack-lock.ts';
import { isNewerVersion, isValidVersionString, parseSemver, semverGt, semverLte } from './semver.ts';

// ── Constants ───────────────────────────────────────────────────────────────

/** Cache freshness: short when up-to-date (detect releases fast), long when an
 * upgrade is already pending (don't re-fetch on every invocation). Mirrors
 * gstack (60min / 12h). */
export const CACHE_TTL_UP_TO_DATE_MS = 60 * 60 * 1000;
export const CACHE_TTL_UPGRADE_AVAILABLE_MS = 12 * 60 * 60 * 1000;

/** Auto channel only checks once per this interval. */
export const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Escalating snooze durations by level (gstack-style). Level >=3 caps at 7d. */
export const SNOOZE_DURATIONS_MS = [
  24 * 60 * 60 * 1000, // level 1 → 24h
  48 * 60 * 60 * 1000, // level 2 → 48h
  7 * 24 * 60 * 60 * 1000, // level 3+ → 7d
] as const;

// ── Types ─────────────────────────────────────────────────────────────────

export type SelfUpgradeMode = 'auto' | 'notify' | 'off';

export type SelfUpgradeChannel = 'invocation' | 'autopilot';

/**
 * The decision outcome. `apply` = silently run the upgrade (autopilot/auto
 * only). `notify` = surface the marker / 4-option prompt. Everything else is a
 * no-op with a named reason (for the audit trail + doctor).
 */
export type SelfUpgradeAction =
  | 'off'
  | 'not_behind'
  | 'downgrade_or_yanked'
  | 'known_bad'
  | 'throttled'
  | 'busy'
  | 'outside_quiet_hours'
  | 'unsupported_install'
  | 'notify'
  | 'apply';

export interface SelfUpgradeDecision {
  action: SelfUpgradeAction;
  reason: string;
  current: string;
  latest: string | null;
}

export interface DecideSelfUpgradeInputs {
  mode: SelfUpgradeMode;
  currentVersion: string;
  /** Latest known version (from cache/marker). null when unknown → fail-open. */
  latestVersion: string | null;
  /** Versions that failed a prior auto-upgrade (never auto-retried). */
  failedVersions: string[];
  channel: SelfUpgradeChannel;
  // autopilot-channel gates (ignored for invocation):
  idle?: boolean;
  inQuietHours?: boolean;
  canSelfUpdate?: boolean;
  /** True when the last auto-check was < AUTO_CHECK_INTERVAL_MS ago. */
  throttledByInterval?: boolean;
  // invocation-channel gate (ignored for autopilot):
  /** True when an unexpired snooze covers `latestVersion`. */
  snoozed?: boolean;
}

export type MarkerKind = 'up_to_date' | 'upgrade_available';

export interface UpdateMarker {
  kind: MarkerKind;
  current: string;
  /** Present only when kind === 'upgrade_available'. */
  latest?: string;
}

export interface SnoozeRecord {
  version: string;
  level: number;
  /** Epoch ms when the snooze was written. */
  ts: number;
}

// ── Pure decision ───────────────────────────────────────────────────────────

/**
 * Decide what to do about a possible upgrade. Pure: all I/O-derived inputs are
 * resolved by the caller. The version comparison is monotonic — we only ever
 * act when `latest` is a real release strictly greater than `current`,
 * so a downgrade / yanked / prerelease-local-build can never trigger an upgrade.
 */
export function decideSelfUpgrade(inp: DecideSelfUpgradeInputs): SelfUpgradeDecision {
  const base = { current: inp.currentVersion, latest: inp.latestVersion };

  if (inp.mode === 'off') {
    return { action: 'off', reason: 'self_upgrade.mode=off', ...base };
  }

  if (!inp.latestVersion || !isValidVersionString(inp.latestVersion)) {
    return { action: 'not_behind', reason: 'latest version unknown or invalid', ...base };
  }

  const cur = parseSemver(inp.currentVersion);
  const lat = parseSemver(inp.latestVersion);
  if (!cur || !lat) {
    return { action: 'not_behind', reason: 'unparseable version', ...base };
  }

  if (semverLte(lat, cur)) {
    // Equal → up to date; strictly-less → a downgrade / yanked release. Never act.
    if (semverGt(cur, lat)) {
      return { action: 'downgrade_or_yanked', reason: `latest ${inp.latestVersion} < current ${inp.currentVersion}`, ...base };
    }
    return { action: 'not_behind', reason: 'already current', ...base };
  }

  if (inp.failedVersions.includes(inp.latestVersion)) {
    return { action: 'known_bad', reason: `${inp.latestVersion} previously failed; not retrying`, ...base };
  }

  // Genuinely behind by a newer release and not known-bad.
  if (inp.channel === 'invocation') {
    if (inp.snoozed) {
      return { action: 'throttled', reason: 'snoozed for this version', ...base };
    }
    return { action: 'notify', reason: `update available: ${inp.currentVersion} -> ${inp.latestVersion}`, ...base };
  }

  // autopilot channel (silent auto)
  if (inp.throttledByInterval) {
    return { action: 'throttled', reason: 'auto-check ran within 24h', ...base };
  }
  if (!inp.idle) {
    return { action: 'busy', reason: 'brain not idle', ...base };
  }
  if (!inp.inQuietHours) {
    return { action: 'outside_quiet_hours', reason: 'outside quiet hours', ...base };
  }
  if (!inp.canSelfUpdate) {
    return { action: 'unsupported_install', reason: 'install method cannot self-update', ...base };
  }
  return { action: 'apply', reason: `auto-upgrading ${inp.currentVersion} -> ${inp.latestVersion}`, ...base };
}

/**
 * Whether this install method + platform/arch can apply an upgrade unattended.
 * `bun` / `bun-link` / `clawhub` delegate to their package managers; `binary`
 * self-updates via atomic rename ONLY where a release asset is published —
 * today that's darwin-arm64 and linux-x64 (see `.github/workflows/release.yml`).
 * Other binary platform/arch combos (darwin-x64, linux-arm64, win32) have no
 * asset and stay notify-only. `unknown` cannot self-update.
 */
export function canSelfUpdate(
  installMethod: string,
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): boolean {
  switch (installMethod) {
    case 'bun':
    case 'bun-link':
    case 'clawhub':
      return true;
    case 'binary':
      return (platform === 'darwin' && arch === 'arm64') || (platform === 'linux' && arch === 'x64');
    default:
      return false;
  }
}

// ── Marker grammar (shared by CLI + MCP + agent skill) ───────────────────────

/** Serialize a marker line. The cache file content IS this string. */
export function formatMarker(m: UpdateMarker): string {
  if (m.kind === 'upgrade_available' && m.latest) {
    return `UPGRADE_AVAILABLE ${m.current} ${m.latest}`;
  }
  return `UP_TO_DATE ${m.current}`;
}

/**
 * Parse a marker line. Strict: both versions must pass the version regex, or we
 * return null. This is the forged-marker guard — a malicious string can't smuggle
 * a non-version token (or a command) into the agent's context as an "upgrade".
 */
export function parseMarker(line: string): UpdateMarker | null {
  const parts = line.trim().split(/\s+/);
  if (parts[0] === 'UP_TO_DATE' && parts.length === 2 && isValidVersionString(parts[1])) {
    return { kind: 'up_to_date', current: parts[1] };
  }
  if (
    parts[0] === 'UPGRADE_AVAILABLE' &&
    parts.length === 3 &&
    isValidVersionString(parts[1]) &&
    isValidVersionString(parts[2])
  ) {
    return { kind: 'upgrade_available', current: parts[1], latest: parts[2] };
  }
  return null;
}

// ── State file paths ────────────────────────────────────────────────────────

export function updateCachePath(): string {
  return gbrainPath('last-update-check');
}

export function snoozePath(): string {
  return gbrainPath('update-snoozed');
}

export function justUpgradedPath(): string {
  return gbrainPath('just-upgraded-from');
}

/**
 * Record the version we just upgraded FROM, so the next `gbrain` invocation's
 * startup hook can print the one-time `JUST_UPGRADED <from> <to>` confirmation
 * and then delete the breadcrumb. Best-effort: a failed write just means no
 * confirmation line. Atomic so a concurrent read never sees a torn file.
 */
export function writeJustUpgraded(fromVersion: string): void {
  try {
    atomicWrite(justUpgradedPath(), fromVersion + '\n');
  } catch {
    /* best-effort confirmation */
  }
}

/** Directory for the self-upgrade + refresh single-flight locks. */
export function locksDir(): string {
  return gbrainPath('.locks');
}

// ── Cache (untrusted local state: atomic write, strict parse, mtime-TTL) ─────

export interface CacheEntry {
  marker: UpdateMarker;
  mtimeMs: number;
}

let _tmpCounter = 0;
function atomicWrite(path: string, content: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${_tmpCounter++}`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeFileSync(fd, content);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/** Read + strict-parse the cache. Returns null on missing / corrupt. */
export function readUpdateCache(): CacheEntry | null {
  const path = updateCachePath();
  let content: string;
  let mtimeMs: number;
  try {
    content = readFileSync(path, 'utf8');
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return null;
  }
  const marker = parseMarker(content);
  if (!marker) return null;
  return { marker, mtimeMs };
}

/** Atomically write the cache (marker line, 0600). Best-effort: throws only on
 * truly unexpected fs errors (callers in the detached refresh swallow). */
export function writeUpdateCache(marker: UpdateMarker): void {
  atomicWrite(updateCachePath(), formatMarker(marker) + '\n');
}

/** Clear the cache (e.g. after a successful upgrade) so the next run re-checks. */
export function clearUpdateCache(): void {
  try {
    unlinkSync(updateCachePath());
  } catch {
    /* already gone */
  }
}

export function isCacheFresh(entry: CacheEntry, now: number): boolean {
  const ttl = entry.marker.kind === 'upgrade_available' ? CACHE_TTL_UPGRADE_AVAILABLE_MS : CACHE_TTL_UP_TO_DATE_MS;
  return now - entry.mtimeMs < ttl;
}

/**
 * The one shared "is an upgrade actually pending for THIS binary?" predicate.
 * Returns the latest version string when the cache is present, fresh, marks an
 * upgrade, AND that upgrade is strictly newer than the RUNNING binary — else
 * null. The running-version comparison is the load-bearing part: the cache
 * records the version of whatever binary WROTE it (an older gbrain on PATH can
 * write it via the detached refresh), so consumers must never trust
 * `marker.current` to describe themselves. Every upgrade-nag surface (CLI
 * startup marker, doctor, advisor, get_brain_identity) routes through here so
 * the suppression rule cannot drift per-surface. Never throws.
 */
export function pendingUpgradeVersion(runningVersion: string, now: number = Date.now()): string | null {
  try {
    const entry = readUpdateCache();
    if (!entry || !isCacheFresh(entry, now)) return null;
    if (entry.marker.kind !== 'upgrade_available' || !entry.marker.latest) return null;
    if (!isNewerVersion(runningVersion, entry.marker.latest)) return null;
    return entry.marker.latest;
  } catch {
    return null;
  }
}

// ── Snooze (interactive prompting only; never overrides mode=off) ────────────

export function readSnooze(): SnoozeRecord | null {
  let content: string;
  try {
    content = readFileSync(snoozePath(), 'utf8');
  } catch {
    return null;
  }
  const parts = content.trim().split(/\s+/);
  if (parts.length !== 3) return null;
  const version = parts[0];
  const level = Number(parts[1]);
  const ts = Number(parts[2]);
  if (!isValidVersionString(version) || !Number.isInteger(level) || level < 1 || !Number.isFinite(ts)) {
    return null;
  }
  return { version, level, ts };
}

/** Snooze duration for a level (1-indexed; >=3 caps at 7d). */
export function snoozeDurationMs(level: number): number {
  const idx = Math.min(Math.max(level, 1), SNOOZE_DURATIONS_MS.length) - 1;
  return SNOOZE_DURATIONS_MS[idx];
}

/** True iff an unexpired snooze covers `latestVersion`. A snooze for a
 * different (older) version never suppresses a newer one (version-reset). */
export function isSnoozeActive(snooze: SnoozeRecord | null, latestVersion: string, now: number): boolean {
  if (!snooze) return false;
  if (snooze.version !== latestVersion) return false;
  return now - snooze.ts < snoozeDurationMs(snooze.level);
}

/**
 * Record (or escalate) a snooze for `latestVersion`. If the existing snooze is
 * for the same version, escalate its level (capped); otherwise start at level 1.
 * Returns the new level.
 */
export function writeSnooze(latestVersion: string, now: number): number {
  const existing = readSnooze();
  let level = 1;
  if (existing && existing.version === latestVersion) {
    level = Math.min(existing.level + 1, SNOOZE_DURATIONS_MS.length);
  }
  atomicWrite(snoozePath(), `${latestVersion} ${level} ${now}\n`);
  return level;
}

export function clearSnooze(): void {
  try {
    unlinkSync(snoozePath());
  } catch {
    /* already gone */
  }
}

// ── Refresh single-flight (anti-stampede) ────────────────────────────────────

/**
 * Try to acquire the short-lived refresh lock so only ONE detached refresh runs
 * when many invocations see a stale cache at once. Returns the lock path on
 * success (caller must release it), or null if another process holds it.
 * Separate from the upgrade mutex.
 */
export function tryAcquireRefreshLock(opts?: Pick<PackLockOpts, 'now' | 'isPidAlive'>): string | null {
  try {
    const { lockPath } = acquirePackLock('update-refresh', {
      lockDir: locksDir(),
      ttlMs: 30_000,
      ...opts,
    });
    return lockPath;
  } catch {
    return null;
  }
}

export function releaseRefreshLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    /* already gone */
  }
}

// ── Breadcrumb reconciliation (attribution for crash-on-launch) ──────────────

/** The mutable slice of `config.self_upgrade` the autopilot channel manages. */
export interface SelfUpgradeState {
  mode?: SelfUpgradeMode;
  mode_prompted?: boolean;
  quiet_hours?: { start?: number; end?: number; tz?: string };
  failed_versions?: string[];
  attempting_version?: string;
  last_check_ts?: number;
  last_applied_version?: string;
}

export type BreadcrumbTransition = 'applied' | 'failed' | null;

/**
 * Reconcile the pre-swap breadcrumb at daemon boot (the post-swap "doctor gate"
 * via attribution). Called by the relaunched binary:
 *
 *   - No breadcrumb → nothing to do.
 *   - breadcrumb === currentVersion → the swap+relaunch worked. Clear it and
 *     record `last_applied_version`. (`applied`)
 *   - breadcrumb !== currentVersion → we're NOT the attempted version (the new
 *     binary crashed on launch and the supervisor relaunched the old one, or a
 *     stale breadcrumb). Record the attempted version in `failed_versions` so
 *     `decideSelfUpgrade` never retries it, and clear the breadcrumb. (`failed`)
 *
 * Pure: returns the next state + the transition; the caller persists + audits.
 */
export function reconcileBreadcrumb(
  su: SelfUpgradeState | undefined,
  currentVersion: string,
): { state: SelfUpgradeState; transition: BreadcrumbTransition } {
  const state: SelfUpgradeState = { ...(su ?? {}) };
  const attempting = state.attempting_version;
  if (!attempting) return { state, transition: null };

  if (attempting === currentVersion) {
    delete state.attempting_version;
    state.last_applied_version = currentVersion;
    return { state, transition: 'applied' };
  }

  const failed = new Set(state.failed_versions ?? []);
  failed.add(attempting);
  state.failed_versions = [...failed];
  delete state.attempting_version;
  return { state, transition: 'failed' };
}

// ── Mode resolution (file plane; no DB on the hot path) ──────────────────────

function normalizeMode(raw: unknown): SelfUpgradeMode | null {
  if (raw === 'auto' || raw === 'notify' || raw === 'off') return raw;
  return null;
}

/**
 * Resolve the effective mode from env > file-plane config > default `notify`.
 * Takes a loosely-typed config so it doesn't pull the full GBrainConfig type
 * onto the hot path. Env (`GBRAIN_SELF_UPGRADE_MODE`) is the operator / CI
 * escape hatch.
 */
/** The `GBRAIN_SELF_UPGRADE_MODE` override, when it names a valid mode. */
export function selfUpgradeModeEnvOverride(): SelfUpgradeMode | null {
  return normalizeMode(process.env.GBRAIN_SELF_UPGRADE_MODE);
}

export function resolveSelfUpgradeMode(
  cfg: { self_upgrade?: { mode?: string } } | null | undefined,
): SelfUpgradeMode {
  const env = selfUpgradeModeEnvOverride();
  if (env) return env;
  const fromCfg = normalizeMode(cfg?.self_upgrade?.mode);
  if (fromCfg) return fromCfg;
  return 'notify';
}

// ── `gbrain config set self_upgrade.<leaf>` (file plane) ─────────────────────

const QUIET_HOURS_DEFAULT_START = 23;
const QUIET_HOURS_DEFAULT_END = 8;

/** The autopilot silent channel's quiet-hours window: configured bounds, else
 * 23:00-08:00 in the system timezone. `config set self_upgrade.quiet_hours`
 * validates against the same resolution. */
export function resolveQuietHoursWindow(
  qh: SelfUpgradeState['quiet_hours'],
): { start: number; end: number; tz: string } {
  return {
    start: qh?.start ?? QUIET_HOURS_DEFAULT_START,
    end: qh?.end ?? QUIET_HOURS_DEFAULT_END,
    tz: qh?.tz || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  };
}

/** Every `self_upgrade.*` leaf `gbrain config set` accepts. All of them route
 * to ~/.gbrain/config.json: each reader (the cli.ts startup check, the
 * autopilot channel, doctor) reads the file plane only, so a DB-plane write
 * would be accepted and never read (#5489). */
export const SELF_UPGRADE_CONFIG_LEAVES = [
  'mode',
  'mode_prompted',
  'quiet_hours',
  'failed_versions',
  'attempting_version',
  'last_check_ts',
  'last_applied_version',
] as const satisfies readonly (keyof SelfUpgradeState)[];

export type SelfUpgradeConfigLeaf = (typeof SELF_UPGRADE_CONFIG_LEAVES)[number];

export type SelfUpgradeConfigParse =
  | { ok: true; value: SelfUpgradeState[SelfUpgradeConfigLeaf] }
  | { ok: false; error: string };

export function isSelfUpgradeConfigLeaf(leaf: string): leaf is SelfUpgradeConfigLeaf {
  return (SELF_UPGRADE_CONFIG_LEAVES as readonly string[]).includes(leaf);
}

/** Normalize to the 4-segment form (`0.57.1` -> `0.57.1.0`): the upgrade
 * machinery compares stored versions to the 4-segment latest by string, so a
 * shorter spelling would be stored and never match. */
function parseVersionLeaf(raw: string): string | null {
  const tuple = parseSemver(raw.trim());
  return tuple ? tuple.join('.') : null;
}

function isHour(n: unknown): n is number {
  return Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 23;
}

function parseQuietHours(raw: string): SelfUpgradeConfigParse {
  const shape = 'a JSON object like {"start":23,"end":8,"tz":"America/New_York"}';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: `must be ${shape}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: `must be ${shape}` };
  }
  const obj = parsed as Record<string, unknown>;
  const unknownKeys = Object.keys(obj).filter((k) => k !== 'start' && k !== 'end' && k !== 'tz');
  if (unknownKeys.length > 0) {
    return { ok: false, error: `accepts only start, end and tz (got ${unknownKeys.join(', ')})` };
  }
  const out: { start?: number; end?: number; tz?: string } = {};
  for (const k of ['start', 'end'] as const) {
    if (obj[k] === undefined) continue;
    if (!isHour(obj[k])) return { ok: false, error: `${k} must be an integer hour 0-23 (got ${JSON.stringify(obj[k])})` };
    out[k] = obj[k];
  }
  if (obj.tz !== undefined) {
    if (typeof obj.tz !== 'string' || !isValidTimeZone(obj.tz)) {
      return { ok: false, error: `tz must be a valid IANA timezone (got ${JSON.stringify(obj.tz)})` };
    }
    out.tz = obj.tz;
  }
  // Validate what the autopilot reader will evaluate (defaults filled in) with
  // the reader's own rule: a window evaluateQuietHours rejects is no window at
  // all, so auto mode would never find a quiet hour to upgrade in.
  if (!isValidQuietHoursWindow(resolveQuietHoursWindow(out))) {
    return { ok: false, error: `start and end must differ (missing bounds default to ${QUIET_HOURS_DEFAULT_START} and ${QUIET_HOURS_DEFAULT_END})` };
  }
  return { ok: true, value: out };
}

function parseFailedVersions(raw: string): SelfUpgradeConfigParse {
  const trimmed = raw.trim();
  let items: unknown[];
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) throw new Error('not an array');
      items = parsed;
    } catch {
      return { ok: false, error: 'must be a JSON array of versions or a comma-separated list' };
    }
  } else {
    items = trimmed === '' ? [] : trimmed.split(',');
  }
  const versions: string[] = [];
  for (const item of items) {
    const v = typeof item === 'string' ? parseVersionLeaf(item) : null;
    if (!v) return { ok: false, error: `entries must be versions like 0.57.1.0 (got ${JSON.stringify(item)})` };
    if (!versions.includes(v)) versions.push(v);
  }
  return { ok: true, value: versions };
}

/**
 * Parse the raw `gbrain config set self_upgrade.<leaf> <value>` string into
 * the typed value the file-plane readers expect. Refuses anything a reader
 * would silently ignore (an unknown mode reads as `notify`).
 */
export function parseSelfUpgradeConfigValue(leaf: SelfUpgradeConfigLeaf, raw: string): SelfUpgradeConfigParse {
  switch (leaf) {
    case 'mode': {
      const mode = normalizeMode(raw.trim());
      return mode ? { ok: true, value: mode } : { ok: false, error: `must be auto, notify or off (got '${raw}')` };
    }
    case 'mode_prompted': {
      if (isConfigTruthy(raw)) return { ok: true, value: true };
      if (['false', '0', 'no', 'off'].includes(raw.trim().toLowerCase())) return { ok: true, value: false };
      return { ok: false, error: `must be true or false (got '${raw}')` };
    }
    case 'quiet_hours':
      return parseQuietHours(raw);
    case 'failed_versions':
      return parseFailedVersions(raw);
    case 'attempting_version':
    case 'last_applied_version': {
      const v = parseVersionLeaf(raw);
      return v ? { ok: true, value: v } : { ok: false, error: `must be a version like 0.57.1.0 (got '${raw}')` };
    }
    case 'last_check_ts': {
      const t = raw.trim();
      const n = /^\d+$/.test(t) ? Number(t) : NaN;
      return Number.isSafeInteger(n)
        ? { ok: true, value: n }
        : { ok: false, error: `must be epoch milliseconds, an integer >= 0 (got '${raw}')` };
    }
  }
}
