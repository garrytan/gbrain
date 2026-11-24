/**
 * State 3 of a swap run, behind the write fence: a final reconcile, the Rust allocators raised to at least the
 * primary's high-water marks, a second full reconcile that must repair nothing, the fingerprint probe, and a full
 * relation digest of every copied relation on both engines.
 *
 * Nothing here writes to the primary. The Rust store is reached through the shadow child's RPC (the same calls
 * `gbrain engine shadow reconcile` makes), so the store keeps one owner.
 */
import type { BrainEngine } from '../engine.ts';
import { quoteIdent, readKeysetRows } from '../persistence/graduation-digest.ts';
import type { SeedIntervalDigest, SeedPlan } from '../rust-engine/store.ts';
import { intervalDigest, rowDigest, sortKey } from '../../shadow/follow-digest.ts';
import type { ProbeRecord } from '../../shadow/follow-status.ts';
import { hasFingerprintFunctions, probeOnPrimary } from '../../shadow/fingerprints.ts';
import type { ReadSource } from '../../shadow/read-pool.ts';
import { Reconciler } from '../../shadow/reconcile.ts';
import { relationRead } from '../../shadow/seed.ts';
import type { SwapRecord } from './record.ts';

export type Rpc = <T>(method: string, args?: Record<string, unknown>, timeoutMs?: number) => Promise<T>;

/** Why the verification stopped: the refusal reason it maps to, and a sanitized detail (counts and names only). */
export class SwapVerifyError extends Error {
  constructor(readonly reason: 'digest_mismatch' | 'fingerprint_semantics_differ' | 'verification_incomplete', detail: string) {
    super(detail);
  }
}

const DIGEST_BATCH = 2_000;

/** The primary's high-water mark per id-keyed relation: the larger of max(id) and its sequence's last value. */
async function primaryFloors(reads: ReadSource, plan: SeedPlan): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const rp of plan.relations) {
    if (rp.key.length !== 1 || rp.key[0] !== 'id') continue;
    const floor = await reads.read(async (_, query) => {
      const [exists] = await query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [rp.relation]);
      if (!exists?.ok) return undefined;
      const [type] = await query(`SELECT format_type(a.atttypid, a.atttypmod) AS t FROM pg_attribute a
        WHERE a.attrelid = to_regclass($1) AND a.attname = 'id' AND NOT a.attisdropped`, [rp.relation]);
      if (!type || !['smallint', 'integer', 'bigint'].includes(String(type.t))) return undefined;
      const [max] = await query(`SELECT max("id")::text AS m FROM ${quoteIdent(rp.relation)}`);
      const [seq] = await query(`SELECT pg_get_serial_sequence($1, 'id') AS s`, [rp.relation]);
      let last: bigint | null = null;
      if (typeof seq?.s === 'string') {
        const [val] = await query(`SELECT last_value::text AS v, is_called FROM ${seq.s}`);
        if (val && val.is_called) last = BigInt(String(val.v));
      }
      const m = typeof max?.m === 'string' ? BigInt(max.m) : null;
      const top = m === null ? last : last === null ? m : (m > last ? m : last);
      return top === null ? null : top.toString();
    });
    if (floor !== undefined) out[rp.relation] = floor;
  }
  return out;
}

/**
 * The full-relation digest of `relation` on the primary, computed as the store computes `relationDigest(null, null)`.
 * Keys are walked in byte order (`COLLATE "C"`, graduation-digest.ts) whatever the database's default collation, so an
 * ICU-default Postgres brain digests the same way the Rust store does. `order` is the first key column of each row, in
 * walk order (tests).
 */
export async function primaryRelationDigest(reads: ReadSource, relation: string, key: readonly string[]): Promise<{ rows: number; digest: string; order: string[] }> {
  // The read source opens each read in one REPEATABLE READ transaction with the digest session settings.
  return reads.read(async (tx) => {
    const plan = await relationRead(tx, relation, key);
    const entries: Array<{ sort: Buffer; digest: Buffer }> = [];
    const order: string[] = [];
    let after: readonly string[] | null = null;
    for (;;) {
      const rows = await readKeysetRows(tx, plan, after, DIGEST_BATCH);
      for (const r of rows) { entries.push({ sort: sortKey(plan.key, r.key), digest: rowDigest(r.values) }); order.push(String(r.key[0])); }
      if (rows.length < DIGEST_BATCH) break;
      after = rows[rows.length - 1]!.key;
    }
    return { rows: entries.length, digest: intervalDigest(entries).toString('hex'), order };
  });
}

/**
 * The forward fingerprint guard, inside the fence and before authority moves: the probe runs on the live primary and
 * the swap continues on the probe's own rule (probeState, src/shadow/fingerprints.ts): where the server's lower() or
 * [[:space:]] differs from the Rust engine on some code points (stock Postgres does, so its corpus sample always reports
 * mismatches), it refuses only when a stored fact holds one; with no differing code point, any corpus mismatch refuses.
 * An affected fact or a failed probe refuses `fingerprint_semantics_differ`; a probe that cannot
 * run (an error, a primary without the fingerprint functions) refuses `verification_incomplete`. Never a silent pass.
 */
