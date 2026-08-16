/**
 * Filesystem coordination points for the autopilot daemon.
 *
 * A LEAF module (imports only `path` + `config`) so other commands can read the
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
import { join } from 'path';
import { gbrainPath } from './config.ts';

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

/**
 * The launchd job label / plist basename (systemd keeps its own unit name).
 *
 * The env override is a TEST SEAM, not a user knob: it exists so the real-launchd
 * lifecycle e2e can load a genuinely unique job on a dev Mac without colliding
 * with — or tearing down — the machine's actual autopilot install. It is read at
 * CALL time, so every invocation touching the same install (install, status,
 * uninstall, the generated wrapper's self-disable) must run with the same value;
 * a mismatched pair reports a false not-installed or misses the plist.
 *
 * The grammar check is load-bearing: the label reaches a plist FILENAME and a
 * double-quoted shell line inside the generated wrapper. `escapeXml` protects
 * only the XML site, so slashes, quotes, whitespace, `$`, backticks, and
 * dot-dot must be rejected here.
 */
export function autopilotLaunchdLabel(): string {
  const label = process.env.GBRAIN_AUTOPILOT_LABEL ?? 'com.gbrain.autopilot';
  if (!/^[A-Za-z0-9._-]+$/.test(label) || label.includes('..')) {
    throw new Error(`invalid GBRAIN_AUTOPILOT_LABEL: ${JSON.stringify(label)}`);
  }
  return label;
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
