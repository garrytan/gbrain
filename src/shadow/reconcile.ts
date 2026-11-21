/**
 * Reconcile (shadow follow, plan PR 1): compares the Rust store with the primary and repairs what differs.
 *
 * One pass reads the primary in one read-only snapshot, relation by relation, in sort-key order. It cuts a relation
 * into intervals of 500 rows and compares each interval's digest (follow-digest.ts) with the store's. For an interval
 * that differs it lists the store's entries, counts the rows that are changed, missing or extra, and rewrites the
 * interval (`replaceInterval`). The pass's generation is taken before the snapshot, so a row the follower wrote
 * after the snapshot is neither counted nor overwritten.
 *
 * A repaired row is a follower miss when the coverage watermark was valid at the pass start: the follower claimed
 * coverage and was wrong. A pass that repaired everything and started after the last invalidation restores the
 * watermark. Not done: reconcile does not fingerprint-check the `facts` rows it rewrites, and it cannot see drift
 * that begins on the Rust side after an import (the digests it compares are the ones the store was given).
 */
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../core/engine.ts';
import { DIGEST_SESSION_SETTINGS, digestQuery, quoteIdent, readKeysetRows, type DigestPlan, type KeysetRow } from '../core/persistence/graduation-digest.ts';
import type { SeedEntry, SeedIntervalDigest, SeedPlan, SeedRelationPlan } from '../core/rust-engine/store.ts';
import { hasFingerprintFunctions, probeOnPrimary } from './fingerprints.ts';
import { appendPass, NIGHTLY_MS, readPasses, type PassRecord, type Watermark } from './follow-status.ts';
import { intervalDigest, rowDigest, sortKey, sortKeyUnsupported } from './follow-digest.ts';
import { nextGeneration, type ShadowFollower } from './follower.ts';
import { primaryTables } from './seed-gaps.ts';
import { relationRead } from './seed.ts';

export const RECONCILE_INTERVAL_ROWS = 500;
const ENTRY_PAGE = 5000;
const INVALID_RETRY_MS = 3_600_000;

export interface ReconcilerOptions {
  dir: string;
  primary: BrainEngine;
  rpc: <T>(method: string, args?: Record<string, unknown>, timeoutMs?: number) => Promise<T>;
  /** The serving follower, when this process has one: a pass waits for it to drain and reads its invalidations. */
  follower?: ShadowFollower | null;
  now?: () => number;
  intervalRows?: number;
  debounceMs?: number;
  tickMs?: number;
}

interface Slice { rows: KeysetRow[]; sorts: Buffer[]; digests: Buffer[] }

export class Reconciler {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly dirty = new Set<string>();
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private nightly: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  /** Set after construction when the follower needs the reconciler's `markDirty` first. */
  set follower(value: ShadowFollower | null) { this.o.follower = value; }

  constructor(private readonly o: ReconcilerOptions) { this.now = o.now ?? Date.now; }

  /** Runs one pass after any pass already running. Never rejects: failures are in the record's `error`. */
  run(kind: 'full' | 'dirty', relations?: string[]): Promise<PassRecord> {
    const next = this.chain.then(() => this.pass(kind, relations));
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** A relation the follower could not describe: repair it soon (debounced). */
  markDirty(relation: string): void {
    this.dirty.add(relation);
    if (this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = null;
      const relations = [...this.dirty];
      this.dirty.clear();
      void this.run('dirty', relations);
    }, this.o.debounceMs ?? 2_000);
    (this.debounce as { unref?: () => void }).unref?.();
  }

  /** A full pass when one has not run for 24 h, or an hour after the last pass while the watermark is invalid. */
  startNightly(): void {
    if (this.nightly) return;
    this.nightly = setInterval(() => { void this.tick(); }, this.o.tickMs ?? 15 * 60_000);
    (this.nightly as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.nightly) clearInterval(this.nightly);
    if (this.debounce) clearTimeout(this.debounce);
    this.nightly = this.debounce = null;
  }

  private async tick(): Promise<void> {
    try {
      const passes = readPasses(this.o.dir);
      const lastFull = passes.filter((p) => p.kind === 'full').at(-1);
      const last = passes.at(-1);
      let due = !lastFull || this.now() - Date.parse(lastFull.finished_at) >= NIGHTLY_MS;
      if (!due && last && this.now() - Date.parse(last.finished_at) >= INVALID_RETRY_MS) due = !(await this.o.rpc<Watermark>('state', {}, 10_000)).valid;
      if (due) await this.run('full');
    } catch { /* the next tick tries again */ }
  }

