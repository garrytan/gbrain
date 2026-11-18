/**
 * The write-journal statements in src/core/engine-sql/persistence-journal.ts are written out in full, so the engines
 * do not load the journal module (its imports reach most of the codebase). Each one copies text the journal builds
 * from shared fragments.
 *
 * 1. Protects: the claim stamp and the completion the engines run are the statements the journal's fragments
 *    describe (the sync-row test, the refresh barrier, the effect sizing, the true-up clamp, the purge columns).
 * 2. Fails when: someone changes one of those fragments (for example the sync kind test or the effect byte sizing)
 *    and the engines keep running the old text, so the claim or the completion disagrees with every other reader.
 * 3. Existing coverage: the journal tests check behavior on today's text; none compares the written-out copy with
 *    the fragments, and a changed fragment can keep those tests green.
 * 4. Production seam: none.
 */
import { describe, expect, test } from 'bun:test';
import { CLAIM_STAMP_SQL, COMPLETE_WRITE_PURGE_PROBE_SQL, COMPLETE_WRITE_SQL } from '../src/core/engine-sql/persistence-journal.ts';
import { REFRESH_BARRIER_CLAIM_PREDICATE, SYNC_KIND } from '../src/core/persistence/journal.ts';
import { EFFECT_BYTES_SQL, TRUE_UP_CLAMP_SQL } from '../src/core/persistence/receipt-bytes.ts';
import { PURGE_PRESENCE_COLUMNS } from '../src/core/persistence/purged-intent.ts';

const completion = (purgeColumns: string) => `WITH effects AS (SELECT COALESCE(SUM(${EFFECT_BYTES_SQL}),0) AS bytes,
      COALESCE(bool_or(state<>'committed'),false) AS unfinished FROM persistence_effects WHERE request_id=$1::uuid),
    done AS (UPDATE persistence_requests SET state=$2,outcome=$3::text::jsonb,
      error_code=$4,error_message=$5,error_detail=COALESCE($8::text::jsonb,error_detail),completed_at=now(),updated_at=now(),claim_expires_at=NULL,blocked_reason=NULL,
      consumer_version=CASE WHEN $2='committed' THEN $6 ELSE consumer_version END,
      consumer_host_id=CASE WHEN $2='committed' THEN $7::uuid ELSE consumer_host_id END,
      consumer_segment_reader=CASE WHEN $2='committed' THEN true ELSE consumer_segment_reader END,
      published_at=CASE WHEN $2='committed' THEN now() ELSE published_at END,
      preparation_attempts=CASE WHEN $2='committed' THEN 0 ELSE preparation_attempts END,
      terminal_reservation=CASE WHEN (SELECT unfinished FROM effects) THEN terminal_reservation
        ELSE LEAST(terminal_reservation,$12::bigint+(SELECT bytes FROM effects)) END
      WHERE id=$1::uuid AND $9::bigint+(SELECT bytes FROM effects)<=terminal_reservation RETURNING *),
    released AS (UPDATE persistence_counters c SET outstanding_count=c.outstanding_count-1,intent_bytes=c.intent_bytes-$11,
      terminal_bytes=c.terminal_bytes-LEAST($13::bigint-done.terminal_reservation,c.terminal_bytes)
      FROM done WHERE c.key=ANY($10::text[])),
    ${TRUE_UP_CLAMP_SQL('SELECT count(*) FROM persistence_counters c, done WHERE c.key=ANY($10::text[]) AND $13::bigint-done.terminal_reservation>c.terminal_bytes')}
    SELECT done.*${purgeColumns} FROM done`;

describe('written-out write-journal statements', () => {
  test('the claim stamp is the journal\'s claim with its sync-row test and refresh barrier', () => {
    expect(CLAIM_STAMP_SQL).toBe(`UPDATE persistence_requests SET state='running',
      execution_token=$2::uuid,claim_expires_at=now()+($3::double precision*interval '1 millisecond'),
      updated_at=now(),blocked_reason=NULL,claim_phase=$4::text::jsonb WHERE id=$1::uuid AND ${REFRESH_BARRIER_CLAIM_PREDICATE} RETURNING *,EXISTS (SELECT 1 FROM persistence_requests earlier
        WHERE earlier.worktree_id=persistence_requests.worktree_id AND earlier.sequence<persistence_requests.sequence
        AND earlier.state='queued' AND ${SYNC_KIND('earlier')}) AS passed_sync,
        CASE WHEN ${SYNC_KIND('persistence_requests')} THEN (SELECT max(sequence) FROM persistence_requests)::text END AS seen_sequence`);
  });

  test('the completion uses the shared effect sizing, true-up clamp and purge columns', () => {
    expect(COMPLETE_WRITE_SQL).toBe(completion(''));
    expect(COMPLETE_WRITE_PURGE_PROBE_SQL).toBe(completion(`, ${PURGE_PRESENCE_COLUMNS}`));
  });
});
