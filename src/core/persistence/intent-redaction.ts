/**
 * Accounting-aware intent redaction for purge (#5575 ENG-6). The journal keeps
 * a request's normalized `intent` until receipt compaction; purge must remove
 * claim text from it sooner. This primitive applies compaction's accounting
 * to an explicit request set:
 *
 * - every affected request is locked (counters first, then request rows, the
 *   global lock order);
 * - a request that is queued, running, recovering or carries a recovery record
 *   refuses the whole purge with retryable `purge_blocked_pending_recovery`,
 *   because its intent is still the input of a pending publication;
 * - a terminal request has `intent` (and `error_message`) nulled, is marked
 *   compacted, and its terminal byte reservation shrinks to what the retained
 *   receipt still needs, released from its counters exactly as compaction does.
 *
 * Replay keys on the stored `digest`, so a later retry of a redacted request
 * returns its stored outcome without re-executing.
 *
 * #6511: the page purge no longer runs the needle search inside its 5 s
 * publication transaction. `sweepRequestsCarrying` walks the source's journal
 * in keyset chunks at preparation (bounded by the preparation budget: the
 * clock between chunks, the server-side bound on Postgres), recording the
 * sequence ceiling it scanned to and the non-terminal rows it saw;
 * `recheckRequestsCarrying` then runs the same predicate inside the
 * publication transaction over the tail past that ceiling and over those
 * pending rows, so a carrying request admitted or settled after the scan is
 * still redacted. `findRequestsCarrying` (one needle, one statement) stays
 * the fact purge's planning read.
 *
 * #6884: `sweepRequestsForGroups` runs that census once for several needle
 * groups (the queued purges of a batch), reading and lowering each journal
 * row once and attributing every hit to the groups whose needles it carries;
 * `after` starts a sweep past an earlier sweep's ceiling, so a purge whose
 * claims an earlier batch sweep already covered scans only the tail.
 */

import { opError } from '../ops/contract.ts';
import type { BrainEngine } from '../engine.ts';
import type { JournalChunkRow } from '../engine-sql/page-purge-journal.ts';
import { enterClaimStep, type ClaimPhaseClock } from './claim-phase.ts';
import { retainedReceiptBytes } from './receipt-bytes.ts';
import { completeWrite, lockCounters } from './journal.ts';
import { isTerminal, principalKey, requestPrincipal, type WriteRequest } from './model.ts';

export interface IntentRedactionTarget { id: string; principal_kind: string; principal_id: string }

/** Rows one keyset chunk of the journal sweep reads at a time. */
export const JOURNAL_SWEEP_CHUNK_ROWS = 2000;
/** The match cap `findRequestsCarrying` always had; a sweep that reaches it reports `complete: false`. */
export const JOURNAL_SWEEP_MATCH_CAP = 10_000;

/** Every form a claim takes inside the journal's text columns: lowercased raw, and lowercased as it appears inside a JSON string. */
export function carryingNeedles(claims: readonly string[]): string[] {
  const forms = claims.flatMap(claim => [claim.toLowerCase(), JSON.stringify(claim).slice(1, -1).toLowerCase()]);
  return [...new Set(forms.filter(Boolean))];
}

type ChunkRow = JournalChunkRow;
/**
 * One chunk of the carrying predicate: the rows of `sourceId` with `after < sequence <= ceiling` (`ceiling` null: no upper
 * bound), in sequence order, at most `limit`. The chunk is materialised once and each text column lowered once per row;
 * only the rows that match a needle or are still pending come back, with the 0-based indexes of the needles each carries
 * (`hits`), plus the chunk's row count and last scanned sequence (as text: bigint) so the caller continues past a chunk
 * that matched nothing (`sweepJournalChunk`, engine-sql/page-purge-journal.ts).
 */
