/** Shadow-directory fixtures for the drill and eval-gates tests: a seed record, an evidence epoch with a build, store files. */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureEpoch, type EpochBuild, type EpochManifest } from '../../src/shadow/evidence-epoch.ts';
import { writeSeedRecord, type SeedRecord } from '../../src/shadow/seed.ts';

export const COMMIT = 'a'.repeat(40);
export const OTHER_COMMIT = 'b'.repeat(40);
export const ADDON_SHA = 'c'.repeat(64);
export const OTHER_ADDON_SHA = 'd'.repeat(64);
export const EVALS_COMMIT = 'e'.repeat(40);
export const EVALS_REF = 'f'.repeat(40);
export const VERSION = '0.60.764.0';
export const TAG = `v${VERSION}`;
export const TARGET = 'linux-x64-glibc';
export const FORMAT_VERSION = 5;
export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

export const SEED = {
  version: 1, seed_id: 'seed-1', started_at: '2026-11-01T00:00:00.000Z', finished_at: '2026-11-01T00:01:00.000Z', primary_engine: 'pglite',
  unseeded_gap_rows_total: 0, unseeded_gap_rows: {}, relations: {}, non_terminal_jobs: 0, segmented_pages: 0, losses: { values: {}, not_copied: [], gaps: {} },
} as unknown as SeedRecord;

export const BUILD: EpochBuild = { gbrain_commit: COMMIT, gbrain_version: VERSION, addon_target: TARGET };

/** A shadow directory with a seed record and an epoch (build recorded unless `build` is null). Returns the epoch. */
export function writeEpoch(dir: string, opts: { build?: EpochBuild | null; addon?: string | null } = {}): EpochManifest {
  mkdirSync(dir, { recursive: true });
  writeSeedRecord(dir, SEED);
  return ensureEpoch(dir, {
    seed_id: SEED.seed_id, rust_addon_sha256: opts.addon === undefined ? ADDON_SHA : opts.addon, comparator_version: 1, adapter_version: 'abi1.catalog1',
    capability_set_hash: 'caps', readiness_policy_hash: 'policy',
  // pregate-literal: SHADOW_ADAPTER_VERSION=11 the number 11 on the next line is test data (a count, size, index or date), not the adapter version
  }, Date.parse('2026-11-26T12:00:00Z'), opts.build === null ? undefined : (opts.build ?? BUILD));
}

/** A store directory with a records file of `bytes` and a FORMAT record. */
export function writeStoreFiles(dir: string, bytes = 4096, formatVersion = FORMAT_VERSION): void {
  const store = join(dir, 'store');
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, 'records.redb'), Buffer.alloc(bytes));
  writeFileSync(join(store, 'FORMAT'), JSON.stringify({ format_version: formatVersion, engine_abi: 1, catalog_version: 1, schema_version: 1, brain_id: 'b', created_by: 'test' }));
}

export type Gate = { verdict: string; threshold: unknown; measured: unknown; rows: unknown; losses: unknown };
export const passGate = (): Gate => ({ verdict: 'PASS', threshold: 0.9, measured: 0.95, rows: 470, losses: 0 });

/** The published file as an object; `patch` edits it. */
export function gatesObject(patch: (f: Record<string, unknown>) => void = () => undefined): Record<string, unknown> {
  const f: Record<string, unknown> = {
    schema_version: 1, gbrain_commit: COMMIT, gbrain_tag: TAG, rust_addon_sha256: ADDON_SHA, engine_format_version: FORMAT_VERSION,
    evals_commit: EVALS_COMMIT, generated_at: '2026-11-28T09:00:00Z', target: TARGET, status: 'FINAL',
    gates: { E1: passGate(), E2: passGate(), E3: passGate() }, receipt_links: ['https://example.test/receipt'],
  };
  patch(f);
  return f;
}

export const evalPath = (tag = TAG, evals = EVALS_COMMIT): string => `eval/results/engine-bench/eval-gates/${tag}/${evals}.json`;
export const evalUrl = (ref = EVALS_REF, tag = TAG, evals = EVALS_COMMIT): string => `https://raw.githubusercontent.com/garrytan/gbrain-evals/${ref}/${evalPath(tag, evals)}`;

/** The pin for a file's text; `patch` edits it. */
export function pinFor(text: string, patch: (p: Record<string, unknown>) => void = () => undefined): Record<string, unknown> {
  const p: Record<string, unknown> = {
    schema_version: 1, gbrain_tag: TAG, gbrain_commit: COMMIT, evals_commit: EVALS_COMMIT, evals_ref: EVALS_REF, path: evalPath(), url: evalUrl(),
    sha256: sha256(text), target: TARGET,
  };
  patch(p);
  return p;
}

/** Writes the cache files `drill --evals` writes. */
export function writeCache(dir: string, file: string, pin: unknown): void {
  mkdirSync(join(dir, 'drills'), { recursive: true });
  writeFileSync(join(dir, 'drills', 'eval-gates.json'), file);
  writeFileSync(join(dir, 'drills', 'eval-gates.pin.json'), typeof pin === 'string' ? pin : JSON.stringify(pin));
}
