/**
 * Byte-identical pins for the caller raw SQL that became typed engine members (Rust engine lane 11).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member sends Postgres exactly the statement text its caller ran through `executeRaw` before the
 *    move. Each expected text below is copied verbatim from the caller at 7470c703ed, or at the commit its `from` names.
 *  - Regression: an edited statement changes what Postgres and PGLite answer while the parity cases may still pass on
 *    a small fixture.
 *  - Why existing coverage misses it: the sql-text goldens cover the W1 domains only (test/engine-sql-sql-text.test.ts),
 *    and these members live outside them.
 *  - Seam: the fake postgres.js driver (test/helpers/fake-postgres-sql.ts) records the text; no database runs.
 */
import { describe, expect, test } from 'bun:test';
import { runCase, withPinnedSqlEnvironment, type SqlCase } from './helpers/postgres-engine-sql-cases.ts';
import { edgeTrimSql } from '../src/core/edge-whitespace.ts';

interface Pin {
  /** The caller site the statement came from, at 7470c703ed unless it names another commit. */
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
  ...([
    ['member', 'alice-example', '$1'],
    ['stdio_config', 'mcp.stdio_member', `SELECT ${edgeTrimSql('value')} FROM config WHERE key = $1`],
    ['legacy_token', '00000000-0000-4000-8000-0000000000aa', 'SELECT member_id FROM access_tokens WHERE id::text = $1 AND revoked_at IS NULL'],
    ['oauth_client', 'client-example', 'SELECT member_id FROM oauth_clients WHERE client_id = $1 AND deleted_at IS NULL'],
  ] as const).map(([via, key, member]): Pin => ({
    from: 'src/core/access/caller.ts:94 liveIdentity (MEMBER_SQL)',
    case: { method: 'readLiveMember', variant: via, run: e => e.readLiveMember(via, key) },
    texts: [`SELECT m.id, COALESCE(array_agg(g.group_id ORDER BY g.group_id) FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
  FROM access_members m LEFT JOIN access_group_members g ON g.member_id = m.id
  WHERE m.id = (${member}) AND m.disabled_at IS NULL AND m.tombstoned_at IS NULL
  GROUP BY m.id`],
  })),
  {
    from: 'src/core/access/caller.ts:170 folderAccessForAll (no readers: the rules read is skipped)',
    case: { method: 'readFolderAccess', variant: 'no_readers', run: e => e.readFolderAccess([]) },
    texts: [`SELECT * FROM (SELECT DISTINCT source_id, prefix FROM access_pending_coverage
      UNION ALL SELECT '!unreadable', '' WHERE gbrain_access_state_unreadable()) c ORDER BY source_id, prefix`],
  },
  {
    from: 'src/core/access/caller.ts:170 folderAccessForAll',
    case: { method: 'readFolderAccess', variant: 'readers', run: e => e.readFolderAccess(['member:alice-example', 'group:team-a']) },
    texts: [
      'SELECT source_id, rule_id, readable_by FROM access_rules WHERE readable_by && $1::text[]',
      `SELECT * FROM (SELECT DISTINCT source_id, prefix FROM access_pending_coverage
      UNION ALL SELECT '!unreadable', '' WHERE gbrain_access_state_unreadable()) c ORDER BY source_id, prefix`,
    ],
  },
  {
    from: 'src/core/context/session-state.ts:201 upsertSessionContextState, at eb30f47b89',
    case: { method: 'upsertSessionState', variant: 'default', run: e => e.upsertSessionState('default', 'local', 's', { standingEntities: ['people/alice-example'], surfacedSlugs: ['notes/a'], lastWakeAt: '2026-11-19T00:00:00Z', replaceStanding: true, replaceCursorSlug: true, factsCursorAt: null, factsCursorId: null, degradedWakes: 'increment' }) },
    texts: [`INSERT INTO session_context_state
         (source_id, client_id, session_id, standing_entities, surfaced_slugs, last_wake_at,
          facts_cursor_at, facts_cursor_id, degraded_wakes, updated_at)
       VALUES ($1, $2, $3, $4::text::jsonb, $5::text::jsonb, $6::text::timestamptz, $9::text::timestamptz, $10::bigint,
               CASE WHEN $11::text = 'increment' THEN 1 ELSE 0 END, now())
       ON CONFLICT (source_id, client_id, session_id) DO UPDATE SET
         standing_entities = CASE WHEN $7::boolean THEN EXCLUDED.standing_entities
                                  ELSE session_context_state.standing_entities END,
         surfaced_slugs    = CASE WHEN $8::boolean THEN EXCLUDED.surfaced_slugs
                                  ELSE session_context_state.surfaced_slugs END,
         last_wake_at      = COALESCE(EXCLUDED.last_wake_at, session_context_state.last_wake_at),
         facts_cursor_at   = COALESCE(EXCLUDED.facts_cursor_at, session_context_state.facts_cursor_at),
         facts_cursor_id   = CASE WHEN EXCLUDED.facts_cursor_at IS NULL THEN session_context_state.facts_cursor_id
                                  ELSE EXCLUDED.facts_cursor_id END,
         degraded_wakes    = CASE $11::text WHEN 'increment' THEN session_context_state.degraded_wakes + 1
                                            WHEN 'reset' THEN 0
                                            ELSE session_context_state.degraded_wakes END,
         updated_at        = now()
       RETURNING degraded_wakes`],
  },
  {
    from: 'src/core/context/session-state.ts:113 getSessionContextState, at eb30f47b89',
    case: { method: 'readSessionCursor', variant: 'default', run: e => e.readSessionCursor('default', 'local', 's') },
    texts: [`SELECT standing_entities, surfaced_slugs,
              to_char(last_wake_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last_wake_at
       FROM session_context_state
       WHERE source_id = $1 AND client_id = $2 AND session_id = $3`],
  },
  {
    from: 'src/core/context/session-state.ts:148 readDeltaSessionState, at eb30f47b89',
    case: { method: 'readDeltaSessionRow', variant: 'default', run: e => e.readDeltaSessionRow('default', 'local', 's') },
    texts: [`SELECT surfaced_slugs, to_char(last_wake_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last_wake_at,
              to_char(facts_cursor_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS facts_cursor_at, facts_cursor_id, degraded_wakes
       FROM session_context_state
       WHERE source_id = $1 AND client_id = $2 AND session_id = $3`],
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
