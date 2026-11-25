/**
 * Pins the statements of engine-sql/persistence-upkeep.ts to the text their callers composed before they moved there
 * (persistence/journal.ts `compactReceipt` and `newestSyncReceipt`, persistence/effect-journal.ts `rearmWithheldTargets`
 * and `effectClaimKeeper`), with the same shared fragments spliced in: the persistence protocol predicate, the effect
 * byte sum, the open-pass predicate and the re-armable rule.
 */
import { expect, test } from 'bun:test';
import '../src/core/persistence/journal.ts';
import { MANAGED_SYNC_PASS_OP } from '../src/core/persistence/sync-pass-row.ts';
import { PERSISTENCE_UPKEEP_SQL } from '../src/core/engine-sql/persistence-upkeep.ts';
import { REARMABLE_SQL } from '../src/core/engine-sql/persistence-effect-worker.ts';
import { PERSISTENCE_PROTOCOL_PREDICATE } from '../src/core/persistence/protocol.ts';
import { EFFECT_BYTES_SQL } from '../src/core/persistence/receipt-bytes.ts';

const OPEN_SYNC_PASS_SQL = (r: string) => `${r}.intent ? 'passId' AND EXISTS (SELECT 1 FROM op_checkpoints p
      WHERE p.op='${MANAGED_SYNC_PASS_OP}' AND p.completed_keys->0->'telemetry'->>'pass_id'=${r}.intent->>'passId' AND p.completed_keys->0->'telemetry'->>'outcome'='open')`;

test('the upkeep statements are their callers\' text with the shared fragments spliced in', () => {
  expect({ ...PERSISTENCE_UPKEEP_SQL } as Record<string, string>).toEqual({
    lockTimeout: "SET LOCAL lock_timeout = '2s'",
    statementTimeout: "SET LOCAL statement_timeout = '15s'",
    lockReceipt: `SELECT r.*,
        ($2::timestamptz IS NULL OR r.completed_at < $2::timestamptz) AS eligible_age,
        EXISTS (SELECT 1 FROM op_checkpoints c WHERE r.intent ? 'runId' AND c.op='managed-sync' AND c.completed_keys->0->>'runId'=r.intent->>'runId'
          AND COALESCE(c.completed_keys->0->>'done','false')<>'true') AS open_cursor,
        COALESCE(${OPEN_SYNC_PASS_SQL('r')}, false) AS open_pass
      FROM persistence_requests r WHERE r.id=$1::uuid FOR UPDATE OF r`,
    unfinishedEffect: "SELECT 1 FROM persistence_effects WHERE request_id=$1::uuid AND state<>'committed' LIMIT 1",
    newestSyncReceipt: `SELECT id FROM persistence_requests WHERE worktree_id=$1::uuid AND state='committed'
    AND COALESCE(intent->>'kind','') LIKE 'managed_sync_%' ORDER BY completed_at DESC, sequence DESC LIMIT 1`,
    effectBytes: `SELECT COALESCE(SUM(${EFFECT_BYTES_SQL}),0)::text AS bytes
      FROM persistence_effects WHERE request_id=$1::uuid`,
    markCompacted: 'UPDATE persistence_requests SET intent=NULL,compacted=true,error_message=NULL,terminal_reservation=$2 WHERE id=$1::uuid',
    releaseTerminalBytes: 'UPDATE persistence_counters SET terminal_bytes=terminal_bytes-LEAST($2::bigint,terminal_bytes) WHERE key=ANY($1::text[])',
    lockRearmable: `SELECT e.* FROM persistence_effects e WHERE ${REARMABLE_SQL}
    ORDER BY e.id FOR UPDATE OF e SKIP LOCKED`,
    rearmEffect: `UPDATE persistence_effects SET state='queued',data=$2::text::jsonb,error_code=NULL,claim_expires_at=NULL,claim_owner=NULL,
      next_attempt_at=now(),updated_at=now() WHERE id=$1 AND execution_token IS NULL AND recovery IS NULL AND ${PERSISTENCE_PROTOCOL_PREDICATE}`,
    renewHeldClaim: `UPDATE persistence_effects SET claim_expires_at=now()+interval '2 minutes',updated_at=now()
      WHERE id=$1 AND execution_token=$2::uuid AND state='running' AND ${PERSISTENCE_PROTOCOL_PREDICATE} RETURNING id`,
  });
});
