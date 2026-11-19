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
 *
 * The claim upkeep statements in src/core/engine-sql/persistence-claims.ts follow the same rule: the claimable-row
 * test, the renewal, the expiry and the protocol predicate are pinned below against the journal, consumer and
 * claim-phase fragments they copy.
 *
 * The housekeeping statements in src/core/engine-sql/persistence-housekeeping.ts and the lifecycle receipt statements in
 * persistence-claims.ts follow it too: the compaction listing's refusal and sync exclusions, the effect sizing of the
 * true-up and the capacity reads, the compacted-byte sizing, and the projection queue's probes are pinned below.
 *
 * The effect claim's candidate read in src/core/engine-sql/persistence-effect-scans.ts does too: its dead-owner test and
 * refresh fence are pinned below against the effect-journal and worktree-refresh fragments.
 */
import { describe, expect, test } from 'bun:test';
import { CLAIM_STAMP_SQL, COMPLETE_WRITE_PURGE_PROBE_SQL, COMPLETE_WRITE_SQL } from '../src/core/engine-sql/persistence-journal.ts';
import { REFRESH_BARRIER_CLAIM_PREDICATE, SYNC_KIND } from '../src/core/persistence/journal.ts';
import { EFFECT_BYTES_SQL, TRUE_UP_CLAMP_SQL } from '../src/core/persistence/receipt-bytes.ts';
import { PURGE_PRESENCE_COLUMNS } from '../src/core/persistence/purged-intent.ts';
import { claimableWriteFragment, EXPIRE_CLAIMS_SQL, foregroundPriorityText, hasClaimableWriteFragment, PROTOCOL_PREDICATE_SQL,
  RENEW_CLAIM_SQL } from '../src/core/engine-sql/persistence-claims.ts';
import { renderFragment } from '../src/core/engine-sql/fragment.ts';
import { withEnv } from './helpers/with-env.ts';
import { claimableWriteSql, foregroundPrioritySql } from '../src/core/persistence/journal.ts';
import { PERSISTENCE_PROTOCOL_PREDICATE } from '../src/core/persistence/protocol.ts';
import { EXPIRED_PREPARING_CHARGE_SQL } from '../src/core/persistence/claim-phase.ts';
import { CAPACITY_PRINCIPAL_DAYS_SQL, CAPACITY_RECLAIM_SQL, COMPACTABLE_RECEIPTS_SQL, PROJECTION_RETRY_READY_TEXT, SEGMENTED_JOB_PROBES_SQL,
  SEGMENTED_PROJECTION_CLAIMED_TEXT, TRUE_UP_REQUESTS_SQL, projectionWindowFragment } from '../src/core/engine-sql/persistence-housekeeping.ts';
