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
 *
 * A full pass saves its progress (`reconcile/progress.json`) after every interval. A process that closes in the middle
 * of one records no pass (closing is not a failed pass) and leaves the progress; the next process's first check resumes
 * it only under the same follower continuity (follow-child.ts: an unbroken run of owner sessions, each confirmed to
 * continue the one before it), so a brain served only in short sessions still completes full passes.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { quoteIdent, readKeysetRows, type DigestPlan, type KeysetRow } from '../core/persistence/graduation-digest.ts';
import type { SeedEntry, SeedFollowResult, SeedIntervalDigest, SeedPlan, SeedRelationPlan } from '../core/rust-engine/store.ts';
import { hasFingerprintFunctions, probeOnPrimary } from './fingerprints.ts';
import { appendPass, NIGHTLY_MS, readPasses, type PassRecord, type Watermark } from './follow-status.ts';
import { intervalDigest, rowDigest, sortKey, sortKeyUnsupported } from './follow-digest.ts';
import { nextGeneration, type ShadowFollower } from './follower.ts';
import { primaryTables } from './seed-gaps.ts';
import { ACTIVE_REFRESH_STATES_SQL } from '../core/persistence/worktree-refresh-schema.ts';
import type { ReadSource } from './read-pool.ts';
import { readSeedRecord, relationRead } from './seed.ts';
import { readEpoch } from './evidence-epoch.ts';

export const RECONCILE_INTERVAL_ROWS = 500;
const ENTRY_PAGE = 5000;
const INVALID_RETRY_MS = 3_600_000;
const DEBOUNCE_MS = 2_000;
const TICK_MS = 15 * 60_000;

/**
 * True when `ms` has passed since `at`. A time that cannot be read, or one in the future (the clock was set back, or the
 * file was written by a host whose clock ran ahead), counts as passed: a doubt about age runs the pass, never skips it.
 */
export function elapsed(at: string | undefined, ms: number, now = Date.now()): boolean {
  if (at === undefined) return true;
  const age = now - Date.parse(at);
  return !Number.isFinite(age) || age < 0 || age >= ms;
}

/**
 * The one rule for "a full pass is due", shared by the first check and the 15-minute tick: by age, or because the
 * last full pass was stopped (it did not finish, so the next one is due whatever its age).
 */
export const fullPassDue = (lastFull: PassRecord | undefined, now = Date.now()): boolean => lastFull?.error === 'stopped' || elapsed(lastFull?.finished_at, NIGHTLY_MS, now);
/**
 * A process that has run this long after it started checks whether its watermark needs a full pass. Short: an MCP
 * client keeps a stdio serve session for seconds, and a pass that cannot finish in one resumes in the next.
 */
export const FIRST_CHECK_MS = 5_000;

export interface ReconcilerOptions {
  dir: string;
  reads: ReadSource;
  rpc: <T>(method: string, args?: Record<string, unknown>, timeoutMs?: number) => Promise<T>;
  /** The serving follower, when this process has one: a pass waits for it to drain and reads its invalidations. */
  follower?: ShadowFollower | null;
  /** Rows per interval; tests make it small to walk several intervals. */
  intervalRows?: number;
  /** Awaited before the first check: the serving process's seal confirmation (seal.ts), so the check sees its outcome. */
  ready?: () => Promise<void>;
}

/** What the child's `state` call answers: the watermark, and the continuity a half-done pass may resume under. */
type StateReply = Watermark & { continuity?: string | null };

/** A full pass in progress, saved after each interval so a later process with the same continuity can finish it. */
interface PassProgress {
  version: 1;
  id: string;
  started_at: string;
  pass_start: number;
  valid_at_start: boolean;
  continuity: string;
  seed_id: string | null;
  epoch_id: string | null;
  verified: boolean;
  settled: string[];
  maxima: Record<string, string>;
  repaired_rows: number;
  repaired_by_relation: Record<string, number>;
  follower_misses: number;
  /** Relations walked to the end. */
  done: string[];
  /** Where the relation being walked continues: the next interval's lower bound, the last key read, rows displaced so far. */
  cursor: { relation: string; lo: string; after: string[]; displaced: number } | null;
}

const progressPath = (dir: string): string => join(dir, 'reconcile', 'progress.json');

