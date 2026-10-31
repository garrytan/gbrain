/**
 * W3 (GBRA-224, #7587, extending #5474): a dream phase that publishes a
 * coordinated write (consolidate, purge) and finds it accepted but still
 * pending after its publish wait records a deferral instead of failing. The
 * deferral keeps the receipt's request id, one per (phase, source); the phase
 * stops submitting for that source and reports `deferred` (status warn), so
 * the cycle is not failed for a write that is merely slow.
 *
 * The next pass of the phase reconciles its deferrals before it submits
 * anything: a committed receipt is done, a failed one is reported as that
 * failure, a receipt that is gone (compacted) clears and the phase re-plans
 * from current state. One still pending keeps its source held and counts a
 * replay; at DREAM_WRITE_DEFERRAL_MAX_REPLAYS the deferral stops counting and
 * escalates: doctor's `dream_write_deferred` check (page class) names the
 * receipt and its status command. The receipt is still read every pass, so a
 * late commit clears it on its own. Every step writes a heal audit row
 * (heal-audit.ts) in the same transaction as the deferral state.
 *
 * `dream.write_deferral.enabled=false` turns this off: a pending write fails
 * the phase as before. State lives in the config table, so it works the same
 * on a repo-less brain.
 */
import type { BrainEngine } from '../engine.ts';
import { acceptedPendingReceipt } from '../persistence/accepted-pending.ts';
import { getWriteRequest } from '../persistence/journal.ts';
import type { Principal } from '../persistence/model.ts';
import { healEnabled, recordHealAudit, type HealAuditInput } from '../heal-audit.ts';

export const DREAM_WRITE_DEFERRALS_KEY = 'dream.write_deferral.pending';
export const DREAM_WRITE_DEFERRAL_ENABLED_KEY = 'dream.write_deferral.enabled';
export const DREAM_WRITE_DEFERRAL_MAX_REPLAYS = 3;
export const DREAM_WRITE_DEFERRED_CODE = 'dream_write_deferred';

export interface DreamWriteDeferral {
  phase: string;
  source_id: string;
  /** What the write was for, e.g. `<source>/<slug>` for purge, `<source>/<entity>` for consolidate. */
  subject: string;
  request_id: string;
  /** The receipt row's primary key (resolved through the principal's request index), so reconciling never scans the journal. */
  receipt_id: string | null;
  /** Later passes that found the receipt still pending, capped at the bound. */
  replays: number;
  deferred_at: string;
}

export interface DreamWriteReconcile {
  committed: DreamWriteDeferral[];
  failed: Array<DreamWriteDeferral & { code: string; message: string }>;
  /** Receipt no longer readable (compacted): cleared; the phase re-plans from current state. */
  cleared: DreamWriteDeferral[];
  /** Still pending: the phase submits nothing for these sources this pass. */
  held: DreamWriteDeferral[];
  /** Held deferrals at the replay bound. */
  escalated: DreamWriteDeferral[];
}

export function writeStatusCommand(requestId: string): string {
  return `gbrain write-request -- ${requestId}`;
}

export function dreamWriteDeferralEnabled(engine: Pick<BrainEngine, 'getConfig'>): Promise<boolean> {
  return healEnabled(engine, DREAM_WRITE_DEFERRAL_ENABLED_KEY);
}

/** The accepted, still-pending receipt's request id an error carries, or null. */
export function pendingRequestId(error: unknown): string | null {
  return acceptedPendingReceipt(error)?.request_id ?? null;
}

function parseDeferrals(raw: string | null | undefined): Record<string, DreamWriteDeferral> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, entry]) => !!entry && typeof entry === 'object'
      && typeof (entry as DreamWriteDeferral).request_id === 'string' && typeof (entry as DreamWriteDeferral).phase === 'string'));
  } catch { return {}; }
}

const entryKey = (phase: string, sourceId: string) => `${phase}:${sourceId}`;

export async function readDreamWriteDeferrals(engine: Pick<BrainEngine, 'getConfig'>): Promise<DreamWriteDeferral[]> {
  return Object.values(parseDeferrals(await engine.getConfig(DREAM_WRITE_DEFERRALS_KEY)));
}

