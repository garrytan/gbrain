/**
 * Byte-identical pins for the caller raw SQL that became typed engine members (Rust engine lane 11).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member sends Postgres exactly the statement text its caller ran through `executeRaw` before the
 *    move. Each expected text below is copied verbatim from the caller at 7470c703ed.
 *  - Regression: an edited statement changes what Postgres and PGLite answer while the parity cases may still pass on
 *    a small fixture.
 *  - Why existing coverage misses it: the sql-text goldens cover the W1 domains only (test/engine-sql-sql-text.test.ts),
 *    and these members live outside them.
 *  - Seam: the fake postgres.js driver (test/helpers/fake-postgres-sql.ts) records the text; no database runs.
 */
import { describe, expect, test } from 'bun:test';
import { runCase, withPinnedSqlEnvironment, type SqlCase } from './helpers/postgres-engine-sql-cases.ts';

interface Pin {
  /** The caller site the statement came from, at 7470c703ed. */
  from: string;
  case: SqlCase;
  /** The statement texts, in order, as the caller sent them. */
  texts: string[];
}

const PINS: Pin[] = [
  {
    from: 'src/core/access/caller.ts:376 appliedAccessSummary',
    case: { method: 'listAppliedPolicyRevisions', variant: 'default', run: e => e.listAppliedPolicyRevisions() },
    texts: [`SELECT s.source_id, (SELECT r.revision FROM access_policy_revisions r WHERE r.source_id = s.source_id AND r.applied_at IS NOT NULL
          ORDER BY r.revision DESC LIMIT 1) AS rev FROM access_policy_state s ORDER BY s.source_id`],
  },
  {
    from: 'src/core/access/caller.ts:196 mayActForOf (legacy token)',
    case: { method: 'readMayActFor', variant: 'legacy-token', run: e => e.readMayActFor('legacy_token', 'tok-1') },
    texts: ['SELECT may_act_for FROM access_tokens WHERE id::text = $1 AND revoked_at IS NULL'],
  },
  {
    from: 'src/core/access/caller.ts:200 mayActForOf (OAuth client)',
    case: { method: 'readMayActFor', variant: 'oauth-client', run: e => e.readMayActFor('oauth_client', 'client-1') },
    texts: ['SELECT may_act_for FROM oauth_clients WHERE client_id = $1 AND deleted_at IS NULL'],
  },
  {
    from: 'src/core/access/caller.ts:204 mayActForOf (stdio config)',
    case: { method: 'readMayActFor', variant: 'stdio-config', run: e => e.readMayActFor('stdio_config', 'mcp.stdio_may_act_for') },
    texts: ['SELECT value FROM config WHERE key = $1'],
  },
  {
    from: 'src/core/access/caller.ts:253 resolveAudienceIdentities (members, then groups)',
    case: { method: 'readAudiencePrincipals', variant: 'members-and-groups', run: e => e.readAudiencePrincipals(['alice-example'], ['team-a']) },
    texts: [`SELECT m.id, COALESCE(array_agg(g.group_id ORDER BY g.group_id) FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
  FROM access_members m LEFT JOIN access_group_members g ON g.member_id = m.id
  WHERE m.id = ANY($1::text[]) AND m.disabled_at IS NULL AND m.tombstoned_at IS NULL
  GROUP BY m.id`, 'SELECT id FROM access_groups WHERE id = ANY($1::text[])'],
  },
  {
    from: 'src/core/access/caller.ts:253 resolveAudienceIdentities (an empty list reads nothing)',
    case: { method: 'readAudiencePrincipals', variant: 'groups-only', run: e => e.readAudiencePrincipals([], ['team-a']) },
    texts: ['SELECT id FROM access_groups WHERE id = ANY($1::text[])'],
  },
  {
    from: 'src/core/access/caller.ts:168 folderAccessForAll (rules, then coverage; at 949a7c98cc)',
    case: { method: 'readFolderAccess', variant: 'readers', run: e => e.readFolderAccess(['member:alice-example', 'group:team-a']) },
    texts: ['SELECT source_id, rule_id, readable_by FROM access_rules WHERE readable_by && $1::text[]', `SELECT * FROM (SELECT DISTINCT source_id, prefix FROM access_pending_coverage
      UNION ALL SELECT '!unreadable', '' WHERE gbrain_access_state_unreadable()) c ORDER BY source_id, prefix`],
  },
  {
    from: 'src/core/access/caller.ts:171 folderAccessForAll (no readers reads the coverage only; at 949a7c98cc)',
    case: { method: 'readFolderAccess', variant: 'no-readers', run: e => e.readFolderAccess([]) },
    texts: [`SELECT * FROM (SELECT DISTINCT source_id, prefix FROM access_pending_coverage
      UNION ALL SELECT '!unreadable', '' WHERE gbrain_access_state_unreadable()) c ORDER BY source_id, prefix`],
  },
  {
    from: 'src/core/access/members.ts:124 getMember (one member by id)',
    case: { method: 'readAccessMembers', variant: 'by-id', run: e => e.readAccessMembers({ id: 'alice-example' }) },
    texts: [`SELECT m.id, m.display_name, m.email, m.kind, m.labelled_only, m.disabled_at, m.tombstoned_at, m.created_at,
  COALESCE(array_agg(g.group_id ORDER BY g.group_id) FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
  FROM access_members m LEFT JOIN access_group_members g ON g.member_id = m.id WHERE m.id = $1 GROUP BY m.id`],
  },
  {
    from: 'src/core/access/members.ts:129 listMembers (removed members filtered out)',
    case: { method: 'readAccessMembers', variant: 'live', run: e => e.readAccessMembers({ includeRemoved: false }) },
    texts: [`SELECT m.id, m.display_name, m.email, m.kind, m.labelled_only, m.disabled_at, m.tombstoned_at, m.created_at,
  COALESCE(array_agg(g.group_id ORDER BY g.group_id) FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
  FROM access_members m LEFT JOIN access_group_members g ON g.member_id = m.id WHERE m.tombstoned_at IS NULL GROUP BY m.id ORDER BY m.id`],
  },
  {
    from: 'src/core/access/members.ts:129 listMembers (--all)',
    case: { method: 'readAccessMembers', variant: 'all', run: e => e.readAccessMembers({ includeRemoved: true }) },
    texts: [`SELECT m.id, m.display_name, m.email, m.kind, m.labelled_only, m.disabled_at, m.tombstoned_at, m.created_at,
  COALESCE(array_agg(g.group_id ORDER BY g.group_id) FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
  FROM access_members m LEFT JOIN access_group_members g ON g.member_id = m.id GROUP BY m.id ORDER BY m.id`],
  },
  {
    from: 'src/core/notifier/store.ts:190 claimLease (the claim, then the holder a lost claim reads; at 6e123afe98)',
    case: { method: 'claimNotifierLease', variant: 'default', run: e => e.claimNotifierLease({ hostId: 'host-1', ownerId: 'owner-1', kind: 'serve', pid: 4242, leaseMs: 30_000 }) },
    texts: [`INSERT INTO sync_notifier_leases (host_id, owner_id, fence, resident_kind, pid, renewed_at, expires_at)
     VALUES ($1, $2, 1, $3, $4, now(), now() + $5::int * interval '1 millisecond')
     ON CONFLICT (host_id) DO UPDATE SET owner_id = EXCLUDED.owner_id, resident_kind = EXCLUDED.resident_kind, pid = EXCLUDED.pid,
       fence = sync_notifier_leases.fence + CASE WHEN sync_notifier_leases.owner_id = EXCLUDED.owner_id THEN 0 ELSE 1 END,
       renewed_at = now(), expires_at = EXCLUDED.expires_at
     WHERE sync_notifier_leases.owner_id = EXCLUDED.owner_id OR sync_notifier_leases.expires_at <= now()
     RETURNING fence`,
      'SELECT owner_id, fence, resident_kind, pid, expires_at, expires_at > now() AS live FROM sync_notifier_leases WHERE host_id = $1'],
  },
  {
    from: 'src/core/notifier/store.ts:193 readLease (at 6e123afe98)',
    case: { method: 'readNotifierLease', variant: 'default', run: e => e.readNotifierLease('host-1') },
    texts: ['SELECT owner_id, fence, resident_kind, pid, expires_at, expires_at > now() AS live FROM sync_notifier_leases WHERE host_id = $1'],
  },
  {
    from: 'src/core/notifier/store.ts:198 holdsLease (at 6e123afe98)',
    case: { method: 'holdsNotifierLease', variant: 'default', run: e => e.holdsNotifierLease('host-1', 'owner-1', 3) },
    texts: ['SELECT host_id FROM sync_notifier_leases WHERE host_id = $1 AND owner_id = $2 AND fence = $3 AND expires_at > now()'],
  },
  {
    from: 'src/core/notifier/store.ts:205 releaseLease (at 6e123afe98)',
    case: { method: 'releaseNotifierLease', variant: 'default', run: e => e.releaseNotifierLease('host-1', 'owner-1') },
    texts: ['UPDATE sync_notifier_leases SET expires_at = now() WHERE host_id = $1 AND owner_id = $2'],
  },
  {
    from: 'src/core/notifier/resident.ts:71 listHostSources (at 6e123afe98)',
    case: { method: 'listNotifierHostSourceRows', variant: 'default', run: e => e.listNotifierHostSourceRows() },
    texts: [`SELECT s.id, s.local_path, s.last_commit, (b.source_id IS NOT NULL) AS bound, w.owner_host_id::text AS owner, h.local_path AS root, n.syncer_host_id AS syncer, s.config
       FROM sources s
       LEFT JOIN persistence_source_bindings b ON b.source_id = s.id AND b.source_incarnation = s.incarnation
       LEFT JOIN persistence_worktrees w ON w.id = b.worktree_id
       LEFT JOIN persistence_host_bindings h ON h.worktree_id = w.id AND h.host_id = w.owner_host_id
       LEFT JOIN sync_notifier_sources n ON n.source_id = s.id
      WHERE NOT s.archived ORDER BY s.id`],
  },
  {
    from: 'src/core/notifier/store.ts:222 readNotifierSources (the listed sources; at 6e123afe98)',
    case: { method: 'readNotifierSources', variant: 'ids', run: e => e.readNotifierSources(['source-a', 'source-b']) },
    texts: ['SELECT * FROM sync_notifier_sources WHERE ($1::text[] IS NULL OR source_id = ANY($1::text[])) ORDER BY source_id'],
  },
  {
    from: 'src/core/notifier/store.ts:222 readNotifierSources (every source; at 6e123afe98)',
    case: { method: 'readNotifierSources', variant: 'all', run: e => e.readNotifierSources(null) },
    texts: ['SELECT * FROM sync_notifier_sources WHERE ($1::text[] IS NULL OR source_id = ANY($1::text[])) ORDER BY source_id'],
  },
  {
    from: 'src/core/notifier/store.ts:241 writeState (at 6e123afe98)',
    case: { method: 'writeNotifierState', variant: 'default', run: e => e.writeNotifierState('source-a', { state: 'retry', reason: 'sync_failed', firstDue: 'keep', attempts: 2, nextRetryInMs: 60_000, progress: true, error: { code: 'E_SYNC', message: 'failed', tracePath: null } }) },
    texts: [`INSERT INTO sync_notifier_sources (source_id, source_incarnation, state, reason, first_due_at, attempts, next_retry_at, last_progress_at,
        last_error_code, last_error, last_error_at, trace_path, updated_at)
     SELECT s.id, s.incarnation::text, $2, $3, CASE WHEN $4::text = 'keep' THEN now() END, COALESCE($5::int, 0),
        CASE WHEN $6::int IS NULL THEN NULL ELSE now() + $6::int * interval '1 millisecond' END, CASE WHEN $7::boolean THEN now() END,
        $8::text, $9::text, CASE WHEN $8::text IS NULL THEN NULL ELSE now() END, $10::text, now()
       FROM sources s WHERE s.id = $1
     ON CONFLICT (source_id) DO UPDATE SET state = EXCLUDED.state, reason = EXCLUDED.reason,
       first_due_at = CASE WHEN $4::text = 'clear' THEN NULL ELSE COALESCE(sync_notifier_sources.first_due_at, now()) END,
       attempts = COALESCE($5::int, sync_notifier_sources.attempts), next_retry_at = EXCLUDED.next_retry_at,
       last_progress_at = CASE WHEN $7::boolean THEN now() ELSE sync_notifier_sources.last_progress_at END,
       last_error_code = CASE WHEN $11::boolean THEN EXCLUDED.last_error_code ELSE sync_notifier_sources.last_error_code END,
       last_error = CASE WHEN $11::boolean THEN EXCLUDED.last_error ELSE sync_notifier_sources.last_error END,
       last_error_at = CASE WHEN $11::boolean THEN EXCLUDED.last_error_at ELSE sync_notifier_sources.last_error_at END,
       trace_path = CASE WHEN $11::boolean THEN EXCLUDED.trace_path ELSE sync_notifier_sources.trace_path END,
       source_incarnation = EXCLUDED.source_incarnation, updated_at = now()`],
  },
  {
    from: 'src/core/notifier/store.ts:265 writeCoverage (at 6e123afe98)',
    case: { method: 'writeNotifierCoverage', variant: 'default', run: e => e.writeNotifierCoverage('source-a', { head: 'abc123', mode: 'watch', ownerHostId: 'host-1', ownerKind: 'serve', ownerPid: 4242 }) },
    texts: [`INSERT INTO sync_notifier_sources (source_id, source_incarnation, observed_head, observed_at, detection_mode, owner_host_id, owner_kind, owner_pid, owner_seen_at, updated_at)
     SELECT s.id, s.incarnation::text, $2, now(), $3, $4, $5, $6, now(), now() FROM sources s WHERE s.id = $1
     ON CONFLICT (source_id) DO UPDATE SET observed_head = EXCLUDED.observed_head, observed_at = now(), detection_mode = EXCLUDED.detection_mode,
       owner_host_id = EXCLUDED.owner_host_id, owner_kind = EXCLUDED.owner_kind, owner_pid = EXCLUDED.owner_pid, owner_seen_at = now(),
       source_incarnation = EXCLUDED.source_incarnation, updated_at = now()`],
  },
  {
    from: 'src/core/notifier/store.ts:276 recordSyncerHost (at 6e123afe98)',
    case: { method: 'recordNotifierSyncerHost', variant: 'default', run: e => e.recordNotifierSyncerHost('source-a', 'host-1') },
    texts: [`INSERT INTO sync_notifier_sources (source_id, source_incarnation, syncer_host_id, syncer_recorded_at, updated_at)
     SELECT s.id, s.incarnation::text, $2, now(), now() FROM sources s WHERE s.id = $1
     ON CONFLICT (source_id) DO UPDATE SET syncer_host_id = EXCLUDED.syncer_host_id, syncer_recorded_at = now(), updated_at = now()
     WHERE sync_notifier_sources.syncer_host_id IS DISTINCT FROM EXCLUDED.syncer_host_id`],
  },
  {
    from: 'src/core/notifier/status.ts:72 readRows (the listed sources; at 6e123afe98)',
    case: { method: 'readNotifierStatusRows', variant: 'ids', run: e => e.readNotifierStatusRows(['source-a']) },
    texts: [`SELECT s.id, s.last_commit, n.state, n.reason, n.first_due_at, n.attempts, n.next_retry_at, n.last_error_code, n.last_error, n.last_error_at,
            n.trace_path, n.observed_head, n.observed_at, n.detection_mode, n.owner_host_id, n.owner_kind, n.owner_pid, n.owner_seen_at,
            EXISTS (SELECT 1 FROM sync_notifier_leases l WHERE l.host_id = n.owner_host_id AND l.expires_at > now()) AS lease_live,
            (SELECT l.expires_at FROM sync_notifier_leases l WHERE l.host_id = n.owner_host_id) AS lease_expires_at,
            (SELECT count(*) FROM sync_wanted_markers m WHERE m.source_id = s.id
               AND (m.intent <> 'freshness' OR m.wanted_head IS NULL OR m.wanted_head IS DISTINCT FROM s.last_commit)) AS due_markers
       FROM sources s LEFT JOIN sync_notifier_sources n ON n.source_id = s.id
      WHERE NOT s.archived AND ($1::text[] IS NULL OR s.id = ANY($1::text[]))
      ORDER BY s.id LIMIT 200`],
  },
  {
    from: 'src/core/notifier/status.ts:72 readRows (every source; at 6e123afe98)',
    case: { method: 'readNotifierStatusRows', variant: 'all', run: e => e.readNotifierStatusRows(null) },
    texts: [`SELECT s.id, s.last_commit, n.state, n.reason, n.first_due_at, n.attempts, n.next_retry_at, n.last_error_code, n.last_error, n.last_error_at,
            n.trace_path, n.observed_head, n.observed_at, n.detection_mode, n.owner_host_id, n.owner_kind, n.owner_pid, n.owner_seen_at,
            EXISTS (SELECT 1 FROM sync_notifier_leases l WHERE l.host_id = n.owner_host_id AND l.expires_at > now()) AS lease_live,
            (SELECT l.expires_at FROM sync_notifier_leases l WHERE l.host_id = n.owner_host_id) AS lease_expires_at,
            (SELECT count(*) FROM sync_wanted_markers m WHERE m.source_id = s.id
               AND (m.intent <> 'freshness' OR m.wanted_head IS NULL OR m.wanted_head IS DISTINCT FROM s.last_commit)) AS due_markers
       FROM sources s LEFT JOIN sync_notifier_sources n ON n.source_id = s.id
      WHERE NOT s.archived AND ($1::text[] IS NULL OR s.id = ANY($1::text[]))
      ORDER BY s.id LIMIT 200`],
  },
  {
    from: 'src/core/notifier/status.ts:107 freshnessReported (at 6e123afe98)',
    case: { method: 'hasNotifierCoverage', variant: 'default', run: e => e.hasNotifierCoverage() },
    texts: ['SELECT EXISTS (SELECT 1 FROM sync_notifier_sources WHERE observed_at IS NOT NULL) AS covered'],
  },  {
    from: 'src/core/notifier/store.ts:71 upsertMarker (at f24fef9a03)',
    case: { method: 'upsertWantedMarker', variant: 'default', run: e => e.upsertWantedMarker({ sourceId: 'source-a', intent: 'freshness', wantedHead: 'abc123', requestedBy: 'webhook', jobId: 7 }) },
    texts: [`INSERT INTO sync_wanted_markers (source_id, intent, source_incarnation, wanted_head, generation, first_due_at, updated_at, requested_by, job_id)
     SELECT s.id, $2, s.incarnation::text, $3, 1, now(), now(), $4, $5 FROM sources s WHERE s.id = $1
     ON CONFLICT (source_id, intent) DO UPDATE SET wanted_head = EXCLUDED.wanted_head, generation = sync_wanted_markers.generation + 1,
       updated_at = now(), requested_by = EXCLUDED.requested_by, job_id = COALESCE(EXCLUDED.job_id, sync_wanted_markers.job_id),
       first_due_at = CASE WHEN sync_wanted_markers.source_incarnation IS DISTINCT FROM EXCLUDED.source_incarnation THEN now() ELSE sync_wanted_markers.first_due_at END,
       source_incarnation = EXCLUDED.source_incarnation
     RETURNING *`],
  },
  {
    from: 'src/core/notifier/store.ts:86 attachMarkerJob (at f24fef9a03)',
    case: { method: 'attachWantedMarkerJob', variant: 'default', run: e => e.attachWantedMarkerJob('source-a', 'pull', 2, 7) },
    texts: ['UPDATE sync_wanted_markers SET job_id = $4 WHERE source_id = $1 AND intent = $2 AND generation = $3'],
  },
  {
    from: 'src/core/notifier/store.ts:90 readMarkers (the listed sources; at f24fef9a03)',
    case: { method: 'readWantedMarkers', variant: 'ids', run: e => e.readWantedMarkers(['source-a', 'source-b']) },
    texts: ['SELECT * FROM sync_wanted_markers WHERE ($1::text[] IS NULL OR source_id = ANY($1::text[])) ORDER BY first_due_at, source_id, intent LIMIT 1000'],
  },
  {
    from: 'src/core/notifier/store.ts:90 readMarkers (every source; at f24fef9a03)',
    case: { method: 'readWantedMarkers', variant: 'all', run: e => e.readWantedMarkers(null) },
    texts: ['SELECT * FROM sync_wanted_markers WHERE ($1::text[] IS NULL OR source_id = ANY($1::text[])) ORDER BY first_due_at, source_id, intent LIMIT 1000'],
  },
  {
    from: 'src/core/notifier/store.ts:100 readDueMarkers (the listed sources; at f24fef9a03)',
    case: { method: 'readDueWantedMarkers', variant: 'ids', run: e => e.readDueWantedMarkers(['source-a']) },
    texts: [`SELECT m.* FROM sync_wanted_markers m JOIN sources s ON s.id = m.source_id
      WHERE ($1::text[] IS NULL OR m.source_id = ANY($1::text[]))
        AND (m.intent <> 'freshness' OR m.wanted_head IS NULL OR m.wanted_head IS DISTINCT FROM s.last_commit)
      ORDER BY m.first_due_at, m.source_id, m.intent LIMIT 1000`],
  },
  {
    from: 'src/core/notifier/store.ts:100 readDueMarkers (every source; at f24fef9a03)',
    case: { method: 'readDueWantedMarkers', variant: 'all', run: e => e.readDueWantedMarkers(null) },
    texts: [`SELECT m.* FROM sync_wanted_markers m JOIN sources s ON s.id = m.source_id
      WHERE ($1::text[] IS NULL OR m.source_id = ANY($1::text[]))
        AND (m.intent <> 'freshness' OR m.wanted_head IS NULL OR m.wanted_head IS DISTINCT FROM s.last_commit)
      ORDER BY m.first_due_at, m.source_id, m.intent LIMIT 1000`],
  },
  {
    from: 'src/core/notifier/store.ts:113 pruneSatisfiedMarkers (at f24fef9a03)',
    case: { method: 'pruneSatisfiedWantedMarkers', variant: 'default', run: e => e.pruneSatisfiedWantedMarkers(['source-a']) },
    texts: [`DELETE FROM sync_wanted_markers m USING sources s WHERE m.source_id = s.id AND m.source_id = ANY($1::text[])
       AND m.intent IN ('freshness','pull') AND m.wanted_head IS NOT NULL AND m.wanted_head = s.last_commit`],
  },
  {
    from: 'src/core/notifier/store.ts:120 clearMarker (at f24fef9a03)',
    case: { method: 'clearWantedMarker', variant: 'default', run: e => e.clearWantedMarker('source-a', 'pull', 2) },
    texts: ['DELETE FROM sync_wanted_markers WHERE source_id = $1 AND intent = $2 AND generation = $3 RETURNING source_id'],
  },
  {
    from: 'src/core/notifier/store.ts:139 settleMarkers (the freshness marker; at f24fef9a03)',
    case: { method: 'settleFreshnessMarker', variant: 'default', run: e => e.settleFreshnessMarker('source-a', 2, 'abc123') },
    texts: [`DELETE FROM sync_wanted_markers m USING sources s WHERE m.source_id = s.id AND m.source_id = $1 AND m.intent = 'freshness'
           AND m.generation = $2 AND (m.wanted_head IS NULL OR m.wanted_head IS NOT DISTINCT FROM s.last_commit
             OR ($3::text IS NOT NULL AND s.last_commit = $3::text))`],
  },
  {
    from: 'src/core/notifier/status.ts:130 readNotifierBlock (the markers; at f24fef9a03)',
    case: { method: 'listSourceWantedMarkers', variant: 'default', run: e => e.listSourceWantedMarkers('source-a') },
    texts: ['SELECT intent, wanted_head, first_due_at, requested_by FROM sync_wanted_markers WHERE source_id = $1 ORDER BY first_due_at, intent'],
  },
  {
    from: 'src/core/notifier/nudge.ts:17 sourceSyncShape (at 87bd59b208)',
    case: { method: 'readSourceSyncShape', variant: 'default', run: e => e.readSourceSyncShape('source-a') },
    texts: [`SELECT s.local_path, h.local_path AS root, (b.source_id IS NOT NULL) AS bound
       FROM sources s
       LEFT JOIN persistence_source_bindings b ON b.source_id = s.id AND b.source_incarnation = s.incarnation
       LEFT JOIN persistence_worktrees w ON w.id = b.worktree_id
       LEFT JOIN persistence_host_bindings h ON h.worktree_id = w.id AND h.host_id = w.owner_host_id
      WHERE s.id = $1 AND NOT s.archived LIMIT 1`],
  },
  {
    from: 'src/core/sync-pending.ts:101 readFirstDue (at 87bd59b208)',
    case: { method: 'readNotifierFirstDue', variant: 'default', run: e => e.readNotifierFirstDue(['source-a']) },
    texts: [`SELECT s.id AS source_id, n.observed_head,
              LEAST(CASE WHEN n.state <> 'idle' THEN n.first_due_at END,
                    (SELECT min(m.first_due_at) FROM sync_wanted_markers m WHERE m.source_id = s.id AND m.intent = 'freshness'
                       AND m.source_incarnation IS NOT DISTINCT FROM s.incarnation::text
                       AND (m.wanted_head IS NULL OR m.wanted_head IS DISTINCT FROM s.last_commit))) AS first_due_at
         FROM sources s LEFT JOIN sync_notifier_sources n ON n.source_id = s.id AND n.source_incarnation IS NOT DISTINCT FROM s.incarnation::text
        WHERE s.id = ANY($1::text[])`],
  },
  {
    from: 'src/core/sync-anchor.ts:272 writeSyncAnchor, with a newest content time (at 87bd59b208)',
    case: { method: 'advanceSourceCommit', variant: 'newest-content', run: e => e.advanceSourceCommit('source-a', 'abc123', '2026-01-02T03:04:05.000Z') },
    texts: ['UPDATE sources SET last_commit = $1, last_sync_at = now(), newest_content_at = $3 WHERE id = $2'],
  },
  {
    from: 'src/core/sync-anchor.ts:277 writeSyncAnchor, without a newest content time (at 87bd59b208)',
    case: { method: 'advanceSourceCommit', variant: 'default', run: e => e.advanceSourceCommit('source-a', 'abc123') },
    texts: ['UPDATE sources SET last_commit = $1, last_sync_at = now() WHERE id = $2'],
  },  {
    from: 'src/core/notifier/resident.ts:50 sqlNotifierStore liveJobs (at e98683e983)',
    case: { method: 'readLiveJobIds', variant: 'default', run: e => e.readLiveJobIds([1, 2]) },
    texts: ["SELECT id FROM minion_jobs WHERE id = ANY($1::bigint[]) AND status IN ('waiting','active','delayed','waiting-children','paused')"],
  },
  {
    from: 'src/core/notifier/resident.ts:169 residentNotifierOptions lastCommit (at e98683e983)',
    case: { method: 'readSourceLastCommit', variant: 'default', run: e => e.readSourceLastCommit('source-a') },
    texts: ['SELECT last_commit FROM sources WHERE id=$1'],
  },
  {
    from: 'src/core/persistence/sync-lease.ts:136 readDrainLease (at e98683e983)',
    case: { method: 'readDrainLeaseBeacon', variant: 'default', run: e => e.readDrainLeaseBeacon('token-a') },
    texts: ["SELECT data->'drain_lease_beacon' AS meta FROM minion_jobs WHERE queue=$1 AND lock_token=$2"],
  },
  {
    from: 'src/core/persistence/sync-lease.ts:161 holderProgress (at e98683e983)',
    case: { method: 'readDrainHolderProgress', variant: 'default', run: e => e.readDrainHolderProgress('source-a', '1970-01-01T00:00:00.000Z') },
    texts: [`
    SELECT (SELECT count(*) FROM persistence_requests r WHERE r.worktree_id=b.worktree_id AND r.state='committed'
        AND COALESCE(r.intent->>'kind','') LIKE 'managed_sync_%' AND r.completed_at >= $2::timestamptz) AS committed,
      (SELECT max(r.completed_at) FROM persistence_requests r WHERE r.worktree_id=b.worktree_id AND r.source_incarnation=b.source_incarnation
        AND r.state='committed' AND COALESCE(r.intent->>'kind','') LIKE 'managed_sync_%') AS last_committed_at,
      GREATEST((SELECT max(c.updated_at) FROM op_checkpoints c WHERE c.op='managed-sync' AND c.completed_keys->0->>'sourceId'=$1),
        (SELECT c.updated_at FROM op_checkpoints c WHERE c.op=$3 AND c.fingerprint=b.source_id||':'||b.source_incarnation::text),
        (SELECT c.updated_at FROM op_checkpoints c WHERE c.op='sync-hold-summary' AND c.fingerprint=b.source_id||':'||b.source_incarnation::text)) AS last_saved_at
    FROM persistence_source_bindings b WHERE b.source_id=$1`],
  },
  {
    from: 'src/core/persistence/sync-lease.ts:259 writeHolderRecord (at e98683e983)',
    case: { method: 'writeDrainLeaseHolder', variant: 'default', run: e => e.writeDrainLeaseHolder({ sourceId: 'source-a', lockToken: 'token-a', beacon: { kind: 'job', id: '7', version: '0.0.0.0' }, ttlMinutes: 5 }) },
    texts: [`WITH gone AS (DELETE FROM minion_jobs WHERE queue=$1 AND name='sync' AND data->>'sourceId'=$5 RETURNING 1)
    INSERT INTO minion_jobs(name,queue,status,submission_authority,data,max_attempts,max_stalled,lock_token,lock_until,started_at,remove_on_complete,remove_on_fail)
    SELECT 'sync',$1,'active','{"version":1,"kind":"application"}'::jsonb,$2::text::jsonb,1,0,$3,now()+make_interval(mins => $4),now(),true,true FROM (SELECT count(*) FROM gone) g`],
  },
  {
    from: 'src/core/persistence/sync-lease.ts:284 withDrainLease beacon refresh (at e98683e983)',
    case: { method: 'refreshDrainLeaseHolder', variant: 'default', run: e => e.refreshDrainLeaseHolder('token-a', 5) },
    texts: ['UPDATE minion_jobs SET lock_until=now()+make_interval(mins => $3),updated_at=now() WHERE queue=$1 AND lock_token=$2'],
  },
  {
    from: 'src/core/persistence/sync-lease.ts:295 withDrainLease release (at e98683e983)',
    case: { method: 'releaseDrainLeaseHolder', variant: 'default', run: e => e.releaseDrainLeaseHolder('token-a') },
    texts: ['DELETE FROM minion_jobs WHERE queue=$1 AND lock_token=$2'],
  },
];

describe('caller raw SQL moved into typed members keeps its Postgres text byte for byte', () => {
  for (const pin of PINS) {
    test(`${pin.case.method}/${pin.case.variant} (${pin.from})`, async () => {
      const capture = await withPinnedSqlEnvironment(undefined, () => runCase(pin.case));
      expect(capture.error).toBeUndefined();
      const sent = capture.trace.filter(s => s.kind === 'query').map(s => s.text);
      expect(sent).toEqual(pin.texts);
    });
  }
});