async function sweepChunk(engine: Pick<BrainEngine, 'sweepJournalChunk'>, sourceId: string, needles: readonly string[], after: string, ceiling: string | null, limit: number,
  ids: readonly string[] | null = null, exclude: string | null = null): Promise<{ rows: ChunkRow[]; scanned: number; last: string | null }> {
  return engine.sweepJournalChunk({ sourceId, needles, after, ceiling, limit, ids, exclude });
}

export interface JournalSweep {
  /** Terminal-at-scan requests carrying a needle (the publication redacts them under `FOR UPDATE`). */
  targets: IntentRedactionTarget[];
  /** Requests that were queued, running or recovering when the scan passed them; the publication tests them again. */
  pendingAtScan: string[];
  /** The highest sequence the scan covered (text: bigint); null when the source had no requests. */
  ceiling: string | null;
  scanned: number;
  /** False when the match cap was hit: rows past it were not tested. */
  complete: boolean;
  /** #6884: the sequence this sweep started past (an earlier batch sweep's ceiling); null when it scanned from the start. */
  watermark?: string | null;
  /** #6884: how many purges the journal sweep this result comes from covered (1: this purge alone). */
  batch?: number;
}
/**
 * The preparation-time census (#6511): every request of `sourceId` up to the sequence ceiling read at the start, in
 * `JOURNAL_SWEEP_CHUNK_ROWS` keyset chunks, continuing from the last scanned row whether or not it matched. Between
 * chunks the loop checks the claim clock itself, so on PGLite (no server-side bound) a sweep past its preparation
 * budget ends with the budget's own `preparation_deadline` and the consumer releases the claim charged; on Postgres
 * `boundedReads` ends the chunk statement at the same bound. Needles stay in memory; no text is returned.
 */
export async function sweepRequestsCarrying(engine: Pick<BrainEngine, 'sweepJournalChunk' | 'readJournalCeiling'>, sourceId: string, claims: readonly string[],
  opts: SweepOptions = {}): Promise<JournalSweep> {
  return (await sweepRequestsForGroups(engine, sourceId, [{ key: '', claims }], opts)).get('')!;
}

export interface SweepOptions {
  clock?: ClaimPhaseClock; chunkRows?: number; matchCap?: number; onChunk?: () => Promise<void> | void; now?: () => number;
  /** The purge's own request row (running while it scans): never a target, never pending. */ exclude?: string;
  /** #6884: start past this sequence (an earlier sweep's ceiling): only the tail is read. */ after?: string;
}
/**
 * #6884: one census for several needle groups. Each journal row is read and lowered once and tested against the union of
 * the groups' needles; a hit counts for every group carrying that needle, and a pending row is pending for every group.
 * The match cap applies per group: a group that reaches it stops collecting (`complete: false`) and the sweep ends once
 * no group is collecting.
 */
