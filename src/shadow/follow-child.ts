/**
 * The shadow follower, child side (shadow follow, plan PR 1). The serving process sends `apply` lines (rows to store),
 * `watermark` and `depth` lines, and `rpc` lines (reconcile's calls into the Rust store); this applies them in order,
 * one at a time, and keeps `follower.json`: applied rows, apply lag histograms, queue depth, the coverage watermark,
 * fingerprint totals and the probe and allocator results. Every number is an EPOCH total (one epoch is one seed).
 *
 * Coverage watermark. Valid means: every committed primary write up to `through` is in the store, or a reconcile
 * pass has proven it. The first reason it went invalid is kept. The child holds the obligations behind an invalid
 * watermark: `fullAt` (something that only a full pass can prove: the time of the last such invalidation) and `dirty`
 * (relations a pass for just those relations repairs, with the time each was last marked). A restore names the time
 * its pass started: it settles an obligation only when that is older than the pass, and the watermark is valid again
 * only when no obligation is left. Every owner session starts with a full obligation, so a restart is never trusted.
 *
 * Only one child owns the Rust store. A child that does not (another process's) cannot apply anything, so it appends
 * a line to `follower-invalidations.jsonl` for every write it was handed; the owner reads those lines before it
 * advances the watermark and treats each as a full obligation that lasts a second past the line (FOREIGN_LEASE_MS),
 * which covers the writes whose lines were throttled.
 */
import { appendFileSync, closeSync, openSync, readSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RustStore } from '../core/rust-engine/store.ts';
import { countFingerprintMismatches, PROBE_CORPUS, probeRecord, type FingerprintPair, type ProbeMeta } from './fingerprints.ts';
import { lagBucket, NOT_RUN_PROBE, readFollowerFile, writeFollowerFile, type FollowerFile } from './follow-status.ts';
import { readSeedRecord } from './seed.ts';

/** The store calls the follower makes; RustStore has them all. */
export type FollowStore = Pick<RustStore, 'replaceRelationRows' | 'replaceInterval' | 'relationDigest' | 'relationEntries' | 'allocatorCheck' | 'factFingerprints' | 'seedPlan'>;

export const FOLLOW_CHILD_QUEUE_BOUND = 1024;
const WRITE_EVERY_MS = 1_000;
const FOREIGN_FILE = 'follower-invalidations.jsonl';
const FOREIGN_LEASE_MS = 1_000;

interface ApplyEvent {
  t: 'apply'; seq: number; committed_at: number; relation: string; generation: number; queued?: number;
  keys: Parameters<RustStore['replaceRelationRows']>[3]; rows: Record<string, string | null>[];
  digests: Parameters<RustStore['replaceRelationRows']>[5]; fp?: (FingerprintPair | null)[];
}
export type FollowEvent = ApplyEvent
  | { t: 'watermark'; valid: false; reason: string; relation?: string }
  | { t: 'depth'; queued: number }
  | { t: 'rpc'; id: number; method: string; args: Record<string, unknown> };

export interface FollowChildOptions {
  dir: string;
  /** The Rust store, or null when the addon is unavailable. */
  store: () => Promise<FollowStore | null>;
  /** The child owns the Rust store (a second process's child is an ipc client and writes nothing). */
  owner: () => boolean;
  writeControl: (line: string) => void;
  now?: () => number;
  /** Called with the boundary (`apply`, `fingerprint`, `reconcile`) and the error whenever a Rust call in the follower throws. */
  onRustError?: (boundary: string, error: unknown) => void;
  /**
   * The evidence epoch the readiness inputs below are counted under (evidence-epoch.ts), or null when this child has none.
   * Left out, nothing is tagged (the follower knows no epochs). The store calls keep using the seed id.
   */
  epochId?: () => string | null;
}

const errorCode = (error: unknown): string => (error as { code?: string })?.code ?? (error instanceof Error ? error.name : 'rpc_failed');

export class FollowChild {
  private readonly file: FollowerFile | null;
  private chain: Promise<void> = Promise.resolve();
  private depth = 0;
  private servingQueued = 0;
  private readonly waiting: number[] = [];
  private lastWrite = 0;
  private fullAt: number | null = null;
  private readonly dirty = new Map<string, number>();
  private foreignOffset = 0;
  private lastForeign = 0;
  private foreignTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;

