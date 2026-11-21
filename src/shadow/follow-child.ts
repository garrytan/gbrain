/**
 * The shadow follower, child side (shadow follow, plan PR 1). The serving process sends `apply` lines (rows to store),
 * `watermark` and `depth` lines, and `rpc` lines (reconcile's calls into the Rust store); this applies them in order,
 * one at a time, and keeps `follower.json`: applied rows, apply lag histograms, queue depth, the coverage watermark,
 * fingerprint totals and the probe and allocator results. Every number is an EPOCH total (one epoch is one seed).
 *
 * Coverage watermark. Valid means: every committed primary write up to `through` is in the store, or a reconcile
 * pass has proven it. The first reason it went invalid is kept. Only an explicit restore (a clean reconcile pass that
 * started after the last invalidation) makes it valid again. A child that did not stop cleanly starts invalid.
 */
import type { RustStore } from '../core/rust-engine/store.ts';
import { countFingerprintMismatches, PROBE_CORPUS, probeRecord, type FingerprintPair } from './fingerprints.ts';
import { lagBucket, NOT_RUN_PROBE, readFollowerFile, writeFollowerFile, type FollowerFile } from './follow-status.ts';
import { readSeedRecord } from './seed.ts';

/** The store calls the follower makes; RustStore has them all. */
export type FollowStore = Pick<RustStore, 'replaceRelationRows' | 'replaceInterval' | 'relationDigest' | 'relationEntries' | 'allocatorCheck' | 'factFingerprints' | 'seedPlan'>;

export const FOLLOW_CHILD_QUEUE_BOUND = 1024;
const WRITE_EVERY_MS = 1_000;

interface ApplyEvent {
  t: 'apply'; seq: number; committed_at: number; relation: string; generation: number; queued?: number;
  keys: Parameters<RustStore['replaceRelationRows']>[3]; rows: Record<string, string | null>[];
  digests: Parameters<RustStore['replaceRelationRows']>[5]; fp?: (FingerprintPair | null)[];
}
export type FollowEvent = ApplyEvent
  | { t: 'watermark'; valid: false; reason: string }
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
}

const errorCode = (error: unknown): string => (error as { code?: string })?.code ?? (error instanceof Error ? error.name : 'rpc_failed');

export class FollowChild {
  private readonly seedId: string | null;
  private readonly file: FollowerFile | null;
  private chain: Promise<void> = Promise.resolve();
  private depth = 0;
  private servingQueued = 0;
  private readonly waiting: number[] = [];
  private lastWrite = 0;
  private lastInvalidatedAt = 0;
  private readonly now: () => number;

  constructor(private readonly o: FollowChildOptions) {
    this.now = o.now ?? Date.now;
    const seed = readSeedRecord(o.dir);
    this.seedId = seed?.seed_id ?? null;
    if (!seed) { this.file = null; return; }
    const old = readFollowerFile(o.dir);
    const keep = old && old.epoch_id === seed.seed_id ? old : null;
    this.file = keep ?? {
      version: 1, epoch_id: seed.seed_id, epoch_started_at: seed.finished_at, updated_at: new Date(this.now()).toISOString(), applied_rows: 0,
      queue_depth: 0, lag_ms: 0, last_seq: null, watermark: { valid: false, through: null, invalidated_reason: 'not_reconciled' },
      lag: { epoch: [], hours: {} }, fingerprints: { checked_rows: 0, mismatches: 0 }, probe: NOT_RUN_PROBE,
      allocators: { verified: false, checked_at: null }, clean_stop: false,
    };
    if (keep && !keep.clean_stop && keep.watermark.valid) this.invalidate('follower_restarted');
    this.file.clean_stop = false;
  }

  /** Queues one event; ordering is the order of calls. */
  handle(event: FollowEvent): void {
    if (event.t === 'depth') { this.servingQueued = event.queued; return; }
    const apply = event.t === 'apply';
    if (apply && this.depth >= FOLLOW_CHILD_QUEUE_BOUND) { this.invalidate('child_queue_full'); return; }
    if (apply) { this.depth++; this.servingQueued = event.queued ?? 0; this.waiting.push(event.committed_at); }
    this.chain = this.chain.then(() => this.run(event)).catch(() => { /* run never throws */ }).finally(() => { if (apply) this.depth--; });
  }

  /** Flushes follower.json (called on the heartbeat). */
  tick(): void { this.write(true); }

  async close(): Promise<void> {
    await this.chain;
    if (this.file && this.depth === 0 && this.servingQueued === 0) this.file.clean_stop = true;
    this.write(true);
  }

  private async run(event: FollowEvent): Promise<void> {
    if (event.t === 'apply') await this.apply(event);
    else if (event.t === 'watermark') this.invalidate(event.reason);
    else if (event.t === 'rpc') await this.rpc(event);
    this.write(false);
  }

