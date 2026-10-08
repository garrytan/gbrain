/**
 * #6317 (B1): one full persistence consumer per host, as a preference.
 *
 * A resident process (`sync`, `jobs`, `autopilot`, `mcp`) that would start a
 * consumer first asks the database whether a live full consumer already runs
 * on this host (consumer-heartbeat.ts). If one does, this process becomes a
 * waiter: it keeps the consumer's whole external surface so `awaitWrite` and
 * every other caller work unchanged, but it claims nothing and writes no
 * heartbeat row; its writes are published by the owner and reach it through
 * the ordinary receipt polls. A `serve` always starts full and short-lived
 * foreground commands (`put`, `import`, `cli`, ...) keep their own consumer
 * (service.ts decides; this class never sees them).
 *
 * Mode machine (`ConsumerMode`):
 *
 *               start()
 *                 │
 *            ┌────▼────┐  switch off · no live owner · probe error · 3 probe timeouts · forced
 *            │ probing ├──────────────────────────────────────────────────────────────┐
 *            └────┬────┘                                                              │
 *                 │ live full resident owner (not this process, not wedged)           │
 *          ┌──────▼──────┐  owner lapsed 60 s · wedged · not full · gone          ┌───▼───┐
 *     ┌───►│ waiter_only ├────────────────────────────────────────────────────►┐  │ full  │  (never demoted)
 *     │    └──────▲──────┘                                                     │  └───▲───┘
 *     │           │ promote() (forced: --no-delegate, skew fallback) ─────────────────┘
 *     │           │                                                            │
 *     │    owner's row `full`, live and healthy for 3 consecutive ticks  ┌─────▼────┐
 *     └──────────────────────────────────────────────────────────────────┤ promoted │
 *                           drain back (finish in-flight, claim nothing) └──────────┘
 *
 * Every transition is decided by one indexed read of `persistence_consumers`
 * per tick, single-flight under the consumer's phase deadline, backing off
 * with the consumer's idle delay. `stop()` cancels and awaits the in-flight
 * probe before the engine closes; a result that lands after `stop()` is
 * dropped. Only a consumer that was promoted drains back, and only for an
 * owner whose row says `full` (an elected owner, never another promoted
 * waiter), so a promotion storm after a heartbeat outage converges and two
 * consumers that both started full stay full until one exits (doctor names
 * them). PGLite admits one process, so the probe is inert there and the
 * consumer goes full on its first tick.
 */
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { LANE_BUSY, type ConsumerStatus, type PersistenceConsumer, type PersistenceConsumerLike } from './consumer.ts';
import {
  CONSUMER_LAPSED_MS, CONSUMER_LIVE_MS, consumerIdentity, consumerWedged, listHostConsumers, RESIDENT_CONSUMER_KINDS, startConsumerHeartbeat,
  type ConsumerHeartbeat, type ConsumerPool, type ConsumerProcessIdentity, type ListedConsumer,
} from './consumer-heartbeat.ts';
import { DEFAULT_PREPARATION_POLICY } from './preparation-budget.ts';
import { consumerConnectionRoute, consumerStatementEngine } from './consumer-lane.ts';
import { readWriteSwitchSnapshot } from './switches.ts';

export type ConsumerMode = 'probing' | 'full' | 'waiter_only' | 'promoted';
/** Consecutive ticks a recovered owner must look healthy before a promoted consumer drains back. */
export const DRAIN_BACK_HEALTHY_TICKS = 3;
/** Consecutive probe timeouts before the consumer stops waiting for an answer and starts full. */
export const PROBE_TIMEOUT_MISSES = 3;

let ownConsumerForced: string | null = null;
/**
 * B1d: the process-level escape hatch (`gbrain sync --no-delegate`, or the skew fallback when an older `serve` cannot take a
 * hand-off): every consumer this process starts from now on is full, and a waiter-only consumer already made promotes.
 */
export function forceOwnConsumer(reason: string): void { ownConsumerForced = reason; }
export function ownConsumerForcedReason(): string | null { return ownConsumerForced; }
/** Test seam. */
export function resetOwnConsumerForTest(): void { ownConsumerForced = null; }

/** The owner a waiter defers to, as its status and the `writer_pending` envelope name it. */
export interface ElectedOwner { kind: string; pid: number; nonce: string; pid_ns: string | null; version: string; started_at: string; renewed_age_ms: number;
  restart_required: boolean; root_barrier_age_ms: number | null; mode: string }

