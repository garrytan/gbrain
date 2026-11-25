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
 * refresh fence are pinned below against the effect-journal and worktree-refresh fragments. So does the publication's
 * effects insert in persistence-journal.ts: its text and its auto-link gate key are pinned against effect-journal.ts.
 * The managed-request withdrawal's effects insert is pinned against the text facts/withdrawal.ts sent.
 * The completion's synchronous-commit statement in persistence-declaration.ts is pinned against journal.ts `completeWrite`.
 * The head-blocker probe in src/core/engine-sql/head-blocker.ts is pinned against the claimable, earlier-head, sync-kind and backoff fragments.
 */
import { describe, expect, test } from 'bun:test';
import { CLAIM_STAMP_SQL, COMPLETE_WRITE_PURGE_PROBE_SQL, COMPLETE_WRITE_SQL, PUBLICATION_EFFECTS_SQL, publicationEffectsParams,
  REMOTE_AUTO_LINKS_CONFIG_KEY, WITHDRAWAL_EFFECTS_SQL, withdrawalEffectsParams } from '../src/core/engine-sql/persistence-journal.ts';
import { REMOTE_AUTO_LINKS_KEY } from '../src/core/persistence/effect-model.ts';
import { asciiLowerSql, edgeTrimSql } from '../src/core/edge-whitespace.ts';
import { REFRESH_BARRIER_CLAIM_PREDICATE, SYNC_KIND } from '../src/core/persistence/journal.ts';
import { EFFECT_BYTES_SQL, TRUE_UP_CLAMP_SQL } from '../src/core/persistence/receipt-bytes.ts';
import { PURGE_PRESENCE_COLUMNS } from '../src/core/persistence/purged-intent.ts';
import { claimableWriteFragment, EXPIRE_CLAIMS_SQL, foregroundPriorityText, hasClaimableWriteFragment, PROTOCOL_PREDICATE_SQL,
  RENEW_CLAIM_SQL } from '../src/core/engine-sql/persistence-claims.ts';