  private invalidate(reason: string): void {
    this.lastInvalidatedAt = this.now();
    const w = this.file?.watermark;
    if (!w || !w.valid) return;
    w.valid = false; w.through = null; w.invalidated_reason = reason;
  }

  private async apply(e: ApplyEvent): Promise<void> {
    const file = this.file;
    const store = this.o.owner() ? await this.o.store() : null;
    const done = (): void => { const i = this.waiting.indexOf(e.committed_at); if (i >= 0) this.waiting.splice(i, 1); };
    if (!file || !store) { done(); this.invalidate(`apply_failed:${this.o.owner() ? 'addon_unavailable' : 'not_owner'}`); return; }
    try {
      const result = await store.replaceRelationRows(file.epoch_id, e.relation, e.generation, e.keys, e.rows, e.digests);
      file.applied_rows += result.upserted + result.deleted;
      file.last_seq = e.seq;
      const at = this.now();
      const bucket = lagBucket(Math.max(0, at - e.committed_at));
      const hour = String(Math.floor(at / 3_600_000));
      file.lag.epoch[bucket] = (file.lag.epoch[bucket] ?? 0) + 1;
      const hourly = file.lag.hours[hour] ??= [];
      hourly[bucket] = (hourly[bucket] ?? 0) + 1;
      for (const h of Object.keys(file.lag.hours)) if (Number(h) < Number(hour) - 24) delete file.lag.hours[h];
      if (file.watermark.valid) file.watermark.through = new Date(e.committed_at).toISOString();
      if (e.fp) {
        const rust = await store.factFingerprints(e.rows.map((r) => r.fact ?? ''));
        const pairs = e.fp.filter((p): p is FingerprintPair => p !== null);
        file.fingerprints.checked_rows += pairs.length;
        file.fingerprints.mismatches += countFingerprintMismatches(pairs, rust);
      }
    } catch (error) {
      this.invalidate(`apply_failed:${errorCode(error)}`);
    } finally { done(); }
  }

  private async rpc(e: Extract<FollowEvent, { t: 'rpc' }>): Promise<void> {
    let line: Record<string, unknown>;
    try { line = { t: 'resp', id: e.id, ok: true, value: await this.call(e.method, e.args) }; } catch (error) {
      line = { t: 'resp', id: e.id, ok: false, error: { code: errorCode(error), message: error instanceof Error ? error.message.slice(0, 300) : 'failed' } };
    }
    try { this.o.writeControl(JSON.stringify(line) + '\n'); } catch { /* parent gone */ }
  }

  private async call(method: string, a: Record<string, unknown>): Promise<unknown> {
    const file = this.file;
    if (!file || !this.seedId) throw Object.assign(new Error('the store has no seed'), { code: 'not_seeded' });
    if (!this.o.owner()) throw Object.assign(new Error('another process owns the Rust store'), { code: 'not_owner' });
    const store = await this.o.store();
    if (!store) throw Object.assign(new Error('the Rust addon is unavailable'), { code: 'addon_unavailable' });
    const id = this.seedId;
    const lo = (a.lo ?? null) as string | null;
    const hi = (a.hi ?? null) as string | null;
    switch (method) {
      case 'state': return { ...file.watermark };
      case 'seedPlan': return store.seedPlan();
      case 'relationDigest': return store.relationDigest(id, a.relation as string, lo, hi);
      case 'relationEntries': return store.relationEntries(id, a.relation as string, lo, hi, a.limit as number);
      case 'replaceInterval': {
        const result = await store.replaceInterval(id, a.relation as string, a.generation as number, lo, hi, a.rows as ApplyEvent['rows'], a.digests as ApplyEvent['digests']);
        file.applied_rows += result.upserted + result.deleted;
        return result;
      }
      case 'allocatorCheck': {
        const checks = await store.allocatorCheck(id, a.primaryMax as Record<string, string | null>);
        file.allocators = { verified: checks.every((c) => c.ok), checked_at: new Date(this.now()).toISOString() };
        return checks;
      }
      case 'probe': {
        const rust = await store.factFingerprints([...PROBE_CORPUS]);
        file.probe = probeRecord(a.sql as FingerprintPair[], rust, { server_version: (a.server_version ?? null) as string | null, collation: (a.collation ?? null) as string | null }, new Date(this.now()));
        return file.probe;
      }
      case 'watermark': {
        const w = file.watermark;
        if (a.valid === false) this.invalidate(String(a.reason ?? 'invalidated'));
        else if (this.lastInvalidatedAt < (a.since as number) && (!a.onlyIfReason || (w.invalidated_reason ?? '').startsWith(a.onlyIfReason as string))) {
          file.watermark = { valid: true, through: new Date(a.since as number).toISOString(), invalidated_reason: null };
        }
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
