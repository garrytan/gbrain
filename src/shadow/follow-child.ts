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
 * only when no obligation is left. Every owner session starts with a full obligation, so a restart is never trusted
 * on its own word.
 *
 * Sealing. A serving process that closes cleanly (everything it committed was handed over and applied, nothing lost)
 * sends a `seal` line last; the child then writes `seal` into follower.json: its obligations, the watermark, the size of
 * the invalidation file and its `continuity`. The next owner session takes those obligations over, provided nothing
 * else wrote the file since (`seal.at` is `updated_at`), state.json was not restarted, the evidence epoch is the same
 * and no other process left an invalidation line. It still holds a full obligation of its own (`provisionalAt`) until
 * its serving process confirms that the primary saw no other writer since the seal (seal.ts `confirmSeal`), or a full
 * pass that started after it settles it. A seal is consumed when an owner session starts, whether or not it is taken.
 *
 * Only one child owns the Rust store. A child that does not (another process's) cannot apply anything, so it appends
 * a line to `follower-invalidations.jsonl` for every write it was handed; the owner reads those lines before it
 * advances the watermark and treats each as a full obligation that lasts a second past the line (FOREIGN_LEASE_MS),
 * which covers the writes whose lines were throttled.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, openSync, readSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RustStore } from '../core/rust-engine/store.ts';
import { countFingerprintMismatches, PROBE_CORPUS, probeRecord, type FingerprintPair, type ProbeMeta } from './fingerprints.ts';
import { lagBucket, NOT_RUN_PROBE, PGLITE_NO_DB_CONTINUITY, readFollowerFile, writeFollowerFile, type FollowerFile, type FollowerSeal, type SealOutcome, type Watermark } from './follow-status.ts';
import { readSeedRecord } from './seed.ts';
import { readShadowState } from './state.ts';

/** The store calls the follower makes; RustStore has them all. */
export type FollowStore = Pick<RustStore, 'replaceRelationRows' | 'replaceInterval' | 'relationDigest' | 'relationEntries' | 'allocatorCheck' | 'factFingerprints' | 'seedPlan'>;

export const FOLLOW_CHILD_QUEUE_BOUND = 1024;
const WRITE_EVERY_MS = 1_000;
/** The watermark reason while a confirmed seal waits for its commit (seal.ts reads the primary a second time first). */
export const SEAL_CONFIRM_PENDING = 'seal_confirm_pending';
/** A commit for another mark, or with no confirmation waiting: the seal is dropped. */
export const SEAL_COMMIT_MISMATCH = 'seal_commit_mismatch';
const FOREIGN_FILE = 'follower-invalidations.jsonl';
const FOREIGN_LEASE_MS = 1_000;

/**
 * A serving process lost a write on its way to its child (the child is gone, refused the line, or the process closed):
 * leave a line for the owner, as a non-owner child does, so the owner and the next session's seal check see it.
 */
export function noteLostWrite(dir: string, reason: string, at: number = Date.now()): boolean {
  try { appendFileSync(join(dir, FOREIGN_FILE), `${JSON.stringify({ at, pid: process.pid, reason })}\n`); return true; } catch { return false; /* the caller keeps the loss and retries (lostWriteRecorder) */ }
}

/** The serving process's record of writes its child will never hear of (attach.ts `onLost`). */
export interface LostWriteRecorder {
  /** A write was lost: leave a line for the owner (one a second is enough: the owner reads any line as "a write was lost"). */
  note(reason: string): void;
  /** Before a seal: tries a loss not yet recorded again; false when it is still unrecorded (the close must not seal). */
  flush(): boolean;
  /** The loss still waiting to be recorded, or null. */
  pending(): string | null;
  stop(): void;
}

export const LOST_WRITE_UNRECORDED = 'lost_write_unrecorded';

/**
 * Only a line that was written starts the one-second throttle. A line that failed is kept as an obligation: retried on
 * an unref timer (and by the next loss, throttle or not), told at once to a live child (`invalidate`, which revokes a
 * seal it holds: follow-child.ts `revokeSeal`), and a close that cannot record it refuses to seal. A process that exits
 * while the storage still fails loses it (the residual a full pass covers).
 */