  constructor(private readonly o: FollowChildOptions) {
    this.now = o.now ?? Date.now;
    const seed = readSeedRecord(o.dir);
    if (seed?.digests !== true) { this.file = null; return; } // no seed, or one written before follow: nothing to follow
    const old = readFollowerFile(o.dir);
    const keep = old && old.seed_id === seed.seed_id ? old : null;
    this.file = keep ?? {
      version: 1, epoch_id: seed.seed_id, seed_id: seed.seed_id, epoch_started_at: seed.finished_at, updated_at: new Date(this.now()).toISOString(), applied_rows: 0,
      queue_depth: 0, lag_ms: 0, last_seq: null, watermark: { valid: false, through: null, invalidated_reason: 'not_reconciled' },
      lag: { epoch: [], hours: {} }, fingerprints: { checked_rows: 0, mismatches: 0 }, probe: NOT_RUN_PROBE,
      allocators: { verified: false, checked_at: null },
    };
    if (!o.owner()) return;
    this.syncEpoch();
    // A new owner session proves nothing about the writes before it: only a full pass that starts after this settles it.
    this.invalidate(keep ? 'follower_session_start' : 'not_reconciled');
    try { writeFileSync(join(o.dir, FOREIGN_FILE), ''); } catch { /* no lines to miss yet */ }
  }

  /**
   * The probe, fingerprint totals, allocator verification and lag histograms are readiness evidence of ONE evidence epoch.
   * They are tagged with it (`evidence_epoch`); when the epoch is not the one they were counted under (a rotation, or a
   * file from before the tag) they start over, so the status never reports another build's evidence as this one's.
   */
  private syncEpoch(): void {
    const file = this.file;
    if (!file || !this.o.epochId || !this.o.owner()) return;
    const id = this.o.epochId();
    if ((file.evidence_epoch ?? null) === id && file.evidence_epoch !== undefined) return;
    file.evidence_epoch = id;
    file.lag = { epoch: [], hours: {} };
    file.fingerprints = { checked_rows: 0, mismatches: 0 };
    file.probe = NOT_RUN_PROBE;
    file.allocators = { verified: false, checked_at: null };
  }

  /** Queues one event; ordering is the order of calls. */
  handle(event: FollowEvent): void {
    if (event.t === 'depth') { this.servingQueued = event.queued; return; }
    const apply = event.t === 'apply';
    if (apply && this.depth >= FOLLOW_CHILD_QUEUE_BOUND) { this.invalidate('child_queue_full'); return; }
    if (apply) { this.depth++; this.servingQueued = event.queued ?? 0; this.waiting.push(event.committed_at); }
    this.chain = this.chain.then(() => this.run(event)).catch(() => { /* run never throws */ }).finally(() => { if (apply) this.depth--; });
  }

  /** True while the follower holds committed work, older than `ms`, that it has not applied (evidence for a `stale` comparison). */
  pendingBefore(ms: number): boolean { return this.waiting.some((committed) => committed < ms); }

  /** Flushes follower.json (called on the heartbeat). */
  tick(): void { this.readForeign(); this.syncEpoch(); this.write(true); }

  async close(): Promise<void> {
    await this.chain;
    if (this.foreignTimer) { clearTimeout(this.foreignTimer); this.foreignTimer = null; this.appendForeign('closing'); }
    this.write(true);
  }

  private async run(event: FollowEvent): Promise<void> {
    this.syncEpoch();
    if (event.t === 'apply') await this.apply(event);
    else if (event.t === 'watermark') this.invalidate(event.reason, event.relation);
    else if (event.t === 'rpc') await this.rpc(event);
    this.write(false);
  }

  /** `relation` makes only that relation dirty; `until` (default now) is the time a pass must start after to settle it. */
  private invalidate(reason: string, relation?: string, until = this.now()): void {
    const w = this.file?.watermark;
    if (!w) return;
    if (!this.o.owner()) { this.noteForeign(reason); return; }
    if (relation) this.dirty.set(relation, Math.max(this.dirty.get(relation) ?? 0, until));
    else this.fullAt = Math.max(this.fullAt ?? 0, until);
    if (!w.valid) return;
    w.valid = false; w.through = null; w.invalidated_reason = reason;
  }

