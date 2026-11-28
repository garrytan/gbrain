/**
 * Replica acks on the served layer (multi-user Rust with the commit log; rust/docs/store/commit-log.md, "Replica
 * acks"). The one owner of "may this write be answered as a success yet": while a replica is attached
 * (`Brain#attachReplica`, done by the follower session when the follower names itself), a successful write is
 * answered only after the replica's ack covers the write's commit position. When the ack does not come within the
 * store's timeout (`Brain#replicaAckSettings`), the answer is `replication_timeout` (reason `outcome_unknown`): the
 * commit is durable on the primary, and the caller resends the same request id to read its stored outcome.
 *
 * - The coverage truth stays in the store (`Brain#replicaCover`); the gate only waits on its in-process ack event
 *   (`wake`, called by follower-serve.ts after each recorded ack, attach or detach) and on the deadline. No polling.
 * - The position is read inside the server, whatever the client's `positions` capability (that capability only
 *   decides whether the position is serialized in the answer). A required replica and no position is never success.
 * - The wait holds no execution permit: the session stores the outcome, hands the answer here and returns.
 * - At most `max_waiters` answers wait at once. A write that would pass that is refused before it runs
 *   (`replication_busy`, nothing committed, `busy`); a full budget found only after a commit ends that write
 *   `replication_timeout`. A detach of the last replica, the session's shutdown and the deadline each end waits with
 *   `replication_timeout`, never with success.
 * - With no replica attached, or multi-user mode or the commit log off, every answer passes unchanged.
 */
import type { CommitPositionWire } from '../owner-ipc/protocol.ts';
import { comparePositions } from '../owner-ipc/protocol.ts';
import type { ReplicationEnd } from './errors.ts';
import type { StoredOutcome } from './requests.ts';

export interface ReplicaCoverWire { required: boolean; covered: boolean; acked_through: CommitPositionWire | null }
export interface ReplicaAckSettingsWire { timeout_ms: number; max_waiters: number }

/** What the gate needs of the open store (`openStoreIfOpen`). */
export interface ReplicaGateStore {
  commitLog?: boolean;
  brain: {
    replicaCover?(position: CommitPositionWire): Promise<ReplicaCoverWire>;
    replicaAckSettings?(): Promise<ReplicaAckSettingsWire>;
  };
}

/** Why a wait ended without the ack. */
export type ReplicaWaitEnd = ReplicationEnd;

export interface ReplicaRefusal {
  position: CommitPositionWire | null;
  timeoutMs: number;
  ackedThrough: CommitPositionWire | null;
  why: ReplicaWaitEnd;
}

interface Waiter {
  position: CommitPositionWire;
  done(refusal: ReplicaRefusal | null): void;
  timer: ReturnType<typeof setTimeout>;
}

const ORIGIN: CommitPositionWire = { sequence: 0, index: 0 };

export class ReplicaGate {
  private readonly waiters = new Set<Waiter>();
  /** The commit position of every stored write outcome, kept off the wire (attached duplicates and replays use it). */
  private readonly positions = new WeakMap<StoredOutcome, CommitPositionWire | null>();
  /** Follower send loops that are caught up and wait for the next commit (`nap`). */
  private readonly nappers = new Set<() => void>();
  private checking = false;
  private again = false;
  private closed = false;

  constructor(private readonly storeOf: () => ReplicaGateStore | null) {}

  /** Answers waiting for an ack now. */
  get pending(): number { return this.waiters.size; }

  /** Notes the commit position of a stored write outcome (null: it could not be read). */
  remember(outcome: StoredOutcome, position: CommitPositionWire | null): void { this.positions.set(outcome, position); }

  /** Whether `outcome` is a stored write outcome, and its position. */
  recall(outcome: StoredOutcome): { write: boolean; position: CommitPositionWire | null } {
    return this.positions.has(outcome) ? { write: true, position: this.positions.get(outcome) ?? null } : { write: false, position: null };
  }

  private store(): (ReplicaGateStore & { brain: Required<ReplicaGateStore['brain']> }) | null {
    const store = this.storeOf();
    if (!store?.commitLog || typeof store.brain.replicaCover !== 'function' || typeof store.brain.replicaAckSettings !== 'function') return null;
    return store as ReplicaGateStore & { brain: Required<ReplicaGateStore['brain']> };
  }