import { renderFragment } from '../src/core/engine-sql/fragment.ts';
import { headBlockerRowsFragment, recoveringHeadFragment } from '../src/core/engine-sql/head-blocker.ts';
import { BACKOFF_ELAPSED } from '../src/core/persistence/transient-retry.ts';
import { EARLIER_DEFERRED, EARLIER_HEAD } from '../src/core/persistence/journal.ts';
import { withEnv } from './helpers/with-env.ts';
import { defineNormalizer, expectGolden } from './helpers/golden.ts';
import { idleProbeStatement, type IdleProbeSpec } from '../src/core/engine-sql/persistence-idle-probe.ts';
import { overdueDeferredWorkSql } from '../src/core/persistence/refresh-barrier.ts';
import { claimableWriteSql, foregroundPrioritySql } from '../src/core/persistence/journal.ts';
import { EXPIRED_PREPARING_CHARGE_SQL } from '../src/core/persistence/claim-phase.ts';
import { CAPACITY_PRINCIPAL_DAYS_SQL, CAPACITY_RECLAIM_SQL, CLAIM_SEGMENTED_PROJECTION_SQL, COMPACTABLE_RECEIPTS_SQL, MARK_PROJECTION_REBUILD_FAILED_SQL,
  PROJECTION_RETRY_READY_TEXT, RECEIPT_COMPACTION_CANDIDATES_SQL, SEGMENTED_JOB_PROBES_SQL, SEGMENTED_PROJECTION_CLAIMED_TEXT, TRUE_UP_REQUESTS_SQL, TRUE_UP_RESERVATIONS_SQL, projectionWindowFragment,
} from '../src/core/engine-sql/persistence-housekeeping.ts';
import { residentWindowCtes, type ProjectionScanCursor } from '../src/core/page-state/projection-window.ts';
import { INSERT_TOPOLOGY_CHANGE_SQL, RELEASE_CLAIM_SQL, releaseUnpublishedClaim as releaseClaimStatement, TOPOLOGY_CHANGE_SQL } from '../src/core/engine-sql/persistence-claims.ts';
import { NEWEST_SYNC_RECEIPT_EXCLUSION, OPEN_SYNC_CURSOR_EXCLUSION } from '../src/core/persistence/journal.ts';
import { UNRESOLVED_CALLER_REFUSAL_SQL } from '../src/core/persistence/terminal-classify.ts';
import { COMPACTED_RECEIPT_BYTES_SQL } from '../src/core/persistence/receipt-bytes.ts';
import { CLAIMABLE_EFFECT_SQL } from '../src/core/engine-sql/persistence-effect-scans.ts';
import { CLAIM_COALESCED_GIT_EFFECTS_SQL } from '../src/core/engine-sql/persistence-effect-worker.ts';
import { TOPOLOGY_STORE_STATEMENTS } from '../src/core/engine-sql/topology-store.ts';
import { REFRESH_STORE_STATEMENTS } from '../src/core/engine-sql/refresh-store.ts';
import { GROUP_PUBLISH_STORE_STATEMENTS } from '../src/core/engine-sql/group-publish-store.ts';
import { MANUAL_LINK_STATEMENTS } from '../src/core/engine-sql/manual-links.ts';
import { SYNC_STATEMENTS } from '../src/core/engine-sql/managed-sync-store.ts';
import { syncKnockOnSql } from '../src/core/persistence/sync-knock-on.ts';
import { chunkVisibleFilter, currentTextProjectionFilter } from '../src/core/search/safe-chunks.ts';
import { LANDING_RECEIPT_LIMIT } from '../src/core/persistence/landing-gaps.ts';
import { databaseOnlyPageSql } from '../src/core/persistence/unbound-pages.ts';
import { LINKS_FENCE_ORIGIN_FIELD } from '../src/core/links-fence.ts';
import { EXPIRED_ARCHIVE_SQL } from '../src/core/engine-sql/sources.ts';
import { ACTIVE_REFRESH_STATES_SQL, CHECKOUT_EFFECT_KINDS_SQL, RELEASED_DEFERRED } from '../src/core/persistence/worktree-refresh-schema.ts';
import { PERSISTENCE_PROTOCOL_PREDICATE } from '../src/core/persistence/protocol.ts';
import { requireSynchronousCommit, SYNCHRONOUS_COMMIT_SQL } from '../src/core/engine-sql/persistence-declaration.ts';
import { claimHeadStatement, claimHeadText } from '../src/core/engine-sql/persistence-claims.ts';
import { CLAIM_ORDER, FOREGROUND_WAITING_ON, GROUP_KEY_SQL } from '../src/core/persistence/journal.ts';
import { DEAD_OWNER_EFFECT_SQL } from '../src/core/persistence/effect-journal.ts';
import { refreshFenceClear } from '../src/core/persistence/worktree-refresh-schema.ts';
import { quoteIdentifier } from '../src/core/search/embedding-column.ts';
import { PROJECTION_RETRY_READY_SQL, SEGMENTED_JOB_PROBES, SEGMENTED_PROJECTION_CLAIM, SEGMENTED_PROJECTION_CLAIMED_SQL, SEGMENTED_PROJECTION_LEASE_SECONDS,
} from '../src/core/page-state/projections.ts';

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

  test('the head-blocker probe copies the journal\'s claimable test, earlier-head, sync-kind and backoff fragments', () => {
    const recovery = (a: string) => `jsonb_build_object('request_id',${a}.request_id::text,'state',${a}.state,'blocked_reason',${a}.blocked_reason,
  'slug',${a}.slug,'version',${a}.recovery->>'version','path',${a}.recovery->>'path','before',${a}.recovery->>'beforeHash','after',${a}.recovery->>'afterHash',
  'files',(SELECT jsonb_agg(jsonb_build_object('path',f->>'path','before',f->>'beforeHash','after',f->>'afterHash'))
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${a}.recovery->'files')='array' THEN ${a}.recovery->'files' ELSE '[]'::jsonb END) f))`;
    const ref = (a: string) => `jsonb_build_object('request_id',${a}.request_id::text,'state',${a}.state,'claim_phase',${a}.claim_phase,
  'execution_token',${a}.execution_token::text,'claim_lapsed',COALESCE(${a}.claim_expires_at<now(),false),'publication_started',COALESCE(${a}.publication_started,false),
  'recovery',${a}.recovery IS NOT NULL,'principal_kind',${a}.principal_kind,'principal_id',${a}.principal_id)`;
    for (const value of [true, false, null]) {
      const priority = foregroundPriorityText(value);
      const rendered = renderFragment(headBlockerRowsFragment(value, 'host', ['id']));
      expect(rendered.text).toBe(`SELECT r.id::text AS id, r.request_id::text AS request_id, r.worktree_id::text AS worktree_id, w.owner_host_id::text AS owner_host_id, w.state AS worktree_state,
      CASE WHEN NOT ${BACKOFF_ELAPSED('r')} THEN r.next_attempt_at END AS backoff_until,
      (${claimableWriteSql(priority)}) AS claimable,
      (SELECT jsonb_build_object('id',f.id::text,'state',f.state) FROM persistence_worktree_refreshes f
        WHERE f.worktree_id=r.worktree_id AND f.state IN ('fenced','merged','recovery_required') LIMIT 1) AS fence,
      (SELECT jsonb_agg(jsonb_build_object('id',e.id::text,'request_id',(SELECT q.request_id::text FROM persistence_requests q WHERE q.id=e.request_id),'error_code',e.error_code,'slug',e.recovery->>'slug','path',e.recovery->>'path',
        'before',e.recovery->>'beforeHash','after',e.recovery->>'afterHash','version',e.recovery->'version') ORDER BY e.id) FROM persistence_effects e WHERE e.worktree_id=r.worktree_id AND e.recovery IS NOT NULL) AS effect_recovery,
      (SELECT array_agg(m.id::text) FROM persistence_effects m WHERE m.worktree_id=r.worktree_id AND m.kind='withdrawal-mirror' AND m.state IN ('queued','running')
        AND (NOT (m.data ? 'targets') OR m.data->'targets' @> jsonb_build_array(jsonb_build_object('slug',r.slug)))) AS mirrors,
      (SELECT jsonb_agg(${recovery('b')} ORDER BY b.sequence) FROM persistence_requests b WHERE b.worktree_id=r.worktree_id AND b.recovery IS NOT NULL) AS request_recovery,
      (SELECT jsonb_agg(${ref('e')} ORDER BY e.sequence) FROM persistence_requests e
        WHERE ((r.worktree_id IS NOT NULL AND e.worktree_id=r.worktree_id) OR (r.worktree_id IS NULL AND e.worktree_id IS NULL AND e.source_incarnation=r.source_incarnation))
        AND (${EARLIER_HEAD('e', 'r', priority, "'{}'::text[]")} OR ${EARLIER_DEFERRED('e', 'r')})) AS earlier,
      (SELECT jsonb_agg(${ref('a')} ORDER BY a.sequence) FROM persistence_requests a WHERE (${priority}) AND ${SYNC_KIND('r')}
        AND a.worktree_id=r.worktree_id AND a.sequence>r.sequence AND a.state IN ('running','recovering') AND NOT ${SYNC_KIND('a')}) AS ahead
    FROM persistence_requests r LEFT JOIN persistence_worktrees w ON w.id=r.worktree_id
    WHERE r.id=ANY($3::uuid[]) AND r.state='queued'`);
      expect(rendered.params).toEqual(['host', [], ['id']]);
    }
    const head = renderFragment(recoveringHeadFragment('id'));
    expect(head.text).toBe(`SELECT ${recovery('r')} AS ref, w.owner_host_id::text AS owner_host_id
    FROM persistence_requests r JOIN persistence_worktrees w ON w.id=r.worktree_id WHERE r.id=$1::uuid AND r.recovery IS NOT NULL`);
    expect(head.params).toEqual(['id']);
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
    expect(RECEIPT_COMPACTION_CANDIDATES_SQL).toContain(`AND NOT EXISTS (SELECT 1 FROM persistence_effects e WHERE e.request_id=r.id AND e.state<>'committed')
      ${OPEN_SYNC_CURSOR_EXCLUSION('r')}
      AND r.id NOT IN`);
    expect(TRUE_UP_REQUESTS_SQL).toBe(`SELECT r.id,r.intent,r.authority,r.outcome,r.error_message,r.error_detail,r.client_request_id,
      r.terminal_reservation,r.principal_kind,r.principal_id,r.compacted,
      COALESCE((SELECT SUM(${EFFECT_BYTES_SQL}) FROM persistence_effects e WHERE e.request_id=r.id),0)::text AS effect_bytes,
      EXISTS(SELECT 1 FROM persistence_effects e WHERE e.request_id=r.id AND e.state IN ('queued','running')) AS unfinished
    FROM persistence_requests r WHERE r.id=ANY($1::uuid[]) AND r.state IN ('committed','failed','conflict','cancelled')`);
    expect(TRUE_UP_RESERVATIONS_SQL).toBe(`WITH t AS (SELECT * FROM unnest($1::uuid[],$2::bigint[],$3::bigint[],$4::bigint[]) AS t(id,old,kept,effects)),
      done AS (UPDATE persistence_requests r SET terminal_reservation=t.kept FROM t
        WHERE r.id=t.id AND r.terminal_reservation=t.old
          AND NOT EXISTS (SELECT 1 FROM persistence_effects e WHERE e.request_id=r.id AND e.state IN ('queued','running'))
          AND COALESCE((SELECT SUM(${EFFECT_BYTES_SQL}) FROM persistence_effects e WHERE e.request_id=r.id),0)=t.effects
        RETURNING r.principal_kind,r.principal_id,t.old-t.kept AS freed),
      d AS (SELECT k.key,SUM(done.freed) AS freed FROM done
        CROSS JOIN LATERAL (VALUES ('brain'),('principal:'||done.principal_kind||':'||done.principal_id)) AS k(key) GROUP BY k.key),
      released AS (UPDATE persistence_counters c SET terminal_bytes=c.terminal_bytes-LEAST(d.freed,c.terminal_bytes) FROM d WHERE c.key=d.key),
      ${TRUE_UP_CLAMP_SQL('SELECT count(*) FROM d JOIN persistence_counters c ON c.key=d.key WHERE d.freed>c.terminal_bytes')}
      SELECT COALESCE(SUM(freed),0)::text AS freed FROM done`);
    const principalNet = COMPACTED_RECEIPT_BYTES_SQL('w', 'e');
    expect(CAPACITY_PRINCIPAL_DAYS_SQL).toContain(`e AS (SELECT request_id,SUM(${EFFECT_BYTES_SQL}) AS bytes FROM persistence_effects`);
    expect(CAPACITY_PRINCIPAL_DAYS_SQL).toContain(`COALESCE(SUM(${principalNet}),0)::text AS net`);
    expect(CAPACITY_PRINCIPAL_DAYS_SQL).toContain(`COALESCE(SUM(${principalNet}) FILTER (WHERE w.created_at>now()-interval '1 day'),0)::text AS recent_net`);
    expect(CAPACITY_RECLAIM_SQL).toContain(`e AS (SELECT request_id,SUM(${EFFECT_BYTES_SQL}) AS bytes,`);
    expect(CAPACITY_RECLAIM_SQL).toContain(`COALESCE(SUM(r.terminal_reservation-${COMPACTED_RECEIPT_BYTES_SQL('r', 'e')}) FILTER (WHERE NOT COALESCE(e.unfinished,false)),0)::text AS bytes`);
    expect(SEGMENTED_JOB_PROBES_SQL).toBe(SEGMENTED_JOB_PROBES);
    expect(SEGMENTED_PROJECTION_CLAIMED_TEXT).toBe(SEGMENTED_PROJECTION_CLAIMED_SQL);
    expect(PROJECTION_RETRY_READY_TEXT).toBe(PROJECTION_RETRY_READY_SQL);
    // The projector's queue writes copy its claim name, lease and live-claim test.
    expect(CLAIM_SEGMENTED_PROJECTION_SQL).toContain(`NOT (split_part(reason,':',1)='${SEGMENTED_PROJECTION_CLAIM}' AND updated_at>=now()-interval '${SEGMENTED_PROJECTION_LEASE_SECONDS} seconds')`);
    expect(MARK_PROJECTION_REBUILD_FAILED_SQL).toContain(`AND NOT ${SEGMENTED_PROJECTION_CLAIMED_SQL}`);
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

  test('claimCoalescedGitEffects sends the statement the journal built, fragments written out', () => {
    expect(CLAIM_COALESCED_GIT_EFFECTS_SQL).toBe(`WITH ready AS (SELECT e.id,gen_random_uuid() AS token FROM persistence_effects e
      WHERE EXISTS (SELECT 1 FROM persistence_worktrees w WHERE w.id=$2::uuid AND w.owner_host_id=$1::uuid
        AND ${refreshFenceClear('w', 'id')}
        AND NOT EXISTS (SELECT 1 FROM persistence_effects blocked WHERE blocked.worktree_id=w.id AND blocked.recovery IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM persistence_requests blocked WHERE blocked.worktree_id=w.id AND blocked.recovery IS NOT NULL))
      AND e.worktree_id=$2::uuid AND e.kind='git' AND e.data ? 'relative_path'
      AND NOT (e.data ? 'targets') AND NOT (e.data ? 'source_scan') AND NOT (e.data ? 'version')
      AND (e.state='queued' OR e.state='running' AND e.claim_expires_at<now() OR ${DEAD_OWNER_EFFECT_SQL('e', '$4')}) AND e.next_attempt_at<=now()
      AND e.recovery IS NULL
      AND NOT EXISTS (SELECT 1 FROM persistence_effects mirror
        WHERE mirror.request_id=e.request_id AND mirror.kind='withdrawal-mirror' AND mirror.state IN ('queued','running'))
      ORDER BY e.next_attempt_at,e.id LIMIT $3 FOR UPDATE OF e SKIP LOCKED)
      UPDATE persistence_effects p SET state='running',execution_token=ready.token,
      claim_owner=jsonb_build_object('token',ready.token::text,'owner',$5::text::jsonb),
      claim_expires_at=now()+interval '2 minutes',attempts=attempts+1,updated_at=now()
      FROM ready WHERE p.id=ready.id RETURNING p.*`);
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

describe('the publication effects insert copies the effect journal statement', () => {
  // The statement effect-journal.ts queuePublicationEffects sent through executeRaw before it called insertPublicationEffects.
  const journalText = `INSERT INTO persistence_effects (request_id,kind,revision,data,source_id,source_incarnation,worktree_id)
    SELECT $1::uuid,t.e->>'kind',$2::uuid,t.e->'data',$3,$4::uuid,$5::uuid FROM jsonb_array_elements($6::text::jsonb) WITH ORDINALITY AS t(e,n)
    WHERE NOT (COALESCE((t.e->>'gated')::boolean,false) AND EXISTS (SELECT 1 FROM config
      WHERE key IN ('auto_link',$7) AND ${asciiLowerSql(edgeTrimSql('value'))} IN ('false','0','no','off')))
    ORDER BY t.n ON CONFLICT(request_id,kind) DO NOTHING RETURNING kind`;

  test('insertPublicationEffects sends the journal text and gates on the remote auto-link key', () => {
    expect(PUBLICATION_EFFECTS_SQL).toBe(journalText);
    expect(REMOTE_AUTO_LINKS_CONFIG_KEY).toBe(REMOTE_AUTO_LINKS_KEY);
  });

  test('the effects bind as one text parameter, so postgres.js does not double-encode them', () => {
    const effects = [{ kind: 'embedding', data: { slug: 'notes/a', page_id: 1 } }, { kind: 'links', data: { slug: 'notes/a' }, gated: true }];
    expect(publicationEffectsParams({ requestId: 'r', revision: null, sourceId: 'default', sourceIncarnation: 'i', worktreeId: null, effects }))
      .toEqual(['r', null, 'default', 'i', null, JSON.stringify(effects), 'mcp.remote_auto_links']);
  });
});

describe('the withdrawal effects insert copies the withdrawal statement', () => {
  // The statement facts/withdrawal.ts recordFactWithdrawal sent through executeRaw before it called insertWithdrawalEffects.
  const withdrawalText = `INSERT INTO persistence_effects(request_id,kind,data,source_id,source_incarnation,worktree_id)
          SELECT $1::uuid,k.kind,$3::text::jsonb,s.id,s.incarnation,b.worktree_id
          FROM sources s LEFT JOIN persistence_source_bindings b ON b.source_id=s.id AND b.source_incarnation=s.incarnation
          CROSS JOIN (VALUES ('withdrawal-mirror'),('git'),('embedding')) AS k(kind)
          WHERE s.id=$2 ON CONFLICT(request_id,kind) DO NOTHING`;

  test('insertWithdrawalEffects sends the withdrawal text', () => {
    expect(WITHDRAWAL_EFFECTS_SQL).toBe(withdrawalText);
  });

  test('the data binds as one text parameter with its targets in slug order, as the withdrawal bound it', () => {
    const targets = [{ slug: 'people/b', page_id: 2, revision: 'r2' }, { slug: 'people/a', page_id: 1, revision: 'r1' }];
    expect(withdrawalEffectsParams({ requestId: 'q', sourceId: 'default', targets }))
      .toEqual(['q', 'default', JSON.stringify({ version: 2, targets: [targets[1], targets[0]] })]);
    expect(targets[0].slug).toBe('people/b');
  });
});

describe('the completion synchronous-commit statement copies the journal statement', () => {
  // The statement journal.ts completeWrite sent through executeRaw before it called requireSynchronousCommit.
  const journalText = "SELECT set_config('synchronous_commit','on',true)";

  test('requireSynchronousCommit sends the journal text alone, with no parameters', async () => {
    expect(SYNCHRONOUS_COMMIT_SQL).toBe(journalText);
    const sent: unknown[][] = [];
    const engine = { executeRaw: async (...args: unknown[]) => { sent.push(args); return []; } };
    await requireSynchronousCommit(engine as never);
    expect(sent).toEqual([[journalText]]);
  });
});

describe('the unpublished-claim release copies the journal statement', () => {
  // The statement journal.ts releaseUnpublishedClaim sent through executeRaw before it called the engine member.
  const journalText = `UPDATE persistence_requests SET state='queued',execution_token=NULL,claim_expires_at=NULL,
    blocked_reason=$3,updated_at=now(),preparation_attempts=preparation_attempts+CASE WHEN $4::boolean THEN 1 ELSE 0 END,
    claim_phase=CASE WHEN $4::boolean THEN claim_phase END
    WHERE id=$1::uuid AND execution_token=$2::uuid
    AND state='running' AND recovery IS NULL AND publication_started=false AND ${PERSISTENCE_PROTOCOL_PREDICATE}`;

  test('releaseUnpublishedClaim sends the journal text with id, token, reason and charge', async () => {
    expect(RELEASE_CLAIM_SQL).toBe(journalText);
    const sent: unknown[][] = [];
    const engine = { executeRaw: async (...args: unknown[]) => { sent.push(args); return []; } };
    await releaseClaimStatement(engine, { id: 'a', token: 'b', reason: 'database_contention', charge: true });
    await releaseClaimStatement(engine, { id: 'a', token: null, reason: 'claim_lost', charge: false });
    expect(sent).toEqual([[journalText, ['a', 'b', 'database_contention', true]], [journalText, ['a', null, 'claim_lost', false]]]);
  });
});

describe('the effect worker statements are one text on both engines', () => {
  // The claim, settle, gate, guard and re-arm statements effect-journal.ts and effect-recovery.ts sent through executeRaw
  // before they called the engine members. Both engines delegate to engine-sql/persistence-effect-worker.ts; this pins
  // the text and bound values each engine sends, through its own prototype, in one golden.
  const T = 'f0000000-0000-4000-8000-0000000000e1';
  const ref = { id: '7', token: T };
  const calls: [string, (e: any) => Promise<unknown>][] = [
    ['stampEffectClaim', e => e.stampEffectClaim({ id: '7', token: T, ownerJson: '{}' })],
    ['renewEffectClaim', e => e.renewEffectClaim(ref)],
    ['renewEffectClaim#direct', e => e.renewEffectClaim(ref, { direct: true })],
    ['advanceEffectRow', e => e.advanceEffectRow({ ...ref, slug: 'notes/a' })],
    ['completeEffectRow', e => e.completeEffectRow({ ...ref, outcomeJson: '{}' })],
    ['retryEffectRow', e => e.retryEffectRow({ ...ref, reason: 'r', delayMs: 1000 })],
    ['retryBusyEffectRow', e => e.retryBusyEffectRow({ ...ref, dataJson: '{}', delayMs: 1000 })],
    ['requeueEffectRow', e => e.requeueEffectRow({ ...ref, dataJson: '{}', reason: null, delayMs: 1000 })],
    ['parkEffectRow', e => e.parkEffectRow({ ...ref, dataJson: '{}' })],
    ['failEffectRow', e => e.failEffectRow({ ...ref, reason: 'r' })],
    ['readMirrorGateRows', e => e.readMirrorGateRows(['b0000000-0000-4000-8000-0000000000b1'])],
    ['lockEffectGuard#brain', e => e.lockEffectGuard(null)],
    ['lockEffectGuard#worktree', e => e.lockEffectGuard('b0000000-0000-4000-8000-0000000000b1')],
    ['hasRearmableTargets', e => e.hasRearmableTargets(['b0000000-0000-4000-8000-0000000000b1'], 'withdrawal_mirror_failed')],
  ];
  async function record(proto: object): Promise<Record<string, unknown[][]>> {
    const out: Record<string, unknown[][]> = {};
    for (const [name, run] of calls) {
      const sent: unknown[][] = [];
      const send = async (sql: string, params?: unknown[]) => { sent.push([sql, params ?? []]); return []; };
      const engine = Object.create(proto, { executeRaw: { value: send }, executeRawDirect: { value: send }, engineSql: { value: { executeRaw: send } } });
      await run(engine);
      out[name] = sent;
    }
    return out;
  }

  test('PGLite and Postgres send the pinned statements with the same bound values', async () => {
    const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
    const { PostgresEngine } = await import('../src/core/postgres-engine.ts');
    const pglite = await record(PGLiteEngine.prototype);
    expect(await record(PostgresEngine.prototype)).toEqual(pglite);
    expectGolden('sql-text-extra/persistence-effect-worker', pglite, defineNormalizer<Record<string, unknown[][]>>('effect-worker-statements-v1', m => m));
  });
});

describe('the idle probe is one text on both engines', () => {
  // consumer.ts hasWork built this statement inline before it called probeIdleWork. `original` is that builder, kept
  // here verbatim over the source fragments (journal.ts, refresh-barrier.ts, page-state/projections.ts), so the engine-sql
  // copy (persistence-idle-probe.ts) cannot drift from what the consumer sent.
  function original(spec: IdleProbeSpec): { sql: string; params: unknown[] } {
    const priority = foregroundPrioritySql();
    const cursor = { after: spec.cursor.after, highWater: spec.cursor.highWater } as ProjectionScanCursor;
    const params: unknown[] = [spec.hostId, spec.excludedRoots, spec.publishing, spec.retryingTopologies, spec.laneRoots];
    const windowCtes = residentWindowCtes(cursor, params, PROJECTION_RETRY_READY_SQL);
    if (spec.abandonedBefore) params.push(spec.abandonedBefore);
    const abandoned = spec.abandonedBefore ? `
      OR EXISTS (SELECT 1 FROM persistence_requests r WHERE r.state='running' AND r.recovery IS NULL AND r.publication_started=false AND r.updated_at<$${params.length}::timestamptz)
      OR EXISTS (SELECT 1 FROM persistence_effects e WHERE e.state='running' AND e.recovery IS NULL AND e.updated_at<$${params.length}::timestamptz)` : '';
    return { sql: `WITH ${windowCtes},
    pwork AS (SELECT EXISTS (SELECT 1 FROM (SELECT source_incarnation,slug FROM recent UNION ALL SELECT source_incarnation,slug FROM win) j
      CROSS JOIN LATERAL (SELECT s.id FROM sources s WHERE s.incarnation=j.source_incarnation AND NOT s.archived OFFSET 0) s
      CROSS JOIN LATERAL (SELECT 1 FROM (SELECT p.id FROM pages p WHERE p.source_id=s.id AND p.slug=j.slug OFFSET 0) k
        JOIN pages p ON p.id=k.id WHERE p.deleted_at IS NULL AND p.page_kind IN ('markdown','code')) p) AS found)
    SELECT (SELECT found FROM pwork) AS projection_work,
      (SELECT json_build_object('source_incarnation',source_incarnation,'slug',slug) FROM win ORDER BY ord DESC LIMIT 1) AS projection_last,
      (SELECT at FROM high_water) AS high_water, (
      EXISTS (SELECT 1 FROM persistence_requests r LEFT JOIN persistence_worktrees w ON w.id=r.worktree_id
        WHERE ${claimableWriteSql(priority, '$5::text[]')}
        AND ($3::boolean OR r.blocked_reason IS DISTINCT FROM 'writer_pool_capacity'))
      OR EXISTS (SELECT 1 FROM persistence_requests r JOIN persistence_worktrees w ON w.id=r.worktree_id
        WHERE w.owner_host_id=$1::uuid AND r.recovery IS NOT NULL AND NOT (r.worktree_id::text=ANY($2::text[])))
      OR EXISTS (SELECT 1 FROM persistence_requests r WHERE r.state='running' AND r.recovery IS NULL
        AND r.publication_started=false AND r.claim_expires_at<now()
        AND (r.worktree_id IS NULL OR EXISTS (SELECT 1 FROM persistence_worktrees w WHERE w.id=r.worktree_id AND w.owner_host_id=$1::uuid)))
      OR EXISTS (SELECT 1 FROM persistence_effects e LEFT JOIN persistence_worktrees w ON w.id=e.worktree_id
        WHERE (e.state='queued' OR e.state='running' AND e.claim_expires_at<now()) AND e.next_attempt_at<=now()
        AND (e.worktree_id IS NULL OR w.owner_host_id=$1::uuid) AND (e.worktree_id IS NULL OR ${refreshFenceClear('e')}) AND e.recovery IS NULL
        AND NOT EXISTS (SELECT 1 FROM persistence_effects blocked WHERE blocked.worktree_id=e.worktree_id AND blocked.recovery IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM persistence_requests blocked WHERE blocked.worktree_id=e.worktree_id AND blocked.recovery IS NOT NULL)
        AND (e.kind='withdrawal-mirror' OR NOT EXISTS (SELECT 1 FROM persistence_effects mirror
          WHERE mirror.request_id=e.request_id AND mirror.kind='withdrawal-mirror' AND mirror.state<>'committed')))
      OR EXISTS (SELECT 1 FROM persistence_effects e JOIN persistence_worktrees w ON w.id=e.worktree_id
        WHERE e.recovery IS NOT NULL AND w.owner_host_id=$1::uuid AND e.next_attempt_at<=now())
      OR (SELECT found FROM pwork)
      OR EXISTS (SELECT 1 FROM page_projection_jobs j JOIN sources s ON s.incarnation=j.source_incarnation AND NOT s.archived
        JOIN pages p ON p.source_id=s.id AND p.slug=j.slug AND p.deleted_at IS NULL AND p.body_storage='segmented'
        WHERE ${PROJECTION_RETRY_READY_SQL})
      OR EXISTS (SELECT 1 FROM persistence_topology_changes c
        JOIN persistence_worktrees w ON w.id=(c.recovery->>'worktreeId')::uuid
        WHERE c.recovery IS NOT NULL AND w.owner_host_id=$1::uuid AND NOT (c.id::text=ANY($4::text[])))
      OR ${overdueDeferredWorkSql('$1')}${abandoned}
    ) AS work`, params };
  }
  const H = 'f0000000-0000-4000-8000-0000000000e2';
  const specs: [string, IdleProbeSpec][] = [
    ['first', { hostId: H, excludedRoots: [], publishing: false, retryingTopologies: [], laneRoots: [], cursor: { after: { source_incarnation: 'b0000000-0000-4000-8000-0000000000b1', slug: '' }, highWater: null }, abandonedBefore: null, foregroundPriority: null }],
    ['later', { hostId: H, excludedRoots: ['db:x'], publishing: true, retryingTopologies: ['9'], laneRoots: ['w'], cursor: { after: { source_incarnation: 'b0000000-0000-4000-8000-0000000000b1', slug: 'notes/a' }, highWater: '2026-11-19 00:00:00+00' }, abandonedBefore: '2026-11-19T00:00:00.000Z', foregroundPriority: true }],
    ['fifo', { hostId: H, excludedRoots: [], publishing: false, retryingTopologies: [], laneRoots: [], cursor: { after: { source_incarnation: 'b0000000-0000-4000-8000-0000000000b1', slug: '' }, highWater: null }, abandonedBefore: null, foregroundPriority: false }],
  ];

  // The engine-sql copy binds each value where it is read (renderFragment numbers them); the consumer hand-numbered
  // $1..$9 and reused them. Writing each placeholder as the value it binds makes the two comparable value for value.
  function bound({ sql, params }: { sql: string; params: unknown[] }): string {
    return sql.replace(/\$(\d+)/g, (_, n: string) => {
      const i = Number(n) - 1;
      expect(i).toBeLessThan(params.length);
      return `<${JSON.stringify(params[i])}>`;
    });
  }

  test('the statement is the one the consumer built, value for value, for every switch and window state', async () => {
    for (const [, spec] of specs) {
      const env = spec.foregroundPriority === null ? undefined : String(spec.foregroundPriority);
      await withEnv({ GBRAIN_SYNC_FOREGROUND_PRIORITY: env }, () => {
        const ours = idleProbeStatement(spec);
        expect(bound(ours)).toBe(bound(original(spec)));
        // Every bound value is read: renderFragment numbers $1..$n in order, once each.
        expect([...ours.sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1]))).toEqual(ours.params.map((_, i) => i + 1));
      });
    }
  });

  test('PGLite and Postgres send it on the lane they are given, with the same bound values', async () => {
    const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
    const { PostgresEngine } = await import('../src/core/postgres-engine.ts');
    async function record(proto: object): Promise<Record<string, unknown[][]>> {
      const out: Record<string, unknown[][]> = {};
      for (const [name, spec] of specs) for (const route of ['engine', 'direct', 'lane'] as const) {
        const sent: unknown[][] = [];
        const send = (via: string) => async (sql: string, params?: unknown[]) => { sent.push([via, sql, params ?? []]); return []; };
        const engine = Object.create(proto, { executeRaw: { value: send('engine') }, executeRawDirect: { value: send('direct') } });
        const lane = { executeRaw: send('lane') } as never;
        await engine.probeIdleWork(spec, route === 'lane' ? { lane } : { direct: route === 'direct' });
        out[`${name}#${route}`] = sent;
      }
      return out;
    }
    const pglite = await record(PGLiteEngine.prototype);
    const postgres = await record(PostgresEngine.prototype);
    // PGLite has no direct lane: its direct route is the engine itself.
    for (const [name] of specs) expect(postgres[`${name}#direct`]!.map(([, ...rest]) => rest)).toEqual(pglite[`${name}#direct`]!.map(([, ...rest]) => rest));
    expect(postgres[`first#direct`]![0]![0]).toBe('direct');
    expect(pglite[`first#direct`]![0]![0]).toBe('engine');
    const shared = (m: Record<string, unknown[][]>) => Object.fromEntries(Object.entries(m).filter(([k]) => !k.endsWith('#direct')));
    expect(shared(postgres)).toEqual(shared(pglite));
    expectGolden('sql-text-extra/persistence-idle-probe', shared(pglite), defineNormalizer<Record<string, unknown[][]>>('idle-probe-statements-v1', m => m));
  });
});

describe('the no-op embedding settle statements are one text on both engines', () => {
  // embedding-noop-settle.ts sent these statements inline before it called the engine members. `original` is its
  // candidate builder, kept here verbatim over refreshFenceClear and quoteIdentifier, so the engine-sql copy
  // (persistence-embedding-noop-settle.ts) cannot drift from what the settle pass sent.
  const H = 'f0000000-0000-4000-8000-0000000000e3';
  const spec = { hostId: H, signature: 'sig-1', expectedModel: 'model-a', column: 'embedding', window: ['7', '9'], pageIds: [3, 4] };
  function original(s: typeof spec): { sql: string; params: unknown[] } {
    const vector = quoteIdentifier(s.column);
    return { sql: `SELECT e.id::text AS id, e.kind, e.source_id, e.source_incarnation, e.worktree_id
      FROM persistence_effects e
      JOIN pages p ON p.id=(e.data->>'page_id')::int AND p.source_id=e.source_id
      WHERE e.id=ANY($4::text[]::bigint[]) AND p.id=ANY($5::int[]) AND e.next_attempt_at<=now()
        AND NOT (e.data ? 'targets') AND NOT (e.data ? 'source_scan') AND NOT (e.data ? 'retry_slugs') AND NOT (e.data ? 'parked')
        AND (e.worktree_id IS NULL OR (EXISTS (SELECT 1 FROM persistence_worktrees w WHERE w.id=e.worktree_id AND w.owner_host_id=$1::uuid)
          AND ${refreshFenceClear('e')}))
        AND NOT EXISTS (SELECT 1 FROM persistence_effects blocked WHERE blocked.worktree_id=e.worktree_id AND blocked.recovery IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM persistence_requests blocked WHERE blocked.worktree_id=e.worktree_id AND blocked.recovery IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM persistence_effects mirror
          WHERE mirror.request_id=e.request_id AND mirror.kind='withdrawal-mirror' AND mirror.state<>'committed')
        AND p.deleted_at IS NULL AND p.knowledge_revision=e.revision AND p.text_projection_revision=p.knowledge_revision
        AND p.embedding_signature=$2
        AND NOT EXISTS (SELECT 1 FROM content_chunks cc WHERE cc.page_id=p.id AND NOT (cc.${vector} IS NOT NULL
          AND cc.embedded_at IS NOT NULL AND cc.embedded_text_hash IS NOT DISTINCT FROM md5(cc.chunk_text) AND cc.model IS NOT DISTINCT FROM $3))
      ORDER BY e.id
      FOR SHARE OF p`, params: [s.hostId, s.signature, s.expectedModel, s.window, s.pageIds] };
  }
  function bound({ sql, params }: { sql: string; params: unknown[] }): string {
    return sql.replace(/\$(\d+)/g, (_, n: string) => {
      const i = Number(n) - 1;
      expect(i).toBeLessThan(params.length);
      return `<${JSON.stringify(params[i])}>`;
    });
  }
  async function record(proto: object): Promise<Record<string, unknown[][]>> {
    const calls: [string, (e: any) => Promise<unknown>][] = [
      ['probeNoopEmbeddingSettle', e => e.probeNoopEmbeddingSettle('5')],
      ['lockNoopEmbeddingWindow', e => e.lockNoopEmbeddingWindow({ from: '5', limit: 50 })],
      ['readNoopEmbeddingCandidates', e => e.readNoopEmbeddingCandidates(spec)],
      ['readNoopEmbeddingCandidates#null-model', e => e.readNoopEmbeddingCandidates({ ...spec, expectedModel: null })],
      ['settleNoopEmbeddingRows', e => e.settleNoopEmbeddingRows(['7', '9'])],
    ];
    const out: Record<string, unknown[][]> = {};
    for (const [name, run] of calls) {
      const sent: unknown[][] = [];
      const send = async (sql: string, params?: unknown[]) => { sent.push([sql, params ?? []]); return [{ newest: '9' }]; };
      await run(Object.create(proto, { executeRaw: { value: send } }));
      out[name] = sent;
    }
    return out;
  }

  test('the candidate read is the one the settle pass built, value for value; the others are its texts', async () => {
    const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
    const sent = await record(PGLiteEngine.prototype);
    const [candidates] = sent.readNoopEmbeddingCandidates as [string, unknown[]][];
    expect(bound({ sql: candidates![0], params: candidates![1] })).toBe(bound(original(spec)));
    const [nullModel] = sent['readNoopEmbeddingCandidates#null-model'] as [string, unknown[]][];
    expect(bound({ sql: nullModel![0], params: nullModel![1] })).toBe(bound(original({ ...spec, expectedModel: null as never })));
    expect(sent.probeNoopEmbeddingSettle).toEqual([[`SELECT 1 FROM persistence_effects e WHERE e.id>$1::bigint AND e.kind='embedding' AND e.state='queued'
    AND e.attempts=0 AND e.recovery IS NULL ORDER BY e.id LIMIT 1`, ['5']]]);
    expect(sent.lockNoopEmbeddingWindow).toEqual([
      ['SELECT COALESCE(max(id),0)::text AS newest FROM persistence_effects', []],
      [`SELECT e.id::text AS id, (e.data->>'page_id')::int AS page_id
      FROM persistence_effects e WHERE e.id>$1::bigint AND e.kind='embedding' AND e.state='queued' AND e.attempts=0 AND e.recovery IS NULL
      ORDER BY e.id LIMIT $2 FOR UPDATE SKIP LOCKED`, ['5', 50]],
    ]);
    expect(sent.settleNoopEmbeddingRows).toEqual([[`UPDATE persistence_effects SET state='committed', error_code=NULL, attempts=attempts+1,
        data=data-'retry_slugs'-'target_failures'-'failing_target', execution_token=NULL, claim_expires_at=NULL, claim_owner=NULL, outcome='{}'::jsonb, updated_at=now()
      WHERE id=ANY($1::text[]::bigint[]) AND state='queued' AND recovery IS NULL AND ${PERSISTENCE_PROTOCOL_PREDICATE} RETURNING id, request_id`, [['7', '9']]]]);
  });

  test('PGLite and Postgres send the pinned statements with the same bound values', async () => {
    const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
    const { PostgresEngine } = await import('../src/core/postgres-engine.ts');
    const pglite = await record(PGLiteEngine.prototype);
    expect(await record(PostgresEngine.prototype)).toEqual(pglite);
    expectGolden('sql-text-extra/persistence-embedding-noop-settle', pglite, defineNormalizer<Record<string, unknown[][]>>('noop-settle-statements-v1', m => m));
  });
});

describe('the topology store sends the statements the lifecycle built, fragments written out', () => {
  test('the active refresh, retire state and expired archive reads carry their shared fragments', () => {
    expect(TOPOLOGY_STORE_STATEMENTS.ACTIVE_REFRESH_SQL).toBe(`SELECT id,state,source_ids FROM persistence_worktree_refreshes
    WHERE worktree_id=ANY($1::uuid[]) AND state IN ${ACTIVE_REFRESH_STATES_SQL} AND ($2::uuid IS NULL OR id<>$2::uuid) LIMIT 1`);
    expect(TOPOLOGY_STORE_STATEMENTS.RETIRE_STATE_EXPIRED_SQL).toBe(`SELECT incarnation,archived,${EXPIRED_ARCHIVE_SQL} AS due FROM sources WHERE id=$1`);
    expect(TOPOLOGY_STORE_STATEMENTS.EXPIRED_ARCHIVE_ROW_SQL).toBe(`SELECT id FROM sources WHERE id=$1 AND ${EXPIRED_ARCHIVE_SQL}`);
  });
});

describe('the refresh store sends the statements the refresh writer and the barrier built, fragments written out', () => {
  const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim();
  test('the drain count carries the released-deferred and checkout-effect fragments', () => {
    expect(flat(REFRESH_STORE_STATEMENTS.DRAIN_COUNTS_SQL)).toBe(flat(`SELECT
    (SELECT count(*) FROM persistence_requests r WHERE r.worktree_id=$1::uuid AND (r.state IN ('queued','running','recovering') OR ${RELEASED_DEFERRED('r')}))::int AS requests,
    (SELECT count(*) FROM persistence_effects WHERE worktree_id=$1::uuid AND kind IN ${CHECKOUT_EFFECT_KINDS_SQL} AND state IN ('queued','running'))::int AS effects,
    ((SELECT count(*) FROM persistence_requests WHERE worktree_id=$1::uuid AND recovery IS NOT NULL)
      +(SELECT count(*) FROM persistence_effects WHERE worktree_id=$1::uuid AND recovery IS NOT NULL))::int AS recovery`));
  });
  test('the import hold carries the protocol and refresh-barrier claim predicates', () => {
    expect(flat(REFRESH_STORE_STATEMENTS.HOLD_FOR_IMPORT_SQL)).toBe(flat(`UPDATE persistence_requests SET state='deferred',deferred_import_from=$3,deferred_refresh_id=NULL,execution_token=NULL,
    claim_expires_at=NULL,blocked_reason=NULL,claim_phase=NULL,updated_at=now()
    WHERE id=$1::uuid AND execution_token=$2::uuid AND state='running' AND recovery IS NULL AND publication_started=false
      AND ${PERSISTENCE_PROTOCOL_PREDICATE} AND ${REFRESH_BARRIER_CLAIM_PREDICATE} RETURNING *`));
  });
  test('the later-write read carries the managed-sync row fragment', () => {
    expect(flat(REFRESH_STORE_STATEMENTS.LATER_WRITE_SQL)).toBe(flat(`SELECT r.request_id::text AS request_id FROM persistence_requests r
    WHERE r.source_id=$1 AND r.slug=$2 AND r.sequence>$3 AND r.state='committed' AND NOT (r.operation='submit_job'
      AND (${SYNC_KIND('r')} OR (r.intent IS NULL AND COALESCE(r.outcome->>'imported_file','')='true' AND NOT (r.outcome ? 'connector_database')))) ORDER BY r.sequence LIMIT 1`));
  });
});

describe('the group publish store sends the statements the group claim and completion built, fragments written out', () => {
  const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim();
  test('the follower candidates carry the group key, backoff and released-deferred fragments', () => {
    const text = flat(GROUP_PUBLISH_STORE_STATEMENTS.FOLLOWER_CANDIDATES_SQL);
    expect(text).toContain(flat(`SELECT id,sequence,state,${GROUP_KEY_SQL} AS grp,recovery IS NOT NULL AS recovering,NOT ${BACKOFF_ELAPSED('persistence_requests')} AS backoff,transient_interruptions>0 AS charged FROM persistence_requests`));
    expect(text).toContain(flat(`OR ${RELEASED_DEFERRED('persistence_requests')}) ORDER BY sequence LIMIT $3),`));
    expect(text).toContain(flat(`SELECT r.id,r.state,${GROUP_KEY_SQL} AS grp,r.recovery IS NOT NULL AS recovering,r.claim_phase`));
  });
  test('the claim renewal and dispatch carry the protocol predicate', () => {
    expect(flat(GROUP_PUBLISH_STORE_STATEMENTS.RENEW_CLAIMS_SQL)).toContain(`AND ${PERSISTENCE_PROTOCOL_PREDICATE} RETURNING r.id`);
    expect(flat(GROUP_PUBLISH_STORE_STATEMENTS.MARK_DISPATCHED_SQL)).toContain(`AND ${PERSISTENCE_PROTOCOL_PREDICATE} RETURNING r.id`);
  });
  test('the group completion carries the effect-byte and true-up clamp fragments', () => {
    const text = flat(GROUP_PUBLISH_STORE_STATEMENTS.COMPLETE_GROUP_SQL);
    expect(text).toContain(`SUM(${EFFECT_BYTES_SQL}) AS bytes`);
    expect(text).toContain(flat(TRUE_UP_CLAMP_SQL('SELECT count(*) FROM d JOIN persistence_counters c ON c.key=d.key WHERE d.freed>c.terminal_bytes')));
  });
});

describe('the parked-push reads and the effect requeue carry the fragment git-durability-administration.ts composed them from', () => {
  // The fragment those statements shared before they moved (engine-sql/git-durability.ts).
  const HELD_ON_CODES = `e.error_code=ANY($2::text[]) OR e.error_code='targets_parked'
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(e.data->'parked','[]'::jsonb)) p WHERE p->>'error_code'=ANY($2::text[]))`;
  test('the parked-push request list and the former-worktree aggregate', async () => {
    const { PARKED_PUSH_REQUESTS_SQL, FORMER_WORKTREE_HOLDS_SQL, REQUEUE_PARKED_EFFECT_SQL } = await import('../src/core/engine-sql/git-durability.ts');
    expect(PARKED_PUSH_REQUESTS_SQL).toBe(`
    SELECT * FROM (SELECT DISTINCT e.source_id,r.id::text AS id,r.request_id::text AS request_id,r.slug FROM persistence_effects e
      JOIN persistence_requests r ON r.id=e.request_id
     WHERE e.worktree_id=$1::uuid AND e.kind='git' AND e.state='failed' AND e.recovery IS NULL AND NOT (e.data ? 'settled') AND (${HELD_ON_CODES})) d
     ORDER BY source_id COLLATE "C",request_id COLLATE "C",id COLLATE "C"`);
    expect(FORMER_WORKTREE_HOLDS_SQL).toBe(`SELECT count(*)::int AS effects,
      min(CASE WHEN e.error_code=ANY($2::text[]) THEN e.error_code ELSE (SELECT min(p->>'error_code') FROM jsonb_array_elements(e.data->'parked') p
        WHERE p->>'error_code'=ANY($2::text[])) END) AS code,
      array_agg(DISTINCT e.worktree_id::text) AS worktree_ids, (array_agg(DISTINCT r.request_id::text))[1:5] AS requests
    FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id WHERE e.source_id=$1 AND e.worktree_id IS DISTINCT FROM $3::uuid AND e.kind='git' AND e.state='failed'
      AND NOT (e.data ? 'settled') AND (${HELD_ON_CODES})`);
    expect(REQUEUE_PARKED_EFFECT_SQL).toBe(`UPDATE persistence_effects SET state='queued',data=$2::text::jsonb,error_code=NULL,
        next_attempt_at=now(),claim_expires_at=NULL,claim_owner=NULL,updated_at=now() WHERE id=$1 AND state='failed' AND error_code IS NOT DISTINCT FROM $3
        AND execution_token IS NULL AND recovery IS NULL RETURNING state`);
  });
});

describe('the topology store sends the clone, recovery and restamp statements as the lifecycle sent them', () => {
  test('the locked reads and the change updates keep their text', () => {
    expect(TOPOLOGY_STORE_STATEMENTS.LOCK_WORKTREE_MANIFEST_SQL).toBe('SELECT owner_host_id,manifest FROM persistence_worktrees WHERE id=$1::uuid FOR UPDATE');
    expect(TOPOLOGY_STORE_STATEMENTS.LOCK_RECOVERING_CHANGES_SQL).toBe("SELECT id,recovery FROM persistence_topology_changes WHERE state='recovering' AND $1::uuid=ANY(worktree_ids) FOR UPDATE");
    expect(TOPOLOGY_STORE_STATEMENTS.CLOSE_CHANGE_SQL).toBe(`UPDATE persistence_topology_changes SET state=$2,recovery=NULL,recovery_bytes=0,updated_at=now(),
    outcome=COALESCE(outcome,'{}'::jsonb)||$3::text::jsonb WHERE id=$1::uuid`);
    expect(TOPOLOGY_STORE_STATEMENTS.COMMIT_CHANGE_SQL).toBe("UPDATE persistence_topology_changes SET state='committed',outcome=outcome||$2::text::jsonb,updated_at=now() WHERE id=$1::uuid");
  });
});

describe('the manual link store sends the statements manual-links.ts built, fragments written out', () => {
  // The fragments persistence/manual-links.ts composed its statements from before they moved (engine-sql/manual-links.ts).
  const RELATIONSHIP = `l.from_page_id=$1 AND l.to_page_id=t.id AND t.source_id=$2 AND t.slug=$3
  AND ($5::text IS NULL OR l.link_type=$5) AND ($6::text IS NULL OR l.link_source=$6)`;
  const DATABASE_ONLY = `l.origin_field IS DISTINCT FROM '${LINKS_FENCE_ORIGIN_FIELD}' AND l.link_source <> ALL($4::text[])`;
  const FENCED = `l.origin_field='${LINKS_FENCE_ORIGIN_FIELD}' AND l.origin_page_id=$1`;
  test('the relationship deletes, count and derived read', () => {
    expect(MANUAL_LINK_STATEMENTS.DELETE_DATABASE_ONLY_SQL).toBe(`DELETE FROM links l USING pages t WHERE ${RELATIONSHIP} AND ${DATABASE_ONLY} AND l.origin_page_id IS NULL`);
    expect(MANUAL_LINK_STATEMENTS.COUNT_RELATIONSHIP_SQL).toBe(`SELECT count(*)::int AS n FROM links l, pages t WHERE ${RELATIONSHIP} AND ((${DATABASE_ONLY}) OR (${FENCED}))`);
    expect(MANUAL_LINK_STATEMENTS.DROP_RELATIONSHIP_SQL).toBe(`DELETE FROM links l USING pages t
      WHERE ${RELATIONSHIP} AND ((${DATABASE_ONLY}) OR ($7::boolean AND ${FENCED}))
      RETURNING l.to_page_id, l.link_type, l.link_source, l.origin_field IS NOT DISTINCT FROM '${LINKS_FENCE_ORIGIN_FIELD}' AS fenced`);
    expect(MANUAL_LINK_STATEMENTS.DERIVED_EDGES_SQL).toBe(`SELECT DISTINCT l.link_type COLLATE "C" AS link_type, l.link_source COLLATE "C" AS link_source FROM links l, pages t
      WHERE ${RELATIONSHIP} AND l.link_source = ANY($4::text[]) ORDER BY l.link_type COLLATE "C", l.link_source COLLATE "C"`);
  });
});

describe('the managed sync store sends the statements the sync built, fragments written out', () => {
  // The fragments persistence/sync-pass-run.ts, sync-discovery.ts, sync-tail-record.ts and sync-tail.ts composed their statements from
  // before they moved (engine-sql/managed-sync-store.ts).
  test('the page statements carry the unbound-source predicate of their alias', () => {
    expect(SYNC_STATEMENTS.pages_by_slug.sql as string).toBe(`SELECT id, slug, source_path, knowledge_revision::text AS revision, deleted_at IS NOT NULL AS deleted, ${databaseOnlyPageSql('pages')} AS unbound, frontmatter->>'id' AS fm_id FROM pages WHERE source_id=$1 AND slug=ANY($2::text[])`);
    expect(SYNC_STATEMENTS.database_only_pages.sql as string).toBe(`SELECT p.id FROM pages p WHERE p.id=ANY($1::bigint[]) AND (${databaseOnlyPageSql('p')} OR p.database_only_reason IS NOT DISTINCT FROM 'origin_twin')`);
  });
  test('the tail statements carry the obligation cap and the page cap', () => {
    expect(SYNC_STATEMENTS.tail_record_run.sql).toContain('jsonb_array_length(op_checkpoints.completed_keys)>=16');
    expect(SYNC_STATEMENTS.tail_record_pass.sql).toContain('jsonb_array_length(op_checkpoints.completed_keys)>=16');
    expect(SYNC_STATEMENTS.tail_slugs.sql.endsWith(') imported LIMIT 1001')).toBe(true);
  });
  test('the in-flight statements carry the request-naming predicate', () => {
    const names = `r.page_id=ANY($2::int[]) OR r.intent->>'sourcePath'=ANY($3::text[]) OR r.intent->>'path'=ANY($3::text[])`;
    expect(SYNC_STATEMENTS.inflight_open_ids.sql as string).toBe(`SELECT r.id FROM persistence_requests r WHERE r.source_id=$1 AND r.state IN ('queued','running','recovering') AND (${names})`);
    expect(SYNC_STATEMENTS.inflight_open_work.sql.split(names).length).toBe(3);
  });
});

describe('the managed sync store sends the status, page-fault and freshness statements (lane LM slice 2 part B), fragments written out', () => {
  test('knock_on_requests is the composed knock-on predicate over the request alias r', () => {
    expect(SYNC_STATEMENTS.knock_on_requests.sql as string).toBe(`SELECT request_id::text AS request_id FROM persistence_requests r
    WHERE r.request_id::text = ANY($1::text[]) AND ${syncKnockOnSql('r')}`);
  });
  test('freshness_aggregate carries the visible-chunk predicate of its aliases and the sample predicate of listFreshnessTargets', () => {
    const sql = SYNC_STATEMENTS.freshness_aggregate.sql as string;
    expect(sql).toContain(`WHERE cc.page_id=s.page_id AND ${chunkVisibleFilter('p', 'cc', currentTextProjectionFilter)}) ch ON true)`);
    expect(sql).toContain(`FROM persistence_requests r JOIN c ON c.target=r.intent->>'target' WHERE r.worktree_id=$1::uuid AND r.source_incarnation=$2::uuid AND r.state='committed' AND COALESCE(r.intent->>'kind','') LIKE 'managed_sync_%'
    AND r.completed_at > now() - ($3::int * interval '1 hour') AND r.intent->>'kind'='managed_sync_import' AND r.intent->>'from' IS NOT NULL
    AND COALESCE(r.intent->>'working','false') <> 'true'),`);
  });
  test('landing_receipts carries the receipt limit of landing-gaps.ts', () => {
    expect((SYNC_STATEMENTS.landing_receipts.sql as string).includes(`ORDER BY r.completed_at DESC, r.sequence DESC LIMIT ${LANDING_RECEIPT_LIMIT}) w`)).toBe(true);
  });
  test('the page-fault statements keep the text of the typed members they sit beside', () => {
    expect(SYNC_STATEMENTS.page_revision_writer.sql as string).toBe('SELECT knowledge_revision::text AS revision, revision_write_request_id::text AS writer FROM pages WHERE id=$1 AND source_id=$2');
    expect(SYNC_STATEMENTS.request_writer.sql as string).toBe(`SELECT request_id::text, operation, intent->>'kind' AS kind, state, source_incarnation::text AS incarnation, page_id FROM persistence_requests WHERE id=$1::uuid`);
  });
});