export function lostWriteRecorder(o: { dir: string; now?: () => number; retryMs?: number; invalidate?: (reason: string) => void }): LostWriteRecorder {
  const now = o.now ?? Date.now;
  let lostAt = 0;
  let pending: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const attempt = (reason: string): boolean => {
    const at = now();
    if (noteLostWrite(o.dir, reason, at)) { lostAt = at; pending = null; return true; }
    pending = reason;
    return false;
  };
  const retry = (): void => {
    if (timer || pending === null) return;
    timer = setTimeout(() => { timer = null; if (pending !== null && !attempt(pending)) retry(); }, o.retryMs ?? 1_000);
    (timer as { unref?: () => void }).unref?.();
  };
  return {
    note(reason) {
      if (pending === null && now() - lostAt < 1_000) return;
      if (attempt(reason)) return;
      try { o.invalidate?.(LOST_WRITE_UNRECORDED); } catch { /* no live child: the close refuses to seal */ }
      retry();
    },
    flush: () => pending === null || attempt(pending),
    pending: () => pending,
    stop() { if (timer) { clearTimeout(timer); timer = null; } },
  };
}

/** Size of the invalidation file: 0 when there is none, null when it cannot be read. */
function foreignSize(dir: string): number | null {
  try { return statSync(join(dir, FOREIGN_FILE)).size; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 0 : null; }
}

interface ApplyEvent {
  t: 'apply'; seq: number; committed_at: number; relation: string; generation: number; queued?: number;
  keys: Parameters<RustStore['replaceRelationRows']>[3]; rows: Record<string, string | null>[];
  digests: Parameters<RustStore['replaceRelationRows']>[5]; fp?: (FingerprintPair | null)[];
}
export type FollowEvent = ApplyEvent
  | { t: 'watermark'; valid: false; reason: string; relation?: string }
  | { t: 'depth'; queued: number }
  | { t: 'rpc'; id: number; method: string; args: Record<string, unknown> }
  | { t: 'seal'; db_at: string | null; refused?: string };

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

/** A short code for a failure: the error's `code`, else its class name, and only when it is a plain token (never text that could hold content). */
const errorCode = (error: unknown): string => {
  const raw = (error as { code?: unknown } | null)?.code ?? (error instanceof Error ? error.name : 'rpc_failed');
  return typeof raw === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(raw) ? raw : 'rpc_failed';
};

export class FollowChild {
  private readonly file: FollowerFile | null;
  private chain: Promise<void> = Promise.resolve();
  private depth = 0;
  private servingQueued = 0;
  private readonly waiting: number[] = [];
  private lastWrite = 0;
  private fullAt: number | null = null;
  private readonly dirty = new Map<string, number>();
  /** Counts everything that can change what the store holds or whether it is covered; a stable read needs it unmoved (`barrier`, `exclusive`). */
  private changes = 0;
  private foreignOffset = 0;
  private lastForeign = 0;
  private foreignTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;
  /** This owner session's continuity (null for a child that does not own the store). */
  private continuity: string | null = null;
  /** The full obligation of a session that took a seal over, until the seal is confirmed or a full pass after it settles it. */
  private provisionalAt: number | null = null;
  /** The seal this session took over and has not confirmed yet. */
  private pendingSeal: { db_at: string | null; watermark: Watermark } | null = null;
  /**
   * The seal the serving process confirmed after its first read, waiting for `commitSeal` (sent only after its second
   * read was quiet too), with the reason the watermark showed before. Held invalid until then (`seal_confirm_pending`).
   */
  private confirmedPending: { seal: { db_at: string | null; watermark: Watermark }; reason: string | null } | null = null;
  /** The seal this session wrote; dropped by anything that happens after it. */
  private seal: FollowerSeal | null = null;

