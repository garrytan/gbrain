/**
 * Byte-identical pins for the caller raw SQL that became typed engine members (Rust engine lane 11).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member sends Postgres exactly the statement text its caller ran through `executeRaw` before the
 *    move. Each expected text below is copied verbatim from the caller at 7470c703ed, or at the commit its `from`
 *    names, except where a pin's comment names an equivalent statement.
 *  - Regression: an edited statement changes what Postgres and PGLite answer while the parity cases may still pass on
 *    a small fixture.
 *  - Why existing coverage misses it: the sql-text goldens cover the W1 domains only (test/engine-sql-sql-text.test.ts),
 *    and these members live outside them.
 *  - Seam: the fake postgres.js driver (test/helpers/fake-postgres-sql.ts) records the text; no database runs.
 */
import { describe, expect, test } from 'bun:test';
import { runCase, withPinnedSqlEnvironment, type SqlCase } from './helpers/postgres-engine-sql-cases.ts';
import { edgeTrimSql } from '../src/core/edge-whitespace.ts';
import { retiredPageSql } from '../src/core/entities/resolve.ts';
import { boundedBodyPrefixSql } from '../src/core/page-window/bounded-lead.ts';
import { callerAccessAllowedSql, privateLinkOriginFilterForCaller, privatePagesFilterForCaller, remoteReadFloorSql } from '../src/core/search/private-visibility.ts';
import { planManualClient } from '../src/core/oauth-provider.ts';
import { clientGrantInsert, grantValidationContext, insertClientGrant } from '../src/core/grants/service.ts';
import { CREDENTIAL_SQL, OAUTH_CODE_SQL, OAUTH_EXPIRE_ALL_SQL, OAUTH_REFRESH_SQL } from '../src/core/engine-sql/access-credentials.ts';
import { CLIENT_GRANT_SQL } from '../src/core/engine-sql/client-grants.ts';
import { PENDING_WRITE_HEALTH_SQL } from '../src/core/engine-sql/telemetry.ts';
import { ABANDONED_TAKES_SQL, TOP_RESOLVED_TAKES_SQL } from '../src/core/engine-sql/takes-reads.ts';
import { createHash } from 'node:crypto';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { markedScopeSources } from '../src/core/access/attest-sources.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { resolveTokenGrant, touchTokenLastUsed } from '../src/core/grants/legacy-token.ts';
import { OAuthGrants } from '../src/core/oauth-grants.ts';
import { OAUTH_TOKEN_SQL } from '../src/core/engine-sql/access-credentials.ts';
import { hashToken } from '../src/core/utils.ts';

