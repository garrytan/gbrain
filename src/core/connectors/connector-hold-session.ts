/**
 * One connector run's use of the item holds (fix wave 4 lane B), shared by
 * the Gmail and GitHub connectors on managed and unmanaged brains.
 *
 *  - `shouldAttempt` skips a held item unless `retry-held`, an upstream
 *    change or a due transient reconsideration re-admits it;
 *  - `fail` counts an item-scoped failure; on a managed brain a connector
 *    write error still aborts the run, and the abort path first publishes the
 *    last committed cursor state plus the updated holds (a stolen lease or a
 *    failed publication records nothing, so the item is counted again);
 *  - `finish` merges the run into the holds, releases held receipts from the
 *    managed automatic retry set, and reports the counts for the summary;
 *  - `complete` removes the retry-held keys this run attempted.
 */
import type { BrainEngine } from '../engine.ts';
import { LockStolenError } from '../db-lock.ts';
import { OperationError } from '../ops/contract.ts';
import type { ManagedConnectorSync } from '../persistence/connector-sync.ts';
import { clearHoldRetryKeys, readHoldRetryKeys, writeHeldRetryPointer } from './item-holds-store.ts';
import { holdsExhaustedError, ItemHoldsRun, type ClassifiedConnectorError, type ItemHoldMeta, type ItemHoldsFinish, type ItemHoldsState } from './item-holds.ts';

/** Errors a managed connector must not absorb (the run aborts). Refusals raised before submission are counted instead. */
function abortsManagedRun(error: unknown): boolean {
  if (error instanceof LockStolenError || (error as { name?: string } | null)?.name === 'ConnectorWaitBudgetStop') return true;
  if (!(error instanceof OperationError)) return false;
  return !(error.code === 'invalid_connector_text' && !error.writeRequest);
}

export interface HoldRunSummary { held: number; newlyHeld: number; skipped: number; outage: boolean }

export class ConnectorHoldSession {
  readonly holds: ItemHoldsRun;
  private readonly attemptedRetries = new Set<string>();
  private readonly attempted = new Set<string>();
  private skipped = 0;
  private finished: ItemHoldsFinish | null = null;

  private constructor(private readonly engine: BrainEngine, private readonly sourceId: string, private readonly incarnation: string | null,
    private readonly managed: ManagedConnectorSync | null, private readonly empty: Record<string, unknown>, stored: unknown,
    private readonly retryKeys: ReadonlySet<string>, opts: { full?: boolean; now?: () => number }) {
    this.holds = new ItemHoldsRun(stored, { ...opts, retryKeys });
  }

  static async open(engine: BrainEngine, sourceId: string, managed: ManagedConnectorSync | null, empty: Record<string, unknown>,
    stored: unknown, opts: { full?: boolean; now?: () => number } = {}): Promise<ConnectorHoldSession> {
    const [row] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [sourceId]).catch(() => []);
    const incarnation = row?.incarnation ?? null;
    const keys = incarnation ? await readHoldRetryKeys(engine, sourceId, incarnation).catch(() => []) : [];
    const session = new ConnectorHoldSession(engine, sourceId, incarnation, managed, empty, stored, new Set(keys), opts);
    // A managed held item re-admitted by a due transient reconsideration gets the same durable retry
    // pointer retry-held writes, so its re-attempt is a new request identity instead of a replay.
    if (managed) {
      for (const key of session.holds.heldKeys()) {
        const record = session.holds.record(key);
        if (record?.request_id && !keys.includes(key) && session.holds.shouldAttempt(key)) {
          await writeHeldRetryPointer(engine, sourceId, record.request_id).catch(() => false);
        }
      }
    }
    return session;
  }

  /** False for a held item this run skips; the skip neither counts nor resets it. */
  shouldAttempt(key: string, version: string | null = null): boolean {
    const attempt = this.holds.shouldAttempt(key, version);
    if (!attempt) this.skipped++;
    else {
      this.attempted.add(key);
      if (this.retryKeys.has(key)) this.attemptedRetries.add(key);
    }
    return attempt;
  }

  /**
   * Held keys this run has not attempted that it should still re-attempt
   * (retry-held or a due transient reconsideration), for items no listing of
   * this run returns.
   */
  dueHeldKeys(): string[] { return this.holds.heldKeys().filter(key => !this.attempted.has(key) && this.holds.shouldAttempt(key)); }

  isHeld(key: string): boolean { return this.holds.isHeld(key); }

  succeed(key: string): void { this.holds.succeed(key); }

  drop(key: string): void { this.holds.drop(key); }

  /**
   * Counts one item failure. Returns the classification for errors the run
   * absorbs; on a managed brain a write error is rethrown after the abort
   * path publishes the holds.
   */
  async fail(key: string, error: unknown, detail: { version?: string | null; meta?: Partial<ItemHoldMeta>; slug?: string | null; ref?: string | null } = {}): Promise<ClassifiedConnectorError> {
    const classified = this.holds.fail(key, error, detail);
    if (!this.managed || !abortsManagedRun(error)) return classified;
    if (!(error instanceof LockStolenError) && classified.scope === 'item') {
      const done = this.holds.finish();
      if (!done.exhausted) {
        this.managed.holdSlugs(this.heldSlugs(done.state));
        // A retry-held re-attempt that failed again is consumed once its hold is published,
        // so the next sync skips the item instead of aborting on it again.
        if (await this.managed.publishHolds(this.empty, done.state) && this.attemptedRetries.has(key) && this.incarnation) {
          await clearHoldRetryKeys(this.engine, this.sourceId, this.incarnation, [key]).catch(() => {});
        }
      }
    }
    throw error;
  }

  private heldSlugs(state: ItemHoldsState): string[] {
    return Object.values(state.items).filter(record => record.state === 'held' && record.slug).map(record => record.slug!);
  }

  /** Merges the run into the holds. Throws `connector_holds_exhausted` when holding another item would exceed the cap. */
  finish(): ItemHoldsState {
    const done = this.holds.finish();
    this.finished = done;
    if (done.exhausted) throw holdsExhaustedError(this.sourceId);
    this.managed?.holdSlugs(this.heldSlugs(done.state));
    return done.state;
  }

  summary(): HoldRunSummary {
    const state = this.finished?.state ?? this.holds.initial();
    return { held: Object.values(state.items).filter(record => record.state === 'held').length, newlyHeld: this.finished?.newlyHeld.length ?? 0,
      skipped: this.skipped, outage: this.finished?.outage ?? false };
  }

  /** After the run's final state save: the retry-held keys it attempted are consumed. */
  async complete(): Promise<void> {
    if (!this.incarnation || !this.attemptedRetries.size) return;
    await clearHoldRetryKeys(this.engine, this.sourceId, this.incarnation, [...this.attemptedRetries]).catch(() => {});
  }
}

/** The sync result's hold counts (printed by the sync summary with the retry command). */
export function connectorHoldsResult(sourceId: string, summary: HoldRunSummary): { connectorHolds?: { held: number; newly_held: number; retry_command: string; status_command: string } } {
  if (!summary.held) return {};
  return { connectorHolds: { held: summary.held, newly_held: summary.newlyHeld, retry_command: `gbrain sources retry-held ${sourceId}`, status_command: `gbrain sources status ${sourceId}` } };
}