  /** The store removed rows to make room for a write: the relation differs from the primary until a pass for it repairs it (a displaced page takes its tags with it, so `tags` too). */
  private relationDisplaced(relation: string): void {
    for (const dirty of relation === 'pages' ? [relation, 'tags'] : [relation]) {
      this.invalidate('relation_dirty', dirty);
      try { this.o.writeControl(`${JSON.stringify({ t: 'dirty', relation: dirty })}\n`); } catch { /* parent gone */ }
    }
  }

  /** Not the owner: leaves a line for the owner (at most one a second; the last one waits for its turn). */
  private noteForeign(reason: string): void {
    const wait = FOREIGN_LEASE_MS - (this.now() - this.lastForeign);
    if (wait <= 0) { this.appendForeign(reason); return; }
    if (this.foreignTimer) return;
    this.foreignTimer = setTimeout(() => { this.foreignTimer = null; this.appendForeign(reason); }, wait);
    (this.foreignTimer as { unref?: () => void }).unref?.();
  }

  private appendForeign(reason: string): void {
    this.lastForeign = this.now();
    try { appendFileSync(join(this.o.dir, FOREIGN_FILE), `${JSON.stringify({ at: this.lastForeign, pid: process.pid, reason })}\n`); } catch { /* the owner learns at its next full pass */ }
  }

