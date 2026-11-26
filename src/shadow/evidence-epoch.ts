/**
 * The evidence epoch (plan decision 1, review F3; docs/designs/RUST_ENGINE.md "Evidence epochs"): the identity of the
 * candidate whose evidence readiness counts. It is NOT the seed id. `<shadow dir>/evidence/epoch.json` holds the seed
 * id, the Rust addon's SHA-256, the comparator version, the adapter version, a hash of the capability set and the
 * hash of the approved readiness policy. The child (child.ts) opens a new epoch when any of them differs from the
 * manifest; an unrelated release with identical inputs does not. Ledger rows, usage lines and `rust_internal_error`
 * faults carry the epoch id of the child that wrote them, and the status counts only rows of the current epoch, so a
 * new epoch starts every count over. Earlier manifests are kept in `evidence/epochs.jsonl`.
 *
 * The epoch id is a hash of the inputs and of the epoch it replaces, so children that open the same new epoch
 * concurrently agree on it, and a return to earlier inputs is still a new epoch (it must not revive old rows).
 */
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { detectAddonTarget } from '../core/rust-engine/addon-target.ts';
import { VERSION } from '../version.ts';
import { appendFault, type ShadowFault } from './ledger.ts';

export interface EpochInputs {
  seed_id: string;
  /** Null when no addon loaded: the evidence of an unavailable addon is its own epoch. */
  rust_addon_sha256: string | null;
  comparator_version: number;
  adapter_version: string;
  capability_set_hash: string | null;
  readiness_policy_hash: string;
}

/** The build that opened the epoch. Recorded once and never an epoch input: an update that changes no input keeps it. */
export interface EpochBuild {
  /** The 40-hex commit a release build stamps (`--define GBRAIN_BUILD_COMMIT`); null for an unstamped run. */
  gbrain_commit: string | null;
  gbrain_version: string;
  addon_target: string | null;
}

export interface EpochManifest {
  version: 1;
  epoch_id: string;
  started_at: string;
  inputs: EpochInputs;
  /** Absent on an epoch from before these fields: that history is unknown, never backfilled, and consumers fail closed. */
  build?: EpochBuild;
}

/** Set by `bun build --define` in the release and `bun run build` compiles (the same stamp as skills/resolver/build.ts). */
declare const GBRAIN_BUILD_COMMIT: string | undefined;

/** This process's build: the stamped commit (a malformed stamp is none), the package version and the addon target. */
export function currentBuild(): EpochBuild {
  const stamp = typeof GBRAIN_BUILD_COMMIT === 'string' && /^[0-9a-f]{40}$/.test(GBRAIN_BUILD_COMMIT) ? GBRAIN_BUILD_COMMIT : null;
  return { gbrain_commit: stamp, gbrain_version: VERSION, addon_target: detectAddonTarget() };
}

export const epochPath = (dir: string): string => join(dir, 'evidence', 'epoch.json');
const historyPath = (dir: string): string => join(dir, 'evidence', 'epochs.jsonl');

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
/** The inputs in one fixed key order, as text. */
const canonical = (i: EpochInputs): string => JSON.stringify([i.seed_id, i.rust_addon_sha256, i.comparator_version, i.adapter_version, i.capability_set_hash, i.readiness_policy_hash]);

/** A stable hash of the capability names the Rust engine reports. */
export function capabilitySetHash(capabilities: Iterable<string>): string {
  return sha(JSON.stringify([...capabilities].sort())).slice(0, 16);
}

/** What reading the manifest found: an epoch, no manifest file at all (no epoch has opened yet), or a manifest that is there and cannot be used (a read error, a torn or foreign file). The last is never the same as the second. */
export type EpochRead = { kind: 'epoch'; epoch: EpochManifest } | { kind: 'absent' } | { kind: 'unreadable' };
export function readEpochState(dir: string): EpochRead {
  let text: string;
  try { text = readFileSync(epochPath(dir), 'utf8'); } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'absent' } : { kind: 'unreadable' }; }
  try {
    const m = JSON.parse(text) as EpochManifest;
    const i = m?.inputs;
    if (!(m?.version === 1 && typeof m.epoch_id === 'string' && Number.isFinite(Date.parse(m.started_at)) && i && typeof i.seed_id === 'string')) return { kind: 'unreadable' };
    const b = m.build;
    const ok = b && typeof b === 'object' && (b.gbrain_commit === null || typeof b.gbrain_commit === 'string') && typeof b.gbrain_version === 'string' && (b.addon_target === null || typeof b.addon_target === 'string');
    return { kind: 'epoch', epoch: ok ? m : { ...m, build: undefined } };
  } catch { return { kind: 'unreadable' }; } // silent-read-ok: not silent; the caller that needs the manifest reads it as a failure, never as no epoch
}