import { residentWindowCtes, type ProjectionScanCursor } from '../src/core/page-state/projection-window.ts';
import { INSERT_TOPOLOGY_CHANGE_SQL, TOPOLOGY_CHANGE_SQL } from '../src/core/engine-sql/persistence-claims.ts';
import { NEWEST_SYNC_RECEIPT_EXCLUSION, OPEN_SYNC_CURSOR_EXCLUSION } from '../src/core/persistence/journal.ts';
import { UNRESOLVED_CALLER_REFUSAL_SQL } from '../src/core/persistence/terminal-classify.ts';
import { COMPACTED_RECEIPT_BYTES_SQL } from '../src/core/persistence/receipt-bytes.ts';
import { CLAIMABLE_EFFECT_SQL } from '../src/core/engine-sql/persistence-effect-scans.ts';
import { claimHeadStatement, claimHeadText } from '../src/core/engine-sql/persistence-claims.ts';
import { CLAIM_ORDER, FOREGROUND_WAITING_ON } from '../src/core/persistence/journal.ts';
import { DEAD_OWNER_EFFECT_SQL } from '../src/core/persistence/effect-journal.ts';
import { refreshFenceClear } from '../src/core/persistence/worktree-refresh-schema.ts';
import { PROJECTION_RETRY_READY_SQL, SEGMENTED_JOB_PROBES, SEGMENTED_PROJECTION_CLAIMED_SQL } from '../src/core/page-state/projections.ts';

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

  test('the claim upkeep copies the journal\'s claimable test, renewal, protocol predicate and expiry', async () => {
    expect(PROTOCOL_PREDICATE_SQL).toBe(PERSISTENCE_PROTOCOL_PREDICATE);
    for (const priority of [true, false, null]) {
      const claimable = renderFragment(claimableWriteFragment(priority, 'host', ['root']));
      expect(claimable.text).toBe(claimableWriteSql(foregroundPriorityText(priority)));
      expect(claimable.params).toEqual(['host', ['root']]);
      expect(renderFragment(hasClaimableWriteFragment(priority, 'host', [])).text).toBe(`SELECT EXISTS (SELECT 1 FROM persistence_requests r
      LEFT JOIN persistence_worktrees w ON w.id=r.worktree_id WHERE ${claimableWriteSql(foregroundPriorityText(priority))} LIMIT 1) AS claimable`);
    }
    await withEnv({ GBRAIN_SYNC_FOREGROUND_PRIORITY: undefined }, () => {
      expect(foregroundPriorityText(null)).toBe(foregroundPrioritySql());
    });
    for (const [env, priority] of [['1', true], ['false', false]] as const) {
      await withEnv({ GBRAIN_SYNC_FOREGROUND_PRIORITY: env }, () => {
        expect(foregroundPriorityText(priority)).toBe(foregroundPrioritySql());
      });
    }
    expect(RENEW_CLAIM_SQL).toBe(`UPDATE persistence_requests SET
    claim_expires_at=now()+($3::double precision*interval '1 millisecond'),updated_at=now(),claim_phase=COALESCE($4::text::jsonb,claim_phase)
    WHERE id=$1::uuid AND execution_token=$2::uuid AND state='running' AND ${PERSISTENCE_PROTOCOL_PREDICATE} RETURNING id`);
    expect(EXPIRE_CLAIMS_SQL).toContain(`CASE WHEN $2::boolean THEN ${EXPIRED_PREPARING_CHARGE_SQL('r')} ELSE 0 END`);
    expect(EXPIRE_CLAIMS_SQL).toContain(`AND r.publication_started=false AND ${PERSISTENCE_PROTOCOL_PREDICATE}`);
  });

  test('the housekeeping reads copy the compaction exclusions, the effect and compacted-byte sizing and the projection probes', () => {
    expect(COMPACTABLE_RECEIPTS_SQL).toBe(`SELECT * FROM persistence_requests r
    WHERE state IN ('committed','conflict','failed','cancelled') AND recovery IS NULL AND NOT compacted
    AND completed_at < now()-($1::double precision*interval '1 day')
    AND NOT EXISTS (SELECT 1 FROM persistence_effects e WHERE e.request_id=r.id AND e.state<>'committed')
    AND NOT COALESCE(${UNRESOLVED_CALLER_REFUSAL_SQL('r')}, false)
    ${OPEN_SYNC_CURSOR_EXCLUSION('r')}
    ${NEWEST_SYNC_RECEIPT_EXCLUSION('r')}
    ORDER BY sequence LIMIT 100`);
    expect(TRUE_UP_REQUESTS_SQL).toBe(`SELECT r.id,r.intent,r.authority,r.outcome,r.error_message,r.error_detail,r.client_request_id,
      r.terminal_reservation,r.principal_kind,r.principal_id,r.compacted,
      COALESCE((SELECT SUM(${EFFECT_BYTES_SQL}) FROM persistence_effects e WHERE e.request_id=r.id),0)::text AS effect_bytes,
      EXISTS(SELECT 1 FROM persistence_effects e WHERE e.request_id=r.id AND e.state IN ('queued','running')) AS unfinished
    FROM persistence_requests r WHERE r.id=ANY($1::uuid[]) AND r.state IN ('committed','failed','conflict','cancelled')`);
    const principalNet = COMPACTED_RECEIPT_BYTES_SQL('w', 'e');
    expect(CAPACITY_PRINCIPAL_DAYS_SQL).toContain(`e AS (SELECT request_id,SUM(${EFFECT_BYTES_SQL}) AS bytes FROM persistence_effects`);
    expect(CAPACITY_PRINCIPAL_DAYS_SQL).toContain(`COALESCE(SUM(${principalNet}),0)::text AS net`);
    expect(CAPACITY_PRINCIPAL_DAYS_SQL).toContain(`COALESCE(SUM(${principalNet}) FILTER (WHERE w.created_at>now()-interval '1 day'),0)::text AS recent_net`);
    expect(CAPACITY_RECLAIM_SQL).toContain(`e AS (SELECT request_id,SUM(${EFFECT_BYTES_SQL}) AS bytes,`);
    expect(CAPACITY_RECLAIM_SQL).toContain(`COALESCE(SUM(r.terminal_reservation-${COMPACTED_RECEIPT_BYTES_SQL('r', 'e')}) FILTER (WHERE NOT COALESCE(e.unfinished,false)),0)::text AS bytes`);
    expect(SEGMENTED_JOB_PROBES_SQL).toBe(SEGMENTED_JOB_PROBES);
    expect(SEGMENTED_PROJECTION_CLAIMED_TEXT).toBe(SEGMENTED_PROJECTION_CLAIMED_SQL);
    expect(PROJECTION_RETRY_READY_TEXT).toBe(PROJECTION_RETRY_READY_SQL);
  });

  test('the resident window copies residentWindowCtes, its row budgets and its parameter order', () => {
    const cursor = { after: { source_incarnation: '00000000-0000-0000-0000-000000000001', slug: 'a/b' }, highWater: '2026-01-01T00:00:00Z' };
    for (const retryCooldown of [true, false]) {
      const params: unknown[] = [];
      const ctes = residentWindowCtes(cursor as ProjectionScanCursor, params, retryCooldown ? PROJECTION_RETRY_READY_SQL : 'TRUE');
      const rendered = renderFragment(projectionWindowFragment(cursor, retryCooldown));
      // The written-out copy numbers each use of a value; the builder reuses $n. Compare the text with each placeholder
      // replaced by the value it binds.
      const bind = (text: string, values: readonly unknown[]) => text.replace(/\$(\d+)/g, (_, n) => `<${String(values[Number(n) - 1])}>`);
      expect(bind(rendered.text, rendered.params).startsWith(`WITH ${bind(ctes, params)}\n    SELECT r.lane,r.ord,`)).toBe(true);
    }
  });

  test('the lifecycle receipt insert binds its jsonb columns as text, so postgres.js does not double-encode them', () => {
    expect(TOPOLOGY_CHANGE_SQL).toBe('SELECT * FROM persistence_topology_changes WHERE principal_id=$1::uuid AND request_id=$2::uuid');
    expect(INSERT_TOPOLOGY_CHANGE_SQL).toContain('$9::text::jsonb');
    expect(INSERT_TOPOLOGY_CHANGE_SQL).toContain('$12::text::jsonb');
    expect(INSERT_TOPOLOGY_CHANGE_SQL).toContain('RETURNING *');
  });
});