  /** The owner: takes in the lines other processes' children appended since it last looked. */
  private readForeign(): void {
    if (!this.file || !this.o.owner()) return;
    try {
      const path = join(this.o.dir, FOREIGN_FILE);
      const size = statSync(path).size;
      if (size < this.foreignOffset) this.foreignOffset = 0;
      if (size === this.foreignOffset) return;
      const buffer = Buffer.alloc(size - this.foreignOffset);
      const fd = openSync(path, 'r');
      try { readSync(fd, buffer, 0, buffer.length, this.foreignOffset); } finally { closeSync(fd); }
      const whole = buffer.subarray(0, buffer.lastIndexOf(10) + 1);
      this.foreignOffset += whole.length;
      for (const line of whole.toString('utf8').split('\n')) {
        if (!line) continue;
        let parsed: { at?: unknown; reason?: unknown } | null = null;
        try { parsed = JSON.parse(line) as { at?: unknown; reason?: unknown } | null; } catch { /* a malformed line counts as a write below */ }
        if (typeof parsed?.at === 'number' && typeof parsed.reason === 'string') this.invalidate(`foreign_write:${parsed.reason}`, undefined, parsed.at + FOREIGN_LEASE_MS);
        else this.invalidate('full_required');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.invalidate('full_required'); // no file: no other writer; any other failure: writes may be unseen
    }
  }

  /** A pass that started at `since` settled these `relations` (or everything, for a full pass). */
  private restore(since: number, relations: string[] | undefined): void {
    const file = this.file!;
    if (!relations && this.fullAt !== null && this.fullAt < since) this.fullAt = null;
    for (const [relation, at] of this.dirty) if (at < since && (!relations || relations.includes(relation))) this.dirty.delete(relation);
    if (this.fullAt === null && this.dirty.size === 0 && !file.watermark.valid) {
      file.watermark = { valid: true, through: new Date(since).toISOString(), invalidated_reason: null };
    }
  }

  private async apply(e: ApplyEvent): Promise<void> {
    const file = this.file;
    this.readForeign();
    const store = this.o.owner() ? await this.o.store() : null;
    const done = (): void => { const i = this.waiting.indexOf(e.committed_at); if (i >= 0) this.waiting.splice(i, 1); };
    if (!file || !store) { done(); this.invalidate(`apply_failed:${this.o.owner() ? 'addon_unavailable' : 'not_owner'}`); return; }
    let boundary = 'apply';
    try {
      const result = await store.replaceRelationRows(file.seed_id, e.relation, e.generation, e.keys, e.rows, e.digests);
      file.applied_rows += result.upserted + result.deleted;
      file.last_seq = e.seq;
      if (result.displaced > 0) this.relationDisplaced(e.relation);
      const at = this.now();
      const bucket = lagBucket(Math.max(0, at - e.committed_at));
      const hour = String(Math.floor(at / 3_600_000));
      file.lag.epoch[bucket] = (file.lag.epoch[bucket] ?? 0) + 1;
      const hourly = file.lag.hours[hour] ??= [];
      hourly[bucket] = (hourly[bucket] ?? 0) + 1;
      for (const h of Object.keys(file.lag.hours)) if (Number(h) < Number(hour) - 24) delete file.lag.hours[h];
      if (file.watermark.valid) file.watermark.through = new Date(e.committed_at).toISOString();
      if (e.fp) {
        boundary = 'fingerprint';
        const rust = await store.factFingerprints(e.rows.map((r) => r.fact ?? ''));
        const pairs = e.fp.filter((p): p is FingerprintPair => p !== null);
        file.fingerprints.checked_rows += pairs.length;
        file.fingerprints.mismatches += countFingerprintMismatches(pairs, rust);
      }
    } catch (error) {
      this.o.onRustError?.(boundary, error);
      this.invalidate(`apply_failed:${errorCode(error)}`);
    } finally { done(); }
  }

  private async rpc(e: Extract<FollowEvent, { t: 'rpc' }>): Promise<void> {
    let line: Record<string, unknown>;
    try { line = { t: 'resp', id: e.id, ok: true, value: await this.call(e.method, e.args) }; } catch (error) {
      this.o.onRustError?.(e.method === 'probe' ? 'fingerprint' : 'reconcile', error);
      line = { t: 'resp', id: e.id, ok: false, error: { code: errorCode(error), message: error instanceof Error ? error.message.slice(0, 300) : 'failed' } };
    }
    try { this.o.writeControl(JSON.stringify(line) + '\n'); } catch { /* parent gone */ }
  }

  private async call(method: string, a: Record<string, unknown>): Promise<unknown> {
    const file = this.file;
    if (!file) throw Object.assign(new Error('the store has no seed'), { code: 'not_seeded' });
    if (!this.o.owner()) throw Object.assign(new Error('another process owns the Rust store'), { code: 'not_owner' });
    const store = await this.o.store();
    if (!store) throw Object.assign(new Error('the Rust addon is unavailable'), { code: 'addon_unavailable' });
    const id = file.seed_id;
    const lo = (a.lo ?? null) as string | null;
    const hi = (a.hi ?? null) as string | null;
    switch (method) {
      case 'state': this.readForeign(); return { ...file.watermark };
      case 'seedPlan': return store.seedPlan();
      case 'relationDigest': return store.relationDigest(id, a.relation as string, lo, hi);
      case 'relationEntries': return store.relationEntries(id, a.relation as string, lo, hi, a.limit as number);
      case 'replaceInterval': {
        const result = await store.replaceInterval(id, a.relation as string, a.generation as number, lo, hi, a.rows as ApplyEvent['rows'], a.digests as ApplyEvent['digests']);
        file.applied_rows += result.upserted + result.deleted;
        if (result.displaced > 0) this.relationDisplaced(a.relation as string);
        return result;
      }
      case 'allocatorCheck': {
        const checks = await store.allocatorCheck(id, a.primaryMax as Record<string, string | null>);
        file.allocators = { verified: checks.every((c) => c.ok), checked_at: new Date(this.now()).toISOString() };
        return checks;
      }
      case 'probe': {
        const rust = await store.factFingerprints([...PROBE_CORPUS]);
        const { sql, ...meta } = a as { sql: FingerprintPair[] } & Partial<ProbeMeta>;
        file.probe = probeRecord(sql, rust, meta, new Date(this.now()));
        return file.probe;
      }
      case 'watermark': {
        this.readForeign();
        this.restore(a.since as number, a.relations as string[] | undefined);
        return { ...file.watermark };
      }
      default: throw Object.assign(new Error(`unknown method ${method}`), { code: 'unknown_method' });
    }
  }

  private write(force: boolean): void {
    const file = this.file;
    if (!file || !this.o.owner()) return;
    const at = this.now();
    if (!force && at - this.lastWrite < WRITE_EVERY_MS) return;
    this.lastWrite = at;
    file.updated_at = new Date(at).toISOString();
    file.queue_depth = this.servingQueued + this.depth;
    file.lag_ms = this.waiting.length ? Math.max(0, at - Math.min(...this.waiting)) : 0;
    try { writeFollowerFile(this.o.dir, file); } catch { /* a full disk loses the status, never the follower */ }
  }
}