/** The manifest, or null when it is absent or not a manifest. */
export function readEpoch(dir: string): EpochManifest | null {
  const read = readEpochState(dir);
  return read.kind === 'epoch' ? read.epoch : null; // silent-read-ok: no readable manifest is no epoch; the status leaves every count absent
}

const lockPath = (dir: string): string => join(dir, 'evidence', 'epoch.lock');
const LOCK_WAIT_MS = 10_000;

const sleepSync = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/** A lock is stale only when its text names a holder process that is gone. A lock that names none (empty: a crash between creating it and writing it, or a creation still in progress) is never taken over: it is not told apart from a new one, so it refuses the lock until removed by hand. `text` is what the lock file said when it was read. */
function staleLock(text: string): boolean {
  const pid = Number.parseInt(text, 10);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'EPERM'; }
}

/** Creates a file exclusively (O_EXCL) holding `body`: true when this process now holds it, false when another does. */
function tryCreateLock(path: string, body: string): boolean {
  try { const fd = openSync(path, 'wx', 0o600); writeSync(fd, body); closeSync(fd); return true; } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
}

const readText = (path: string): string | null => { try { return readFileSync(path, 'utf8'); } catch { return null; } }; // silent-read-ok: no readable lock is never taken over
const removeIfOurs = (path: string, body: string): void => { try { if (readText(path) === body) unlinkSync(path); } catch { /* already gone */ } };

/**
 * Runs `fn` while holding the lock file at `path` (created O_EXCL; its text is `<pid>:<token>`), so processes take turns. Throws (`epoch_lock_timeout`)
 * when it stays held. The directory must exist. A lock whose holder is gone is taken over only through `<path>.takeover`, created exclusively: the
 * taker re-reads the lock under it and removes it only if it is still the very text it judged dead, so two takers never both enter and a lock another
 * process just created is never removed (the drill lock's pattern). A takeover file a crash left behind refuses the lock until it is removed by hand.
 * The release removes the lock only while it is still ours. `seams` are for tests: `afterJudged` runs right after a lock was judged dead, `waitMs` shortens the wait. A lock with no holder named in it (empty) is never taken over.
 */
export function withLock<T>(path: string, fn: () => T, seams: { afterJudged?: () => void; waitMs?: number } = {}): T {
  const body = `${process.pid}:${randomBytes(6).toString('hex')}`;
  const deadline = Date.now() + (seams.waitMs ?? LOCK_WAIT_MS);
  for (;;) {
    if (tryCreateLock(path, body)) break;
    const seen = readText(path);
    if (seen !== null && staleLock(seen)) {
      seams.afterJudged?.();
      if (tryCreateLock(`${path}.takeover`, body)) {
        try { if (readText(path) === seen) unlinkSync(path); } catch { /* already gone */ } /* silent-read-ok: a lock that is already gone needs no removal; the loop then creates it */ finally { removeIfOurs(`${path}.takeover`, body); }
        continue;
      }
    }
    if (Date.now() > deadline) throw Object.assign(new Error('the lock is held'), { code: 'epoch_lock_timeout' });
    sleepSync(20);
  }
  try { return fn(); } finally { removeIfOurs(path, body); }
}

/** The epoch manifest's lock, `<dir>/evidence/epoch.lock`. */
function withEpochLock<T>(dir: string, fn: () => T): T {
  mkdirSync(join(dir, 'evidence'), { recursive: true, mode: 0o700 });
  return withLock(lockPath(dir), fn);
}

