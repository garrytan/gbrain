/**
 * Filesystem coordination points for the autopilot daemon.
 *
 * A LEAF module (imports only node builtins + `config`) so other commands can read the
 * daemon's state files WITHOUT importing `src/commands/autopilot.ts`.
 *
 * Why that matters concretely: the CLI flag-registry generator follows a
 * command's dynamic `import('./x.ts')` one level deep and harvests every flag
 * literal it finds. A single `await import()` of the autopilot command module inside
 * `migrate-engine.ts` therefore folded autopilot's ENTIRE flag surface (install,
 * uninstall, interval, no-worker, status, repo, ...) into the migrate command's
 * accepted-flag allowlist, which would have made `gbrain migrate` silently
 * accept and ignore any of them. Pinned by `test/cli-flag-validation.test.ts`.
 *
 * Flag names appear here WITHOUT leading dashes on purpose — the generator
 * scans comments too, so writing them literally recreates the very bug this
 * comment describes.
 *
 * Everything here resolves through `gbrainPath` (NOT raw `process.env.HOME`)
 * because that is where the daemon itself writes; a `GBRAIN_HOME` install
 * otherwise has readers looking in a different directory than the writer.
 */
import { existsSync, linkSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { randomBytes } from 'crypto';
import { configDir, gbrainPath } from './config.ts';

/**
 * The daemon's lock file. Its mtime IS the liveness heartbeat — the tick loop
 * refreshes it every pass — so "is autopilot alive?" is `now - mtime` against
 * the expected interval, with no scheduler probing required.
 */
export function autopilotLockPath(): string {
  return gbrainPath('autopilot.lock');
}

/**
 * Written by the generated wrapper when it self-disables (its captured repo path
 * is gone). Read by the status command so a stopped daemon explains itself
 * instead of looking merely idle.
 */
export function autopilotDisabledMarkerPath(): string {
  return join(gbrainPath(), 'autopilot-disabled');
}

/** The pre-#5195 shared job names, still used by the default brain. */
export const DEFAULT_AUTOPILOT_LAUNCHD_LABEL = 'com.gbrain.autopilot';
export const DEFAULT_AUTOPILOT_SYSTEMD_UNIT = 'gbrain-autopilot.service';

/**
 * The launchd job label / plist basename. `suffix` names a non-default brain's
 * own job (#5195); the default brain keeps the shared label.
 *
 * The env override is a TEST SEAM, not a user knob: it exists so the real-launchd
 * lifecycle e2e can load a genuinely unique job on a dev Mac without colliding
 * with — or tearing down — the machine's actual autopilot install. It is read at
 * CALL time and wins over the per-brain suffix, so every invocation touching the
 * same install (install, status, uninstall, the generated wrapper's self-disable)
 * must run with the same value; a mismatched pair reports a false not-installed
 * or misses the plist.
 *
 * The grammar check is load-bearing: the label reaches a plist FILENAME and a
 * double-quoted shell line inside the generated wrapper. `escapeXml` protects
 * only the XML site, so slashes, quotes, whitespace, `$`, backticks, and
 * dot-dot must be rejected here.
 */
export function autopilotLaunchdLabel(suffix: string | null = null): string {
  const label = process.env.GBRAIN_AUTOPILOT_LABEL
    ?? (suffix ? `${DEFAULT_AUTOPILOT_LAUNCHD_LABEL}.${suffix}` : DEFAULT_AUTOPILOT_LAUNCHD_LABEL);
  if (!/^[A-Za-z0-9._-]+$/.test(label) || label.includes('..')) {
    throw new Error(`invalid GBRAIN_AUTOPILOT_LABEL: ${JSON.stringify(label)}`);
  }
  return label;
}

/** realpath, or `resolve` for a directory that does not exist yet (ENG-O11). */
export function canonicalDir(path: string): string {
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- canonicalizes the operator's own brain home for the install-id record; no fs write
  try { return realpathSync(path); } catch { return resolve(path); }
}

/**
 * #5195: the default brain is the one at `~/.gbrain` (GBRAIN_HOME unset, or
 * pointing at the user's home). It keeps the shared job names so existing
 * installs need no migration; every other brain gets its own job.
 */
export function isDefaultBrainHome(): boolean {
  return canonicalDir(configDir()) === canonicalDir(join(homedir(), '.gbrain'));
}

/** Where a non-default brain records the random id its job names derive from. */
export function autopilotInstallIdPath(): string {
  return gbrainPath('autopilot-install-id');
}

interface InstallIdRecord { id: string; realpath: string; created_at: string }

function readInstallIdRecord(): InstallIdRecord | null {
  try {
    const rec = JSON.parse(readFileSync(autopilotInstallIdPath(), 'utf-8')) as Partial<InstallIdRecord>;
    if (typeof rec.id !== 'string' || !/^[0-9a-f]{8,64}$/.test(rec.id)) return null;
    if (typeof rec.realpath !== 'string' || !rec.realpath) return null;
    return { id: rec.id, realpath: rec.realpath, created_at: typeof rec.created_at === 'string' ? rec.created_at : '' };
  } catch {
    return null;
  }
}

/**
 * Read-only view of this brain's install id (T4, ENG-O11). The record names the
 * directory it was written for, because a copied brain carries the file along:
 *   - same     — recorded for this directory;
 *   - moved    — the recorded directory no longer exists, so this brain is it,
 *                moved or renamed (the id, and the job, carry over);
 *   - copied   — the recorded directory still exists elsewhere, so this is a
 *                copy that has not installed its own job yet;
 *   - none     — never installed.
 */
export function resolveAutopilotInstallId():
  | { relation: 'same' | 'moved'; id: string; recordedPath: string }
  | { relation: 'copied' | 'none'; id: null; recordedPath: string | null } {
  const rec = readInstallIdRecord();
  if (!rec) return { relation: 'none', id: null, recordedPath: null };
  if (rec.realpath === canonicalDir(configDir())) return { relation: 'same', id: rec.id, recordedPath: rec.realpath };
  if (!existsSync(rec.realpath)) return { relation: 'moved', id: rec.id, recordedPath: rec.realpath };
  return { relation: 'copied', id: null, recordedPath: rec.realpath };
}

function writeRecordExclusive(path: string, rec: InstallIdRecord): boolean {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(rec) + '\n', { mode: 0o644 });
  try {
    linkSync(tmp, path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    try {
      writeFileSync(path, JSON.stringify(rec) + '\n', { flag: 'wx', mode: 0o644 });
      return true;
    } catch (e2) {
      if ((e2 as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw e2;
    }
  } finally {
    try { unlinkSync(tmp); } catch { /* already gone */ }
  }
}

function replaceRecord(path: string, rec: InstallIdRecord): void {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(rec) + '\n', { mode: 0o644 });
  renameSync(tmp, path);
}

/**
 * One installer at a time decides a move or a copy: without it two installers
 * of a freshly copied brain could each mint an id, and the one whose record
 * lost would leave a job nobody can find. A crashed holder's lock is broken
 * after 30 seconds.
 */
function withInstallIdLock<T>(fn: () => T): T {
  const lock = `${autopilotInstallIdPath()}.lock`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try { if (Date.now() - statSync(lock).mtimeMs > 30_000) { rmdirSync(lock); continue; } } catch { continue; }
      if (Date.now() > deadline) throw new Error(`another autopilot install holds ${lock}; retry when it finishes`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try { return fn(); } finally { try { rmdirSync(lock); } catch { /* already gone */ } }
}

/**
 * The install id for this brain, minting or re-homing it as ENG-O11 describes.
 * The first record is created exclusively, so concurrent first installs agree on
 * one id; a move keeps the id and records the new directory; a copy mints its
 * own id so the original brain's job is never taken over. Moves and copies are
 * decided under a lock, so concurrent installers settle on one id.
 */
export function ensureAutopilotInstallId(): string {
  mkdirSync(configDir(), { recursive: true });
  const path = autopilotInstallIdPath();
  const here = canonicalDir(configDir());
  const current = resolveAutopilotInstallId();
  if (current.relation === 'same') return current.id;
  if (current.relation === 'none') {
    const fresh = { id: randomBytes(16).toString('hex'), realpath: here, created_at: new Date().toISOString() };
    if (writeRecordExclusive(path, fresh)) return fresh.id;
  }
  return withInstallIdLock(() => {
    const locked = resolveAutopilotInstallId();
    if (locked.relation === 'same') return locked.id;
    if (locked.relation === 'moved') {
      replaceRecord(path, { id: locked.id, realpath: here, created_at: readInstallIdRecord()?.created_at || new Date().toISOString() });
      return locked.id;
    }
    const fresh = { id: randomBytes(16).toString('hex'), realpath: here, created_at: new Date().toISOString() };
    replaceRecord(path, fresh);
    return fresh.id;
  });
}

/**
 * Every name one brain's autopilot job uses (#5195). The default brain keeps the
 * shared pre-#5195 names; any other brain gets `<name>-<suffix>` names, where the
 * suffix is the first 8 hex characters of its install id. `unassigned` is a
 * non-default brain that has no id yet (never installed, or an uninstalled
 * copy): it owns no named job, and its names are the shared ones only so the
 * pure generators have something to print.
 */
export interface AutopilotJob {
  kind: 'default' | 'suffixed' | 'unassigned';
  suffix: string | null;
  launchdLabel: string;
  systemdUnit: string;
  /** Ephemeral-container start script, under the brain's own home. */
  startScriptPath: string;
  /** Trailing crontab comment that marks this brain's line; null for the default brain. */
  cronMarker: string | null;
  wrapperPath: string;
  logPath: string;
  errPath: string;
  installIdPath: string | null;
  /** configDir() at resolution time. */
  homeDir: string;
}

export function resolveAutopilotJob(opts: { mint?: boolean } = {}): AutopilotJob {
  const homeDir = configDir();
  let kind: AutopilotJob['kind'] = 'default';
  let suffix: string | null = null;
  if (!isDefaultBrainHome()) {
    const id = opts.mint ? ensureAutopilotInstallId() : resolveAutopilotInstallId().id;
    suffix = id ? id.slice(0, 8) : null;
    kind = suffix ? 'suffixed' : 'unassigned';
  }
  return {
    kind,
    suffix,
    launchdLabel: autopilotLaunchdLabel(suffix),
    systemdUnit: suffix ? `gbrain-autopilot-${suffix}.service` : DEFAULT_AUTOPILOT_SYSTEMD_UNIT,
    startScriptPath: join(homeDir, suffix ? `start-autopilot-${suffix}.sh` : 'start-autopilot.sh'),
    cronMarker: suffix ? `# gbrain-autopilot:${suffix}` : null,
    wrapperPath: join(homeDir, 'autopilot-run.sh'),
    logPath: join(homeDir, 'autopilot.log'),
    errPath: join(homeDir, 'autopilot.err'),
    installIdPath: kind === 'default' ? null : autopilotInstallIdPath(),
    homeDir,
  };
}

/**
 * Who a job definition belongs to, judged by the wrapper path it runs (the
 * wrapper always lives at `<brain home>/autopilot-run.sh`):
 *   - own      — this brain's wrapper;
 *   - dangling — a wrapper that no longer exists (a moved or deleted brain);
 *   - other    — a live wrapper of another brain (`home` is that brain's dir);
 *   - unknown  — the definition names no wrapper.
 */
export function autopilotWrapperOwner(
  wrapperPath: string | null,
  homeDir: string = configDir(),
): { owner: 'own' | 'dangling' | 'unknown' } | { owner: 'other'; home: string } {
  if (!wrapperPath) return { owner: 'unknown' };
  const dir = dirname(wrapperPath);
  if (canonicalDir(dir) === canonicalDir(homeDir)) return { owner: 'own' };
  if (!existsSync(wrapperPath)) return { owner: 'dangling' };
  return { owner: 'other', home: dir };
}

/**
 * Cooperative pause. While present the tick loop keeps heartbeating but does no
 * work. `gbrain migrate` uses it to quiesce the daemon for the
 * duration of a cross-engine copy, so the daemon cannot keep writing into an
 * engine that is about to stop being the configured one.
 *
 * A marker rather than stopping the supervisor: ephemeral-container installs
 * have no supervisor to restart afterwards, a crash mid-migration leaves a
 * removable file rather than an uninstalled daemon, and it is one code path
 * across launchd / systemd / cron / container.
 */
export function autopilotPausedMarkerPath(): string {
  return join(gbrainPath(), 'autopilot-paused');
}

/**
 * Consecutive-miss counter for the wrapper's self-disable guard. A repo on an
 * external volume, NFS, or a cloud-synced folder is routinely absent for the
 * first daemon launch after login, and a single missed probe must not
 * permanently take the install out of rotation — the guard requires several
 * consecutive strikes before disabling, and any successful probe resets this
 * file.
 */
export function autopilotDisableStrikesPath(): string {
  return join(gbrainPath(), 'autopilot-disable-strikes');
}

/**
 * First line of every pause marker written by `gbrain migrate` — the ownership
 * signature that separates a migrate-owned pause (safe to adopt when its pid
 * is dead) from an operator's manual hold (never touched).
 */
export const MIGRATE_PAUSE_MARKER_PREFIX = 'paused by gbrain migrate';

/**
 * Is the pid recorded in a pause-marker body still a live process?
 * ESRCH = provably dead. EPERM = exists but owned by another user: alive.
 * No parseable pid = unknown (treat as a foreign hold; adoption needs proof).
 */
export function markerHolderAlive(body: string): 'alive' | 'dead' | 'unknown' {
  const m = /\(pid (\d+)\)/.exec(body);
  if (!m) return 'unknown';
  try {
    process.kill(Number(m[1]), 0);
    return 'alive';
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'ESRCH' ? 'dead' : 'alive';
  }
}

/**
 * The operator's own pause (the autopilot pause subcommand), kept apart from
 * the migration/restore hold above: installing autopilot and upgrading gbrain
 * clear a leaked migration hold but never this marker, and resuming clears
 * only this marker, never a live migration's hold.
 */
export function autopilotOperatorPauseMarkerPath(): string {
  return join(gbrainPath(), 'autopilot-operator-paused');
}

/** True while either pause marker is present; the daemon and workers do no new work. */
export function autopilotPaused(): boolean {
  return existsSync(autopilotOperatorPauseMarkerPath()) || existsSync(autopilotPausedMarkerPath());
}

/** The recorded reason for the active pause (the operator pause first), or null. */
export function autopilotPauseReason(): string | null {
  for (const path of [autopilotOperatorPauseMarkerPath(), autopilotPausedMarkerPath()]) {
    try { return readFileSync(path, 'utf-8').trim() || 'pause marker present (no reason recorded)'; } catch { /* not present */ }
  }
  return null;
}
