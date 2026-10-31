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
 *   - cache helpers — one file per release channel stamped with its evidence
 *     policy; atomic temp+rename writes, strict parse, mtime-TTL.
 *   - snooze helpers — per channel, time-based, escalating 24h/48h/7d.
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
import { gbrainPath, isConfigTruthy, loadConfigFileOnly } from './config.ts';
import { isValidTimeZone } from './cycle/cycle-date.ts';
import { isValidConfig as isValidQuietHoursWindow } from './minions/quiet-hours.ts';
import { evaluateBunFloor, type HostBun, type TargetFloor } from './bun-floor.ts';
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

/**
 * The release line an install follows (GBRA-224 W1). `stable` (the default) is the newest release a maintainer
 * promoted after its gates passed on the exact tree, published with an evidence record (core/stable-channel.ts);
 * `alpha` is every published release (the `latest-stable` tag release.yml advances). `latest` is accepted
 * everywhere as an alias for alpha. Precedence: `--channel`, then GBRAIN_RELEASE_CHANNEL, then
 * `self_upgrade.channel` (file plane), then stable.
 */
export type ReleaseChannel = 'stable' | 'alpha';
export const RELEASE_CHANNELS: readonly ReleaseChannel[] = ['stable', 'alpha'];
export const DEFAULT_RELEASE_CHANNEL: ReleaseChannel = 'stable';
export const RELEASE_CHANNEL_ENV = 'GBRAIN_RELEASE_CHANNEL';
export const VALID_CHANNELS_TEXT = 'stable or alpha (latest is an alias for alpha)';

export function normalizeChannel(raw: unknown): ReleaseChannel | null {
  if (typeof raw !== 'string') return null;
  if (raw === 'stable') return 'stable';
  return raw === 'alpha' || raw === 'latest' ? 'alpha' : null;
}

export type ChannelSource = 'flag' | 'env' | 'config' | 'default';
export type ChannelResolution =
  | { ok: true; channel: ReleaseChannel; source: ChannelSource }
  | { ok: false; source: Exclude<ChannelSource, 'default'>; raw: string };

/**
 * The effective channel and where it came from. `flag` is the raw `--channel` value (null when absent, '' when the
 * flag had no value). The first source present decides; an invalid value there is an error, never a fallthrough.
 */
export function resolveReleaseChannel(
  cfg: { self_upgrade?: { channel?: string } } | null | undefined,
  flag: string | null = null,
  env: string | undefined = process.env[RELEASE_CHANNEL_ENV],
): ChannelResolution {
  const sources: Array<[Exclude<ChannelSource, 'default'>, string | null | undefined]> = [
    ['flag', flag],
    ['env', env === '' ? undefined : env],
    ['config', cfg?.self_upgrade?.channel],
  ];
  for (const [source, raw] of sources) {
    if (raw === null || raw === undefined) continue;
    const channel = normalizeChannel(raw);
    return channel ? { ok: true, channel, source } : { ok: false, source, raw: String(raw) };
  }
  return { ok: true, channel: DEFAULT_RELEASE_CHANNEL, source: 'default' };
}

/** The hot-path channel (env and file-plane config, no flag); null when the value there is invalid. */
export function currentReleaseChannel(): ReleaseChannel | null {
  const res = resolveReleaseChannel(loadConfigFileOnly());
  return res.ok ? res.channel : null;
}

/** The command that moves this install to `target`, rendered against what currently decides the channel. */
export function channelSwitchCommand(target: ReleaseChannel, res: ChannelResolution): string {
  if (res.source === 'flag') return `gbrain upgrade --channel ${target}`;
  if (res.source === 'env') return `${RELEASE_CHANNEL_ENV}=${target} (it overrides self_upgrade.channel), or unset ${RELEASE_CHANNEL_ENV} and run gbrain config set self_upgrade.channel ${target}`;
  return `gbrain config set self_upgrade.channel ${target}`;
}

/** A usage-error sentence for an invalid channel value. */
export function invalidChannelMessage(res: Extract<ChannelResolution, { ok: false }>): string {
  const where = res.source === 'flag' ? '--channel' : res.source === 'env' ? RELEASE_CHANNEL_ENV : 'self_upgrade.channel';
  return `${where} is '${res.raw}', which is not a release channel; use ${VALID_CHANNELS_TEXT}.`;
}