/**
 * The owner to defer to among `rows`, or null: a resident-kind row that is not this process, in mode `full` or `promoted`,
 * not wedged and live (renewed within `CONSUMER_LIVE_MS`); the current owner is kept while it is merely stale (under
 * `CONSUMER_LAPSED_MS`), so one slow renewal does not promote every waiter on the host.
 */
export function electOwner(rows: readonly ListedConsumer[], current: Pick<ListedConsumer, 'pid' | 'nonce'> | null, ceilingMs: number,
  self: ConsumerProcessIdentity = consumerIdentity()): ListedConsumer | null {
  const eligible = rows.filter(row => !(row.pid === self.pid && row.nonce === self.nonce) && RESIDENT_CONSUMER_KINDS.includes(row.kind)
    && (row.mode === 'full' || row.mode === 'promoted') && !consumerWedged(row, ceilingMs));
  const kept = current ? eligible.find(row => row.pid === current.pid && row.nonce === current.nonce && row.renewed_age_ms < CONSUMER_LAPSED_MS) : undefined;
  if (kept) return kept;
  return eligible.find(row => row.renewed_age_ms < CONSUMER_LIVE_MS) ?? null;
}
const ownerOf = (row: ListedConsumer): ElectedOwner => ({ kind: row.kind, pid: row.pid, nonce: row.nonce, pid_ns: row.pid_ns, version: row.version, started_at: row.started_at,
  renewed_age_ms: row.renewed_age_ms, restart_required: row.restart_required, root_barrier_age_ms: row.root_barrier_age_ms, mode: row.mode });

export interface WaiterOnlyConsumerOpts {
  /** The gbrain command this process runs (`claimOwnerKind()`); resident kinds only reach this class. */
  kind: string;
  hostId: string;
  pollMs?: number;
  idleMaxMs?: number;
  /** Deadline of one probe (the consumer's phase deadline). */
  phaseMs?: number;
  /** Test seams: the consumer rows of this host, the switch, the ceiling, the heartbeat cadence and the log sink. */
  readConsumers?: (signal: AbortSignal) => Promise<ListedConsumer[]>;
  singleConsumer?: () => Promise<boolean>;
  ceilingMs?: () => Promise<number>;
  heartbeatEveryMs?: number;
  pool?: () => ConsumerPool | null;
  log?: (line: string) => void;
}