export async function sweepRequestsForGroups(engine: Pick<BrainEngine, 'sweepJournalChunk' | 'readJournalCeiling'>, sourceId: string, groups: ReadonlyArray<{ key: string; claims: readonly string[] }>,
  opts: SweepOptions = {}): Promise<Map<string, JournalSweep>> {
  const chunkRows = opts.chunkRows ?? JOURNAL_SWEEP_CHUNK_ROWS, matchCap = opts.matchCap ?? JOURNAL_SWEEP_MATCH_CAP, now = opts.now ?? Date.now;
  const needles: string[] = [], owners: Array<Set<string>> = [];
  for (const group of groups) for (const needle of carryingNeedles(group.claims)) {
    let at = needles.indexOf(needle);
    if (at < 0) { at = needles.push(needle) - 1; owners.push(new Set()); }
    owners[at]!.add(group.key);
  }
  const ceiling = await engine.readJournalCeiling(sourceId);
  let scanned = 0;
  const sweeps = new Map(groups.map(group => [group.key, { targets: [] as IntentRedactionTarget[], pendingAtScan: [] as string[], ceiling, scanned: 0, complete: true,
    ...(opts.after !== undefined ? { watermark: opts.after } : {}) }]));
  const collecting = new Set(groups.filter(group => carryingNeedles(group.claims).length).map(group => group.key));
  const stopped = new Set<string>();
  const finish = () => { for (const [key, sweep] of sweeps) if (!stopped.has(key)) sweep.scanned = scanned; return sweeps; };
  if (ceiling === null || !needles.length || (opts.after !== undefined && BigInt(opts.after) >= BigInt(ceiling))) return finish();
  for (let after = opts.after ?? '0'; ;) {
    enterClaimStep(opts.clock, 'purge_journal_sweep', undefined, 'db');
    if (opts.clock?.deadlineAt !== undefined && now() >= opts.clock.deadlineAt) throw journalSweepDeadline(opts.clock);
    await opts.onChunk?.();
    const chunk = await sweepChunk(engine, sourceId, needles, after, ceiling, chunkRows, null, opts.exclude ?? null);
    scanned += chunk.scanned;
    for (const row of chunk.rows) {
      const target = { id: row.id, principal_kind: row.principal_kind, principal_id: row.principal_id };
      const hit = new Set(row.hits.flatMap(i => [...owners[i] ?? []]));
      for (const key of collecting) {
        if (row.pending) sweeps.get(key)!.pendingAtScan.push(row.id);
        else if (hit.has(key)) sweeps.get(key)!.targets.push(target);
      }
    }
    for (const key of [...collecting]) {
      const sweep = sweeps.get(key)!;
      if (sweep.targets.length < matchCap) continue;
      sweep.targets.length = matchCap;
      sweep.complete = false;
      sweep.scanned = scanned;
      collecting.delete(key);
      stopped.add(key);
    }
    if (!collecting.size || chunk.scanned < chunkRows || chunk.last === null) return finish();
    after = chunk.last;
  }
}
/** The budget's own abort reason, raised by the sweep loop between chunks when the clock has run out (`preparationAbortReason` reads `code`). */
function journalSweepDeadline(clock: ClaimPhaseClock): Error {
  return Object.assign(new Error(`The purge's journal sweep${clock.step ? ` at step ${clock.step}` : ''} reached its preparation budget between chunks.`), { code: 'preparation_deadline' });
}

export interface JournalRecheck { targets: IntentRedactionTarget[]; tail: number; pendingRechecked: number; complete: boolean }
/**
 * The publication-time reconciliation (#6511), inside the purge transaction: the same predicate over the tail the scan
 * did not cover (`sequence > ceiling`, one bounded chunk; more rows than that leave `complete: false`) and over the rows
 * that were pending at scan time (settled ones with a carrying outcome now redact; still-pending ones are left to
 * `redactRequestIntents`' `skipPending`). Returns the ids to redact in addition to the sweep's.
 */
export async function recheckRequestsCarrying(tx: Pick<BrainEngine, 'sweepJournalChunk'>, sourceId: string, claims: readonly string[], sweep: Pick<JournalSweep, 'ceiling' | 'pendingAtScan'>,
  opts: { tailRows?: number; beforePending?: () => Promise<void> | void; exclude?: string } = {}): Promise<JournalRecheck> {
  const needles = carryingNeedles(claims);
  const tailRows = opts.tailRows ?? JOURNAL_SWEEP_CHUNK_ROWS;
  const targets = new Map<string, IntentRedactionTarget>();
  if (!needles.length) return { targets: [], tail: 0, pendingRechecked: 0, complete: true };
  const tail = await sweepChunk(tx, sourceId, needles, sweep.ceiling ?? '0', null, tailRows, null, opts.exclude ?? null);
  for (const row of tail.rows) if (row.matched && !row.pending) targets.set(row.id, { id: row.id, principal_kind: row.principal_kind, principal_id: row.principal_id });
  await opts.beforePending?.();
  const pending = sweep.pendingAtScan.length ? await sweepChunk(tx, sourceId, needles, '0', null, sweep.pendingAtScan.length, sweep.pendingAtScan, opts.exclude ?? null) : { rows: [], scanned: 0, last: null };
  for (const row of pending.rows) if (row.matched && !row.pending) targets.set(row.id, { id: row.id, principal_kind: row.principal_kind, principal_id: row.principal_id });
  return { targets: [...targets.values()], tail: tail.scanned, pendingRechecked: pending.scanned, complete: tail.scanned < tailRows };
}