/**
 * The evidence policy a cached stable answer was validated under. A record whose version is at or above
 * MATRIX_REQUIRED_FROM must carry `matrix_run` as well as `soak_run`; null until the upgrade matrix (W2) ships, so
 * every generation-1 record (soak evidence only) stays valid. Changing either changes the policy id, which
 * invalidates cached stable answers.
 */
export const MATRIX_REQUIRED_FROM: string | null = null;
export const STABLE_EVIDENCE_POLICY = `stable-record-v1;matrix-from=${MATRIX_REQUIRED_FROM ?? 'none'}`;
export const ALPHA_EVIDENCE_POLICY = 'alpha-version-file-v1';
export function evidencePolicyFor(channel: ReleaseChannel): string {
  return channel === 'stable' ? STABLE_EVIDENCE_POLICY : ALPHA_EVIDENCE_POLICY;
}

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
  | 'unsupported_runtime'
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
  /** Epoch ms when it ends. */
  until: number;
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
 * Runtime gate for an `apply` on an install that runs the target on the host's
 * Bun (every method but `binary`, which carries its own runtime). Holds the
 * upgrade when the target's `engines.bun` floor is above the host's Bun, or
 * when either could not be read: once swapped, every command refuses at
 * startup (the relaunched daemon included, before it can reconcile the
 * breadcrumb) and an unattended host has nothing that upgrades Bun (#5855).
 * The target is NOT recorded known-bad, so the first tick after the cause
 * clears applies it. #6828: the version the install would actually get (a
 * bun-link clone follows master, a moving tag can pass the checked version)
 * is also checked against `failedVersions`, so a release recorded known-bad
 * under its installed version is not reinstalled while the check names
 * another one. Pure.
 */