  /**
   * True when a write must be refused `replication_busy` before it runs: a replica is attached and `max_waiters`
   * answers wait already.
   */
  async busy(): Promise<{ maxWaiters: number } | null> {
    // max_waiters is at least 1, so with no waiter nothing is full (and a write with no replica costs no store call).
    if (this.waiters.size === 0) return null;
    const store = this.store();
    if (!store) return null;
    const settings = await store.brain.replicaAckSettings();
    if (this.waiters.size < settings.max_waiters) return null;
    const cover = await store.brain.replicaCover(ORIGIN);
    return cover.required ? { maxWaiters: settings.max_waiters } : null;
  }

  /**
   * Null when the write at `position` may be answered as a success now or after the ack; a refusal when it ends
   * without the ack (module docs). Resolves when that is known.
   */
  async admit(position: CommitPositionWire | null): Promise<ReplicaRefusal | null> {
    const store = this.store();
    if (!store) return null;
    let cover: ReplicaCoverWire;
    let settings: ReplicaAckSettingsWire;
    try {
      [cover, settings] = await Promise.all([store.brain.replicaCover(position ?? ORIGIN), store.brain.replicaAckSettings()]);
    } catch {
      // The store could not say whether a replica must ack: never success.
      return { position, timeoutMs: 0, ackedThrough: null, why: 'cover_failed' };
    }
    if (!cover.required) return null;
    const refusal = (why: ReplicaWaitEnd, ackedThrough = cover.acked_through): ReplicaRefusal =>
      ({ position, timeoutMs: settings.timeout_ms, ackedThrough, why });
    if (!position) return refusal('no_position');
    if (cover.covered) return null;
    if (this.closed) return refusal('closed');
    if (this.waiters.size >= settings.max_waiters) return refusal('budget');
    return new Promise<ReplicaRefusal | null>(resolve => {
      const waiter: Waiter = {
        position,
        done: (end) => { clearTimeout(waiter.timer); this.waiters.delete(waiter); resolve(end); },
        timer: setTimeout(() => waiter.done(refusal('timeout', this.lastAcked)), settings.timeout_ms),
      };
      waiter.timer.unref?.();
      this.waiters.add(waiter);
      // An ack may have landed between the cover read and now.
      this.wake();
    });
  }

  private lastAcked: CommitPositionWire | null = null;

  /** An ack, attach or detach was recorded: reads the cover once and ends every wait it settles. */
  wake(): void {
    if (this.checking) { this.again = true; return; }
    if (!this.waiters.size) return;
    this.checking = true;
    void this.check().finally(() => {
      this.checking = false;
      if (this.again) { this.again = false; this.wake(); }
    });
  }

  private async check(): Promise<void> {
    const store = this.store();
    let newest = ORIGIN;
    for (const w of this.waiters) if (comparePositions(w.position, newest) > 0) newest = w.position;
    let cover: ReplicaCoverWire | null = null;
    try { cover = store ? await store.brain.replicaCover(newest) : null; } catch { cover = null; }
    if (!cover) return; // the deadline still ends every wait
    this.lastAcked = cover.acked_through;
    for (const w of [...this.waiters]) {
      if (cover.acked_through && comparePositions(cover.acked_through, w.position) >= 0) w.done(null);
      else if (!cover.required) w.done({ position: w.position, timeoutMs: 0, ackedThrough: cover.acked_through, why: 'detached' });
    }
  }

  /**
   * A follower send loop that is caught up waits here: until `ms` pass or a served write commits (`committed`), so a
   * write's records go out at once instead of on the next poll.
   */
  nap(ms: number): Promise<void> {
    return new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); this.nappers.delete(done); resolve(); };
      const timer = setTimeout(done, ms);
      timer.unref?.();
      this.nappers.add(done);
    });
  }

  /** A served write committed: wakes every caught-up send loop. */
  committed(): void {
    for (const wake of [...this.nappers]) wake();
  }

  /** Shutdown: ends every wait with `replication_timeout`; later admits refuse at once. */
  close(): void {
    this.closed = true;
    for (const w of [...this.waiters]) w.done({ position: w.position, timeoutMs: 0, ackedThrough: this.lastAcked, why: 'closed' });
  }
}