  constructor(private readonly o: FollowChildOptions) {
    this.now = o.now ?? Date.now;
    const seed = readSeedRecord(o.dir);
    if (seed?.digests !== true) { this.file = null; return; } // no seed, or one written before follow: nothing to follow
    const old = readFollowerFile(o.dir);
    const keep = old && old.seed_id === seed.seed_id ? old : null;
    const seal = keep?.seal;
    this.file = keep ?? {
      version: 1, epoch_id: seed.seed_id, seed_id: seed.seed_id, epoch_started_at: seed.finished_at, updated_at: new Date(this.now()).toISOString(), applied_rows: 0,
      queue_depth: 0, lag_ms: 0, last_seq: null, watermark: { valid: false, through: null, invalidated_reason: 'not_reconciled' },
      lag: { epoch: [], hours: {} }, fingerprints: { checked_rows: 0, mismatches: 0 }, probe: NOT_RUN_PROBE,
      allocators: { verified: false, checked_at: null },
    };
    delete this.file.seal; // only the owner start below may use it, and never twice
    if (!o.owner()) { delete this.file.continuity; return; }
    // Why no seal is taken over, named in status: a close that would not seal left its own reason.
    const prior = keep?.seal_outcome;
    const refusal = !keep ? 'follower_state_reset' : !seal ? (prior?.outcome === 'not_sealed' && prior.reason ? prior.reason : 'no_seal') : this.takeSeal(keep, seal);
    if (refusal === null) { this.syncEpoch(); return; }
    this.outcome('refused', refusal);
    this.syncEpoch();
    // A new owner session proves nothing about the writes before it: only a full pass that starts after this settles it.
    this.invalidate(keep ? 'follower_session_start' : 'not_reconciled');
    this.continuity = randomUUID();
    this.file.continuity = this.continuity;
    const clear = (): boolean => { try { writeFileSync(join(o.dir, FOREIGN_FILE), ''); return true; } catch { return false; } };
    if (!seal) {
      clear(); // no seal on disk: the old lines name writes this session's own invalidation above already covers
      this.write(true);
      return;
    }
    // The seal is still on disk until this session's first write. A blocker line appended to the existing bytes (never
    // after a truncation, which could bring the file back to the seal's exact foreign size) keeps it untakeable if
    // that write fails or this process dies first. Only once the seal-free file is on disk are the old lines cleared.
    this.appendForeign('seal_revoked');
    // The old lines and its own blocker are not read back as new writes (an unknown size: all of them are).
    this.foreignOffset = foreignSize(o.dir) ?? 0;
    // Shown refused and invalid at once, with the seal removed.
    if (this.write(true) && clear()) this.foreignOffset = 0;
  }

  /**
   * Takes over the obligations a clean close sealed, when nothing could have written behind them: the file was last
   * written by that seal, state.json was not restarted, the evidence epoch is the same and no other process left an
   * invalidation line. The seal is removed from disk first, so it is used at most once. The session still holds a full
   * obligation of its own until `confirmSeal` (the primary saw no other writer since the seal) or a full pass settles it.
   */
  private takeSeal(keep: FollowerFile, seal: FollowerSeal): string | null {
    const file = this.file!;
    if (seal.version !== 1) return 'seal_unreadable';
    if (seal.at !== keep.updated_at) return 'seal_rewritten';
    if (typeof seal.continuity !== 'string' || !seal.continuity) return 'seal_no_continuity';
    // A seal with no database mark is what a PGLite close wrote: nothing proves the database was untouched since.
    if (typeof seal.db_at !== 'string' || !seal.db_at) return PGLITE_NO_DB_CONTINUITY;
    if ((seal.evidence_epoch ?? null) !== (this.o.epochId ? this.o.epochId() : null)) return 'evidence_epoch_changed';
    const state = readShadowState(this.o.dir);
    if (state?.enabled !== true) return 'shadow_disabled';
    if (state.started_at !== seal.state_started_at) return 'shadow_restarted';
    const size = foreignSize(this.o.dir);
    if (size === null) return 'invalidations_unreadable';
    if (size !== seal.foreign_size) return 'invalidation_after_seal';
    // One first write removes the seal AND shows the provisional invalid watermark: a process killed right after it
    // leaves no seal to take twice and no valid watermark the takeover has not confirmed. A failed write changes nothing
    // on disk (never a freshened valid file); the caller then leaves a blocker for the seal it could not remove.
    const at = new Date(this.now()).toISOString();
    const watermark = seal.watermark?.valid === true
      ? { valid: false, through: null, invalidated_reason: 'follower_session_start' }
      : { ...file.watermark, valid: false, through: null };
    const out: FollowerFile = { ...file, updated_at: at, watermark, seal_outcome: { outcome: 'taken', reason: null, at } };
    delete out.seal;
    try { writeFollowerFile(this.o.dir, out); } catch { return 'seal_consume_failed'; }
    Object.assign(file, out);
    this.foreignOffset = size;
    this.continuity = seal.continuity;
    this.fullAt = typeof seal.full_at === 'number' ? seal.full_at : null;
    for (const [relation, at] of Object.entries(seal.dirty ?? {})) if (typeof at === 'number') this.dirty.set(relation, at);
    this.pendingSeal = { db_at: seal.db_at ?? null, watermark: { ...seal.watermark } };
    this.provisionalAt = this.now();
    this.changes++;
    // Shown invalid until confirmed (written above); a seal that was already invalid keeps its own first reason.
    return null;
  }