export function gateOnTargetRuntime(
  decision: SelfUpgradeDecision,
  target: TargetFloor,
  host: HostBun | null,
  failedVersions: readonly string[] = [],
): SelfUpgradeDecision {
  if (decision.action !== 'apply') return decision;
  if (target.version && target.version !== decision.latest && failedVersions.includes(target.version)) {
    return { ...decision, action: 'known_bad', reason: `the install would get ${target.version}, which previously failed; not retrying` };
  }
  const verdict = evaluateBunFloor(target, host, decision.latest);
  if (verdict.ok) return decision;
  const retry = verdict.kind === 'unreadable' ? ' The next quiet-hours tick retries.' : '';
  return { ...decision, action: 'unsupported_runtime', reason: `${verdict.auditReason}${retry}` };
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

/** Files from before the cache was partitioned by channel (GBRA-224): never read, removed on clear. */
const LEGACY_CACHE_FILE = 'last-update-check';
const LEGACY_SNOOZE_FILE = 'update-snoozed';

/** The update-check cache for one channel (default: the hot-path channel; stable when that is invalid). */
export function updateCachePath(channel: ReleaseChannel = currentReleaseChannel() ?? DEFAULT_RELEASE_CHANNEL): string {
  return gbrainPath(`update-check.${channel}.json`);
}

/** The "Not now" snooze for one channel. */
export function snoozePath(channel: ReleaseChannel = currentReleaseChannel() ?? DEFAULT_RELEASE_CHANNEL): string {
  return gbrainPath(`update-snoozed.${channel}.json`);
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

/** A stable lookup that failed, kept so doctor and --check-only can report it without a network call. */
export interface StableLookupError {
  code: 'stable_missing' | 'stable_invalid' | 'stable_unreadable';
  cause: string;
}

/**
 * One channel's cached answer. Partitioned by channel (one file each) and stamped with the evidence policy it was
 * validated under, so a channel switch, a default flip or a policy change never reads another partition's answer.
 * `latest` is the channel's release (on stable, the evidence record's version, which can be below the running build);
 * `knownBad` is the record's withdrawn list; `error` is set when the last stable lookup failed.
 */
export interface CacheEntry {
  marker: UpdateMarker | null;
  mtimeMs: number;
  channel: ReleaseChannel;
  policy: string;
  checkedAt: number;
  latest: string | null;
  knownBad: string[];
  error: StableLookupError | null;
}

export interface CacheWriteOptions {
  channel?: ReleaseChannel;
  /** The channel's release when it differs from the marker's (a stable record below the running build). */
  latest?: string | null;
  knownBad?: readonly string[];
  error?: StableLookupError | null;
  /** When the refresh that produced this answer started; an older answer never overwrites a newer one. */
  checkedAt?: number;
}

const STABLE_CODES = new Set(['stable_missing', 'stable_invalid', 'stable_unreadable']);

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

function unlinkQuiet(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
}

/**
 * Read + strict-parse one channel's cache. Null on missing, corrupt, another channel's or another evidence policy's
 * entry (a legacy unpartitioned file is never read).
 */
export function readUpdateCache(channel: ReleaseChannel | null = currentReleaseChannel()): CacheEntry | null {
  if (!channel) return null;
  const path = updateCachePath(channel);
  let raw: Record<string, unknown>;
  let mtimeMs: number;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || raw.schema !== 2) return null;
  if (raw.channel !== channel || raw.policy !== evidencePolicyFor(channel)) return null;
  const marker = raw.marker === null ? null : parseMarker(String(raw.marker ?? ''));
  if (raw.marker !== null && !marker) return null;
  const latest = typeof raw.latest === 'string' && isValidVersionString(raw.latest) ? raw.latest : null;
  const knownBad = Array.isArray(raw.known_bad) ? raw.known_bad.filter((v): v is string => typeof v === 'string' && isValidVersionString(v)) : [];
  const e = raw.error as { code?: unknown; cause?: unknown } | null | undefined;
  const error = e && typeof e === 'object' && typeof e.code === 'string' && STABLE_CODES.has(e.code)
    ? { code: e.code as StableLookupError['code'], cause: typeof e.cause === 'string' ? e.cause.slice(0, 300) : '' }
    : null;
  if (!marker && !error) return null;
  const checkedAt = typeof raw.checked_at === 'number' && Number.isFinite(raw.checked_at) ? raw.checked_at : mtimeMs;
  return { marker, mtimeMs, channel, policy: raw.policy as string, checkedAt, latest: latest ?? marker?.latest ?? null, knownBad, error };
}

/**
 * Atomically write one channel's cache (0600). A refresh that started before the stored answer's refresh never
 * overwrites it (reversed completion). Best-effort: throws only on truly unexpected fs errors.
 */
export function writeUpdateCache(marker: UpdateMarker | null, opts: CacheWriteOptions = {}): void {
  const channel = opts.channel ?? currentReleaseChannel() ?? DEFAULT_RELEASE_CHANNEL;
  const checkedAt = opts.checkedAt ?? Date.now();
  const prior = readUpdateCache(channel);
  if (prior && prior.checkedAt > checkedAt) return;
  atomicWrite(updateCachePath(channel), JSON.stringify({
    schema: 2,
    channel,
    policy: evidencePolicyFor(channel),
    checked_at: checkedAt,
    marker: marker ? formatMarker(marker) : null,
    latest: opts.latest === undefined ? marker?.latest ?? null : opts.latest,
    known_bad: [...(opts.knownBad ?? [])],
    error: opts.error ?? null,
  }) + '\n');
  unlinkQuiet(gbrainPath(LEGACY_CACHE_FILE));
}

/** Clear every channel's cache (e.g. after a successful upgrade) so the next run re-checks. */
export function clearUpdateCache(): void {
  for (const channel of RELEASE_CHANNELS) unlinkQuiet(updateCachePath(channel));
  unlinkQuiet(gbrainPath(LEGACY_CACHE_FILE));
}

export function isCacheFresh(entry: CacheEntry, now: number): boolean {
  const ttl = entry.marker?.kind === 'upgrade_available' && !entry.error ? CACHE_TTL_UPGRADE_AVAILABLE_MS : CACHE_TTL_UP_TO_DATE_MS;
  return now - entry.mtimeMs < ttl;
}

/**
 * The release a channel offers this build: its release when strictly newer, or, on stable, the current stable when
 * the running version is on the record's known_bad list (the one move below the running build the channel makes,
 * because the record says so). Null otherwise. Pure.
 */
export function offeredVersion(runningVersion: string, latest: string | null, knownBad: readonly string[]): string | null {
  if (!latest || !isValidVersionString(latest)) return null;
  if (isNewerVersion(runningVersion, latest)) return latest;
  return knownBad.includes(runningVersion) && latest !== runningVersion ? latest : null;
}

/**
 * The one shared "is an upgrade actually pending for THIS binary?" predicate.
 * Returns the offered version (offeredVersion) when the effective channel's cache is present and fresh — else
 * null. The running-version comparison is the load-bearing part: the cache
 * records the version of whatever binary WROTE it (an older gbrain on PATH can
 * write it via the detached refresh), so consumers must never trust
 * `marker.current` to describe themselves. Every upgrade-nag surface (CLI
 * startup marker, doctor, advisor, get_brain_identity) routes through here so
 * the suppression rule cannot drift per-surface. Never throws.
 */
export function pendingUpgradeVersion(runningVersion: string, now: number = Date.now(), channel: ReleaseChannel | null = currentReleaseChannel()): string | null {
  try {
    const entry = readUpdateCache(channel);
    if (!entry || !isCacheFresh(entry, now)) return null;
    if (entry.error?.code === 'stable_missing' || entry.error?.code === 'stable_invalid') return null;
    return offeredVersion(runningVersion, entry.latest, entry.knownBad);
  } catch {
    return null;
  }
}

// ── Snooze (interactive prompting only; never overrides mode=off) ────────────

/**
 * Read one channel's snooze. A snooze is time-based: "Not now" holds until `until` whatever the channel ships
 * meanwhile; `version` is what was offered when it was written (a rollback below it ends the snooze).
 */
export function readSnooze(channel: ReleaseChannel = currentReleaseChannel() ?? DEFAULT_RELEASE_CHANNEL): SnoozeRecord | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(snoozePath(channel), 'utf8'));
  } catch {
    return null;
  }
  const { version, level, ts, until } = raw ?? {};
  if (typeof version !== 'string' || !isValidVersionString(version)) return null;
  if (!Number.isInteger(level) || (level as number) < 1 || !Number.isFinite(ts) || !Number.isFinite(until)) return null;
  return { version, level: level as number, ts: ts as number, until: until as number };
}

