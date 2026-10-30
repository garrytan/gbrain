/**
 * #6696 (A1): the settlement-time true-up. A terminal request whose effects
 * have all settled (none `queued` or `running`) keeps only
 * `retainedReceiptBytes` of its admission reservation; the rest goes back to
 * the brain and principal counters.
 *
 * Effects settle on many paths (the effect runner's complete/fail/park, the
 * bulk embedding settles, `retry-effects`, restore's bulk fail), several of
 * them inside transactions that lock effect rows and page keys before any
 * counter. So the true-up never runs inside them: each path calls
 * `trueUpRequests` after its own transaction commits, and it takes its own
 * short transaction under the established lock order, counters first in
 * their collated order, then a compare-and-set on the request rows (the
 * reservation it read and the effect bytes it sized are unchanged, no effect
 * re-armed). A decrement larger than a counter clamps at zero and is counted
 * in `persistence.true_up.clamped`. Calling it twice changes nothing.
 * `test/persistence-true-up-sites.test.ts` fails when an effect state change
 * site does not reach it.
 */
import type { BrainEngine } from '../engine.ts';
import { lockCounters } from './journal.ts';
import { principalKey, type WriteRequest } from './model.ts';
import { declarePersistenceProtocol, isPersistenceDeclaration } from './protocol.ts';
import { EFFECT_BYTES_SQL, retainedReceiptBytes, TRUE_UP_CLAMP_SQL } from './receipt-bytes.ts';

type Candidate = Pick<WriteRequest, 'id' | 'intent' | 'authority' | 'outcome' | 'error_message' | 'error_detail' | 'client_request_id'
  | 'terminal_reservation' | 'principal_kind' | 'principal_id'> & { compacted: boolean; effect_bytes: string; unfinished: boolean };

const UNSETTLED = "('queued','running')";

/** Shrinks each settled terminal request's reservation to what its receipt keeps; returns the bytes given back. */
export async function trueUpRequests(engine: BrainEngine, requestIds: Iterable<string>): Promise<number> {
  const ids = [...new Set(requestIds)];
  if (!ids.length) return 0;
  const rows = await engine.executeRaw<Candidate>(`SELECT r.id,r.intent,r.authority,r.outcome,r.error_message,r.error_detail,r.client_request_id,
      r.terminal_reservation,r.principal_kind,r.principal_id,r.compacted,
      COALESCE((SELECT SUM(${EFFECT_BYTES_SQL}) FROM persistence_effects e WHERE e.request_id=r.id),0)::text AS effect_bytes,
      EXISTS(SELECT 1 FROM persistence_effects e WHERE e.request_id=r.id AND e.state IN ${UNSETTLED}) AS unfinished
    FROM persistence_requests r WHERE r.id=ANY($1::uuid[]) AND r.state IN ('committed','failed','conflict','cancelled')`, [ids]);
  const shrink = rows.flatMap(row => {
    if (row.unfinished) return [];
    const old = Number(row.terminal_reservation);
    const kept = retainedReceiptBytes(row, { stage: row.compacted ? 'compacted' : 'terminal', effects: Number(row.effect_bytes) });
    return kept < old ? [{ row, old, kept }] : [];
  });
  if (!shrink.length) return 0;
  const keys = ['brain', ...shrink.map(({ row }) => principalKey({ kind: row.principal_kind, id: row.principal_id }))];
  return engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    await lockCounters(tx, keys);
    const [freed] = await tx.executeRaw<{ freed: string }>(`WITH t AS (SELECT * FROM unnest($1::uuid[],$2::bigint[],$3::bigint[],$4::bigint[]) AS t(id,old,kept,effects)),
      done AS (UPDATE persistence_requests r SET terminal_reservation=t.kept FROM t
        WHERE r.id=t.id AND r.terminal_reservation=t.old
          AND NOT EXISTS (SELECT 1 FROM persistence_effects e WHERE e.request_id=r.id AND e.state IN ${UNSETTLED})
          AND COALESCE((SELECT SUM(${EFFECT_BYTES_SQL}) FROM persistence_effects e WHERE e.request_id=r.id),0)=t.effects
        RETURNING r.principal_kind,r.principal_id,t.old-t.kept AS freed),
      d AS (SELECT k.key,SUM(done.freed) AS freed FROM done
        CROSS JOIN LATERAL (VALUES ('brain'),('principal:'||done.principal_kind||':'||done.principal_id)) AS k(key) GROUP BY k.key),
      released AS (UPDATE persistence_counters c SET terminal_bytes=c.terminal_bytes-LEAST(d.freed,c.terminal_bytes) FROM d WHERE c.key=d.key),
      ${TRUE_UP_CLAMP_SQL('SELECT count(*) FROM d JOIN persistence_counters c ON c.key=d.key WHERE d.freed>c.terminal_bytes')}
      SELECT COALESCE(SUM(freed),0)::text AS freed FROM done`,
    [shrink.map(s => s.row.id), shrink.map(s => s.old), shrink.map(s => s.kept), shrink.map(s => s.row.effect_bytes)]);
    return Number(freed?.freed ?? 0);
  }, { pipelineFirst: isPersistenceDeclaration });
}

/** Config row: the sequence the one-shot compacted-receipt sweep has walked through (`done` once it reached the end). */
export const COMPACTED_SWEEP_KEY = 'persistence.true_up.compacted_through';

/**
 * #6696: receipts compacted before this release (redacted for purged content,
 * or compacted by an older formula) can still hold their full admission
 * reservation. One bounded pass walks `scan` rows of the sequence index past
 * the stored cursor and trues up the compacted ones; the cursor reaches
 * `done` at the end of the journal, after which the pass costs one config
 * read. Receipts compacted from now on shrink at compaction. Returns the bytes
 * given back.
 */
export async function sweepCompactedReservations(engine: BrainEngine, scan = 1000): Promise<{ freed_bytes: number; done: boolean }> {
  const cursor = await engine.getConfig(COMPACTED_SWEEP_KEY);
  if (cursor === 'done') return { freed_bytes: 0, done: true };
  const after = cursor && /^\d+$/.test(cursor) ? cursor : '0';
  const window = await engine.executeRaw<{ id: string; sequence: string; compacted: boolean }>(`SELECT id,sequence::text AS sequence,compacted
    FROM persistence_requests WHERE sequence>$1::bigint ORDER BY sequence LIMIT $2`, [after, scan]);
  if (!window.length) {
    await engine.setConfig(COMPACTED_SWEEP_KEY, 'done');
    return { freed_bytes: 0, done: true };
  }
  const freed = await trueUpRequests(engine, window.filter(row => row.compacted).map(row => row.id));
  await engine.setConfig(COMPACTED_SWEEP_KEY, window[window.length - 1]!.sequence);
  return { freed_bytes: freed, done: false };
}