/**
 * Requests in `sourceId` whose stored intent, outcome or error text carries `claim`, or `reason` (the claim folded
 * as a stored change reason is), bounded, compacted ones included (compaction keeps the outcome). Owner-only; never
 * returns the text.
 */
export async function findRequestsCarrying(engine: BrainEngine, sourceId: string, claim: string, reason = claim, limit = 10_000): Promise<IntentRedactionTarget[]> {
  // The claim as it appears inside a JSON string (quotes and backslashes escaped), lowercased.
  return engine.listRequestsCarryingClaim({ sourceId, claimLower: claim.toLowerCase(), claimJson: JSON.stringify(claim).slice(1, -1).toLowerCase(),
    reason: JSON.stringify(reason).slice(1, -1).toLowerCase(), limit });
}

/** Replace every JSON string that carries one of `needles` (case-insensitive) with "[purged]"; structure and other values stay. */
export function redactJson<T>(value: T, needles: readonly string[], exact?: ReadonlySet<string>): T {
  const lowered = needles.map(n => n.toLowerCase()).filter(Boolean);
  if ((!lowered.length && !exact?.size) || value === null || value === undefined) return value;
  const hit = (v: string) => { if (exact?.has(v.trim())) return true; const low = v.toLowerCase(); return lowered.some(n => low.includes(n)); };
  const walk = (v: unknown): unknown => typeof v === 'string' ? (hit(v) ? '[purged]' : v)
    : Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v;
  return walk(value) as T;
}

/** Requests in `sourceId` that target one of `slugs` and still hold an intent (page purge), in sequence order after `after`. */
export async function findRequestsForSlugs(engine: Pick<BrainEngine, 'listRequestsForSlugs'>, sourceId: string, slugs: readonly string[], limit = 10_000, after = '0'): Promise<Array<IntentRedactionTarget & { sequence: string }>> {
  return engine.listRequestsForSlugs(sourceId, slugs, limit, after);
}

/**
 * Wave B (spec 11): unfinished requests of `sourceId` whose intent references one of `stagingIds` by
 * `body_ref` (the request publishes that staged body, so its text lives in the staging, not the intent).
 */
export async function findRequestsHoldingStagings(engine: Pick<BrainEngine, 'listRequestsHoldingStagings'>, sourceId: string, stagingIds: readonly string[]): Promise<IntentRedactionTarget[]> {
  if (!stagingIds.length) return [];
  return engine.listRequestsHoldingStagings(sourceId, stagingIds);
}

/**
 * Cancel the unclaimed (queued, or deferred behind a refresh: GST-1602) requests of `targets` with `purged_content` inside the
 * purge's transaction (the caller holds their counter locks): the staged body they would publish is being purged. A request
 * already claimed (running, recovering, or with a recovery record) refuses the purge with retryable `purge_blocked_pending_recovery`.
 */
