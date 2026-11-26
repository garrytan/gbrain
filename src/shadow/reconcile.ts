/**
 * Reconcile (shadow follow, plan PR 1): compares the Rust store with the primary and repairs what differs.
 *
 * One pass walks the seeded relations in sort-key order, cutting each into intervals of 500 rows. Every interval is read
 * from the primary in its own short read-only transaction (read-pool.ts), with the pass's pause between intervals, and
 * nothing is held open while the pass talks to the Rust store. An interval's digest (follow-digest.ts) is compared with
 * the store's; for an interval that differs the pass lists the store's entries, counts the rows that are changed,
 * missing or extra, and rewrites the interval (`replaceInterval`). The generation is taken just before each interval's
 * read, so a row the follower wrote after that read is neither counted nor overwritten. The intervals of a pass are
 * therefore not one snapshot: consistency across them rests on those generations.
 *
 * A repaired row is a follower miss when the coverage watermark was valid at the pass start: the follower claimed
 * coverage and was wrong. A pass that repaired everything restores the watermark by naming the time it started; the
 * child settles only the obligations older than that (follow-child.ts). A relation whose rewrite displaced rows
 * (the store moved a row off a natural key another row took) is marked dirty for another pass and is not restored by
 * this one. Not done: reconcile does not fingerprint-check the `facts` rows it rewrites, and it cannot see drift that
 * begins on the Rust side after an import (the digests it compares are the ones the store was given).
 */
import { randomUUID } from 'node:crypto';
import { quoteIdent, readKeysetRows, type DigestPlan, type KeysetRow } from '../core/persistence/graduation-digest.ts';
import type { SeedEntry, SeedFollowResult, SeedIntervalDigest, SeedPlan, SeedRelationPlan } from '../core/rust-engine/store.ts';
import { hasFingerprintFunctions, probeOnPrimary } from './fingerprints.ts';
import { appendPass, NIGHTLY_MS, readPasses, type PassRecord, type Watermark } from './follow-status.ts';
import { intervalDigest, rowDigest, sortKey, sortKeyUnsupported } from './follow-digest.ts';
import { nextGeneration, type ShadowFollower } from './follower.ts';
import { primaryTables } from './seed-gaps.ts';
import { ACTIVE_REFRESH_STATES_SQL } from '../core/persistence/worktree-refresh-schema.ts';
import type { ReadSource } from './read-pool.ts';
import { relationRead } from './seed.ts';

export const RECONCILE_INTERVAL_ROWS = 500;
const ENTRY_PAGE = 5000;
const INVALID_RETRY_MS = 3_600_000;
const DEBOUNCE_MS = 2_000;
const TICK_MS = 15 * 60_000;
/** A process that has run this long after it started checks whether its watermark needs a full pass. */
const FIRST_CHECK_MS = 60_000;

export interface ReconcilerOptions {
  dir: string;
  reads: ReadSource;
  rpc: <T>(method: string, args?: Record<string, unknown>, timeoutMs?: number) => Promise<T>;
  /** The serving follower, when this process has one: a pass waits for it to drain and reads its invalidations. */
  follower?: ShadowFollower | null;
  /** Rows per interval; tests make it small to walk several intervals. */
  intervalRows?: number;
}

const unref = (timer: unknown): void => { (timer as { unref?: () => void }).unref?.(); };
const pause = (ms: number): Promise<void> => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