/** Snooze duration for a level (1-indexed; >=3 caps at 7d). */
export function snoozeDurationMs(level: number): number {
  const idx = Math.min(Math.max(level, 1), SNOOZE_DURATIONS_MS.length) - 1;
  return SNOOZE_DURATIONS_MS[idx];
}

/**
 * True iff an unexpired snooze covers an offer of `offered`. Newer releases never end it (it is time-based); an
 * offer below the snoozed version (a stable rollback) does.
 */
export function isSnoozeActive(snooze: SnoozeRecord | null, offered: string, now: number): boolean {
  if (!snooze || now >= snooze.until) return false;
  return !isNewerVersion(offered, snooze.version);
}

/**
 * Whether the channel's snooze holds back an offer of `offered`. A snooze the offer rolled back below is cleared,
 * so the rolled-back release is offered at once.
 */
export function snoozeHolds(offered: string, now: number, channel: ReleaseChannel = currentReleaseChannel() ?? DEFAULT_RELEASE_CHANNEL): boolean {
  const snooze = readSnooze(channel);
  if (snooze && isNewerVersion(offered, snooze.version)) {
    clearSnooze(channel);
    return false;
  }
  return isSnoozeActive(snooze, offered, now);
}

/**
 * Record (or escalate) "Not now" on a channel: level 1 (24 h), then 48 h, then 7 d for each later "Not now" until an
 * upgrade clears it. Written atomically. Returns the new record.
 */
export function writeSnooze(offered: string, now: number, channel: ReleaseChannel = currentReleaseChannel() ?? DEFAULT_RELEASE_CHANNEL): SnoozeRecord {
  const existing = readSnooze(channel);
  const level = existing ? Math.min(existing.level + 1, SNOOZE_DURATIONS_MS.length) : 1;
  const record = { version: offered, level, ts: now, until: now + snoozeDurationMs(level) };
  atomicWrite(snoozePath(channel), JSON.stringify(record) + '\n');
  return record;
}

/** Clear one channel's snooze, or every channel's (after an upgrade). */
export function clearSnooze(channel?: ReleaseChannel): void {
  for (const c of channel ? [channel] : RELEASE_CHANNELS) unlinkQuiet(snoozePath(c));
  if (!channel) unlinkQuiet(gbrainPath(LEGACY_SNOOZE_FILE));
}

// ── Refresh single-flight (anti-stampede) ────────────────────────────────────

/**
 * Try to acquire the short-lived refresh lock so only ONE detached refresh runs
 * when many invocations see a stale cache at once. Returns the lock path on
 * success (caller must release it), or null if another process holds it.
 * Separate from the upgrade mutex.
 */