/** Lock the deferral map for one read-modify-write; `mutate` returns the audit rows to write with it. */
async function withDeferrals<T>(engine: BrainEngine,
  mutate: (map: Record<string, DreamWriteDeferral>, now: string, tx: BrainEngine) => Promise<{ result: T; audit: HealAuditInput[] }>): Promise<T> {
  return engine.transaction(async tx => {
    await tx.executeRaw("INSERT INTO config (key, value) VALUES ($1, '{}') ON CONFLICT (key) DO NOTHING", [DREAM_WRITE_DEFERRALS_KEY]);
    const [row] = await tx.executeRaw<{ value: string; now: string }>(
      `SELECT value, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now FROM config WHERE key=$1 FOR UPDATE`,
      [DREAM_WRITE_DEFERRALS_KEY]);
    const map = parseDeferrals(row?.value);
    const { result, audit } = await mutate(map, row!.now, tx);
    await tx.executeRaw('UPDATE config SET value=$2 WHERE key=$1', [DREAM_WRITE_DEFERRALS_KEY, JSON.stringify(map)]);
    await recordHealAudit(tx, audit);
    return result;
  });
}

const auditRow = (entry: DreamWriteDeferral, outcome: string, detail?: string): HealAuditInput => ({
  code: DREAM_WRITE_DEFERRED_CODE, outcome, attempt: entry.replays, bound: DREAM_WRITE_DEFERRAL_MAX_REPLAYS,
  subject: `${entry.phase}:${entry.subject}`, request_id: entry.request_id, ...(detail ? { detail } : {}),
});

/**
 * Reconcile this phase's deferrals against their receipts before the phase
 * submits anything. Reads each receipt by request id; never resubmits.
 */
export async function reconcileDreamWriteDeferrals(engine: BrainEngine, phase: string): Promise<DreamWriteReconcile> {
  return withDeferrals(engine, async (map, _now, tx) => {
    const out: DreamWriteReconcile = { committed: [], failed: [], cleared: [], held: [], escalated: [] };
    const audit: HealAuditInput[] = [];
    for (const [key, entry] of Object.entries(map)) {
      if (entry.phase !== phase) continue;
      const [receipt] = entry.receipt_id ? await tx.executeRaw<{ state: string; error_code: string | null; error_message: string | null }>(
        'SELECT state, error_code, error_message FROM persistence_requests WHERE id=$1::uuid', [entry.receipt_id]) : [];
      if (!receipt) {
        delete map[key];
        out.cleared.push(entry);
        audit.push(auditRow(entry, 'receipt_missing'));
      } else if (receipt.state === 'committed') {
        delete map[key];
        out.committed.push(entry);
        audit.push(auditRow(entry, 'committed'));
      } else if (['failed', 'conflict', 'cancelled'].includes(receipt.state)) {
        delete map[key];
        const code = receipt.error_code ?? (receipt.state === 'cancelled' ? 'cancelled' : receipt.state === 'conflict' ? 'revision_conflict' : 'storage_error');
        const message = receipt.error_message ?? `The deferred ${phase} write (request_id ${entry.request_id}) ended ${receipt.state}.`;
        out.failed.push({ ...entry, code, message });
        audit.push(auditRow(entry, 'failed', code));
      } else {
        if (entry.replays < DREAM_WRITE_DEFERRAL_MAX_REPLAYS) {
          entry.replays += 1;
          audit.push(auditRow(entry, entry.replays >= DREAM_WRITE_DEFERRAL_MAX_REPLAYS ? 'escalated' : 'replayed'));
        }
        out.held.push(entry);
        if (entry.replays >= DREAM_WRITE_DEFERRAL_MAX_REPLAYS) out.escalated.push(entry);
      }
    }
    return { result: out, audit };
  });
}