export class Reconciler {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly dirty = new Set<string>();
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private nightly: ReturnType<typeof setInterval> | null = null;
  private firstCheck: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(private readonly o: ReconcilerOptions) {}

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
    }, DEBOUNCE_MS);
    unref(this.debounce);
  }

  /**
   * A full pass when one has not run for 24 h, or an hour after the last pass while the watermark is invalid; and one
   * a minute after start if the watermark is already invalid (a new session starts that way). A short command exits
   * before that minute and never runs it.
   */
  startNightly(): void {
    if (this.nightly) return;
    this.nightly = setInterval(() => { void this.tick(); }, TICK_MS);
    this.firstCheck = setTimeout(() => {
      void this.o.rpc<Watermark>('state', {}, 10_000).then((w) => (w.valid ? undefined : this.run('full')), () => undefined);
    }, FIRST_CHECK_MS);
    unref(this.nightly);
    unref(this.firstCheck);
  }

  stop(): void {
    this.stopped = true; // a pass in flight ends at its next read, so it cannot reopen what the caller is closing
    if (this.nightly) clearInterval(this.nightly);
    if (this.debounce) clearTimeout(this.debounce);
    if (this.firstCheck) clearTimeout(this.firstCheck);
    this.nightly = this.debounce = this.firstCheck = null;
  }

  private readonly read: ReadSource['read'] = (fn) => (this.stopped ? Promise.reject(new Error('reconciler stopped')) : this.o.reads.read(fn));

  private async tick(): Promise<void> {
    try {
      const passes = readPasses(this.o.dir);
      const lastFull = passes.filter((p) => p.kind === 'full').at(-1);
      const last = passes.at(-1);
      let due = !lastFull || Date.now() - Date.parse(lastFull.finished_at) >= NIGHTLY_MS;
      if (!due && last && Date.now() - Date.parse(last.finished_at) >= INVALID_RETRY_MS) due = !(await this.o.rpc<Watermark>('state', {}, 10_000)).valid;
      if (due) await this.run('full');
    } catch { /* the next tick tries again */ }
  }

  private async pass(kind: 'full' | 'dirty', only?: string[]): Promise<PassRecord> {
    const startedAt = new Date().toISOString();
    const rec: PassRecord = { id: `pass-${startedAt.replace(/[-:.]/g, '')}-${randomUUID().slice(0, 4)}`, kind, started_at: startedAt, finished_at: startedAt, repaired_rows: 0, repaired_by_relation: {}, follower_misses: 0 };
    let verified = true;
    let repairFailed = false;
    let passStart = Date.now();
    const settled: string[] = [];
    try {
      await this.o.follower?.settle();
      const barrier = await this.o.rpc<Watermark>('state', {}, 30_000);
      const plan = await this.o.rpc<SeedPlan>('seedPlan', {}, 30_000);
      passStart = Date.now();
      const validAtStart = barrier.valid && (this.o.follower?.lastInvalidatedAt ?? 0) < passStart;
      const tables = new Set(await this.read((_, query) => primaryTables(query)));
      const maxima: Record<string, string> = {};
      for (const rp of plan.relations) {
        if (only && !only.includes(rp.relation)) continue;
        if (!tables.has(rp.relation)) { settled.push(rp.relation); continue; }
        const read = await this.read((tx) => relationRead(tx, rp.relation, rp.key));
        if (sortKeyUnsupported(read.key)) { verified = false; continue; }
        const displaced = await this.relation(rp, read, validAtStart, rec);
        if (displaced > 0) { verified = false; this.markDirty(rp.relation); } else settled.push(rp.relation);
        const [k] = read.key;
        if (kind === 'full' && read.key.length === 1 && k!.name === 'id' && ['smallint', 'integer', 'bigint'].includes(k!.type)) {
          const [row] = await this.read((_, query) => query(`SELECT max("id")::text AS m FROM ${quoteIdent(rp.relation)}`));
          if (typeof row?.m === 'string' && /^\d+$/.test(row.m)) maxima[rp.relation] = row.m;
        }
      }
      // The probe's answer depends on the stored facts and purge tombstones: a dirty pass for either runs it again, so a tombstone
      // added after a passing probe cannot be covered by a cached pass.
      if (kind === 'dirty' && only?.some((relation) => relation === 'facts' || relation === 'fact_purges')) {
        try { await this.probe(); } catch (error) { rec.error ??= `probe:${(error as { code?: string }).code ?? 'failed'}`; }
      }
      if (kind === 'full') {
        try { await this.o.rpc('allocatorCheck', { primaryMax: maxima }, 60_000); } catch (error) { rec.error = `allocator_check:${(error as { code?: string }).code ?? 'failed'}`; }
        try { await this.probe(); } catch (error) { rec.error ??= `probe:${(error as { code?: string }).code ?? 'failed'}`; }
        try { rec.nonterminal_refresh_rows = !tables.has('persistence_worktree_refreshes') ? 0 : Number((await this.read((_, query) => query(`SELECT count(*)::int AS n FROM persistence_worktree_refreshes WHERE state IN ${ACTIVE_REFRESH_STATES_SQL}`)))[0]?.n); } catch (error) { rec.error ??= `refresh_count:${(error as { code?: string }).code ?? 'failed'}`; }
      }
    } catch (error) {
      repairFailed = true;
      // The child still holds what it was told is dirty; a later pass for these relations repairs it.
      for (const relation of only ?? []) this.dirty.add(relation);
      rec.error = `${(error as { code?: string }).code ?? (error instanceof Error ? error.name : 'failed')}: ${error instanceof Error ? error.message.slice(0, 200) : ''}`;
    }
    // Allocator and probe failures are reported but do not decide whether the rows are covered.
    if (!repairFailed) await this.restore(kind, passStart, verified, settled);
    rec.finished_at = new Date().toISOString();
    try { appendPass(this.o.dir, rec); } catch { /* a full disk loses the record, never the pass */ }
    return rec;
  }

  private async restore(kind: 'full' | 'dirty', passStart: number, verified: boolean, relations: string[]): Promise<void> {
    if ((this.o.follower?.lastInvalidatedAt ?? 0) >= passStart) return;
    if (kind === 'full' ? !verified : relations.length === 0) return;
    try { await this.o.rpc('watermark', { valid: true, since: passStart, ...(kind === 'dirty' ? { relations } : {}) }, 30_000); } catch { /* stays invalid */ }
  }

  /** Evaluates the fingerprint probe corpus on the primary and in the store; the store records the result. */
  async probe(): Promise<void> {
    const probe = await this.read(async (tx) => ((await hasFingerprintFunctions(tx)) ? probeOnPrimary(tx) : null));
    if (!probe) return;
    const { sql, ...meta } = probe;
    await this.o.rpc('probe', { sql, ...meta }, 30_000);
  }

  /** Walks one relation interval by interval; returns how many rows the store displaced while rewriting. */
  private async relation(rp: SeedRelationPlan, read: DigestPlan, validAtStart: boolean, rec: PassRecord): Promise<number> {
    const size = this.o.intervalRows ?? RECONCILE_INTERVAL_ROWS;
    let lo: string | null = null;
    let after: readonly string[] | null = null;
    let displaced = 0;
    for (;;) {
      const generation = nextGeneration();
      const from: readonly string[] | null = after;
      const rows: KeysetRow[] = await this.read((tx) => readKeysetRows(tx, read, from, size));
      // A full interval ends just past its last key (the next possible sort key); a short one is the end of the relation.
      const hi = rows.length === size ? `${sortKey(read.key, rows[rows.length - 1]!.key).toString('hex')}00` : null;
      const result = await this.interval(rp.relation, lo, hi, read, rows, generation);
      displaced += result.displaced;
      if (result.repaired) {
        rec.repaired_rows += result.repaired;
        rec.repaired_by_relation[rp.relation] = (rec.repaired_by_relation[rp.relation] ?? 0) + result.repaired;
        if (validAtStart) rec.follower_misses += result.repaired;
      }
      if (hi === null) return displaced;
      lo = hi;
      after = rows[rows.length - 1]!.key;
      await pause(this.o.reads.pauseMs);
    }
  }

  /** Repairs `[lo, hi)` when its digest differs; returns the rows changed, missing or extra, and the rows displaced. A clean interval is rewritten too, so its fence stops a follower read that started before this pass from overwriting what it verified. */
  private async interval(relation: string, lo: string | null, hi: string | null, read: DigestPlan, rows: KeysetRow[], generation: number): Promise<{ repaired: number; displaced: number }> {
    const sorts = rows.map((r) => sortKey(read.key, r.key));
    const digests = rows.map((r) => rowDigest(r.values));
    const local = intervalDigest(sorts.map((sort, i) => ({ sort, digest: digests[i]! }))).toString('hex');
    const remote = await this.o.rpc<SeedIntervalDigest>('relationDigest', { relation, lo, hi }, 60_000);
    const replace = () => this.o.rpc<SeedFollowResult>('replaceInterval', {
      relation, generation, lo, hi, rows: rows.map((r) => r.values),
      digests: sorts.map((sort, i) => ({ sort: sort.toString('hex'), digest: digests[i]!.toString('hex') })),
    }, 120_000);
    if (remote.rows === rows.length && remote.digest === local) return { repaired: 0, displaced: (await replace()).displaced };
    const entries = new Map<string, SeedEntry>();
    for (let from = lo; ;) {
      const page = await this.o.rpc<SeedEntry[]>('relationEntries', { relation, lo: from, hi, limit: ENTRY_PAGE }, 60_000);
      for (const e of page) entries.set(e.sort, e);
      if (page.length < ENTRY_PAGE) break;
      from = `${page.at(-1)!.sort}00`;
    }
    let differing = 0;
    const seen = new Set<string>();
    sorts.forEach((sort, i) => {
      const hex = sort.toString('hex');
      seen.add(hex);
      const e = entries.get(hex);
      if (!e || (e.digest !== digests[i]!.toString('hex') && e.generation <= generation)) differing++;
    });
    for (const e of entries.values()) if (!seen.has(e.sort) && e.generation <= generation) differing++;
    return { repaired: differing, displaced: (await replace()).displaced };
  }
}