interface Pin {
  /** The caller site the statement came from, at 7470c703ed unless it names another commit. */
  from: string;
  case: SqlCase;
  /** The statement texts, in order, as the caller sent them; a function renders them in the pinned environment. */
  texts: string[] | (() => string[]);
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
  ...([
    ['none', () => ''],
    ['caller', () => `AND ${privatePagesFilterForCaller('p')}`],
    ['floor', () => `AND ${remoteReadFloorSql('p')}`],
    ['member_access', () => `AND ${callerAccessAllowedSql('p')}`],
  ] as const).map(([privacy, predicate]): Pin => ({
    from: `src/core/entities/resolve.ts:246 followRetirement (privacy ${privacy})`,
    case: { method: 'readRetirementHop', variant: privacy, run: e => e.readRetirementHop('default', 'people/alice-example', privacy) },
    texts: () => [`SELECT p.slug, p.type, ${retiredPageSql('p')} AS retired,
              COALESCE(NULLIF(btrim(p.frontmatter->>'superseded_by'), ''), NULLIF(btrim(p.frontmatter->>'merged_into'), '')) AS target
         FROM pages p
        WHERE p.source_id = $1 AND p.slug = $2 AND p.deleted_at IS NULL ${predicate()}
        LIMIT 1`],
  })),
  ...([
    ['name', ''],
    ['name+private', `private`],
  ] as const).map(([variant, priv]): Pin => ({
    from: `src/core/verbs/entity-card.ts:354 selectEntityCandidates (${variant})`,
    case: { method: 'readEntityCardRows', variant, run: e => e.readEntityCardRows('default', { titleLc: 'alice example', slugs: ['people/alice-example'], slugLike: '%/alice-example' }, { excludePrivate: priv !== '' }) },
    texts: () => [`SELECT ${CARD_ROW_COLUMNS()}
         FROM pages
        WHERE deleted_at IS NULL
          AND source_id = $1
          AND ( lower(title) = $2
             OR slug = ANY($3::text[])
             OR slug LIKE $4 )${priv ? ` AND ${privatePagesFilterForCaller('pages')}` : ''}`],
  })),
  ...([
    ['slugs', ''],
    ['slugs+private', `private`],
  ] as const).map(([variant, priv]): Pin => ({
    from: `src/core/verbs/entity-card.ts:380 selectEntityCandidates hydrate (${variant})`,
    case: { method: 'readEntityCardRows', variant, run: e => e.readEntityCardRows('default', { slugs: ['people/alice-example'] }, { excludePrivate: priv !== '' }) },
    texts: () => [`SELECT ${CARD_ROW_COLUMNS()}
           FROM pages
          WHERE deleted_at IS NULL AND source_id = $1 AND slug = ANY($2::text[])${priv ? ` AND ${privatePagesFilterForCaller('pages')}` : ''}`],
  })),
  {
    from: 'src/commands/sync/plain-directory.ts:36 plainDirectorySyncRoot',
    case: { method: 'readPlainSyncSource', variant: 'default', run: e => e.readPlainSyncSource('default') },
    texts: ['SELECT local_path,last_commit,config FROM sources WHERE id=$1 AND NOT archived'],
  },
  {
    from: 'src/core/verbs/entity-card-identity.ts:141 readSiblingIdentity',
    case: { method: 'readEntityAliasRows', variant: 'siblings', run: e => e.readEntityAliasRows('default', ['people/alice-example', 'people/alice-twin']) },
    texts: ['SELECT slug, alias_norm, origin, alias_text FROM page_aliases WHERE source_id = $1 AND slug = ANY($2::text[]) ORDER BY alias_norm'],
  },
  {
    // readAka ran `SELECT alias_norm FROM page_aliases WHERE source_id = $1 AND slug = $2 ORDER BY alias_norm`. It now
    // sends the sibling statement with a one-slug array: the same rows in the same order (one slug, so no tie).
    from: 'src/core/verbs/entity-card.ts:783 readAka (one slug)',
    case: { method: 'readEntityAliasRows', variant: 'aka', run: e => e.readEntityAliasRows('default', ['people/alice-example']) },
    texts: ['SELECT slug, alias_norm, origin, alias_text FROM page_aliases WHERE source_id = $1 AND slug = ANY($2::text[]) ORDER BY alias_norm'],
  },
  // The caller bound the source once as $2 and named it three times (four for a remote read). The member binds it at
  // each use (engine-sql numbers every value once: check-engine-sql-dynamic), so the source is $2, $3 and $4: the same
  // value at each place, so the same rows in the same order.
  ...([[false, false], [true, true]] as const).map(([excludePrivate, remote]): Pin => ({
    from: 'src/core/verbs/entity-card.ts:617 assembleCard incoming edges',
    case: {
      method: 'readEntityInboundEdges', variant: excludePrivate ? 'remote+private' : 'local',
      run: e => e.readEntityInboundEdges('people/alice-example', 'default', { excludePrivate, originSameSource: remote }),
    },
    texts: () => [`SELECT f.slug AS from_slug, l.link_type, l.context, lr_t.valid_ranges::text AS temporal_ranges, lr_t.semantics AS temporal_semantics,
      lr_t.disputed AS temporal_disputed, lr_t.undated_past AS temporal_undated_past, lr_t.first_start::text AS temporal_first_start,
      lr_t.recorded_at AS temporal_recorded_at, lr_t.retired_at AS temporal_retired_at
           FROM links l
           JOIN pages f ON f.id = l.from_page_id
           JOIN pages t ON t.id = l.to_page_id
           LEFT JOIN link_relationships lr_t ON lr_t.from_page_id = l.from_page_id
      AND lr_t.to_page_id = l.to_page_id AND lr_t.link_type = l.link_type
      AND lr_t.scope = '${excludePrivate ? 'world' : 'all'}'
          WHERE t.slug = $1 AND t.source_id = $2 AND f.source_id = $3 AND f.deleted_at IS NULL
            AND COALESCE(l.link_source, '') <> 'mentions'${excludePrivate
    ? ` AND ${privatePagesFilterForCaller('f')} AND ${privateLinkOriginFilterForCaller('l')}`
    : ''} AND (l.origin_page_id IS NULL OR EXISTS (SELECT 1 FROM pages lo WHERE lo.id = l.origin_page_id AND lo.deleted_at IS NULL${remote ? ' AND lo.source_id = $4' : ''}))
          ORDER BY l.id`],
  })),
  // Not the caller's text: the statement adds `id DESC` as the last ORDER BY key, so tied loops read in one order.
  {
    from: 'src/core/verbs/entity-card.ts:691 assembleCard open loops',
    case: { method: 'readEntityOpenLoops', variant: 'default', run: e => e.readEntityOpenLoops('people/alice-example', 'default', 3) },
    texts: [`SELECT id, loop_type, summary, due_at, last_activity_at, fact_id
       FROM open_loops
       WHERE status = 'open' AND counterparty_slug = $1
         AND COALESCE(counterparty_source_id, source_id) = $2
       ORDER BY last_activity_at DESC, id DESC
       LIMIT 3`],
  },
  ...([[true, 'canonical'], [null, 'keep']] as const).map(([canonical, variant]): Pin => ({
    from: 'src/core/entity-identity.ts:71/114/118 resolvePageId + linkEntityIdentity',
    case: {
      method: 'linkEntityIdentityRow', variant,
      rows: [[/SELECT id FROM pages/i, [{ id: 7 }]]],
      run: e => e.linkEntityIdentityRow({ entityId: 'alice', slug: 'people/alice-example', sourceId: 'default', confidence: 1, establishedBy: 'manual', canonical }),
    },
    texts: [
      'SELECT id FROM pages WHERE slug = $1 AND source_id = $2 AND deleted_at IS NULL',
      ...(canonical === true ? ['UPDATE entity_identities SET canonical = false WHERE entity_id = $1 AND canonical'] : []),
      `INSERT INTO entity_identities (entity_id, source_id, page_id, confidence, established_by, canonical)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6::boolean, false))
       ON CONFLICT (source_id, page_id) DO UPDATE SET
         entity_id = EXCLUDED.entity_id,
         confidence = EXCLUDED.confidence,
         established_by = EXCLUDED.established_by,
         canonical = CASE WHEN $6::boolean IS NULL
           THEN entity_identities.canonical AND entity_identities.entity_id = EXCLUDED.entity_id
           ELSE EXCLUDED.canonical END,
         established_at = now()`,
    ],
  })),
  {
    from: 'src/core/entity-identity.ts:146 unlinkEntityIdentity',
    case: { method: 'unlinkEntityIdentityRow', variant: 'default', run: e => e.unlinkEntityIdentityRow({ entityId: 'alice', slug: 'people/alice-example', sourceId: 'default' }) },
    texts: [`DELETE FROM entity_identities ei
     USING pages p
     WHERE ei.page_id = p.id
       AND ei.entity_id = $1
       AND p.slug = $2
       AND ei.source_id = $3
     RETURNING ei.id`],
  },
  // Equivalent statement, not byte for byte: master expanded each source list into `IN ($4, $5)` placeholders;
  // engine-sql binds the list once as `= ANY($n::text[])` (check-engine-sql-dynamic bans a composed `IN (`
  // list). The same sources match, so the same rows come back in the same order. The rest of the text is verbatim.
  ...([
    ['all', {}],
    ['entity', { entityId: 'alice' }],
    ['seed+grant+private', { entityId: 'alice', slug: 'people/alice-example', slugSourceId: 'default', allowedSources: ['default', 'team'], excludePrivate: true }],
  ] as const).map(([variant, filter]): Pin => ({
    from: 'src/core/entity-identity.ts:220 listEntityIdentities',
    case: { method: 'listEntityIdentityRows', variant, run: e => e.listEntityIdentityRows(filter) },
    texts: () => {
      const f = filter as { entityId?: string; slug?: string; excludePrivate?: boolean };
      const where: string[] = [];
      if (f.excludePrivate) where.push(privatePagesFilterForCaller('p'));
      if (f.entityId) where.push('ei.entity_id = $1');
      if (f.slug) {
        where.push(`ei.entity_id IN (
      SELECT ei2.entity_id FROM entity_identities ei2
      JOIN pages p2 ON p2.id = ei2.page_id AND p2.source_id = ei2.source_id
      WHERE p2.slug = $2 AND p2.deleted_at IS NULL AND ei2.source_id = $3 AND ei2.source_id = ANY($4::text[]) AND ${privatePagesFilterForCaller('p2')}
    )`);
        where.push('ei.source_id = ANY($5::text[])');
      }
      return [`SELECT ei.entity_id, ei.source_id, p.slug, p.title, ei.confidence,
              ei.established_by, ei.established_at, ei.canonical
       FROM entity_identities ei
       JOIN pages p ON p.id = ei.page_id AND p.source_id = ei.source_id AND p.deleted_at IS NULL
       ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY ei.entity_id, ei.canonical DESC, ei.source_id, p.slug`];
    },
  })),
  {
    from: 'src/core/entity-identity.ts:266 identityIdsForPages',
    case: { method: 'readEntityIdentityIdsForPages', variant: 'default', run: e => e.readEntityIdentityIdsForPages([{ sourceId: 'default', slug: 'people/alice-example' }]) },
    texts: [`SELECT ei.entity_id, ei.source_id, p.slug
         FROM entity_identities ei
         JOIN pages p ON p.id = ei.page_id AND p.source_id = ei.source_id AND p.deleted_at IS NULL
        WHERE ei.source_id = ANY($1::text[]) AND p.slug = ANY($2::text[])`],
  },
  {
    from: 'src/core/google/counterparty.ts:35 canonicalTwin',
    case: { method: 'readCanonicalTwin', variant: 'default', run: e => e.readCanonicalTwin('default', 'people/alice-example') },
    texts: [`SELECT c.slug, ei.source_id
         FROM entity_identities me
         JOIN pages p ON p.id = me.page_id AND p.source_id = $1 AND p.slug = $2 AND p.deleted_at IS NULL
         JOIN entity_identities ei ON ei.entity_id = me.entity_id AND ei.canonical AND ei.source_id <> $1
         JOIN pages c ON c.id = ei.page_id AND c.deleted_at IS NULL
        LIMIT 2`],
  },
  {
    from: 'src/core/access/owner-only.ts:56 ownerOnlySourcesPresent',
    case: { method: 'readOwnerOnlySourcesPresent', variant: 'default', run: e => e.readOwnerOnlySourcesPresent() },
    texts: [`SELECT EXISTS (SELECT 1 FROM sources read_source WHERE read_source.id >= '' AND (read_source.config->>'kind' IN ('imessage') OR read_source.config->>'owner_only' = 'true')) AS present`],
  },
  {
    from: 'src/core/access/owner-only.ts:66 sourceIsOwnerOnly',
    case: { method: 'readOwnerOnlySourceConfig', variant: 'default', run: e => e.readOwnerOnlySourceConfig('default') },
    texts: ['SELECT config FROM sources WHERE id = $1'],
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
  {
    from: 'src/core/context/session-state.ts:299 getCheckpointManifest, at eb30f47b89',
    case: { method: 'readCheckpointManifestRow', variant: 'default', run: e => e.readCheckpointManifestRow('default', 'local', 's') },
    texts: [`SELECT checkpoint_manifest
       FROM session_context_state
       WHERE source_id = $1 AND client_id = $2 AND session_id = $3`],
  },
  {
    from: 'src/core/context/session-state.ts:355 appendCheckpointManifest, at eb30f47b89',
    case: { method: 'writeCheckpointManifest', variant: 'default', run: e => e.writeCheckpointManifest('default', 'local', 's', [{ slug: 'notes/a', title: 'A' }]) },
    texts: [`INSERT INTO session_context_state
         (source_id, client_id, session_id, checkpoint_manifest, updated_at)
       VALUES ($1, $2, $3, $4::text::jsonb, now())
       ON CONFLICT (source_id, client_id, session_id) DO UPDATE SET
         checkpoint_manifest = EXCLUDED.checkpoint_manifest,
         updated_at          = now()`],
  },
  {
    from: 'src/core/context/session-state.ts:389 gcSessionContextState (age-out), at eb30f47b89',
    case: { method: 'ageOutSessionState', variant: 'default', run: e => e.ageOutSessionState(7) },
    texts: [`DELETE FROM session_context_state WHERE updated_at < now() - ($1 || ' days')::interval`],
  },
  {
    from: 'src/core/context/session-state.ts:394 gcSessionContextState (per-client cap), at eb30f47b89',
    case: { method: 'capSessionStatePerClient', variant: 'default', run: e => e.capSessionStatePerClient(1000) },
    texts: [`DELETE FROM session_context_state s
       USING (
         SELECT source_id, client_id, session_id,
                row_number() OVER (
                  PARTITION BY source_id, client_id ORDER BY updated_at DESC
                ) AS rn
         FROM session_context_state
       ) ranked
       WHERE s.source_id = ranked.source_id
         AND s.client_id = ranked.client_id
         AND s.session_id = ranked.session_id
         AND ranked.rn > $1`],
  },
  {
    from: 'src/core/ops/facts.ts:706 withProvenance, at 0a68889b57',
    case: { method: 'listFactProvenance', variant: 'default', run: e => e.listFactProvenance({ sourceId: 'default', ids: [1, 2] }) },
    texts: ['SELECT id, source FROM facts WHERE source_id = $1 AND id = ANY($2::bigint[])'],
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
    from: 'src/core/access/members.ts:124 getMember (one member by id)',
    case: { method: 'readAccessMembers', variant: 'by-id', run: e => e.readAccessMembers({ id: 'alice-example' }) },
    texts: [`SELECT m.id, m.display_name, m.email, m.kind, m.labelled_only, m.disabled_at, m.tombstoned_at, m.created_at,
  COALESCE(array_agg(g.group_id ORDER BY g.group_id) FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
  FROM access_members m LEFT JOIN access_group_members g ON g.member_id = m.id WHERE m.id = $1 GROUP BY m.id`],
  },
  {
    from: 'src/core/access/members.ts:160 memberByEmail and :143 assertEmailFree (members declaring one email)',
    case: { method: 'readAccessMembers', variant: 'by-email', run: e => e.readAccessMembers({ email: 'alice@example.com' }) },
    texts: [`SELECT m.id, m.display_name, m.email, m.kind, m.labelled_only, m.disabled_at, m.tombstoned_at, m.created_at,
  COALESCE(array_agg(g.group_id ORDER BY g.group_id) FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
  FROM access_members m LEFT JOIN access_group_members g ON g.member_id = m.id WHERE m.email = $1 GROUP BY m.id ORDER BY m.id`],
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
    from: 'src/core/access/members.ts:199 legacyTokenByName (active tokens with one name)',
    case: { method: 'readAccessCredentials', variant: 'token-name', run: e => e.readAccessCredentials({ tokenName: 'laptop' }) },
    texts: ['SELECT id::text AS id, name FROM access_tokens WHERE name = $1 AND revoked_at IS NULL ORDER BY created_at'],
  },
  {
    from: 'src/core/access/members.ts:305/307 boundCredentials (tokens, then clients)',
    case: { method: 'readAccessCredentials', variant: 'member', run: e => e.readAccessCredentials({ memberId: 'alice-example' }) },
    texts: ['SELECT id::text AS id, name FROM access_tokens WHERE member_id = $1 AND revoked_at IS NULL ORDER BY name',
      "SELECT client_id AS id, client_name AS name FROM oauth_clients WHERE member_id = $1 AND (to_jsonb(oauth_clients)->>'deleted_at') IS NULL ORDER BY client_id"],
  },
  {
    from: 'src/core/access/members.ts:295 audienceMemberIds',
    case: { method: 'listAudienceAccessMembers', variant: 'default', run: e => e.listAudienceAccessMembers() },
    texts: ["SELECT id FROM access_members WHERE kind = 'audience' AND disabled_at IS NULL AND tombstoned_at IS NULL ORDER BY id"],
  },
  {
    from: 'src/core/access/members.ts:345 listGroups (every group)',
    case: { method: 'readAccessGroups', variant: 'all', run: e => e.readAccessGroups(null) },
    texts: [`SELECT g.id, COALESCE(array_agg(gm.member_id ORDER BY gm.member_id) FILTER (WHERE gm.member_id IS NOT NULL), '{}') AS members
     FROM access_groups g LEFT JOIN access_group_members gm ON gm.group_id = g.id
      GROUP BY g.id ORDER BY g.id`],
  },
  {
    from: 'src/core/access/members.ts:345 listGroups (one group by id)',
    case: { method: 'readAccessGroups', variant: 'by-id', run: e => e.readAccessGroups('team-a') },
    texts: [`SELECT g.id, COALESCE(array_agg(gm.member_id ORDER BY gm.member_id) FILTER (WHERE gm.member_id IS NOT NULL), '{}') AS members
     FROM access_groups g LEFT JOIN access_group_members gm ON gm.group_id = g.id
     WHERE g.id = $1 GROUP BY g.id ORDER BY g.id`],
  },
  {
    from: 'src/core/access/members.ts:303 pagesNaming',
    case: { method: 'listPagesNamingReader', variant: 'default', run: e => e.listPagesNamingReader('member:alice-example') },
    texts: [`SELECT slug, source_id FROM pages WHERE frontmatter ? 'readable_by' AND gbrain_access_readers(frontmatter) @> ARRAY[$1]::text[]
     ORDER BY source_id, slug LIMIT 51`],
  },
  {
    from: 'src/core/wakeshift/forget.ts:23 forgetWakePrincipal (member), called from members.ts removeMember',
    case: { method: 'forgetWakeMember', variant: 'default', run: e => e.forgetWakeMember('alice-example') },
    texts: [
      `INSERT INTO wake_forgets (wake_user) SELECT DISTINCT wake_user FROM wake_subscriptions WHERE member_id = $1
        ON CONFLICT (wake_user) WHERE state = 'pending' DO NOTHING RETURNING id`,
      `UPDATE wake_subscriptions SET state = 'ended', last_error = 'principal_revoked', lease_until = NULL, updated_at = now()
        WHERE member_id = $1 AND state = 'open' RETURNING id`,
      'DELETE FROM wake_terms_acceptances WHERE principal_key = $1',
    ],
  },
  {
    from: 'src/core/wakeshift/forget.ts forgetWakePrincipal (credential), called from auth.ts revoke/revokeById/revokeClient and token-mint.ts revokeLegacyTokenById',
    case: { method: 'forgetWakeCredential', variant: 'default', run: e => e.forgetWakeCredential('oauth_client', 'client-a') },
    texts: [
      `INSERT INTO wake_forgets (wake_user) SELECT DISTINCT wake_user FROM wake_subscriptions
      WHERE principal_kind = $1 AND principal_id = $2 AND member_id IS NULL
      ON CONFLICT (wake_user) WHERE state = 'pending' DO NOTHING RETURNING id`,
      `UPDATE wake_subscriptions SET state = 'ended', last_error = 'principal_revoked', lease_until = NULL, updated_at = now()
      WHERE principal_kind = $1 AND principal_id = $2 AND state = 'open' RETURNING id`,
      'DELETE FROM wake_terms_acceptances WHERE principal_key = $1',
    ],
  },
  {
    from: 'src/commands/auth.ts revoke (by name)',
    case: { method: 'revokeAccessTokensNamed', variant: 'default', run: e => e.revokeAccessTokensNamed('laptop') },
    texts: [`
      UPDATE access_tokens SET revoked_at = now()
      WHERE name = $1 AND revoked_at IS NULL
      RETURNING id
    `],
  },
  {
    from: 'src/commands/auth.ts revokeById, src/core/token-mint.ts revokeLegacyTokenById',
    case: { method: 'revokeAccessToken', variant: 'default', run: e => e.revokeAccessToken('00000000-0000-4000-8000-0000000000c1') },
    texts: [`
      UPDATE access_tokens SET revoked_at = now()
      WHERE id = $1::uuid AND revoked_at IS NULL
      RETURNING name
    `],
  },
  {
    from: 'src/commands/auth.ts revokeClient',
    case: { method: 'deleteOAuthClient', variant: 'default', run: e => e.deleteOAuthClient('client-a') },
    texts: [`
        DELETE FROM oauth_clients WHERE client_id = $1
        RETURNING client_id, client_name
      `],
  },
  {
    from: 'src/core/oauth-grants.ts revokeToken (at d8d9956871; the template, as $N text)',
    case: { method: 'deleteOauthTokenByHash', variant: 'default', run: e => e.deleteOauthTokenByHash('hash-x', 'client-a') },
    texts: ['DELETE FROM oauth_tokens WHERE token_hash = $1 AND client_id = $2'],
  },
  {
    from: 'src/core/oauth-grants.ts revokeClient soft delete (at d8d9956871)',
    case: { method: 'softDeleteOauthClient', variant: 'default', run: e => e.softDeleteOauthClient('client-a') },
    texts: ['UPDATE oauth_clients SET deleted_at = now() WHERE client_id = $1'],
  },
  {
    from: 'src/core/oauth-grants.ts revokeClient codes (at d8d9956871)',
    case: { method: 'deleteOauthClientCodes', variant: 'default', run: e => e.deleteOauthClientCodes('client-a') },
    texts: ['DELETE FROM oauth_codes WHERE client_id = $1'],
  },
  {
    from: 'src/core/oauth-grants.ts revokeClient tokens (at d8d9956871)',
    case: { method: 'deleteOauthClientTokens', variant: 'default', run: e => e.deleteOauthClientTokens('client-a') },
    texts: ['DELETE FROM oauth_tokens WHERE client_id = $1'],
  },
  {
    from: 'src/core/grants/lifecycle.ts delete (at d8d9956871)',
    case: { method: 'deleteOauthClientRow', variant: 'default', run: e => e.deleteOauthClientRow('client-a') },
    texts: ['DELETE FROM oauth_clients WHERE client_id = $1'],
  },
  {
    from: 'src/core/grants/lifecycle.ts revoke (at d8d9956871)',
    case: { method: 'setOauthClientRevision', variant: 'revoke', run: e => e.setOauthClientRevision('client-a', 2, true) },
    texts: ['UPDATE oauth_clients SET deleted_at = COALESCE(deleted_at, now()), grant_revision = $1 WHERE client_id = $2'],
  },
  {
    from: 'src/core/grants/lifecycle.ts invalidate-tokens (at d8d9956871)',
    case: { method: 'setOauthClientRevision', variant: 'invalidate', run: e => e.setOauthClientRevision('client-a', 2, false) },
    texts: ['UPDATE oauth_clients SET grant_revision = $1 WHERE client_id = $2'],
  },
  {
    from: 'src/core/grants/lifecycle.ts audit (at d8d9956871)',
    case: { method: 'insertOauthGrantAudit', variant: 'default', run: e => e.insertOauthGrantAudit({ client_id: 'client-a', actor: 'admin', action: 'revoke', revision: 2, before_grant: '{}', after_grant: '{}' }) },
    texts: [`INSERT INTO oauth_grant_audit (client_id, actor, action, revision, before_grant, after_grant)
      VALUES ($1, $2, $3, $4, $5::text::jsonb, $6::text::jsonb)`],
  },
  {
    from: 'src/commands/serve-http-admin-api.ts health-indicators expiring_soon (at dca1a50918)',
    case: { method: 'countOauthAccessTokens', variant: 'between', run: e => e.countOauthAccessTokens(1, 2) },
    texts: ["SELECT count(*)::int as count FROM oauth_tokens WHERE token_type = 'access' AND expires_at BETWEEN $1 AND $2"],
  },
  {
    from: 'src/commands/serve-http-admin-api.ts stats active_tokens (at dca1a50918)',
    case: { method: 'countOauthAccessTokens', variant: 'after', run: e => e.countOauthAccessTokens(1, null) },
    texts: ["SELECT count(*)::int as count FROM oauth_tokens WHERE token_type = 'access' AND expires_at > $1"],
  },
  {
    from: 'src/commands/serve-http-admin-api.ts stats requests_today (at dca1a50918)',
    case: { method: 'countMcpRequestsLastDay', variant: 'all', run: e => e.countMcpRequestsLastDay('all') },
    texts: ["SELECT count(*)::int as count FROM mcp_request_log WHERE created_at > now() - interval '24 hours'"],
  },
  {
    from: 'src/commands/serve-http-admin-api.ts health-indicators total (at dca1a50918)',
    case: { method: 'countMcpRequestsLastDay', variant: 'traffic', run: e => e.countMcpRequestsLastDay('traffic') },
    texts: ["SELECT count(*)::int as count FROM mcp_request_log WHERE operation != 'surface_change' AND created_at > now() - interval '24 hours'"],
  },
  {
    from: 'src/commands/serve-http-admin-api.ts health-indicators errors (at dca1a50918)',
    case: { method: 'countMcpRequestsLastDay', variant: 'errors', run: e => e.countMcpRequestsLastDay('errors') },
    texts: ["SELECT count(*)::int as count FROM mcp_request_log WHERE status NOT IN ('success', 'success_with_warnings', 'accepted_pending') AND operation != 'surface_change' AND created_at > now() - interval '24 hours'"],
  },
  {
    // New text: the agents list's per-row correlated subselects became one grouped read over the asked names.
    from: 'src/commands/serve-http-admin-api.ts agents requests_today (grouped, new at dca1a50918)',
    case: { method: 'countMcpRequestsLastDayByToken', variant: 'default', run: e => e.countMcpRequestsLastDayByToken(['client-a']) },
    texts: [`SELECT token_name, count(*)::int AS requests FROM mcp_request_log
    WHERE token_name = ANY($1::text[]) AND created_at > now() - interval '24 hours' GROUP BY token_name ORDER BY token_name COLLATE "C"`],
  },
  {
    from: 'src/commands/auth.ts:180 list (at 837c389e52)',
    case: { method: 'listAccessTokens', variant: 'default', run: e => e.listAccessTokens() },
    texts: [`
      SELECT * FROM access_tokens
      ORDER BY created_at DESC
    `],
  },
  {
    from: 'src/core/token-mint.ts:192 readActiveTokenPrivatePages (at 837c389e52)',
    case: { method: 'readActiveAccessTokenGrant', variant: 'private-pages', run: e => e.readActiveAccessTokenGrant('00000000-0000-4000-8000-0000000000c1', 'private_pages') },
    texts: ['SELECT private_pages FROM access_tokens WHERE id = $1::uuid AND revoked_at IS NULL'],
  },
  {
    from: 'src/core/token-mint.ts:209 readActiveTokenPermissions (at 837c389e52)',
    case: { method: 'readActiveAccessTokenGrant', variant: 'permissions', run: e => e.readActiveAccessTokenGrant('00000000-0000-4000-8000-0000000000c1', 'permissions') },
    texts: ['SELECT permissions FROM access_tokens WHERE id = $1::uuid AND revoked_at IS NULL'],
  },
  {
    from: 'src/core/wakeshift/drain.ts:80 principalLive (legacy token, at 837c389e52)',
    case: { method: 'accessTokenLive', variant: 'default', run: e => e.accessTokenLive('00000000-0000-4000-8000-0000000000c1') },
    texts: ['SELECT 1 FROM access_tokens WHERE id::text = $1 AND revoked_at IS NULL'],
  },
  {
    from: 'src/core/wakeshift/drain.ts:77 principalLive (OAuth client, at 837c389e52)',
    case: { method: 'oauthClientLive', variant: 'default', run: e => e.oauthClientLive('client-a') },
    texts: ['SELECT 1 FROM oauth_clients WHERE client_id = $1 AND deleted_at IS NULL'],
  },
  {
    from: 'src/commands/auth.ts:581 preflightOauthClientColumns (at 837c389e52)',
    case: { method: 'readOauthClientColumns', variant: 'preflight', run: e => e.readOauthClientColumns('preflight') },
    texts: [`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'oauth_clients'
      AND table_schema = current_schema()
      AND column_name IN ('token_ttl', 'surface', 'federated_read', 'source_id', 'deleted_at')
  `],
  },
  {
    from: 'src/core/oauth-provider.ts:1112 registerClientManual column probe (at 837c389e52)',
    case: { method: 'readOauthClientColumns', variant: 'grant', run: e => e.readOauthClientColumns('grant') },
    texts: [`SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'oauth_clients'
        AND column_name IN ('grant_revision', 'allowed_operations', 'delegated_slug_prefixes', 'delegated_namespace', 'grant_profile', 'grant_repair_reasons', 'surface', 'surface_set_by', 'token_ttl', 'source_id', 'federated_read', 'bound_slug_prefixes', 'bound_tools', 'bound_source_id', 'bound_brain_id', 'bound_max_concurrent', 'budget_usd_per_day')`],
  },
  {
    from: 'src/commands/auth.ts:677 registerScopedClient token_ttl write (at 837c389e52; the template, as $N text)',
    case: { method: 'setOauthClientTokenTtl', variant: 'default', run: e => e.setOauthClientTokenTtl('client-a', 3600) },
    texts: [`
        UPDATE oauth_clients SET token_ttl = $1
        WHERE client_id = $2
        RETURNING client_id
      `],
  },
  {
    from: 'src/commands/auth.ts:1111 tokenLifetimeClampedClients (at 837c389e52)',
    case: { method: 'readTokenLifetimeClampedClients', variant: 'default', run: e => e.readTokenLifetimeClampedClients() },
    texts: [`SELECT DISTINCT client_id FROM oauth_grant_audit WHERE actor = 'migration' AND action IN ('clamp_token_ttl', 'shorten_access_tokens')`],
  },
  {
    from: 'src/core/access/attest-sources.ts:67 markedScopeSources FOR UPDATE (at 758c3b853e)',
    case: { method: 'readScopeSourceConfigs', variant: 'update', run: e => e.readScopeSourceConfigs(['team-a'], 'update') },
    texts: ['SELECT id, config FROM sources WHERE id IN (SELECT jsonb_array_elements_text($1::text::jsonb)) ORDER BY id FOR UPDATE'],
  },
  {
    from: 'src/core/access/attest-sources.ts:69 markedScopeSources FOR SHARE (at 758c3b853e)',
    case: { method: 'readScopeSourceConfigs', variant: 'share', run: e => e.readScopeSourceConfigs(['team-a'], 'share') },
    texts: ['SELECT id, config FROM sources WHERE id IN (SELECT jsonb_array_elements_text($1::text::jsonb)) ORDER BY id FOR SHARE'],
  },
  {
    from: 'src/core/access/attest-sources.ts:70 markedScopeSources (at 758c3b853e)',
    case: { method: 'readScopeSourceConfigs', variant: 'default', run: e => e.readScopeSourceConfigs(['team-a']) },
    texts: ['SELECT id, config FROM sources WHERE id IN (SELECT jsonb_array_elements_text($1::text::jsonb))'],
  },  {
    from: 'src/core/oauth-provider.ts:778 verifyAccessToken OAuth rung 0 (at d51679a5fd)',
    case: { method: 'readOauthAccessTokenRows', variant: 'rung0', run: e => e.readOauthAccessTokenRows('hash-x', 0) },
    texts: [`
        SELECT t.client_id, t.scopes, t.expires_at, t.resource, c.client_name, c.scope AS current_scopes, to_jsonb(t)->>'grant_type' AS token_grant,
               (to_jsonb(c) - 'client_secret_hash') AS current_grant,
               EXISTS(SELECT 1 FROM sources s WHERE s.id = to_jsonb(c)->>'source_id'
                 AND NOT COALESCE((to_jsonb(s)->>'archived')::boolean, false)) AS source_active,
               ARRAY(SELECT s.id FROM sources s WHERE NOT COALESCE((to_jsonb(s)->>'archived')::boolean, false)
                 AND s.id IN (SELECT jsonb_array_elements_text(COALESCE(NULLIF(to_jsonb(c)->'federated_read', 'null'::jsonb), jsonb_build_array(to_jsonb(c)->>'source_id'))))) AS active_read_sources,
               c.source_id, c.federated_read, c.bound_slug_prefixes,
               c.surface, c.surface_set_by
        FROM oauth_tokens t
        LEFT JOIN oauth_clients c ON c.client_id = t.client_id
        WHERE t.token_hash = $1 AND t.token_type = 'access'
          AND c.client_id IS NOT NULL AND (to_jsonb(c)->>'deleted_at') IS NULL
      `],
  },
  {
    from: 'src/core/oauth-provider.ts:824 verifyAccessToken OAuth rung 1 (at d51679a5fd)',
    case: { method: 'readOauthAccessTokenRows', variant: 'rung1', run: e => e.readOauthAccessTokenRows('hash-x', 1) },
    texts: [`
          SELECT t.client_id, t.scopes, t.expires_at, t.resource, c.client_name, c.scope AS current_scopes,
               (to_jsonb(c) - 'client_secret_hash') AS current_grant,
               EXISTS(SELECT 1 FROM sources s WHERE s.id = to_jsonb(c)->>'source_id'
                 AND NOT COALESCE((to_jsonb(s)->>'archived')::boolean, false)) AS source_active,
               ARRAY(SELECT s.id FROM sources s WHERE NOT COALESCE((to_jsonb(s)->>'archived')::boolean, false)
                 AND s.id IN (SELECT jsonb_array_elements_text(COALESCE(NULLIF(to_jsonb(c)->'federated_read', 'null'::jsonb), jsonb_build_array(to_jsonb(c)->>'source_id'))))) AS active_read_sources,
                 c.source_id, c.federated_read, c.bound_slug_prefixes
          FROM oauth_tokens t
          LEFT JOIN oauth_clients c ON c.client_id = t.client_id
          WHERE t.token_hash = $1 AND t.token_type = 'access'
          AND c.client_id IS NOT NULL AND (to_jsonb(c)->>'deleted_at') IS NULL
        `],
  },
  {
    from: 'src/core/oauth-provider.ts:841 verifyAccessToken OAuth rung 2 (at d51679a5fd)',
    case: { method: 'readOauthAccessTokenRows', variant: 'rung2', run: e => e.readOauthAccessTokenRows('hash-x', 2) },
    texts: [`
            SELECT t.client_id, t.scopes, t.expires_at, t.resource, c.client_name, c.scope AS current_scopes,
               (to_jsonb(c) - 'client_secret_hash') AS current_grant,
               EXISTS(SELECT 1 FROM sources s WHERE s.id = to_jsonb(c)->>'source_id'
                 AND NOT COALESCE((to_jsonb(s)->>'archived')::boolean, false)) AS source_active,
               ARRAY(SELECT s.id FROM sources s WHERE NOT COALESCE((to_jsonb(s)->>'archived')::boolean, false)
                 AND s.id IN (SELECT jsonb_array_elements_text(COALESCE(NULLIF(to_jsonb(c)->'federated_read', 'null'::jsonb), jsonb_build_array(to_jsonb(c)->>'source_id'))))) AS active_read_sources,
                   c.source_id, c.federated_read
            FROM oauth_tokens t
            LEFT JOIN oauth_clients c ON c.client_id = t.client_id
            WHERE t.token_hash = $1 AND t.token_type = 'access'
          AND c.client_id IS NOT NULL AND (to_jsonb(c)->>'deleted_at') IS NULL
          `],
  },
  {
    from: 'src/core/oauth-provider.ts:858 verifyAccessToken OAuth rung 3 (at d51679a5fd)',
    case: { method: 'readOauthAccessTokenRows', variant: 'rung3', run: e => e.readOauthAccessTokenRows('hash-x', 3) },
    texts: [`
              SELECT t.client_id, t.scopes, t.expires_at, t.resource, c.client_name, c.scope AS current_scopes,
               (to_jsonb(c) - 'client_secret_hash') AS current_grant,
               EXISTS(SELECT 1 FROM sources s WHERE s.id = to_jsonb(c)->>'source_id'
                 AND NOT COALESCE((to_jsonb(s)->>'archived')::boolean, false)) AS source_active,
               ARRAY(SELECT s.id FROM sources s WHERE NOT COALESCE((to_jsonb(s)->>'archived')::boolean, false)
                 AND s.id IN (SELECT jsonb_array_elements_text(COALESCE(NULLIF(to_jsonb(c)->'federated_read', 'null'::jsonb), jsonb_build_array(to_jsonb(c)->>'source_id'))))) AS active_read_sources, c.source_id
              FROM oauth_tokens t
              LEFT JOIN oauth_clients c ON c.client_id = t.client_id
              WHERE t.token_hash = $1 AND t.token_type = 'access'
          AND c.client_id IS NOT NULL AND (to_jsonb(c)->>'deleted_at') IS NULL
            `],
  },
  {
    from: 'src/core/oauth-provider.ts:873 verifyAccessToken OAuth rung 4 (at d51679a5fd)',
    case: { method: 'readOauthAccessTokenRows', variant: 'rung4', run: e => e.readOauthAccessTokenRows('hash-x', 4) },
    texts: [`
              SELECT t.client_id, t.scopes, t.expires_at, t.resource, c.client_name, c.scope AS current_scopes,
               (to_jsonb(c) - 'client_secret_hash') AS current_grant,
               EXISTS(SELECT 1 FROM sources s WHERE s.id = to_jsonb(c)->>'source_id'
                 AND NOT COALESCE((to_jsonb(s)->>'archived')::boolean, false)) AS source_active,
               ARRAY(SELECT s.id FROM sources s WHERE NOT COALESCE((to_jsonb(s)->>'archived')::boolean, false)
                 AND s.id IN (SELECT jsonb_array_elements_text(COALESCE(NULLIF(to_jsonb(c)->'federated_read', 'null'::jsonb), jsonb_build_array(to_jsonb(c)->>'source_id'))))) AS active_read_sources
              FROM oauth_tokens t
              LEFT JOIN oauth_clients c ON c.client_id = t.client_id
              WHERE t.token_hash = $1 AND t.token_type = 'access'
          AND c.client_id IS NOT NULL AND (to_jsonb(c)->>'deleted_at') IS NULL
            `],
  },
  {
    from: 'src/core/oauth-provider.ts:1021 verifyAccessToken legacy fallback (at d51679a5fd)',
    case: { method: 'readActiveAccessTokenByHash', variant: 'provider', run: e => e.readActiveAccessTokenByHash('hash-x', 'provider') },
    texts: [`
      SELECT * FROM access_tokens
      WHERE token_hash = $1 AND revoked_at IS NULL
    `],
  },
  {
    from: 'src/mcp/http-transport.ts:297 validateToken (at d51679a5fd)',
    case: { method: 'readActiveAccessTokenByHash', variant: 'transport', run: e => e.readActiveAccessTokenByHash('hash-x', 'transport') },
    texts: [`
        SELECT * FROM access_tokens
        WHERE token_hash = $1 AND revoked_at IS NULL
      `],
  },
  {
    from: 'src/core/grants/legacy-token.ts:413 touchTokenLastUsed unified row (at d51679a5fd)',
    case: { method: 'touchAccessTokenLastUsed', variant: 'unified', run: e => e.touchAccessTokenLastUsed('00000000-0000-4000-8000-0000000000b1', true) },
    texts: [`UPDATE access_tokens SET last_used_at = now()
        WHERE id IN (SELECT id FROM access_tokens WHERE id = $1::uuid AND source_grant IS NOT NULL
          AND (last_used_at IS NULL OR last_used_at < now() - interval '60 seconds') FOR UPDATE SKIP LOCKED)`],
  },
  {
    from: 'src/core/grants/legacy-token.ts:416 touchTokenLastUsed legacy row (at d51679a5fd)',
    case: { method: 'touchAccessTokenLastUsed', variant: 'legacy', run: e => e.touchAccessTokenLastUsed('00000000-0000-4000-8000-0000000000b1', false) },
    texts: [`UPDATE access_tokens SET last_used_at = now()
        WHERE id IN (SELECT id FROM access_tokens WHERE id = $1::uuid
          AND (last_used_at IS NULL OR last_used_at < now() - interval '60 seconds') FOR UPDATE SKIP LOCKED)`],
  },
  {
    from: 'src/core/grants/legacy-token.ts:390 resolveTokenGrant legacy-shape conversion (at afc2094edd)',
    case: { method: 'convertLegacyAccessTokenGrant', variant: 'default', run: e => e.convertLegacyAccessTokenGrant('00000000-0000-4000-8000-0000000000b1',
      { source_grant: 'federated', source_id: 'default', federated_read: ['default', 'wiki'], allowed_operations: null, takes_holders: ['world'] }) },
    texts: [`
      UPDATE access_tokens SET source_grant = $1, source_id = $2, federated_read = $3::text[],
        allowed_operations = $4::text[], takes_holders = $5::text[], grant_revision = grant_revision + 1,
        last_used_at = now()
      WHERE id IN (SELECT id FROM access_tokens WHERE id = $6::uuid AND source_grant IS NULL FOR UPDATE SKIP LOCKED)
      RETURNING *
    `],
  },
  {
    from: 'src/core/oauth-provider.ts:1144 sweepExpiredTokens (at afc2094edd)',
    case: { method: 'deleteExpiredOauthCredentials', variant: 'default', run: e => e.deleteExpiredOauthCredentials(1_700_000_000) },
    texts: [`
      DELETE FROM oauth_tokens WHERE expires_at < $1 RETURNING 1
    `, `
      DELETE FROM oauth_codes WHERE expires_at < $1 RETURNING 1
    `],
  },
  // The unowned admin and serve routes (Rust engine lane admin-unowned-rust), each text copied from its caller at 1bc04e66a8.
  {
    from: 'src/commands/serve-http-api-keys.ts:131 the admin key list (at 1bc04e66a8)',
    case: { method: 'listAccessTokenRows', variant: 'default', run: e => e.listAccessTokenRows() },
    texts: ['SELECT * FROM access_tokens ORDER BY created_at DESC, id'],
  },
  {
    // serve-http-registration.ts:199 sent this text; mcp-provision.ts:36 sent the same statement through the SqlQuery tag.
    from: 'src/commands/serve-http-registration.ts:199 the same-name registration lock (at 1bc04e66a8)',
    case: { method: 'lockOauthClientName', variant: 'default', run: e => e.lockOauthClientName('agent-register:pin-client') },
    texts: ['SELECT pg_advisory_xact_lock(hashtext($1)::bigint)'],
  },
  {
    from: 'src/core/access/actor.ts:315 linkRow (at 1bc04e66a8)',
    case: { method: 'readAccessMemberLink', variant: 'default', run: e => e.readAccessMemberLink('slack', 'U123') },
    texts: ['SELECT system, external_id, member_id, created_at FROM access_member_links WHERE system = $1 AND external_id = $2'],
  },
  {
    from: 'src/core/access/actor.ts:329 linkMember (at 1bc04e66a8)',
    case: { method: 'insertAccessMemberLink', variant: 'default', run: e => e.insertAccessMemberLink('slack', 'U123', 'alice-example') },
    texts: ['INSERT INTO access_member_links (system, external_id, member_id) VALUES ($1, $2, $3)'],
  },
  {
    from: 'src/core/access/actor.ts:343 unlinkMember (at 1bc04e66a8)',
    case: { method: 'deleteAccessMemberLink', variant: 'default', run: e => e.deleteAccessMemberLink('slack', 'U123') },
    texts: ['DELETE FROM access_member_links WHERE system = $1 AND external_id = $2'],
  },
  {
    from: 'src/core/access/actor.ts:349 listMemberLinks, every member (at 1bc04e66a8)',
    case: { method: 'listAccessMemberLinks', variant: 'all', run: e => e.listAccessMemberLinks(null) },
    texts: ['SELECT system, external_id, member_id, created_at FROM access_member_links ORDER BY member_id, system, external_id'],
  },
  {
    from: 'src/core/access/actor.ts:349 listMemberLinks, one member (at 1bc04e66a8)',
    case: { method: 'listAccessMemberLinks', variant: 'member', run: e => e.listAccessMemberLinks('alice-example') },
    texts: ['SELECT system, external_id, member_id, created_at FROM access_member_links WHERE member_id = $1 ORDER BY member_id, system, external_id'],
  },
  {
    from: 'src/core/persistence/page-visibility.ts:298 defaultSourceMemberWriter, a legacy token (at 1bc04e66a8)',
    case: { method: 'readCredentialMemberId', variant: 'token', run: e => e.readCredentialMemberId({ kind: 'token', id: '00000000-0000-4000-8000-0000000000b1' }) },
    texts: ['SELECT member_id FROM access_tokens WHERE id::text = $1'],
  },
  {
    from: 'src/core/persistence/page-visibility.ts:299 defaultSourceMemberWriter, an OAuth client (at 1bc04e66a8)',
    case: { method: 'readCredentialMemberId', variant: 'client', run: e => e.readCredentialMemberId({ kind: 'client', id: 'client-example' }) },
    texts: ['SELECT member_id FROM oauth_clients WHERE client_id = $1'],
  },
  {
    // serve-http-metrics.ts:263 sent this text; doctor/checks/db-connection.ts:317 sent the equivalent 'SELECT 1 AS ok'.
    from: 'src/commands/serve-http-metrics.ts:263 the health probe (at 1bc04e66a8)',
    case: { method: 'pingStore', variant: 'default', run: e => e.pingStore() },
    texts: ['SELECT 1'],
  },
  {
    from: 'src/commands/serve-http-webhooks.ts:303 legacyIngestJob (at 1bc04e66a8)',
    case: { method: 'readJobDataByIdempotencyKey', variant: 'default', run: e => e.readJobDataByIdempotencyKey('ingest:pin') },
    texts: ['SELECT data FROM minion_jobs WHERE idempotency_key = $1'],
  },
  {
    from: 'src/commands/jobs-watch.ts:163 the budget owners (at 1bc04e66a8)',
    case: { method: 'listBudgetOwners', variant: 'default', run: e => e.listBudgetOwners() },
    texts: [`SELECT
         mj.id AS owner_id,
         mj.budget_remaining_cents AS remaining_cents,
         COALESCE((SELECT SUM(ABS(cents_delta)) FROM minion_budget_log
                    WHERE owner_id = mj.id AND event_type = 'reserved'), 0) AS total_spent_cents
       FROM minion_jobs mj
       WHERE mj.budget_remaining_cents IS NOT NULL
         AND mj.budget_owner_job_id = mj.id
         AND mj.status NOT IN ('completed', 'failed', 'dead', 'cancelled')
       ORDER BY mj.id DESC
       LIMIT 5`],
  },
  {
    from: 'src/core/access/actor.ts:171 linkedMember, the attested-actor link (at 3f7de41dd9)',
    case: { method: 'readLinkedMember', variant: 'default', run: e => e.readLinkedMember('qm', 'person-1') },
    texts: [`SELECT m.id, COALESCE(array_agg(g.group_id ORDER BY g.group_id) FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
       FROM access_member_links l JOIN access_members m ON m.id = l.member_id LEFT JOIN access_group_members g ON g.member_id = m.id
       WHERE l.system = $1 AND l.external_id = $2 AND m.disabled_at IS NULL AND m.tombstoned_at IS NULL GROUP BY m.id`],
  },
  // Personal sources (Rust engine lane member-sources-rust), each text copied from access/member-sources.ts at 8e72de1bb6.
  {
    from: 'src/core/access/member-sources.ts:47 bindMemberSource, and :59 unbindMemberSource, the binding read (at 8e72de1bb6)',
    case: { method: 'readAccessMemberSource', variant: 'default', run: e => e.readAccessMemberSource('alice-example', 'dm-alice') },
    texts: ['SELECT member_id, source_id, created_at FROM access_member_sources WHERE member_id = $1 AND source_id = $2'],
  },
  {
    from: 'src/core/access/member-sources.ts:45 bindMemberSource (at 8e72de1bb6)',
    case: { method: 'insertAccessMemberSource', variant: 'default', run: e => e.insertAccessMemberSource('alice-example', 'dm-alice') },
    texts: ['INSERT INTO access_member_sources (member_id, source_id) VALUES ($1, $2) ON CONFLICT DO NOTHING'],
  },
  {
    from: 'src/core/access/member-sources.ts:63 unbindMemberSource (at 8e72de1bb6)',
    case: { method: 'deleteAccessMemberSource', variant: 'default', run: e => e.deleteAccessMemberSource('alice-example', 'dm-alice') },
    texts: ['DELETE FROM access_member_sources WHERE member_id = $1 AND source_id = $2'],
  },
  {
    from: 'src/core/access/member-sources.ts:70 listMemberSources, every member (at 8e72de1bb6)',
    case: { method: 'listAccessMemberSources', variant: 'all', run: e => e.listAccessMemberSources(null) },
    texts: ['SELECT member_id, source_id, created_at FROM access_member_sources ORDER BY member_id, source_id'],
  },
  {
    from: 'src/core/access/member-sources.ts:70 listMemberSources, one member (at 8e72de1bb6)',
    case: { method: 'listAccessMemberSources', variant: 'member', run: e => e.listAccessMemberSources('alice-example') },
    texts: ['SELECT member_id, source_id, created_at FROM access_member_sources WHERE member_id = $1 ORDER BY member_id, source_id'],
  },
  {
    from: 'src/core/access/member-sources.ts:76 sourceOwners (at 8e72de1bb6)',
    case: { method: 'listAccessMemberSourceOwners', variant: 'default', run: e => e.listAccessMemberSourceOwners('dm-alice') },
    texts: ['SELECT member_id FROM access_member_sources WHERE source_id = $1 ORDER BY member_id'],
  },
  {
    from: 'src/core/access/member-sources.ts:89 hiddenPersonalSources (at 8e72de1bb6)',
    case: { method: 'readMemberSourceBindings', variant: 'default', run: e => e.readMemberSourceBindings(['dm-alice']) },
    texts: ['SELECT source_id, member_id FROM access_member_sources WHERE source_id = ANY($1::text[])'],
  },
];

/** entity-card.ts CARD_ROW_COLUMNS at 7470c703ed, verbatim. */
function CARD_ROW_COLUMNS(): string {
  return `slug, source_id, title, type, frontmatter, ${boundedBodyPrefixSql('pages')} AS compiled_truth, updated_at,
              GREATEST(last_retrieved_at, (SELECT r.last_retrieved_at FROM page_retrievals r WHERE r.page_id = pages.id)) AS last_retrieved_at`;
}

describe('caller raw SQL moved into typed members keeps its Postgres text byte for byte', () => {
  for (const pin of PINS) {
    test(`${pin.case.method}/${pin.case.variant} (${pin.from})`, async () => {
      let expected: string[] = [];
      const capture = await withPinnedSqlEnvironment(undefined, () => {
        expected = typeof pin.texts === 'function' ? pin.texts() : pin.texts;
        return runCase(pin.case);
      });
      expect(capture.error).toBeUndefined();
      const sent = capture.trace.filter(s => s.kind === 'query').map(s => s.text);
      expect(sent).toEqual(expected);
    });
  }
});

describe('insertOauthClientGrant sends what insertClientGrant sends', () => {
  // The drift pin: grants/service.ts insertClientGrant stays the provider's path, so the member's constant text and
  // parameter order must keep matching the template it was captured from.
  test('same statement text and parameters for one planned client', async () => {
    const plan = planManualClient('pin-client', ['client_credentials'], 'read write', [], 'default', ['default']);
    const context = await grantValidationContext({ listAllSources: async () => [{ id: 'default' }] } as never);
    const grant = plan.grant(context);
    const sent = async (run: (e: any) => Promise<unknown>) => {
      const capture = await withPinnedSqlEnvironment(undefined, () => runCase({ method: 'insert', variant: 'default', run }));
      expect(capture.error).toBeUndefined();
      return capture.trace.filter(s => s.kind === 'query').map(s => ({ text: s.text, params: s.params }));
    };
    const template = await sent(e => insertClientGrant(sqlQueryForEngine(e), grant, plan.metadata));
    const member = await sent(e => e.insertOauthClientGrant(clientGrantInsert(grant, plan.metadata)));
    expect(template.length).toBe(1);
    expect(member).toEqual(template);
    expect(member[0].text).toBe(CREDENTIAL_SQL.client_grant_insert);
  });
});

describe('markedScopeSources sends the same statement through an engine as through a SqlQuery', () => {
  // The drift pin: the grant writes still pass a transaction SqlQuery (the template path); an engine caller now reads
  // through readScopeSourceConfigs. Both must send one text and one parameter list.
  for (const lock of [undefined, 'share', 'update'] as const) {
    test(`lock ${lock ?? 'none'}`, async () => {
      const sent = async (run: (e: any) => Promise<unknown>) => {
        const capture = await withPinnedSqlEnvironment(undefined, () => runCase({ method: 'markedScopeSources', variant: lock ?? 'none', run }));
        expect(capture.error).toBeUndefined();
        return capture.trace.filter(s => s.kind === 'query').map(s => ({ text: s.text, params: s.params }));
      };
      const ids = ['team-b', 'team-a', 'team-b'];
      const template = await sent(e => markedScopeSources(sqlQueryForEngine(e), ids, lock));
      const member = await sent(e => markedScopeSources(e, ids, lock));
      expect(template.length).toBe(1);
      expect(member).toEqual(template);
      expect(member[0].params).toEqual([JSON.stringify(['team-b', 'team-a'])]);
    });
  }
});

describe('the bearer check sends the same statements through an engine as through a SqlQuery', () => {
  // The drift pin: a provider built with only `sql` (no engine) keeps the template statements; serve --http passes its
  // engine, which reads through readOauthAccessTokenRows, readActiveAccessTokenByHash and touchAccessTokenLastUsed.
  const TOKEN_ROW = { id: '00000000-0000-4000-8000-0000000000b1', name: 'bearer', scopes: ['read'], permissions: {}, source_grant: 'default',
    source_id: null, federated_read: null, allowed_operations: null, takes_holders: null, grant_revision: 1, min_trust: null,
    private_pages: 'none', member_id: null, may_act_for: null, reads_unscoped: null, created_at: new Date(0) };
  const sent = async (rows: unknown[], degrade: number, run: (e: any) => Promise<unknown>) => {
    let failures = degrade;
    const capture = await withPinnedSqlEnvironment(undefined, () => runCase({
      method: 'verifyAccessToken', variant: 'default', run: async e => {
        await run(e).catch(() => undefined);
        await new Promise(r => setTimeout(r, 20)); // the last-use stamp is fire-and-forget
      },
      rows: [
        [/FROM oauth_tokens t/, () => { if (failures-- > 0) throw Object.assign(new Error('column "surface" does not exist'), { code: '42703' }); return []; }],
        [/SELECT \* FROM access_tokens/, rows],
        [/UPDATE access_tokens SET last_used_at/, []],
      ],
    }));
    expect(capture.error).toBeUndefined();
    return capture.trace.filter(s => s.kind === 'query').map(s => ({ text: s.text, params: s.params }));
  };
  for (const degrade of [0, 4]) {
    test(`a legacy token with ${degrade} failed OAuth rungs`, async () => {
      const template = await sent([TOKEN_ROW], degrade, e => new GBrainOAuthProvider({ sql: sqlQueryForEngine(e) }).verifyAccessToken('tok'));
      const member = await sent([TOKEN_ROW], degrade, e => new GBrainOAuthProvider({ sql: sqlQueryForEngine(e), engine: e }).verifyAccessToken('tok'));
      expect(template.length).toBe(degrade + 3);
      expect(member).toEqual(template);
    });
  }
  test('an unknown token', async () => {
    const template = await sent([], 0, e => new GBrainOAuthProvider({ sql: sqlQueryForEngine(e) }).verifyAccessToken('tok'));
    const member = await sent([], 0, e => new GBrainOAuthProvider({ sql: sqlQueryForEngine(e), engine: e }).verifyAccessToken('tok'));
    expect(template.length).toBe(2);
    expect(member).toEqual(template);
  });
  for (const unified of [true, false]) {
    test(`touchTokenLastUsed on a ${unified ? 'unified' : 'legacy'} row`, async () => {
      const row: Record<string, unknown> = unified ? { id: TOKEN_ROW.id, source_grant: 'default' } : { id: TOKEN_ROW.id };
      const template = await sent([], 0, e => touchTokenLastUsed(sqlQueryForEngine(e), row));
      const member = await sent([], 0, e => touchTokenLastUsed(e, row));
      expect(template.length).toBe(1);
      expect(member).toEqual(template);
    });
  }
});

describe('a legacy-shape token converts with the same statement through an engine as through a SqlQuery', () => {
  // serve --http and the legacy transport pass their engine, so resolveTokenGrant runs convertLegacyAccessTokenGrant;
  // without an engine it keeps the template. Both send the same text and params and authorize the same grant.
  const LEGACY_ROW = { id: '00000000-0000-4000-8000-0000000000b2', name: 'legacy', scopes: null, source_grant: null, source_id: null,
    federated_read: null, allowed_operations: null, takes_holders: null, grant_revision: 0, created_at: new Date(0),
    permissions: { source_id: 'default', federated_read: ['default', 'wiki'], takes_holders: ['world', 'garry'] } };
  const converted = { ...LEGACY_ROW, source_grant: 'federated', source_id: 'default', federated_read: ['default', 'wiki'],
    takes_holders: ['garry', 'world'], grant_revision: 1 };
  const resolved = async (run: (e: any) => Promise<unknown>, returned: unknown[]) => {
    let grant: unknown;
    const capture = await withPinnedSqlEnvironment(undefined, () => runCase({
      method: 'resolveTokenGrant', variant: 'legacy', run: async e => { grant = await run(e); },
      rows: [[/UPDATE access_tokens SET source_grant/, returned]],
    }));
    expect(capture.error).toBeUndefined();
    return { grant, sent: capture.trace.filter(s => s.kind === 'query').map(s => ({ text: s.text, params: s.params })) };
  };
  for (const [label, returned] of [['the row converts', [converted]], ['another reader converted it first', []]] as const) {
    test(label, async () => {
      const template = await resolved(e => resolveTokenGrant(sqlQueryForEngine(e), LEGACY_ROW), [...returned]);
      const member = await resolved(e => resolveTokenGrant(sqlQueryForEngine(e), LEGACY_ROW, e), [...returned]);
      expect(template.sent.length).toBe(1);
      expect(member).toEqual(template);
    });
  }
});

describe('the expired-credential sweep sends the same statements through an engine as through a SqlQuery', () => {
  // serve --http passes its engine, so sweepExpiredTokens runs deleteExpiredOauthCredentials; a provider built with only
  // `sql` keeps the template statements. Both send the same text and params and return the same count.
  const swept = async (run: (e: any) => Promise<number>) => {
    let count: number | undefined;
    const capture = await withPinnedSqlEnvironment(undefined, () => runCase({
      method: 'sweepExpiredTokens', variant: 'default', run: async e => { count = await run(e); },
      rows: [[/DELETE FROM oauth_tokens/, [{ '?column?': 1 }, { '?column?': 1 }]], [/DELETE FROM oauth_codes/, [{ '?column?': 1 }]]],
    }));
    expect(capture.error).toBeUndefined();
    return { count, sent: capture.trace.filter(s => s.kind === 'query').map(s => ({ text: s.text, params: s.params })) };
  };
  test('two expired tokens and one expired code', async () => {
    const template = await swept(e => new GBrainOAuthProvider({ sql: sqlQueryForEngine(e) }).sweepExpiredTokens());
    const member = await swept(e => new GBrainOAuthProvider({ sql: sqlQueryForEngine(e), engine: e }).sweepExpiredTokens());
    expect(template.sent.length).toBe(2);
    expect(template.count).toBe(3);
    expect({ ...member, sent: member.sent.map(s => ({ ...s, params: s.params.map(() => 'now') })) })
      .toEqual({ ...template, sent: template.sent.map(s => ({ ...s, params: s.params.map(() => 'now') })) });
  });
});

describe('insertOauthToken sends what OAuthGrants.issue sends', () => {
  // The drift pin for a grant built without the transaction handle (mcp-provision, auth.ts): issue() sends the templates
  // through the grant transaction's SqlQuery, so the member's constant text and parameter order must keep matching them.
  // The next describe pins the handle route (what serve --http runs) against the same statements.
  const NOW = 1_700_000_000_000;
  const CLIENT = { client_id: 'pin-oauth', client_name: 'pin', grant_types: ['client_credentials'], scope: 'read write', client_secret_hash: hashToken('secret'),
    client_secret_expires_at: 0, deleted_at: null };
  for (const marked of [true, false]) {
    test(marked ? 'a schema with grant_type' : 'a schema without grant_type', async () => {
      const client = marked ? { ...CLIENT, attest_actor: false } : CLIENT;
      const capture = await withPinnedSqlEnvironment(undefined, () => runCase({
        method: 'issue', variant: marked ? 'grant' : 'plain',
        rows: [[/FROM oauth_clients WHERE client_id = \$1 FOR UPDATE/, [client]]],
        run: async e => {
          const grants = new OAuthGrants({ sql: sqlQueryForEngine(e), transaction: fn => fn(sqlQueryForEngine(e)) as never, tokenTtl: 3600, refreshTtl: 86400, now: () => NOW });
          await grants.clientCredentials('pin-oauth', 'secret');
        },
      }));
      expect(capture.error).toBeUndefined();
      const template = capture.trace.flatMap(t => (t.kind === 'query' && /INSERT INTO oauth_tokens/.test(t.text) ? [{ text: t.text, params: t.params as unknown[] }] : []));
      expect(template.length).toBe(1);
      expect(template[0].text).toBe(marked ? OAUTH_TOKEN_SQL.insert_grant : OAUTH_TOKEN_SQL.insert_plain);
      const [hash, type, clientId, scopes, expiresAt, resource, created, grantType] = template[0].params;
      expect([type, clientId, scopes, expiresAt, resource, created, grantType]).toEqual(['access', 'pin-oauth', '{"read","write"}', NOW / 1000 + 3600, null, NOW / 1000, ...(marked ? ['client_credentials'] : [])]);
      const row = { token_hash: hash as string, token_type: 'access' as const, client_id: 'pin-oauth', scopes: ['read', 'write'], expires_at: expiresAt as number, resource: null, created_at: created as number,
        ...(marked ? { grant_type: 'client_credentials' as const } : {}) };
      const member = await withPinnedSqlEnvironment(undefined, () => runCase({ method: 'insertOauthToken', variant: marked ? 'grant' : 'plain', run: e => e.insertOauthToken(row) }));
      expect(member.error).toBeUndefined();
      expect(member.trace.flatMap(t => (t.kind === 'query' ? [{ text: t.text, params: t.params }] : []))).toEqual(template);
    });
  }
});

describe('the OAuth code flow and the token grant send the same statements through the transaction handle as through the SqlQuery', () => {
  // serve --http hands the grant transaction's engine handle to OAuthGrants (`fn(sql, tx)`): the client lock, the code
  // and the token INSERTs then run as members (a store with no raw SQL runs them in one write). A grant built without
  // the handle keeps the templates. Both routes must send the same text and params, in the same order.
  const NOW = 1_700_000_000_000;
  const VERIFIER = 'v'.repeat(43);
  const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
  const REDIRECT = 'https://client.example/callback';
  const CLIENT = { client_id: 'pin-code', client_name: 'pin', grant_types: ['authorization_code', 'client_credentials'], redirect_uris: [REDIRECT], scope: 'read write',
    client_secret_hash: hashToken('secret'), client_secret_expires_at: 0, deleted_at: null, grant_revision: 0, registered_via: 'manual', attest_actor: false };
  const CODE_ROW = { code_hash: 'x', client_id: 'pin-code', scopes: ['read'], code_challenge: CHALLENGE, code_challenge_method: 'S256', redirect_uri: REDIRECT,
    state: null, resource: null, expires_at: NOW / 1000 + 300, created_at: new Date(NOW) };
  const REFRESH_ROW = { token_hash: 'r', token_type: 'refresh', client_id: 'pin-code', scopes: ['read'], expires_at: NOW / 1000 + 3600, resource: null, created_at: new Date(NOW) };
  const sentBy = async (variant: string, run: (e: any) => Promise<unknown>) => {
    const capture = await withPinnedSqlEnvironment(undefined, () => runCase({ method: 'issue', variant, run: async e => { await run(e); },
      rows: [[/FROM oauth_clients WHERE client_id = \$1/, [CLIENT]], [/FROM oauth_codes WHERE code_hash/, [CODE_ROW]], [/SELECT code_challenge FROM oauth_codes/, [{ code_challenge: CHALLENGE }]], [/FROM oauth_tokens WHERE token_hash = \$1 AND token_type = 'refresh'/, [REFRESH_ROW]]] }));
    expect(capture.error).toBeUndefined();
    // The random code and token hashes differ per run; every other parameter must match.
    return capture.trace.filter(s => s.kind === 'query').map(s => ({ text: s.text, params: (s.params as unknown[]).map(p => typeof p === 'string' && /^[a-f0-9]{64}$/.test(p) ? 'hash' : p) }));
  };
  const grants = (e: any, handle: boolean) => new OAuthGrants({ sql: sqlQueryForEngine(e), ...(handle ? { engine: e } : {}),
    transaction: fn => (handle ? fn(sqlQueryForEngine(e), e) : fn(sqlQueryForEngine(e))) as never, tokenTtl: 3600, refreshTtl: 86400, now: () => NOW });
  const flow = (handle: boolean) => async (e: any) => {
    const g = grants(e, handle);
    const id = await g.begin('pin-code', { redirectUri: REDIRECT, codeChallenge: CHALLENGE, scopes: ['read'], state: undefined } as never);
    const code = new URL(await g.decide(id, true)).searchParams.get('code')!;
    const issued = await g.exchangeCode('pin-code', code, VERIFIER, REDIRECT, undefined, hashToken('secret'));
    await g.refresh('pin-code', issued.refresh_token!, undefined, undefined, hashToken('secret'));
    await g.clientCredentials('pin-code', 'secret');
    await new GBrainOAuthProvider({ sql: sqlQueryForEngine(e), ...(handle ? { engine: e } : {}) }).challengeForAuthorizationCode({ client_id: 'pin-code' } as never, code);
  };
  test('begin, decide, the code lookup, exchangeCode, refresh and clientCredentials', async () => {
    const template = await sentBy('flow-template', flow(false));
    const member = await sentBy('flow-member', flow(true));
    expect(template.map(s => s.text.trim().split(/\s+/).slice(0, 3).join(' '))).toEqual([
      'SELECT * FROM', 'SELECT * FROM', 'INSERT INTO oauth_codes', 'SELECT * FROM', 'SELECT * FROM',
      'DELETE FROM oauth_codes', 'INSERT INTO oauth_tokens', 'INSERT INTO oauth_tokens', 'SELECT * FROM', 'SELECT * FROM', 'DELETE FROM oauth_tokens',
      'INSERT INTO oauth_tokens', 'INSERT INTO oauth_tokens', 'SELECT * FROM', 'INSERT INTO oauth_tokens', 'SELECT code_challenge FROM']);
    expect(member).toEqual(template);
  });
  test('the member texts are the constants the templates were captured into', async () => {
    const sent = await sentBy('flow-constants', flow(true));
    const texts = new Set(sent.map(s => s.text));
    for (const text of [CLIENT_GRANT_SQL.client_for_update, OAUTH_CODE_SQL.insert, OAUTH_CODE_SQL.for_update, OAUTH_CODE_SQL.delete, OAUTH_CODE_SQL.challenge, OAUTH_TOKEN_SQL.insert_grant, OAUTH_REFRESH_SQL.for_update, OAUTH_REFRESH_SQL.delete]) {
      expect(texts.has(text)).toBe(true);
    }
  });
  test('the refresh-token read and delete members send their constants with the hash and client id', async () => {
    const read = await withPinnedSqlEnvironment(undefined, () => runCase({ method: 'readOauthRefreshTokenForUpdate', variant: 'member', run: e => e.readOauthRefreshTokenForUpdate('h', 'pin-code') }));
    const del = await withPinnedSqlEnvironment(undefined, () => runCase({ method: 'deleteOauthRefreshToken', variant: 'member', run: e => e.deleteOauthRefreshToken('h', 'pin-code') }));
    for (const [capture, text] of [[read, OAUTH_REFRESH_SQL.for_update], [del, OAUTH_REFRESH_SQL.delete]] as const) {
      expect(capture.error).toBeUndefined();
      expect(capture.trace.flatMap(t => (t.kind === 'query' ? [{ text: t.text, params: t.params }] : []))).toEqual([{ text, params: ['h', 'pin-code'] }]);
    }
  });
  test('the restore quarantine member sends the two expiry statements restore.ts sent, tokens first, with no params', async () => {
    const capture = await withPinnedSqlEnvironment(undefined, () => runCase({ method: 'expireAllOauthCredentials', variant: 'member', run: e => e.expireAllOauthCredentials() }));
    expect(capture.error).toBeUndefined();
    expect(OAUTH_EXPIRE_ALL_SQL).toEqual({ tokens: 'UPDATE oauth_tokens SET expires_at=0', codes: 'UPDATE oauth_codes SET expires_at=0' });
    expect(capture.trace.flatMap(t => (t.kind === 'query' ? [t.text] : []))).toEqual([OAUTH_EXPIRE_ALL_SQL.tokens, OAUTH_EXPIRE_ALL_SQL.codes]);
  });
  test('the pending-write health member sends the two statements serve-http-admin-api.ts sent, in flight first, with no params', async () => {
    const capture = await withPinnedSqlEnvironment(undefined, () => runCase({ method: 'readPendingWriteHealth', variant: 'member', run: e => e.readPendingWriteHealth() }));
    expect(capture.error).toBeUndefined();
    // The texts at 982540fd6e src/commands/serve-http-admin-api.ts:90-96, byte for byte.
    expect(PENDING_WRITE_HEALTH_SQL.pending).toBe(`SELECT count(*)::int AS count,
    COALESCE(floor(extract(epoch FROM now() - min(created_at))), 0)::int AS oldest_age_seconds
    FROM persistence_requests WHERE state IN ('queued', 'deferred', 'running', 'recovering')`);
    expect(PENDING_WRITE_HEALTH_SQL.later_failed).toBe(`SELECT count(DISTINCT r.id)::int AS count FROM mcp_request_log l
    JOIN persistence_requests r ON r.request_id::text = l.params->>'write_request_id'
    WHERE l.status = 'accepted_pending' AND l.created_at > now() - interval '24 hours'
      AND r.state IN ('conflict', 'failed', 'cancelled')`);
    expect(capture.trace.flatMap(t => (t.kind === 'query' ? [t.text] : []))).toEqual([PENDING_WRITE_HEALTH_SQL.pending, PENDING_WRITE_HEALTH_SQL.later_failed]);
  });
  test('the request-log page member sends the list and count serve-http-admin-api.ts sent, filters numbered in order', async () => {
    const queries = async (spec: Parameters<import('../src/core/engine.ts').BrainEngine['readMcpRequestLogPage']>[0]) => {
      const capture = await withPinnedSqlEnvironment(undefined, () => runCase({ method: 'readMcpRequestLogPage', variant: 'member', run: e => e.readMcpRequestLogPage(spec) }));
      expect(capture.error).toBeUndefined();
      return capture.trace.flatMap(t => (t.kind === 'query' ? [{ text: t.text, params: t.params }] : []));
    };
    // The texts at 551fdcf393 src/commands/serve-http-admin-api.ts:509-519, byte for byte, with the filters built there.
    const list = (filterSql: string, limit: string, offset: string) => `SELECT id, token_name, COALESCE(agent_name, token_name) as agent_name,
                operation, latency_ms, status, params, error_message, created_at
         FROM mcp_request_log
         WHERE 1=1 ${filterSql}
         ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;
    const count = (filterSql: string) => `SELECT count(*)::int as total FROM mcp_request_log
         WHERE 1=1 ${filterSql}`;
    expect(await queries({ limit: 50, offset: 0 })).toEqual([{ text: list('', '$1', '$2'), params: [50, 0] }, { text: count(''), params: [] }]);
    expect(await queries({ tokenName: 'a', operation: null, status: 'error', limit: 50, offset: 100 })).toEqual([
      { text: list('AND token_name = $1 AND status = $2', '$3', '$4'), params: ['a', 'error', 50, 100] },
      { text: count('AND token_name = $1 AND status = $2'), params: ['a', 'error'] },
    ]);
    expect(await queries({ tokenName: 'a', operation: 'search', status: 'ok', limit: 50, offset: 0 })).toEqual([
      { text: list('AND token_name = $1 AND operation = $2 AND status = $3', '$4', '$5'), params: ['a', 'search', 'ok', 50, 0] },
      { text: count('AND token_name = $1 AND operation = $2 AND status = $3'), params: ['a', 'search', 'ok'] },
    ]);
  });
  test('the calibration take reads send the statements serve-http-admin-api.ts sent', async () => {
    // The texts at 551fdcf393 src/commands/serve-http-admin-api.ts:357-361 and 441-448, byte for byte.
    expect(TOP_RESOLVED_TAKES_SQL).toBe(`SELECT t.id::text AS id, p.slug AS page_slug, t.row_num, t.claim, t.weight, t.resolved_quality, t.since_date
           FROM takes t JOIN pages p ON p.id = t.page_id
           WHERE t.holder = $1 AND t.active = true AND t.resolved_at IS NOT NULL
           ORDER BY t.weight DESC, t.since_date DESC
           LIMIT 25`);
    expect(ABANDONED_TAKES_SQL).toBe(`SELECT t.id, p.slug AS page_slug, t.claim, t.weight, t.since_date
             FROM takes t JOIN pages p ON p.id = t.page_id
             WHERE t.active = true AND t.resolved_at IS NULL AND t.superseded_by IS NULL
               AND t.weight >= 0.7
               AND (t.since_date || CASE WHEN length(t.since_date) = 7 THEN '-01' ELSE '' END)::date
                   < (now() - INTERVAL '12 months')
             ORDER BY t.since_date ASC
             LIMIT 5`);
    const top = await withPinnedSqlEnvironment(undefined, () => runCase({ method: 'listTopResolvedTakesForHolder', variant: 'member', run: e => e.listTopResolvedTakesForHolder('alice-example') }));
    const abandoned = await withPinnedSqlEnvironment(undefined, () => runCase({ method: 'listAbandonedTakes', variant: 'member', run: e => e.listAbandonedTakes() }));
    const expected: Array<[typeof top, string, unknown[]]> = [[top, TOP_RESOLVED_TAKES_SQL, ['alice-example']], [abandoned, ABANDONED_TAKES_SQL, []]];
    for (const [capture, text, params] of expected) {
      expect(capture.error).toBeUndefined();
      expect(capture.trace.flatMap(t => (t.kind === 'query' ? [{ text: t.text, params: t.params }] : []))).toEqual([{ text, params }]);
    }
  });
  test('issueOauthTokens runs on the transaction handle, never on the pool', async () => {
    // The client row is locked by the grant's transaction: a token INSERT on another connection waits on its foreign key.
    const used: string[] = [];
    const capture = await withPinnedSqlEnvironment(undefined, () => runCase({ method: 'issue', variant: 'handle', rows: [[/FROM oauth_clients WHERE client_id = \$1/, [CLIENT]]],
      run: async pool => {
        const names = ['readOauthClientForUpdate', 'issueOauthTokens'];
        const originals = Object.fromEntries(names.map(name => [name, (pool as any)[name].bind(pool)]));
        const tx = Object.create(pool);
        for (const name of names) {
          (pool as any)[name] = (...args: unknown[]) => { used.push(`pool.${name}`); return originals[name](...args); };
          tx[name] = (...args: unknown[]) => { used.push(`tx.${name}`); return originals[name](...args); };
        }
        const g = new OAuthGrants({ sql: sqlQueryForEngine(pool), engine: pool, transaction: fn => fn(sqlQueryForEngine(tx), tx) as never, tokenTtl: 3600, refreshTtl: 86400, now: () => NOW });
        await g.clientCredentials('pin-code', 'secret');
      } }));
    expect(capture.error).toBeUndefined();
    expect(used).toEqual(['tx.readOauthClientForUpdate', 'tx.issueOauthTokens']);
  });
});