/** Record an accepted write still pending after its wait. One deferral per (phase, source): an existing one is kept. */
export async function deferDreamWrite(engine: BrainEngine,
  input: { phase: string; sourceId: string; subject: string; requestId: string; principal: Principal }): Promise<DreamWriteDeferral> {
  return withDeferrals(engine, async (map, now, tx) => {
    const key = entryKey(input.phase, input.sourceId);
    const existing = map[key];
    if (existing) return { result: existing, audit: [] };
    const receipt = await getWriteRequest(tx, input.principal, input.requestId);
    const entry: DreamWriteDeferral = { phase: input.phase, source_id: input.sourceId, subject: input.subject,
      request_id: input.requestId, receipt_id: receipt?.id ?? null, replays: 0, deferred_at: now };
    map[key] = entry;
    return { result: entry, audit: [auditRow(entry, 'deferred')] };
  });
}

/**
 * One pass of a deferring phase: reconciles first (`start`), then answers whether a source is held, records a
 * pending write as a deferral, and reports. Null from `start` when deferral is off for this run.
 */
export class DreamWriteDeferralPass {
  readonly deferredNow: DreamWriteDeferral[] = [];
  /** Items this pass did not submit: held behind a pending receipt, or deferred themselves. */
  skipped = 0;
  private readonly holding: Map<string, DreamWriteDeferral>;
  private constructor(private readonly engine: BrainEngine, private readonly phase: string, readonly reconcile: DreamWriteReconcile) {
    this.holding = new Map(reconcile.held.map(entry => [entry.source_id, entry]));
  }

  static async start(engine: BrainEngine, phase: string, applies: boolean): Promise<DreamWriteDeferralPass | null> {
    if (!applies || !await dreamWriteDeferralEnabled(engine)) return null;
    return new DreamWriteDeferralPass(engine, phase, await reconcileDreamWriteDeferrals(engine, phase));
  }

  /** The pending deferral holding `sourceId`, counted as one skipped item; undefined when the source may submit. */
  hold(sourceId: string): DreamWriteDeferral | undefined {
    const entry = this.holding.get(sourceId);
    if (entry) this.skipped++;
    return entry;
  }

  /** The new deferral when `error` is an accepted write still pending after its wait; null for any other error. */
  async defer(error: unknown, input: { sourceId: string; subject: string; principal: Principal }): Promise<DreamWriteDeferral | null> {
    const requestId = pendingRequestId(error);
    if (!requestId) return null;
    const entry = await deferDreamWrite(this.engine, { phase: this.phase, requestId, ...input });
    this.deferredNow.push(entry);
    this.holding.set(input.sourceId, entry);
    this.skipped++;
    return entry;
  }

  details(): Record<string, unknown> | null { return deferralDetails(this.reconcile, this.deferredNow); }

  /** The phase details fields: the skipped count and, when there is anything to say, `write_deferral`. */
  detailFields(countKey: string): Record<string, unknown> {
    const details = this.details();
    return { [countKey]: this.skipped, ...(details ? { write_deferral: details } : {}) };
  }
}

/** The phase details block every deferring phase reports. */
export function deferralDetails(reconcile: DreamWriteReconcile | null, deferredNow: DreamWriteDeferral[]): Record<string, unknown> | null {
  const held = reconcile?.held ?? [];
  if (!reconcile && deferredNow.length === 0) return null;
  const pending = [...held, ...deferredNow.filter(entry => !held.some(h => h.request_id === entry.request_id))];
  if (pending.length === 0 && !reconcile?.committed.length && !reconcile?.failed.length && !reconcile?.cleared.length) return null;
  return {
    code: DREAM_WRITE_DEFERRED_CODE,
    bound: DREAM_WRITE_DEFERRAL_MAX_REPLAYS,
    pending: pending.map(entry => ({ source_id: entry.source_id, subject: entry.subject, request_id: entry.request_id,
      replays: entry.replays, status_command: writeStatusCommand(entry.request_id) })),
    escalated: (reconcile?.escalated ?? []).map(entry => entry.request_id),
    reconciled_committed: (reconcile?.committed ?? []).map(entry => entry.request_id),
    reconciled_failed: (reconcile?.failed ?? []).map(entry => ({ request_id: entry.request_id, code: entry.code })),
    reconciled_cleared: (reconcile?.cleared ?? []).map(entry => entry.request_id),
  };
}