export async function cancelRequestsHoldingStagings(tx: BrainEngine, targets: readonly IntentRedactionTarget[], exclude?: string): Promise<number> {
  const ids = targets.map(t => t.id).filter(id => id !== exclude);
  if (!ids.length) return 0;
  // The typed request lock (engine-sql/persistence-journal.ts lockWriteRequestsById): the rows in id order, FOR UPDATE.
  const rows = await tx.lockWriteRequestsById(ids);
  const blocked = rows.find(row => (!isTerminal(row) && row.state !== 'queued' && row.state !== 'deferred') || row.recovery);
  if (blocked) {
    throw opError('purge_blocked_pending_recovery', 'A pending write is publishing a staged body that holds this content, so nothing was purged.',
      `Request ${blocked.request_id} (${blocked.operation} on ${blocked.slug}, state ${blocked.state}) is publishing the staged body. Wait for it to finish, then retry the purge with the same request id.`,
      { fix: { argv: ['gbrain', 'write-request', '--', blocked.request_id], consent: [], actor: 'agent', requires_exclusive: false,
        why: 'Shows the blocking write\'s state, read-only; retry the purge once it is final.' } });
  }
  let cancelled = 0;
  for (const row of rows) {
    if (isTerminal(row)) continue;
    await completeWrite(tx, row, 'cancelled', {}, { code: 'purged_content', message: 'Cancelled: the staged body this request would publish held purged content.' });
    cancelled++;
  }
  return cancelled;
}

/** The counter keys an affected request set touches; lock them before admitting the purge's own request. */
export function redactionCounterKeys(targets: readonly IntentRedactionTarget[]): string[] {
  return [...new Set(targets.map(t => principalKey({ kind: t.principal_kind as WriteRequest['principal_kind'], id: t.principal_id })))];
}

/**
 * Redact the intents of `targets` inside the caller's transaction. The caller
 * already holds the counter locks (`redactionCounterKeys` plus 'brain').
 * `exclude` is the purge's own request id. Returns the number redacted.
 */
export async function redactRequestIntents(tx: BrainEngine, targets: readonly IntentRedactionTarget[], exclude?: string,
  opts: { skipPending?: boolean; needles?: readonly string[]; exact?: ReadonlySet<string> } = {}): Promise<number> {
  const ids = targets.map(t => t.id).filter(id => id !== exclude);
  if (!ids.length) return 0;
  await lockCounters(tx, ['brain', ...redactionCounterKeys(targets)]);
  const rows = await tx.lockWriteRequestsById(ids);
  // A page purge leaves later queued writes for the slug in place (they fail on the missing page); a fact purge refuses.
  const blocked = opts.skipPending ? undefined : rows.find(row => !isTerminal(row) || row.recovery);
  if (blocked) {
    throw opError('purge_blocked_pending_recovery', 'A pending write still carries this content, so nothing was purged.',
      `Request ${blocked.request_id} (${blocked.operation} on ${blocked.slug}, state ${blocked.state}${blocked.recovery ? ', with a recovery record' : ''}) still needs its stored intent. `
      + 'Wait for it to finish or recover, then retry the purge with the same request id.',
      { fix: { argv: ['gbrain', 'write-request', '--', blocked.request_id], consent: [], actor: 'agent', requires_exclusive: false,
        why: 'Shows the blocking write\'s state, read-only; retry the purge once it is final.' } });
  }
  let redacted = 0;
  for (const current of rows) {
    if (!isTerminal(current) || current.recovery) continue;
    // The stored outcome stays the replay answer, with every string carrying the claim replaced by "[purged]".
    const outcome = redactJson(current.outcome, opts.needles ?? [], opts.exact);
    const detail = redactJson(current.error_detail, opts.needles ?? [], opts.exact);
    if (current.compacted && JSON.stringify(outcome) === JSON.stringify(current.outcome) && JSON.stringify(detail) === JSON.stringify(current.error_detail)
      && current.error_message === null) continue;
    const effects = await tx.readEffectBytes(current.id);
    const retained = Math.min(Number(current.terminal_reservation), retainedReceiptBytes({ authority: current.authority, outcome, error_detail: detail,
      client_request_id: current.client_request_id }, { stage: 'compacted', effects }));
    await tx.redactWriteRequestRow({ id: current.id, terminalReservation: retained, outcome, errorDetail: detail });
    for (const key of ['brain', principalKey(requestPrincipal(current))]) await tx.releaseTerminalBytes(key, Number(current.terminal_reservation) - retained);
    redacted++;
  }
  return redacted;
}