export async function checkFingerprints(reads: ReadSource, rpc: Rpc): Promise<'pass'> {
  let record: ProbeRecord;
  try {
    const sample = await reads.read(async (tx) => ((await hasFingerprintFunctions(tx)) ? probeOnPrimary(tx) : null));
    if (!sample) throw new SwapVerifyError('verification_incomplete', 'the fingerprint probe could not run: the primary has no fingerprint functions (run gbrain apply-migrations)');
    const { sql, ...meta } = sample;
    record = await rpc<ProbeRecord>('probe', { sql, ...meta }, 30_000);
  } catch (error) {
    if (error instanceof SwapVerifyError) throw error;
    throw new SwapVerifyError('verification_incomplete', `the fingerprint probe could not run (${String((error as { code?: unknown } | null)?.code ?? 'error')})`);
  }
  const affected = Number(record.facts_with_differing_code_points ?? 0);
  if (affected > 0) {
    throw new SwapVerifyError('fingerprint_semantics_differ', `${affected} stored fact(s) hold a code point whose fingerprint differs under the Rust engine (${record.differing_code_points_total} differing code point(s))`);
  }
  if (record.state !== 'pass') {
    throw new SwapVerifyError('fingerprint_semantics_differ', `the fingerprint probe found ${record.mismatches + Number(record.corpus_mismatches ?? 0)} mismatch(es)`);
  }
  return 'pass';
}

export interface VerifyDeps {
  primary: BrainEngine;
  reads: ReadSource;
  rpc: Rpc;
  dir: string;
  intervalRows?: number;
}

/** Runs state 3. Throws `SwapVerifyError` when the engines cannot be shown equal; the fence stays either way. */
export async function verifyEngines(d: VerifyDeps): Promise<NonNullable<SwapRecord['verify']>> {
  const reconciler = new Reconciler({ dir: d.dir, reads: d.reads, rpc: d.rpc, intervalRows: d.intervalRows });
  const first = await reconciler.run('full');
  if (first.error) throw new SwapVerifyError('verification_incomplete', `the final reconcile failed (${first.error.split(':')[0]})`);
  const plan = await d.rpc<SeedPlan>('seedPlan', {}, 30_000);
  const floors = await primaryFloors(d.reads, plan);
  const allocators = await d.rpc<Array<{ relation: string; counter: string; primary_max: string | null; ok: boolean }>>('allocatorAdvance', { primaryFloor: floors }, 60_000);
  if (!allocators.every(a => a.ok)) throw new SwapVerifyError('verification_incomplete', `${allocators.filter(a => !a.ok).length} allocator(s) stayed at or below the primary's high-water mark`);
  const second = await reconciler.run('full');
  if (second.error) throw new SwapVerifyError('verification_incomplete', `the confirming reconcile failed (${second.error.split(':')[0]})`);
  if (second.repaired_rows > 0) throw new SwapVerifyError('digest_mismatch', `the confirming reconcile still repaired ${second.repaired_rows} row(s) behind the fence (${Object.keys(second.repaired_by_relation).join(', ')})`);
  // Read back from the store, not the follower file (the child writes that file at most once a second).
  const checked = await d.rpc<Array<{ ok: boolean }>>('allocatorCheck', { primaryMax: floors }, 60_000);
  if (!checked.every(c => c.ok)) throw new SwapVerifyError('verification_incomplete', 'the allocator check did not pass');
  const probe: 'pass' | 'fail' | 'not_run' = await checkFingerprints(d.reads, d.rpc);
  const tables = new Set(await d.reads.read(async (_, query) => (await query(`SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = current_schema() AND c.relkind = 'r'`)).map(r => String(r.name))));
  const digests: NonNullable<SwapRecord['verify']>['digests'] = [];
  for (const rp of plan.relations) {
    if (!tables.has(rp.relation)) continue;
    const ours = await primaryRelationDigest(d.reads, rp.relation, rp.key);
    const theirs = await d.rpc<SeedIntervalDigest>('relationDigest', { relation: rp.relation, lo: null, hi: null }, 120_000);
    digests.push({ relation: rp.relation, rows: ours.rows, primary: ours.digest, rust: theirs.digest });
    if (theirs.rows !== ours.rows || theirs.digest !== ours.digest) {
      throw new SwapVerifyError('digest_mismatch', `${rp.relation}: ${ours.rows} row(s) on the primary, ${theirs.rows} in the Rust store, and the digests differ`);
    }
  }
  return {
    passes: [first, second].map(p => ({ id: p.id, repaired_rows: p.repaired_rows, error: p.error ?? null })),
    digests,
    allocators: allocators.map(a => ({ relation: a.relation, counter: a.counter, floor: floors[a.relation] ?? null, ok: a.ok })),
    probe,
    at: new Date().toISOString(),
  };
}