/**
 * Returns the current epoch for `inputs`, opening a new one (and keeping the old manifest) when any input changed.
 * `build` is written only when a new epoch opens; an unchanged epoch keeps the build it started with. Opening is
 * serialized across processes by a lock file and re-reads the manifest under it, so children that start together
 * agree on one epoch. Throws (`epoch_lock_timeout`) when the lock stays held: the caller then has no epoch.
 */
export function ensureEpoch(dir: string, inputs: EpochInputs, now: number = Date.now(), build?: EpochBuild): EpochManifest {
  const quick = readEpoch(dir);
  if (quick && canonical(quick.inputs) === canonical(inputs)) return quick;
  return withEpochLock(dir, () => {
    const current = readEpoch(dir);
    if (current && canonical(current.inputs) === canonical(inputs)) return current;
    const next: EpochManifest = {
      version: 1, started_at: new Date(now).toISOString(), inputs, ...(build ? { build } : {}),
      epoch_id: sha(`${canonical(inputs)}\0${current?.epoch_id ?? new Date(now).toISOString()}`).slice(0, 16),
    };
    if (current) appendFileSync(historyPath(dir), JSON.stringify(current) + '\n', { mode: 0o600 });
    const tmp = `${epochPath(dir)}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, epochPath(dir));
    return next;
  });
}

/**
 * The epoch id a long-lived process sees: the manifest's, re-read at most every `ttlMs`. A serving process notes each
 * call under the epoch current at that moment, so a rotation is seen within `ttlMs`.
 */
export function epochWatch(dir: string, now: () => number = Date.now, ttlMs = 1_000): () => string | null {
  let checked = -Infinity;
  let id: string | null = null;
  return () => {
    const t = now();
    if (t - checked >= ttlMs) { checked = t; id = readEpoch(dir)?.epoch_id ?? null; }
    return id;
  };
}

/**
 * The version of the TS adapter that turns the Rust store's answers into engine results (src/core/rust-engine/
 * store-members/**, store-codec.ts, members.ts). It is an epoch input: bump it with any change to that mapping.
 * test/shadow-evidence.test.ts pins it to a digest of those files, so a change that forgets to bump it fails CI.
 */
export const SHADOW_ADAPTER_VERSION = 10;

/** The adapter identity an epoch records: the adapter version, the engine ABI and the addon's catalog version. */
export function adapterIdentity(abi: number, catalog: string, adapterVersion: number = SHADOW_ADAPTER_VERSION): string {
  return `adapter${adapterVersion}.abi${abi}.catalog${catalog}`;
}

/** Same failure, same boundary, at most one fault line this often: a broken engine must not fill the disk. */
export const INTERNAL_ERROR_SPACING_MS = 1_000;

/**
 * The child's hook at every Rust boundary (open, read, apply, fingerprint, reconcile). A Rust panic reaches TypeScript
 * as an error with code `internal_error`; this appends one content-free `rust_internal_error` fault (the epoch, the
 * boundary, the code) whatever the read ledger holds, so a panic in follow or reconcile work that a later pass repairs
 * still counts. One thrown error seen on two paths counts once (it is remembered by identity), and the same boundary
 * is recorded at most once per `INTERNAL_ERROR_SPACING_MS`. Never throws.
 */
export function internalErrorRecorder(dir: string, epochId: string | null | (() => string | null), now: () => number = Date.now): (boundary: string, error: unknown) => void {
  const seen = new WeakSet<object>();
  const last = new Map<string, number>();
  return (boundary, error) => {
    try {
      const code = (error as { code?: unknown } | null)?.code;
      if (code !== 'internal_error') return;
      if (typeof error === 'object' && error !== null) { if (seen.has(error)) return; seen.add(error); }
      const at = now();
      if (at - (last.get(boundary) ?? -Infinity) < INTERNAL_ERROR_SPACING_MS) return;
      last.set(boundary, at);
      const epoch = typeof epochId === 'function' ? epochId() : epochId;
      const fault: ShadowFault = { ts: new Date(at).toISOString(), kind: 'rust_internal_error', detail: `boundary=${boundary} code=${code}`, ...(epoch ? { epoch_id: epoch } : {}) };
      appendFault(dir, fault);
    } catch { /* a full disk loses the line, never the child */ }
  };
}
