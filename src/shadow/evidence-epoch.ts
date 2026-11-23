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
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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

/** The manifest, or null when it is absent or not a manifest. */
export function readEpoch(dir: string): EpochManifest | null {
  try {
    const m = JSON.parse(readFileSync(epochPath(dir), 'utf8')) as EpochManifest;
    const i = m?.inputs;
    if (!(m?.version === 1 && typeof m.epoch_id === 'string' && Number.isFinite(Date.parse(m.started_at)) && i && typeof i.seed_id === 'string')) return null;
    const b = m.build;
    const ok = b && typeof b === 'object' && (b.gbrain_commit === null || typeof b.gbrain_commit === 'string') && typeof b.gbrain_version === 'string' && (b.addon_target === null || typeof b.addon_target === 'string');
    return ok ? m : { ...m, build: undefined };
  } catch { return null; } // silent-read-ok: no readable manifest is no epoch; the status leaves every count absent
}

/**
 * Returns the current epoch for `inputs`, opening a new one (and keeping the old manifest) when any input changed.
 * `build` is written only when a new epoch opens; an unchanged epoch keeps the build it started with.
 */
export function ensureEpoch(dir: string, inputs: EpochInputs, now: number = Date.now(), build?: EpochBuild): EpochManifest {
  const current = readEpoch(dir);
  if (current && canonical(current.inputs) === canonical(inputs)) return current;
  const next: EpochManifest = {
    version: 1, started_at: new Date(now).toISOString(), inputs, ...(build ? { build } : {}),
    epoch_id: sha(`${canonical(inputs)}\0${current?.epoch_id ?? new Date(now).toISOString()}`).slice(0, 16),
  };
  mkdirSync(join(dir, 'evidence'), { recursive: true, mode: 0o700 });
  if (current) appendFileSync(historyPath(dir), JSON.stringify(current) + '\n', { mode: 0o600 });
  const tmp = `${epochPath(dir)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, epochPath(dir));
  // Two children racing to open the same new epoch: both use the one that is on disk.
  const won = readEpoch(dir);
  return won && canonical(won.inputs) === canonical(inputs) ? won : next;
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
export function internalErrorRecorder(dir: string, epochId: string | null, now: () => number = Date.now): (boundary: string, error: unknown) => void {
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
      const fault: ShadowFault = { ts: new Date(at).toISOString(), kind: 'rust_internal_error', detail: `boundary=${boundary} code=${code}`, ...(epochId ? { epoch_id: epochId } : {}) };
      appendFault(dir, fault);
    } catch { /* a full disk loses the line, never the child */ }
  };
}