  /** Records the last seal decision for status (written with the file's next write). */
  private outcome(outcome: SealOutcome['outcome'], reason: string | null): void {
    if (this.file) this.file.seal_outcome = { outcome, reason, at: new Date(this.now()).toISOString() };
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

  /**
   * The barrier's answer, handed out by the `barrier` call: the child has applied every apply line before it and the
   * coverage watermark is valid. Returns the change count to hold the read to, or throws (`watermark_invalid`).
   */
  private barrier(): number {
    this.readForeign();
    if (!this.file?.watermark.valid) throw Object.assign(new Error('the coverage watermark is not valid'), { code: 'watermark_invalid' });
    return this.changes;
  }

  /**
   * Runs `read` after everything queued before it and before anything queued after it: no apply, reconcile call or
   * invalidation runs in between. Resolves with its value when nothing changed since the barrier's `stamp` and the
   * watermark is still valid before and after the read, else null (the sample stays inconclusive).
   */
  exclusive<T, W = never>(stamp: number, read: () => Promise<T>, wait?: { ms: number; onTimeout: W }): Promise<T | W | null> {
    let abandoned = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = this.chain.then(async () => {
      if (abandoned) return null; // the caller gave up waiting for the lock: the read never runs
      if (timer) clearTimeout(timer);
      const stable = (): boolean => { this.readForeign(); return this.changes === stamp && this.file?.watermark.valid === true; };
      if (!stable()) return null;
      const value = await read();
      return stable() ? value : null;
    });
    this.chain = run.then(() => undefined, () => undefined);
    if (!wait) return run;
    // The wait for the lock has a deadline of its own: an apply that never ends holds the chain, and a caller behind it must not wait for ever.
    return Promise.race([run, new Promise<W>((resolve) => { timer = setTimeout(() => { abandoned = true; resolve(wait.onTimeout); }, Math.max(1, wait.ms)); (timer as { unref?: () => void }).unref?.(); })]);
  }

  /** Settles when everything queued so far has ended: a caller that gave up on the lock tracks it as a stall (child.ts), so a chain that never ends is seen. */
  pending(): Promise<void> { return this.chain; }

  /** Flushes follower.json (called on the heartbeat). */
  tick(): void { this.readForeign(); this.syncEpoch(); this.write(true); }

  /**
   * The last write of this session. The invalidation lines are read first: a veto the serving process appended (seal.ts
   * `revoke`) while no heartbeat or call came after it must not leave a valid file behind when the child exits.
   */
  async close(): Promise<void> {
    await this.chain;
    if (this.foreignTimer) { clearTimeout(this.foreignTimer); this.foreignTimer = null; this.appendForeign('closing'); }
    this.readForeign();
    this.write(true);
  }

  private async run(event: FollowEvent): Promise<void> {
    this.syncEpoch();
    if (event.t === 'seal') { this.sealNow(event.db_at ?? null, event.refused); return; }
    this.revokeSeal(); // anything after a seal (an apply, an invalidation, a reconcile call) voids it, on disk first
    if (event.t === 'apply') await this.apply(event);
    else if (event.t === 'watermark') this.invalidate(event.reason, event.relation);
    else if (event.t === 'rpc') await this.rpc(event);
    this.write(false);
  }

  /**
   * The serving process closed cleanly and handed over everything it committed: record the obligations for the next
   * owner session. Nothing is sealed while an invalidation line is unread (or the file cannot be read): that line names
   * a write this session holds no obligation for yet. A session start not yet confirmed is sealed as a full obligation.
   */
  private sealNow(dbAt: string | null, refused?: string): void {
    const file = this.file;
    if (!file || !this.o.owner() || this.continuity === null) return;
    const notSealed = (reason: string): void => {
      const had = this.seal !== null;
      this.seal = null;
      this.outcome('not_sealed', reason);
      if (!this.write(true) && had) this.appendForeign('seal_revoked'); // an earlier seal is still on disk: make it stale
    };
    // Read before any write here, a refused seal's included: a veto line appended since the last read is taken in.
    this.readForeign();
    if (refused) { notSealed(typeof refused === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(refused) ? refused : 'refused'); return; }
    const size = foreignSize(this.o.dir);
    if (size === null) { notSealed('invalidations_unreadable'); return; }
    if (size !== this.foreignOffset) { notSealed('invalidation_unread'); return; }
    const fullAt = this.provisionalAt === null ? this.fullAt : Math.max(this.fullAt ?? 0, this.provisionalAt);
    this.seal = {
      version: 1, at: '', continuity: this.continuity, foreign_size: size, full_at: fullAt, dirty: Object.fromEntries(this.dirty),
      watermark: { ...file.watermark }, state_started_at: readShadowState(this.o.dir)?.started_at ?? null,
      evidence_epoch: this.o.epochId ? this.o.epochId() : null, db_at: dbAt,
    };
    this.outcome('sealed', null);
    this.write(true);
  }

  /**
   * Removes a seal this session wrote, from disk before anything else happens: a process killed after the next event
   * must not leave a seal that never saw it. When that write fails the seal is still on disk, so a line in the
   * invalidation file makes its foreign size stale (the next owner then refuses it).
   */
  private revokeSeal(): void {
    if (!this.seal) return;
    this.seal = null;
    this.outcome('not_sealed', 'seal_revoked');
    if (!this.write(true)) this.appendForeign('seal_revoked');
  }

  /** `relation` makes only that relation dirty; `until` (default now) is the time a pass must start after to settle it. */
  private invalidate(reason: string, relation?: string, until = this.now()): void {
    const w = this.file?.watermark;
    if (!w) return;
    this.changes++;
    this.revokeSeal();
    if (!this.o.owner()) { this.noteForeign(reason); return; }
    if (relation) this.dirty.set(relation, Math.max(this.dirty.get(relation) ?? 0, until));
    else this.fullAt = Math.max(this.fullAt ?? 0, until);
    // The first reason is kept, except a confirmation waiting for its commit: what invalidated it is the reason then.
    if (!w.valid && w.invalidated_reason !== SEAL_CONFIRM_PENDING) return;
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
    this.changes++;
    if (!relations && this.fullAt !== null && this.fullAt < since) this.fullAt = null;
    if (!relations && this.provisionalAt !== null && this.provisionalAt < since) { this.provisionalAt = null; this.pendingSeal = null; this.confirmedPending = null; }
    for (const [relation, at] of this.dirty) if (at < since && (!relations || relations.includes(relation))) this.dirty.delete(relation);
    if (this.fullAt === null && this.provisionalAt === null && this.dirty.size === 0 && !file.watermark.valid) {
      file.watermark = { valid: true, through: new Date(since).toISOString(), invalidated_reason: null };
    }
  }

  private async apply(e: ApplyEvent): Promise<void> {
    const file = this.file;
    this.changes++;
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
      line = { t: 'resp', id: e.id, ok: false, error: { code: errorCode(error), message: errorCode(error) } }; // a code, never the exception's text: the control channel carries no content
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
      // `continuity` only once this session is known to continue the one before it (no seal waiting for its confirmation).
      case 'state': this.readForeign(); return { ...file.watermark, continuity: this.pendingSeal ? null : this.continuity, pending_seal: this.pendingSeal ? { db_at: this.pendingSeal.db_at } : null };
      case 'confirmSeal': return this.confirmSeal((a.db_at ?? null) as string | null, a.ok === true, typeof a.reason === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(a.reason) ? a.reason : 'refused');
      case 'commitSeal': return this.commitSeal((a.db_at ?? null) as string | null);
      case 'revokeSeal': return this.withdrawConfirmation(typeof a.reason === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(a.reason) ? a.reason : 'refused');
      case 'barrier': return { stamp: this.barrier() };
      case 'seedPlan': return store.seedPlan();
      case 'relationDigest': return store.relationDigest(id, a.relation as string, lo, hi);
      case 'relationEntries': return store.relationEntries(id, a.relation as string, lo, hi, a.limit as number);
      case 'replaceInterval': {
        this.changes++;
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
      case 'probeReset': file.probe = NOT_RUN_PROBE; return file.probe;
      case 'watermark': {
        this.readForeign();
        this.restore(a.since as number, a.relations as string[] | undefined);
        return { ...file.watermark };
      }
      default: throw Object.assign(new Error(`unknown method ${method}`), { code: 'unknown_method' });
    }
  }

  /**
   * The serving process checked the primary for writers since the seal this session took over (seal.ts), first read.
   * Refused, the seal is dropped, the session draws a new continuity (a half-done pass cannot resume across it) and its
   * obligation stays. Confirmed, nothing is published yet: the session stays invalid (`seal_confirm_pending`), with no
   * continuity and its own full obligation, until `commitSeal`, which the serving process sends only after a second
   * read found the primary still quiet. A heartbeat, a forced write or a status read in between shows it invalid.
   */
  private confirmSeal(dbAt: string | null, ok: boolean, reason: string): Watermark & { confirmed: boolean } {
    const file = this.file!;
    this.readForeign();
    const pending = this.pendingSeal;
    if (!pending || pending.db_at !== dbAt || this.confirmedPending) return { ...file.watermark, confirmed: false };
    this.changes++;
    if (!ok) {
      this.dropPendingSeal(reason);
      return { ...file.watermark, confirmed: false };
    }
    this.confirmedPending = { seal: pending, reason: file.watermark.invalidated_reason };
    if (!file.watermark.valid && pending.watermark.valid) file.watermark = { valid: false, through: null, invalidated_reason: SEAL_CONFIRM_PENDING };
    return { ...file.watermark, confirmed: true };
  }

  /**
   * The second phase: the serving process read the primary again after the confirmation and it was still quiet. Only
   * now does the session's own full obligation go, the sealed watermark come back when nothing else is owed, and the
   * continuity become visible (so a half-done pass can resume). Written at once. A commit for another mark, or with no
   * confirmation waiting, drops the seal like a refusal (`seal_commit_mismatch`).
   */
  private commitSeal(dbAt: string | null): Watermark & { confirmed: boolean } {
    const file = this.file!;
    this.readForeign();
    const held = this.confirmedPending;
    if (!held || held.seal !== this.pendingSeal || held.seal.db_at !== dbAt) {
      if (this.pendingSeal || held) { this.changes++; this.dropPendingSeal(SEAL_COMMIT_MISMATCH); this.write(true); }
      return { ...file.watermark, confirmed: false };
    }
    this.pendingSeal = null;
    this.confirmedPending = null;
    this.provisionalAt = null;
    this.changes++;
    this.outcome('confirmed', null);
    if (this.fullAt === null && this.dirty.size === 0 && !file.watermark.valid && held.seal.watermark.valid) file.watermark = { ...held.seal.watermark };
    else if (!file.watermark.valid && file.watermark.invalidated_reason === SEAL_CONFIRM_PENDING) file.watermark = { ...file.watermark, invalidated_reason: held.reason };
    this.write(true);
    return { ...file.watermark, confirmed: true };
  }

  /** A seal refused (or a commit that does not match): dropped, a new continuity drawn, the obligation kept, the reason shown. */
  private dropPendingSeal(reason: string): void {
    const file = this.file!;
    this.pendingSeal = null;
    if (this.confirmedPending && file.watermark.invalidated_reason === SEAL_CONFIRM_PENDING) file.watermark = { ...file.watermark, invalidated_reason: this.confirmedPending.reason };
    this.confirmedPending = null;
    this.continuity = randomUUID();
    file.continuity = this.continuity;
    this.outcome('refused', reason);
  }

  /**
   * The serving process saw a write after it confirmed the seal (seal.ts): the confirmation is withdrawn. The watermark
   * is invalid with a full obligation, a new continuity is drawn (as for a refused seal), and status names the reason.
   */
  private withdrawConfirmation(reason: string): Watermark {
    this.readForeign();
    this.pendingSeal = null;
    this.confirmedPending = null;
    this.invalidate('seal_revoked');
    this.continuity = randomUUID();
    this.file!.continuity = this.continuity;
    this.outcome('refused', reason);
    return { ...this.file!.watermark };
  }

  /** False only when the write was attempted and failed. */
  private write(force: boolean): boolean {
    const file = this.file;
    if (!file || !this.o.owner()) return true;
    const at = this.now();
    if (!force && at - this.lastWrite < WRITE_EVERY_MS) return true;
    this.lastWrite = at;
    file.updated_at = new Date(at).toISOString();
    if (this.seal) file.seal = { ...this.seal, at: file.updated_at }; else delete file.seal;
    file.queue_depth = this.servingQueued + this.depth;
    file.lag_ms = this.waiting.length ? Math.max(0, at - Math.min(...this.waiting)) : 0;
    try { writeFollowerFile(this.o.dir, file); return true; } catch { return false; /* a full disk loses the status, never the follower */ }
  }
}