export function tryAcquireRefreshLock(opts?: Pick<PackLockOpts, 'now' | 'isPidAlive'>, channel: ReleaseChannel = currentReleaseChannel() ?? DEFAULT_RELEASE_CHANNEL): string | null {
  try {
    const { lockPath } = acquirePackLock(`update-refresh-${channel}`, {
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

// ── Swap receipt (what `gbrain upgrade --swap-only` actually installed) ──────

/**
 * #6828: the autopilot channel names a file in this env var; `gbrain upgrade`
 * writes what its swap installed there. Exit 0 alone cannot tell a swap from
 * a no-op (`bun update` on a tag whose head is already installed exits 0 and
 * changes nothing), and a no-op must never relaunch or record known-bad.
 */
export const SWAP_RECEIPT_ENV = 'GBRAIN_SWAP_RECEIPT';

/**
 * - `installed`: a newer version is on disk and passed the post-swap smoke.
 * - `not_installed`: the version did not change (the install step failed, or
 *   succeeded without installing anything newer).
 * - `installed_broken`: a newer version is on disk and does not start.
 */
export interface SwapReceipt {
  outcome: 'installed' | 'not_installed' | 'installed_broken';
  from: string;
  /** What `gbrain --version` reported after the swap; null when unreadable. */
  installed: string | null;
}

/** Write the receipt when the caller asked for one. Best-effort. */
export function writeSwapReceipt(receipt: SwapReceipt): void {
  const path = process.env[SWAP_RECEIPT_ENV];
  if (!path) return;
  try {
    atomicWrite(path, JSON.stringify(receipt) + '\n');
  } catch {
    /* the channel falls back to the exit status */
  }
}

/** Read a receipt; null when missing or malformed (the channel then trusts the exit status). */
export function readSwapReceipt(path: string): SwapReceipt | null {
  try {
    const r = JSON.parse(readFileSync(path, 'utf8')) as Partial<SwapReceipt>;
    if (r.outcome !== 'installed' && r.outcome !== 'not_installed' && r.outcome !== 'installed_broken') return null;
    if (typeof r.from !== 'string') return null;
    const installed = typeof r.installed === 'string' && isValidVersionString(r.installed) ? r.installed : null;
    return { outcome: r.outcome, from: r.from, installed };
  } catch {
    return null;
  }
}

// ── Breadcrumb reconciliation (attribution for crash-on-launch) ──────────────

/** The mutable slice of `config.self_upgrade` the autopilot channel manages. */
export interface SelfUpgradeState {
  mode?: SelfUpgradeMode;
  /** Stored as written; `latest` (the pre-alpha name) reads as alpha. */
  channel?: ReleaseChannel | 'latest';
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
 *   - currentVersion >= breadcrumb → the swap+relaunch worked. The swap
 *     installs whatever is current at swap time (`git pull`, `bun update`,
 *     `releases/latest`), so a release published after the update check lands
 *     a NEWER version than the breadcrumb names (#5813). Clear it, record
 *     `last_applied_version`, and drop `failed_versions` entries at or below
 *     the running version: `decideSelfUpgrade` only acts on a strictly newer
 *     release, so they can never be targeted again. (`applied`)
 *   - otherwise → we're NOT at the attempted version (the new binary crashed
 *     on launch and the supervisor relaunched the old one, or a stale
 *     breadcrumb, or an unparseable version). Record the attempted version in
 *     `failed_versions` so `decideSelfUpgrade` never retries it, and clear the
 *     breadcrumb. (`failed`)
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

  const running = parseSemver(currentVersion);
  const attempted = parseSemver(attempting);
  if (attempting === currentVersion || (running && attempted && semverLte(attempted, running))) {
    delete state.attempting_version;
    state.last_applied_version = currentVersion;
    if (state.failed_versions) {
      // Unparseable entries stay: there is no ordering to prove them superseded.
      const stillBad = state.failed_versions.filter((v) => {
        const t = parseSemver(v);
        return !t || !running || semverGt(t, running);
      });
      if (stillBad.length > 0) state.failed_versions = stillBad;
      else delete state.failed_versions;
    }
    return { state, transition: 'applied' };
  }

  const failed = new Set(state.failed_versions ?? []);
  failed.add(attempting);
  state.failed_versions = [...failed];
  delete state.attempting_version;
  return { state, transition: 'failed' };
}

/** The audit reason the boot reconcile writes when it records a version known-bad (core/self-upgrade-recovery.ts matches on it, #6828). */
export const CRASH_ON_LAUNCH_REASON_PREFIX = 'crash-on-launch:';
/** The audit reason the channel writes when its swap installed a newer version and it exits for relaunch. */
export const SWAPPED_REASON = 'swapped; exiting for supervisor relaunch';

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
  'channel',
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
    case 'channel': {
      const value = raw.trim();
      return normalizeChannel(value) ? { ok: true, value } : { ok: false, error: `must be ${VALID_CHANNELS_TEXT} (got '${raw}')` };
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
