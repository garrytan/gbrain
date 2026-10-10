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
 */

import { opError } from '../ops/contract.ts';
import type { BrainEngine } from '../engine.ts';
import { jsonBytes } from './digest.ts';
import { lockCounters } from './journal.ts';
import { isTerminal, principalKey, requestPrincipal, type WriteRequest } from './model.ts';

export interface IntentRedactionTarget { id: string; principal_kind: string; principal_id: string }

/**
 * Requests in `sourceId` whose stored intent, outcome or error text carries `claim`, bounded, compacted
 * ones included (compaction keeps the outcome). Owner-only; never returns the text.
 */
export async function findRequestsCarrying(engine: BrainEngine, sourceId: string, claim: string, limit = 10_000): Promise<IntentRedactionTarget[]> {
  const needle = claim.toLowerCase();
  // The claim as it appears inside a JSON string (quotes and backslashes escaped), lowercased.
  const jsonNeedle = JSON.stringify(claim).slice(1, -1).toLowerCase();
  const carries = (column: string) => `(${column} IS NOT NULL AND (strpos(lower(${column}::text),$2)>0 OR strpos(lower(${column}::text),$3)>0))`;
  return engine.executeRaw<IntentRedactionTarget>(`SELECT id::text AS id,principal_kind,principal_id FROM persistence_requests
    WHERE source_id=$1 AND (${carries('intent')} OR ${carries('outcome')} OR ${carries('error_detail')} OR ${carries('error_message')})
    ORDER BY sequence LIMIT $4`, [sourceId, needle, jsonNeedle, limit]);
}

/** Replace every JSON string that carries one of `needles` (case-insensitive) with "[purged]"; structure and other values stay. */
export function redactJson<T>(value: T, needles: readonly string[]): T {
  const lowered = needles.map(n => n.toLowerCase()).filter(Boolean);
  if (!lowered.length || value === null || value === undefined) return value;
  const walk = (v: unknown): unknown => typeof v === 'string' ? (lowered.some(n => v.toLowerCase().includes(n)) ? '[purged]' : v)
    : Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v;
  return walk(value) as T;
}

/** Requests in `sourceId` that target one of `slugs` and still hold an intent (page purge). */
export async function findRequestsForSlugs(engine: BrainEngine, sourceId: string, slugs: readonly string[], limit = 10_000): Promise<IntentRedactionTarget[]> {
  return engine.executeRaw<IntentRedactionTarget>(`SELECT id::text AS id,principal_kind,principal_id FROM persistence_requests
    WHERE source_id=$1 AND slug=ANY($2::text[]) AND NOT compacted AND intent IS NOT NULL ORDER BY sequence LIMIT $3`, [sourceId, [...slugs], limit]);
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
  opts: { skipPending?: boolean; needles?: readonly string[] } = {}): Promise<number> {
  const ids = targets.map(t => t.id).filter(id => id !== exclude);
  if (!ids.length) return 0;
  await lockCounters(tx, ['brain', ...redactionCounterKeys(targets)]);
  const rows = await tx.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [ids]);
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
    const outcome = redactJson(current.outcome, opts.needles ?? []);
    const detail = redactJson(current.error_detail, opts.needles ?? []);
    if (current.compacted && JSON.stringify(outcome) === JSON.stringify(current.outcome) && JSON.stringify(detail) === JSON.stringify(current.error_detail)
      && current.error_message === null) continue;
    const [effects] = await tx.executeRaw<{ bytes: string }>(`SELECT COALESCE(SUM(octet_length(data::text)+octet_length(kind)+1024),0)::text AS bytes
      FROM persistence_effects WHERE request_id=$1::uuid`, [current.id]);
    const retained = Math.min(Number(current.terminal_reservation), jsonBytes(current.authority) + jsonBytes(outcome ?? {})
      + (detail ? jsonBytes(detail) : 0) + Number(effects.bytes) + 1024);
    await tx.executeRaw(`UPDATE persistence_requests SET intent=NULL,compacted=true,error_message=NULL,terminal_reservation=$2,
      outcome=$3::text::jsonb,error_detail=$4::text::jsonb WHERE id=$1::uuid`,
    [current.id, retained, outcome == null ? null : JSON.stringify(outcome), detail == null ? null : JSON.stringify(detail)]);
    for (const key of ['brain', principalKey(requestPrincipal(current))]) {
      await tx.executeRaw('UPDATE persistence_counters SET terminal_bytes=terminal_bytes-$2 WHERE key=$1', [key, Number(current.terminal_reservation) - retained]);
    }
    redacted++;
  }
  return redacted;
}