function readProgress(dir: string): PassProgress | null {
  // silent-read-ok: a missing or torn progress file only means the next full pass starts from the beginning.
  try { const p = JSON.parse(readFileSync(progressPath(dir), 'utf8')) as PassProgress; return p?.version === 1 ? p : null; } catch { return null; }
}

function writeProgress(dir: string, p: PassProgress): boolean {
  try {
    mkdirSync(join(dir, 'reconcile'), { recursive: true, mode: 0o700 });
    const tmp = `${progressPath(dir)}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(p) + '\n', { mode: 0o600 });
    renameSync(tmp, progressPath(dir));
    return true;
  } catch { return false; } // silent-read-ok: false tells the caller the resume point is not saved; a pass that repaired rows then records them another way
}

function clearProgress(dir: string): void {
  try { rmSync(progressPath(dir), { force: true }); } catch { /* the next pass checks the continuity anyway */ }
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

  /**
   * Runs one pass after any pass already running. Never rejects: failures are in the record's `error`. `resume` lets a
   * full pass continue the one a closed process left half done (same continuity, seed and evidence epoch).
   */
  run(kind: 'full' | 'dirty', relations?: string[], o: { resume?: boolean } = {}): Promise<PassRecord> {
    const next = this.chain.then(() => this.pass(kind, relations, o.resume === true));
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Waits, at most `ms`, for the passes queued so far to end (after `stop()` one ends at its next read). */
  async idle(ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.chain, new Promise((resolve) => { timer = setTimeout(resolve, ms); unref(timer); })]);
    if (timer) clearTimeout(timer);
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
   * FIRST_CHECK_MS after start when the watermark is invalid then (once a seal is confirmed or refused), a pass is
   * left half done, or the last full pass is 24 h old. A command that exits sooner never runs it.
   */
  startNightly(): void {
    if (this.nightly) return;
    this.nightly = setInterval(() => { void this.tick(); }, TICK_MS);
    this.firstCheck = setTimeout(() => { void this.firstRun(); }, FIRST_CHECK_MS);
    unref(this.nightly);
    unref(this.firstCheck);
  }

  private async firstRun(): Promise<void> {
    try {
      await this.o.ready?.();
      if (this.stopped) return;
      const w = await this.o.rpc<StateReply>('state', {}, 10_000);
      const lastFull = readPasses(this.o.dir).filter((p) => p.kind === 'full').at(-1);
      const due = !w.valid || readProgress(this.o.dir) !== null || fullPassDue(lastFull);
      if (due && !this.stopped) await this.run('full', undefined, { resume: true });
    } catch { /* the nightly tick tries again */ } // silent-read-ok: no pass runs, so the watermark stays as it was (invalid until a full pass) and the nightly tick retries
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
      let due = fullPassDue(lastFull);
      if (!due && last && elapsed(last.finished_at, INVALID_RETRY_MS)) due = !(await this.o.rpc<Watermark>('state', {}, 10_000)).valid;
      if (due) await this.run('full');
    } catch { /* the next tick tries again */ }
  }

  private async pass(kind: 'full' | 'dirty', only?: string[], resume = false): Promise<PassRecord> {
    const startedAt = new Date().toISOString();
    const rec: PassRecord = { id: `pass-${startedAt.replace(/[-:.]/g, '')}-${randomUUID().slice(0, 4)}`, kind, started_at: startedAt, finished_at: startedAt, repaired_rows: 0, repaired_by_relation: {}, follower_misses: 0 };
    let verified = true;
    let repairFailed = false;
    let probeFailed = false;
    let passStart = Date.now();
    const settled: string[] = [];
    const resumable = kind === 'full' && !only;
    let progress: PassProgress | null = null;
    let lastCursor: PassProgress['cursor'] = null;
    let countsSaved = true;
    let saveCounts: () => boolean = () => false;
    try {
      await this.o.follower?.settle();
      const barrier = await this.o.rpc<StateReply>('state', {}, 30_000);
      const plan = await this.o.rpc<SeedPlan>('seedPlan', {}, 30_000);
      passStart = Date.now();
      let validAtStart = barrier.valid && (this.o.follower?.lastInvalidatedAt ?? 0) < passStart;
      const tables = new Set(await this.read((_, query) => primaryTables(query)));
      const maxima: Record<string, string> = {};
      const done = new Set<string>();
      let cursor: PassProgress['cursor'] = null;
      if (resumable) {
        const continuity = typeof barrier.continuity === 'string' && barrier.continuity ? barrier.continuity : null;
        const seedId = readSeedRecord(this.o.dir)?.seed_id ?? null;
        const epochId = readEpoch(this.o.dir)?.epoch_id ?? null;
        const prior = resume && continuity ? readProgress(this.o.dir) : null;
        // A resume point whose pass is already in the log is left over from a finished pass whose removal failed: that
        // pass is never continued (it would be counted again with no new scan), and an unreadable log refuses it too.
        let finished = true;
        if (prior) { try { finished = readPasses(this.o.dir).some((p) => p.id === prior.id); } catch { finished = true; } } // silent-read-ok: an unreadable pass log refuses the resume (a fresh scan)
        if (prior && !finished && prior.continuity === continuity && prior.seed_id === seedId && prior.epoch_id === epochId) {
          // The same pass, continued: its start (what its restore settles), its counts and where it stopped.
          Object.assign(rec, { id: prior.id, started_at: prior.started_at, repaired_rows: prior.repaired_rows, repaired_by_relation: { ...prior.repaired_by_relation }, follower_misses: prior.follower_misses });
          passStart = prior.pass_start; validAtStart = prior.valid_at_start; verified = prior.verified;
          settled.push(...prior.settled); Object.assign(maxima, prior.maxima);
          for (const relation of prior.done) done.add(relation);
          cursor = prior.cursor;
          lastCursor = prior.cursor;
        } else clearProgress(this.o.dir);
        if (continuity) {
          progress = {
            version: 1, id: rec.id, started_at: rec.started_at, pass_start: passStart, valid_at_start: validAtStart, continuity, seed_id: seedId, epoch_id: epochId,
            verified, settled, maxima, repaired_rows: 0, repaired_by_relation: {}, follower_misses: 0, done: [], cursor: null,
          };
        }
      }
      // `at` is where a resumed pass continues; it is always at or before the interval being walked, so a resume reads
      // that interval again. `countsSaved` is false from a repair until a save that holds it lands.
      const save = (at: PassProgress['cursor']): boolean => {
        lastCursor = at;
        if (!progress) return false;
        const ok = writeProgress(this.o.dir, { ...progress, verified, settled: [...settled], maxima: { ...maxima }, repaired_rows: rec.repaired_rows, repaired_by_relation: { ...rec.repaired_by_relation }, follower_misses: rec.follower_misses, done: [...done], cursor: at });
        if (ok) countsSaved = true;
        return ok;
      };
      saveCounts = () => save(lastCursor);
      for (const rp of plan.relations) {
        if (only && !only.includes(rp.relation)) continue;
        if (done.has(rp.relation)) continue;
        if (!tables.has(rp.relation)) { settled.push(rp.relation); done.add(rp.relation); continue; }
        const read = await this.read((tx) => relationRead(tx, rp.relation, rp.key));
        if (sortKeyUnsupported(read.key)) { verified = false; done.add(rp.relation); save(null); continue; }
        const from = cursor?.relation === rp.relation ? cursor : null;
        cursor = null;
        const displaced = await this.relation(rp, read, validAtStart, rec, from, (lo, after, displaced) => save({ relation: rp.relation, lo, after, displaced }), () => { countsSaved = false; save(lastCursor); });
        if (displaced > 0) { verified = false; this.markDirty(rp.relation); } else settled.push(rp.relation);
        const [k] = read.key;
        if (kind === 'full' && read.key.length === 1 && k!.name === 'id' && ['smallint', 'integer', 'bigint'].includes(k!.type)) {
          const [row] = await this.read((_, query) => query(`SELECT max("id")::text AS m FROM ${quoteIdent(rp.relation)}`));
          if (typeof row?.m === 'string' && /^\d+$/.test(row.m)) maxima[rp.relation] = row.m;
        }
        done.add(rp.relation);
        save(null);
      }
      // The probe's answer depends on the stored facts and purge tombstones: a dirty pass for either runs it again, so a tombstone
      // added after a passing probe cannot be covered by a cached pass.
      // A probe that fails here leaves the obligation open: the cached verdict is cleared and coverage is not restored, so the
      // old pass cannot vouch for the new rows. The invalid watermark makes the next full pass run the probe again.
      if (kind === 'dirty' && only?.some((relation) => relation === 'facts' || relation === 'fact_purges')) {
        try { await this.probe(); } catch (error) {
          probeFailed = true;
          rec.error ??= `probe:${(error as { code?: string }).code ?? 'failed'}`;
          for (const relation of only) this.dirty.add(relation);
          try { await this.o.rpc('probeReset', {}, 30_000); } catch { /* the watermark stays invalid either way */ }
        }
      }
      if (kind === 'full') {
        try { await this.o.rpc('allocatorCheck', { primaryMax: maxima }, 60_000); } catch (error) { rec.error = `allocator_check:${(error as { code?: string }).code ?? 'failed'}`; }
        try { await this.probe(); } catch (error) { rec.error ??= `probe:${(error as { code?: string }).code ?? 'failed'}`; }
        try { rec.nonterminal_refresh_rows = !tables.has('persistence_worktree_refreshes') ? 0 : Number((await this.read((_, query) => query(`SELECT count(*)::int AS n FROM persistence_worktree_refreshes WHERE state IN ${ACTIVE_REFRESH_STATES_SQL}`)))[0]?.n); } catch (error) { rec.error ??= `refresh_count:${(error as { code?: string }).code ?? 'failed'}`; }
      }
      // Stopped during the closing checks: the walked relations are saved as done, and the next process runs only these.
      if (this.stopped) throw new Error('reconciler stopped');
    } catch (error) {
      // The process is closing (its reads were stopped): that is no failed pass. Nothing is restored, and the progress
      // (with the counts up to here) stays for the next process to resume.
      if (this.stopped) {
        rec.error = 'stopped'; rec.finished_at = new Date().toISOString();
        // Rows this pass repaired are evidence the store had drifted, and the store now holds the repair: a pass that
        // reads them again finds nothing. So a stopped pass that saw any repair or miss goes on record at once, as a
        // stopped pass (not clean, so the clean streak ends, and counted by writer coverage), and its resume point is
        // removed only after that record landed: a resume point alone is dropped by any fresh pass or new continuity.
        // A stopped pass that saw nothing keeps only its resume point, and the next process finishes it.
        if (rec.repaired_rows > 0 || rec.follower_misses > 0) {
          let recorded = false;
          try { appendPass(this.o.dir, rec); recorded = true; } catch { /* kept in the resume point below */ } // silent-read-ok: the counts stay in the resume point, and the next full pass is due (a stopped pass did not finish)
          if (recorded) clearProgress(this.o.dir);
          else if (resumable) saveCounts();
          return rec;
        }
        if (resumable && saveCounts()) return rec;
        if (!countsSaved) {
          clearProgress(this.o.dir);
          try { appendPass(this.o.dir, rec); } catch { /* a full disk loses the record */ } // silent-read-ok: nothing else can hold it; the next full pass is due anyway (the watermark was not restored)
        }
        return rec;
      }
      repairFailed = true;
      // The child still holds what it was told is dirty; a later pass for these relations repairs it.
      for (const relation of only ?? []) this.dirty.add(relation);
      rec.error = `${(error as { code?: string }).code ?? (error instanceof Error ? error.name : 'failed')}: ${error instanceof Error ? error.message.slice(0, 200) : ''}`;
    }
    // Allocator and full-pass probe failures are reported but do not decide whether the rows are covered; a failed probe of a dirty
    // pass for facts or purge tombstones does, because those rows are what it checks.
    if (resumable) clearProgress(this.o.dir);
    if (!repairFailed && !probeFailed) await this.restore(kind, passStart, verified, settled);
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
  private async relation(
    rp: SeedRelationPlan, read: DigestPlan, validAtStart: boolean, rec: PassRecord,
    from: { lo: string; after: string[]; displaced: number } | null = null, onInterval?: (lo: string, after: string[], displaced: number) => void,
    onRepaired?: () => void,
  ): Promise<number> {
    const size = this.o.intervalRows ?? RECONCILE_INTERVAL_ROWS;
    let lo: string | null = from?.lo ?? null;
    let after: readonly string[] | null = from?.after ?? null;
    let displaced = from?.displaced ?? 0;
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
        onRepaired?.(); // saved before anything else is read: the interval's own checkpoint below does not come after the last one
      }
      if (hi === null) return displaced;
      lo = hi;
      after = rows[rows.length - 1]!.key;
      onInterval?.(lo, [...after], displaced);
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