describe('the effect claim read copies the claim fragments', () => {
  test('selectClaimableEffect carries the dead-owner test and the refresh fence the journal builds', () => {
    expect(CLAIMABLE_EFFECT_SQL).toContain(`OR ${DEAD_OWNER_EFFECT_SQL('e', '$2')}) AND e.next_attempt_at<=now()`);
    expect(CLAIMABLE_EFFECT_SQL).toContain(`AND (e.worktree_id IS NULL OR ${refreshFenceClear('e')})\n`);
    expect(CLAIMABLE_EFFECT_SQL).toContain('w.owner_host_id=$1::uuid');
    expect(CLAIMABLE_EFFECT_SQL.endsWith('ORDER BY e.next_attempt_at,e.id LIMIT 1 FOR UPDATE OF e SKIP LOCKED')).toBe(true);
  });
});

describe('the FIFO head read copies the journal claim formula', () => {
  // The text claimNextWrite sent through executeRaw before selectClaimableWrite, built from the journal's own fragments.
  const LEASE_HELD = `EXISTS (SELECT 1 FROM gbrain_cycle_locks l WHERE ${SYNC_KIND('r')} AND l.id=$7::text||r.source_id
  AND l.ttl_expires_at>now() AND NOT (l.holder_pid=$8::integer AND l.holder_host IS NOT DISTINCT FROM $9::text))`;
  const journalText = (prio: string, holderOnly: boolean) => {
    const first = `(${prio}) AND NOT (COALESCE(r.worktree_id::text,'db:'||r.source_incarnation::text)=ANY($3::text[]))`;
    return `WITH waiting AS MATERIALIZED (SELECT f.worktree_id, max(f.sequence) AS last
        FROM (${FOREGROUND_WAITING_ON('$5::text', "($6::text::jsonb->>f.worktree_id::text)::bigint")}) f GROUP BY f.worktree_id)
      SELECT r.* FROM persistence_requests r
      LEFT JOIN persistence_worktrees w ON w.id=r.worktree_id
      WHERE ${claimableWriteSql(`(${first})`, '$4::text[]')}
        -- On a root whose lane groups run in this process only a foreground write is claimed (beside them).
        AND NOT (r.worktree_id::text=ANY($4::text[]) AND (${SYNC_KIND('r')} OR NOT (${first})))
        AND NOT (${SYNC_KIND('r')} AND ${first} AND EXISTS (SELECT 1 FROM waiting g WHERE g.worktree_id=r.worktree_id AND g.last>r.sequence))
      ORDER BY ${holderOnly ? `${LEASE_HELD}, ` : ''}${CLAIM_ORDER(`(${first})`)} LIMIT 1 FOR UPDATE OF r SKIP LOCKED`;
  };

  test('selectClaimableWrite sends the journal text for each priority and claim owner', () => {
    for (const priority of [null, true, false] as const) {
      for (const holder of [false, true]) expect(claimHeadText(priority, holder)).toBe(journalText(foregroundPriorityText(priority), holder));
    }
  });

  test('the lease holder binds $7..$9 only when the claim owner holds no resident lease', () => {
    const spec = { hostId: 'h', excludeRoots: ['x'], fifoRoots: ['f'], laneRoots: ['l'], nonce: 'n', syncSeen: { w: '3' }, priority: null };
    expect(claimHeadStatement({ ...spec, leaseHolder: null }).params).toEqual(['h', ['x'], ['f'], ['l'], 'n', '{"w":"3"}']);
    expect(claimHeadStatement({ ...spec, leaseHolder: { lockPrefix: 'p:', pid: 7, host: 'host' } }).params)
      .toEqual(['h', ['x'], ['f'], ['l'], 'n', '{"w":"3"}', 'p:', 7, 'host']);
  });
});