export class WaiterOnlyConsumer implements PersistenceConsumerLike {
  private _mode: ConsumerMode = 'probing';
  private inner: PersistenceConsumer | undefined;
  private heartbeat: ConsumerHeartbeat | undefined;
  private owner: ListedConsumer | null = null;
  private healthyOwnerTicks = 0;
  private probeTimeouts = 0;
  private stopping = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private tickPromise: Promise<void> | undefined;
  private transition: Promise<void> | undefined;
  private delayMs: number;
  private wakeRequested = false;
  private readonly self = consumerIdentity();
  /** The probe reads through the consumer's statement route (the direct lane when the engine has one). */
  private readonly statements: BrainEngine;
  constructor(readonly engine: BrainEngine, readonly config: GBrainConfig, private readonly makeConsumer: () => PersistenceConsumer, private readonly opts: WaiterOnlyConsumerOpts) {
    this.delayMs = opts.pollMs ?? 250;
    this.statements = consumerStatementEngine(engine);
  }
  get mode(): ConsumerMode { return this._mode; }
  /** The owner this process defers to (waiter-only), or null. */
  electedOwner(): ElectedOwner | null { return this.owner ? ownerOf(this.owner) : null; }
  start(): void {
    this.stopping = false;
    if (this.engine.kind !== 'postgres' || ownConsumerForced !== null) { this.becomeFull('full', this.engine.kind !== 'postgres' ? 'single_process_engine' : `forced:${ownConsumerForced}`); return; }
    this.schedule(0);
  }
  private schedule(ms: number): void {
    if (this.stopping || this._mode === 'full') return;
    if (this.tickPromise) { if (ms === 0) this.wakeRequested = true; return; }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.probeTick(); }, ms);
    this.timer.unref?.();
  }
  /** The full consumer's tick once this process consumes; a probe tick while it decides. */
  tick(afterProgress = false): Promise<void> {
    return this.inner ? this.inner.tick(afterProgress) : this.probeTick();
  }
  /** One probe tick (single-flight); the timer calls it. */
  probeTick(): Promise<void> {
    if (this.tickPromise) return this.tickPromise;
    this.tickPromise = this.doTick().catch(() => undefined).finally(() => {
      this.tickPromise = undefined;
      if (this.stopping || this._mode === 'full') return;
      const next = this.wakeRequested ? 0 : this.delayMs;
      this.wakeRequested = false;
      this.schedule(next);
    });
    return this.tickPromise;
  }
  private backoff(): void { this.delayMs = Math.min(Math.max(this.delayMs, this.opts.pollMs ?? 250) * 2, Math.max(this.opts.pollMs ?? 250, this.opts.idleMaxMs ?? 5000)); }
  private log(line: string): void {
    if (this.opts.log) { this.opts.log(line); return; }
    process.stderr.write(`[persistence] ${line}; fix: gbrain sources writer status --json; docs: docs/guides/live-sync.md#one-consumer-per-host\n`);
  }
  private async doTick(): Promise<void> {
    if (this.stopping || this._mode === 'full') return;
    if (ownConsumerForced !== null) { await this.becomeFull('full', `forced:${ownConsumerForced}`); return; }
    const cancel = new AbortController();
    const timer = setTimeout(() => cancel.abort(new Error('probe_timeout')), this.opts.phaseMs ?? 5000);
    // The deadline settles the await itself: a round-trip the pooler never completes (the #6278 class) must not park the probe.
    const bounded = <T>(work: Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(cancel.signal.reason);
      if (cancel.signal.aborted) { onAbort(); return; }
      cancel.signal.addEventListener('abort', onAbort, { once: true });
      work.then(resolve, reject).finally(() => cancel.signal.removeEventListener('abort', onAbort));
    });
    let rows: ListedConsumer[];
    let ceiling: number;
    try {
      if (this._mode === 'probing') {
        const on = await bounded(this.opts.singleConsumer ? this.opts.singleConsumer() : readWriteSwitchSnapshot(this.statements, { signal: cancel.signal }).then(s => s.switches.single_consumer));
        if (this.stopping) return;
        if (!on) { await this.becomeFull('full', 'single_consumer_off'); return; }
      }
      ceiling = await bounded(this.opts.ceilingMs ? this.opts.ceilingMs() : readWriteSwitchSnapshot(this.statements, { signal: cancel.signal }).then(s => s.preparation.ceilingMs, () => DEFAULT_PREPARATION_POLICY.ceilingMs));
      rows = await bounded(this.opts.readConsumers ? this.opts.readConsumers(cancel.signal) : listHostConsumers(this.statements, this.opts.hostId, { signal: cancel.signal }));
    } catch (error) {
      if (this.stopping) return;
      if (cancel.signal.aborted) {
        // The database did not answer in time: stay in this mode for this tick; after three misses a probing consumer starts full.
        if (++this.probeTimeouts >= PROBE_TIMEOUT_MISSES && this._mode === 'probing') { this.log(`phase=consumer_probe reason=probe_timeout message="no answer in ${PROBE_TIMEOUT_MISSES} probes; running own consumer"`); await this.becomeFull('full', 'probe_timeout'); }
        else this.backoff();
        return;
      }
      // A read the database cannot answer (an older schema, a refused statement): today's behaviour, one log line.
      if (this._mode === 'probing') { this.log(`phase=consumer_probe reason=probe_failed message="${error instanceof Error ? error.message.replace(/\s+/g, ' ').slice(0, 200) : String(error)}; running own consumer"`); await this.becomeFull('full', 'probe_failed'); }
      else this.backoff();
      return;
    } finally { clearTimeout(timer); }
    if (this.stopping) return;
    this.probeTimeouts = 0;
    const owner = electOwner(rows, this.owner, ceiling, this.self);
    if (this._mode === 'probing') {
      if (!owner) { await this.becomeFull('full', 'no_live_owner'); return; }
      this.owner = owner; this._mode = 'waiter_only';
      this.log(`phase=consumer_probe reason=waiter_only message="deferring to ${owner.kind} pid ${owner.pid} on this host; this process claims nothing"`);
      this.backoff();
      return;
    }
    if (this._mode === 'waiter_only') {
      if (owner) { this.owner = owner; this.backoff(); return; }
      const was = this.owner;
      this.log(`phase=consumer_probe reason=owner_lapsed promoted_to_consumer message="${was ? `${was.kind} pid ${was.pid} is ${was.renewed_age_ms >= CONSUMER_LAPSED_MS ? 'lapsed' : was.restart_required ? 'restart_required' : 'wedged or gone'}` : 'no live owner'}"`);
      await this.becomeFull('promoted', 'owner_lapsed');
      return;
    }
    // promoted: drain back once an elected (`full`) owner has been live and healthy for three consecutive ticks.
    if (owner && owner.mode === 'full') {
      this.owner = owner;
      if (++this.healthyOwnerTicks >= DRAIN_BACK_HEALTHY_TICKS) { await this.drainBack(owner); return; }
    } else { this.healthyOwnerTicks = 0; if (owner) this.owner = owner; }
    this.backoff();
  }
  private becomeFull(mode: 'full' | 'promoted', reason: string): Promise<void> {
    if (this.transition) return this.transition;
    this.transition = (async () => {
      if (this.stopping || this.inner) return;
      this._mode = mode;
      this.healthyOwnerTicks = 0;
      const inner = this.makeConsumer();
      this.inner = inner;
      this.heartbeat = startConsumerHeartbeat(this.engine, this.opts.hostId, { kind: this.opts.kind, mode: () => this._mode, everyMs: this.opts.heartbeatEveryMs, deadlineMs: this.opts.phaseMs, identity: this.self,
        report: () => ({ restart_required: inner.restartRequired(), root_barrier_age_ms: inner.oldestRootBarrierAgeMs(), pool: this.opts.pool?.() ?? null }) });
      inner.start();
      if (mode === 'full') { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
      if (reason !== 'no_live_owner' && reason !== 'single_consumer_off' && reason !== 'single_process_engine') this.log(`phase=consumer_probe reason=${mode} message="${reason}"`);
    })().finally(() => { this.transition = undefined; });
    return this.transition;
  }
  private drainBack(owner: ListedConsumer): Promise<void> {
    if (this.transition) return this.transition;
    this.transition = (async () => {
      const inner = this.inner;
      if (!inner || this.stopping) return;
      this.log(`phase=consumer_probe reason=drained_back message="${owner.kind} pid ${owner.pid} is live again; finishing in-flight work, then deferring"`);
      // stop() finishes in-flight tasks and claims nothing new; the heartbeat row goes with it.
      await inner.stop();
      await this.heartbeat?.stop();
      if (this.inner === inner) { this.inner = undefined; this.heartbeat = undefined; this._mode = 'waiter_only'; this.owner = owner; this.healthyOwnerTicks = 0; }
    })().finally(() => { this.transition = undefined; });
    return this.transition;
  }
  /** B1d: a waiter-only (or probing) consumer becomes full now and never drains back. */
  promote(reason = 'promote'): Promise<void> {
    if (this.inner) { this._mode = 'full'; if (this.timer) clearTimeout(this.timer); this.timer = undefined; return Promise.resolve(); }
    return this.becomeFull('full', reason);
  }
  wake(ownAdmission = false): void {
    if (this.inner) { this.inner.wake(ownAdmission); return; }
    // A waiter claims nothing; the wake only brings the next probe forward so a lapsed owner is noticed sooner.
    this.delayMs = this.opts.pollMs ?? 250;
    this.schedule(0);
  }
  holds(id: string): boolean { return this.inner?.holds(id) ?? false; }
  foregroundCompletions(worktreeId: string): number { return this.inner?.foregroundCompletions(worktreeId) ?? 0; }
  onLane<T>(run: (transaction: <R>(fn: (tx: BrainEngine) => Promise<R>) => Promise<R>) => Promise<T>): Promise<T | typeof LANE_BUSY> {
    return this.inner ? this.inner.onLane(run) : Promise.resolve(LANE_BUSY);
  }
  restartRequired(): boolean { return this.inner?.restartRequired() ?? false; }
  status(): ConsumerStatus {
    const election = { mode: this._mode, kind: this.opts.kind, owner: this.electedOwner(), heartbeat_failures: this.heartbeat?.failures ?? 0 };
    if (this.inner) return { ...this.inner.status(), consumer_election: election };
    return { accepting: !this.stopping, active_preparations: 0, active_worktrees: 0, restart_required: false, sampled_at: new Date().toISOString(),
      observation_scope: 'current_process_reset_on_restart', connection: consumerConnectionRoute(this.engine), consumer_election: election };
  }
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    await this.tickPromise;
    await this.transition;
    await this.inner?.stop();
    await this.heartbeat?.stop();
  }
}