  private async pass(kind: 'full' | 'dirty', only?: string[]): Promise<PassRecord> {
    const startedAt = new Date(this.now()).toISOString();
    const rec: PassRecord = { id: `pass-${startedAt.replace(/[-:.]/g, '')}-${randomUUID().slice(0, 4)}`, kind, started_at: startedAt, finished_at: startedAt, repaired_rows: 0, repaired_by_relation: {}, follower_misses: 0 };
    let verified = true;
    let repairFailed = false;
    let passStart = this.now();
    try {
      await this.o.follower?.settle();
      const barrier = await this.o.rpc<Watermark>('state', {}, 30_000);
      const plan = await this.o.rpc<SeedPlan>('seedPlan', {}, 30_000);
      const generation = nextGeneration();
      passStart = this.now();
      const validAtStart = barrier.valid && (this.o.follower?.lastInvalidatedAt ?? 0) < passStart;
      const maxima: Record<string, string> = {};
      await this.o.primary.transaction(async (tx) => {
        const query = digestQuery(tx);
        await query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        await query(DIGEST_SESSION_SETTINGS);
        const tables = new Set(await primaryTables(query));
        for (const rp of plan.relations) {
          if ((only && !only.includes(rp.relation)) || !tables.has(rp.relation)) continue;
          const read = await relationRead(tx, rp.relation, rp.key);
          if (sortKeyUnsupported(read.key)) { verified = false; continue; }
          await this.relation(tx, rp, read, generation, validAtStart, rec);
          const [k] = read.key;
          if (kind === 'full' && read.key.length === 1 && k!.name === 'id' && ['smallint', 'integer', 'bigint'].includes(k!.type)) {
            const [row] = await query(`SELECT max("id")::text AS m FROM ${quoteIdent(rp.relation)}`);
            if (typeof row?.m === 'string' && /^\d+$/.test(row.m)) maxima[rp.relation] = row.m;
          }
        }
      }, { readOnly: true });
      if (kind === 'full') {
        try { await this.o.rpc('allocatorCheck', { primaryMax: maxima }, 60_000); } catch (error) { rec.error = `allocator_check:${(error as { code?: string }).code ?? 'failed'}`; }
        try { await this.probe(); } catch (error) { rec.error ??= `probe:${(error as { code?: string }).code ?? 'failed'}`; }
      }
    } catch (error) {
      repairFailed = true;
      rec.error = `${(error as { code?: string }).code ?? (error instanceof Error ? error.name : 'failed')}: ${error instanceof Error ? error.message.slice(0, 200) : ''}`;
    }
    // Allocator and probe failures are reported but do not decide whether the rows are covered.
    if (!repairFailed) await this.restore(kind, passStart, verified);
    rec.finished_at = new Date(this.now()).toISOString();
    try { appendPass(this.o.dir, rec); } catch { /* a full disk loses the record, never the pass */ }
    return rec;
  }

  private async restore(kind: 'full' | 'dirty', passStart: number, verified: boolean): Promise<void> {
    if (!verified || (this.o.follower?.lastInvalidatedAt ?? 0) >= passStart) return;
    if (kind === 'dirty' && this.dirty.size) return;
    try { await this.o.rpc('watermark', { valid: true, since: passStart, ...(kind === 'dirty' ? { onlyIfReason: 'relation_dirty' } : {}) }, 30_000); } catch { /* stays invalid */ }
  }

  /** Evaluates the fingerprint probe corpus on the primary and in the store; the store records the result. */
  async probe(): Promise<void> {
    if (!(await hasFingerprintFunctions(this.o.primary))) return;
    const { sql, ...meta } = await probeOnPrimary(this.o.primary);
    await this.o.rpc('probe', { sql, ...meta }, 30_000);
  }

  private slice(read: DigestPlan, rows: KeysetRow[]): Slice {
    return { rows, sorts: rows.map((r) => sortKey(read.key, r.key)), digests: rows.map((r) => rowDigest(r.values)) };
  }

  private async relation(tx: BrainEngine, rp: SeedRelationPlan, read: DigestPlan, generation: number, validAtStart: boolean, rec: PassRecord): Promise<void> {
    const size = this.o.intervalRows ?? RECONCILE_INTERVAL_ROWS;
    let current = await readKeysetRows(tx, read, null, size);
    let lo: string | null = null;
    for (;;) {
      const next = current.length === size ? await readKeysetRows(tx, read, current.at(-1)!.key, size) : [];
      const slice = this.slice(read, current);
      const hi = next.length ? sortKey(read.key, next[0]!.key).toString('hex') : null;
      const repaired = await this.interval(rp.relation, lo, hi, slice, generation);
      if (repaired) {
        rec.repaired_rows += repaired;
        rec.repaired_by_relation[rp.relation] = (rec.repaired_by_relation[rp.relation] ?? 0) + repaired;
        if (validAtStart) rec.follower_misses += repaired;
      }
      if (!next.length) return;
      lo = hi;
      current = next;
    }
  }

  /** Repairs `[lo, hi)` when its digest differs; returns the rows changed, missing or extra. */
  private async interval(relation: string, lo: string | null, hi: string | null, s: Slice, generation: number): Promise<number> {
    const local = intervalDigest(s.sorts.map((sort, i) => ({ sort, digest: s.digests[i]! }))).toString('hex');
    const remote = await this.o.rpc<SeedIntervalDigest>('relationDigest', { relation, lo, hi }, 60_000);
    if (remote.rows === s.rows.length && remote.digest === local) return 0;
    const entries = new Map<string, SeedEntry>();
    for (let from = lo; ;) {
      const page = await this.o.rpc<SeedEntry[]>('relationEntries', { relation, lo: from, hi, limit: ENTRY_PAGE }, 60_000);
      for (const e of page) entries.set(e.sort, e);
      if (page.length < ENTRY_PAGE) break;
      from = `${page.at(-1)!.sort}00`;
    }
    let differing = 0;
    const seen = new Set<string>();
    s.sorts.forEach((sort, i) => {
      const hex = sort.toString('hex');
      seen.add(hex);
      const e = entries.get(hex);
      if (!e || (e.digest !== s.digests[i]!.toString('hex') && e.generation <= generation)) differing++;
    });
    for (const e of entries.values()) if (!seen.has(e.sort) && e.generation <= generation) differing++;
    if (differing === 0) return 0;
    await this.o.rpc('replaceInterval', {
      relation, generation, lo, hi, rows: s.rows.map((r) => r.values),
      digests: s.sorts.map((sort, i) => ({ sort: sort.toString('hex'), digest: s.digests[i]!.toString('hex') })),
    }, 120_000);
    return differing;
  }
}
