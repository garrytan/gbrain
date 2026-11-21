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
import { budgetRowAppliesFilter } from '../src/core/page-size-policy.ts';
import { chunkGenerationFilter } from '../src/core/search/safe-chunks.ts';
import { quoteIdentifier } from '../src/core/search/embedding-column.ts';
import { retiredPageSql } from '../src/core/entities/resolve.ts';
import { rankingLinkSql } from '../src/core/link-ranking-policy.ts';
import { boundedBodyPrefixSql } from '../src/core/page-window/bounded-lead.ts';
import { accessAllowedSql, privacyPartSql } from '../src/core/search/private-visibility.ts';
import { callerAccessAllowedSql, privateLinkOriginFilterForCaller, privatePagesFilterFastForCaller, privatePagesFilterForCaller, remoteReadFloorSql } from '../src/core/search/private-visibility.ts';
import { planManualClient } from '../src/core/oauth-provider.ts';
import { clientGrantInsert, grantValidationContext, insertClientGrant } from '../src/core/grants/service.ts';
import { CREDENTIAL_SQL, OAUTH_CODE_SQL, OAUTH_EXPIRE_ALL_SQL, OAUTH_REFRESH_SQL } from '../src/core/engine-sql/access-credentials.ts';
import { CLIENT_GRANT_SQL } from '../src/core/engine-sql/client-grants.ts';
import { PENDING_WRITE_HEALTH_SQL } from '../src/core/engine-sql/telemetry.ts';
import { createHash } from 'node:crypto';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { markedScopeSources } from '../src/core/access/attest-sources.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { resolveTokenGrant, touchTokenLastUsed } from '../src/core/grants/legacy-token.ts';
import { OAuthGrants } from '../src/core/oauth-grants.ts';
import { OAUTH_TOKEN_SQL } from '../src/core/engine-sql/access-credentials.ts';
import { hashToken } from '../src/core/utils.ts';
import { activationSuppressedSql, pageEligibleSql } from '../src/core/eligibility/sql.ts';
import { quarantineFilterFragment } from '../src/core/quarantine.ts';
import { MANAGED_MODE_SQL } from '../src/core/persistence/managed-mode.ts';
import { FACT_PREIMAGE_SQL } from '../src/core/engine-sql/facts.ts';
import { TAKE_PREIMAGE_SQL } from '../src/core/engine-sql/takes-reads.ts';
import { trustRankSql } from '../src/core/trust/tier.ts';

interface Pin {
  /** The caller site the statement came from, at 7470c703ed unless it names another commit. */
  from: string;
  case: SqlCase;
  /** The statement texts, in order, as the caller sent them; a function renders them in the pinned environment. */
  texts: string[] | (() => string[]);
}

const PINS: Pin[] = [
  {
    from: 'src/core/access/caller.ts:376 appliedAccessSummary (the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'listAppliedPolicyRevisions', variant: 'default', run: e => e.listAppliedPolicyRevisions() },
    texts: [`SELECT s.source_id, (SELECT r.revision FROM access_policy_revisions r WHERE r.source_id = s.source_id AND r.applied_at IS NOT NULL
          ORDER BY r.revision DESC LIMIT 1) AS rev FROM access_policy_state s ORDER BY s.source_id COLLATE "C"`],
  },
  ...([
    ['member', 'alice-example', '$1'],
    ['stdio_config', 'mcp.stdio_member', `SELECT ${edgeTrimSql('value')} FROM config WHERE key = $1`],
    ['legacy_token', '00000000-0000-4000-8000-0000000000aa', 'SELECT member_id FROM access_tokens WHERE id::text = $1 AND revoked_at IS NULL'],
    ['oauth_client', 'client-example', 'SELECT member_id FROM oauth_clients WHERE client_id = $1 AND deleted_at IS NULL'],
  ] as const).map(([via, key, member]): Pin => ({
    from: 'src/core/access/caller.ts:94 liveIdentity (MEMBER_SQL; the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'readLiveMember', variant: via, run: e => e.readLiveMember(via, key) },
    texts: [`SELECT m.id, COALESCE(array_agg(g.group_id ORDER BY g.group_id COLLATE "C") FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
  FROM access_members m LEFT JOIN access_group_members g ON g.member_id = m.id
  WHERE m.id = (${member}) AND m.disabled_at IS NULL AND m.tombstoned_at IS NULL
  GROUP BY m.id`],
  })),
  {
    from: 'src/core/access/caller.ts:170 folderAccessForAll (no readers: the rules read is skipped; the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'readFolderAccess', variant: 'no_readers', run: e => e.readFolderAccess([]) },
    texts: [`SELECT * FROM (SELECT DISTINCT source_id, prefix FROM access_pending_coverage
      UNION ALL SELECT '!unreadable', '' WHERE gbrain_access_state_unreadable()) c ORDER BY source_id COLLATE "C", prefix COLLATE "C"`],
  },
  {
    from: 'src/core/access/caller.ts:170 folderAccessForAll (the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'readFolderAccess', variant: 'readers', run: e => e.readFolderAccess(['member:alice-example', 'group:team-a']) },
    texts: [
      'SELECT source_id, rule_id, readable_by FROM access_rules WHERE readable_by && $1::text[]',
      `SELECT * FROM (SELECT DISTINCT source_id, prefix FROM access_pending_coverage
      UNION ALL SELECT '!unreadable', '' WHERE gbrain_access_state_unreadable()) c ORDER BY source_id COLLATE "C", prefix COLLATE "C"`,
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
    from: 'src/core/verbs/entity-card-identity.ts:141 readSiblingIdentity (the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'readEntityAliasRows', variant: 'siblings', run: e => e.readEntityAliasRows('default', ['people/alice-example', 'people/alice-twin']) },
    texts: ['SELECT slug, alias_norm, origin, alias_text FROM page_aliases WHERE source_id = $1 AND slug = ANY($2::text[]) ORDER BY alias_norm COLLATE "C"'],
  },
  {
    // readAka ran `SELECT alias_norm FROM page_aliases WHERE source_id = $1 AND slug = $2 ORDER BY alias_norm`. It now
    // sends the sibling statement with a one-slug array: the same rows in the same order (one slug, so no tie).
    from: 'src/core/verbs/entity-card.ts:783 readAka (one slug; the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'readEntityAliasRows', variant: 'aka', run: e => e.readEntityAliasRows('default', ['people/alice-example']) },
    texts: ['SELECT slug, alias_norm, origin, alias_text FROM page_aliases WHERE source_id = $1 AND slug = ANY($2::text[]) ORDER BY alias_norm COLLATE "C"'],
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
    from: 'src/core/entity-identity.ts:220 listEntityIdentities (the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
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
       ORDER BY ei.entity_id COLLATE "C", ei.canonical DESC, ei.source_id COLLATE "C", p.slug COLLATE "C"`];
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
  ...([[false, false], [true, true]] as const).map(([excludePrivate, floored]): Pin => ({
    from: 'src/core/mentions/referrers.ts:233 readReferrerGroups (with referrersCte at :108)',
    case: {
      method: 'readReferrerGroupRows', variant: excludePrivate ? 'remote+floor' : 'local',
      run: e => e.readReferrerGroupRows({ sources: ['default'], slugs: ['companies/acme-example'] }, {
        referrerSources: ['default'], storedTypes: ['call'], canonicalTypes: ['meeting'], excludePrivate,
        eligibility: floored ? { floor: 'operator_curated' } : undefined, includeQuarantined: false, perGroup: 10,
      }),
    },
    texts: () => [`WITH tgt AS MATERIALIZED (
      SELECT t.id FROM pages t JOIN unnest($1::text[], $2::text[]) AS k(s, g) ON t.source_id = k.s AND t.slug = k.g
       WHERE t.deleted_at IS NULL${excludePrivate ? ` AND ${privatePagesFilterForCaller('t')}` : ''}
    ),
    refs AS MATERIALIZED (
      SELECT DISTINCT l.from_page_id AS id FROM links l WHERE l.to_page_id IN (SELECT id FROM tgt)${excludePrivate ? ` AND ${privateLinkOriginFilterForCaller('l')}` : ''}
    ),
    typed AS MATERIALIZED (
      SELECT f.id, f.slug, f.source_id, f.type,
             COALESCE(f.effective_date, f.updated_at) AS d,
             COALESCE(($5::text[])[array_position($4::text[], f.type)], NULLIF(f.type, ''), 'untyped') AS canonical_type
        FROM pages f
       WHERE f.id IN (SELECT id FROM refs)
         AND f.deleted_at IS NULL AND f.source_id = ANY($3::text[])
         AND f.id NOT IN (SELECT id FROM tgt)${excludePrivate ? ` AND ${privatePagesFilterFastForCaller('f')}` : ''} AND ${pageEligibleSql('f', floored ? { floor: 'operator_curated' } : undefined)} AND ${quarantineFilterFragment('f')}
    ),
     counts AS (SELECT canonical_type, count(*)::int AS n FROM typed GROUP BY canonical_type)
     SELECT x.id, x.slug, x.source_id, x.type, c.canonical_type, to_char(x.d AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS d, c.n AS gtotal
       FROM counts c CROSS JOIN LATERAL (
         SELECT * FROM typed t WHERE t.canonical_type = c.canonical_type ORDER BY t.d DESC NULLS LAST, t.source_id COLLATE "C", t.slug COLLATE "C" LIMIT $6
       ) x
      ORDER BY c.canonical_type COLLATE "C", x.d DESC NULLS LAST, x.source_id COLLATE "C", x.slug COLLATE "C"`],
  })),
  ...([[false, false], [true, true]] as const).map(([excludePrivate, floored]): Pin => ({
    from: 'src/core/mentions/referrers.ts:387 readTargetReferences counts (with referrersCteBatched at :274)',
    case: {
      method: 'readReferrerTargetCounts', variant: excludePrivate ? 'remote+floor' : 'local',
      run: e => e.readReferrerTargetCounts({ sources: ['default', 'default'], slugs: ['companies/acme-example', 'people/alice-example'], indexes: [0, 1] }, {
        referrerSources: ['default'], storedTypes: ['call'], canonicalTypes: ['meeting'], excludePrivate,
        eligibility: floored ? { floor: 'operator_curated' } : undefined, includeQuarantined: false, recordTypes: ['meeting'],
      }),
    },
    texts: () => [`WITH tgt AS MATERIALIZED (
      SELECT k.i, t.id FROM pages t JOIN unnest($1::text[], $2::text[], $3::int[]) AS k(s, g, i) ON t.source_id = k.s AND t.slug = k.g
       WHERE t.deleted_at IS NULL${excludePrivate ? ` AND ${privatePagesFilterForCaller('t')}` : ''}
    ),
    refs AS MATERIALIZED (
      SELECT DISTINCT tg.i, l.from_page_id AS id FROM links l JOIN tgt tg ON l.to_page_id = tg.id WHERE true${excludePrivate ? ` AND ${privateLinkOriginFilterForCaller('l')}` : ''}
    ),
    typed AS MATERIALIZED (
      SELECT r.i, f.id, f.slug, f.source_id, f.type,
             COALESCE(f.effective_date, f.updated_at) AS d,
             COALESCE(($6::text[])[array_position($5::text[], f.type)], NULLIF(f.type, ''), 'untyped') AS canonical_type
        FROM refs r JOIN pages f ON f.id = r.id
       WHERE f.deleted_at IS NULL AND f.source_id = ANY($4::text[])
         AND NOT EXISTS (SELECT 1 FROM tgt x WHERE x.i = r.i AND x.id = f.id)${excludePrivate ? ` AND ${privatePagesFilterFastForCaller('f')}` : ''} AND ${pageEligibleSql('f', floored ? { floor: 'operator_curated' } : undefined)} AND ${quarantineFilterFragment('f')}
    )
     SELECT i, NULL::text AS canonical_type, count(*)::int AS n FROM typed GROUP BY i
     UNION ALL
     SELECT i, canonical_type, count(*)::int AS n FROM typed WHERE canonical_type = ANY($7::text[]) GROUP BY i, canonical_type`],
  })),
  {
    from: 'src/core/mentions/referrers.ts:99 hydrate',
    case: { method: 'readReferrerPageDetails', variant: 'default', run: e => e.readReferrerPageDetails([7, 3]) },
    texts: () => [`SELECT id, title, left(${boundedBodyPrefixSql('pages')}, 4000) AS body,
            CASE WHEN effective_date IS NULL THEN 'updated_at' ELSE COALESCE(effective_date_source, 'effective_date') END AS date_source,
            trust_tier, write_origin, ${activationSuppressedSql('pages', 'pages')} AS flagged, frontmatter
       FROM pages WHERE id = ANY($1::int[])`],
  },
  {
    from: 'src/core/ops/backlinks-paged.ts:50 targetSource (at 97bf5544dd)',
    case: { method: 'listReferrerTargetSources', variant: 'default', run: e => e.listReferrerTargetSources('companies/acme-example', ['default', 'other']) },
    texts: ['SELECT source_id FROM pages WHERE slug = $1 AND source_id = ANY($2::text[]) AND deleted_at IS NULL'],
  },
  ...([[false, false], [true, true]] as const).map(([excludePrivate, floored]): Pin => ({
    from: 'src/core/mentions/referrers.ts:143 readReferrerPage count (with referrersCte at mentions/referrers-sql.ts:43; lines at 97bf5544dd)',
    case: {
      method: 'countReferrerRows', variant: excludePrivate ? 'remote+floor' : 'local',
      run: e => e.countReferrerRows({ sources: ['default'], slugs: ['companies/acme-example'] }, {
        referrerSources: ['default'], storedTypes: ['call'], canonicalTypes: ['meeting'], excludePrivate,
        eligibility: floored ? { floor: 'operator_curated' } : undefined, includeQuarantined: false, type: 'meeting',
      }),
    },
    texts: () => [`${pinnedReferrersCte(excludePrivate, floored)} SELECT count(*)::int AS n FROM typed WHERE ($6::text IS NULL OR canonical_type = $6 OR type = $6)`],
  })),
  ...([[false, false, false], [true, true, true]] as const).map(([excludePrivate, floored, cursor]): Pin => ({
    // The cursor date binds as text ($7::text::timestamptz): bound as timestamptz, postgres.js cut it to milliseconds.
    from: `src/core/mentions/referrers.ts:151 readReferrerPage rows (${cursor ? 'after a cursor, its date bound as text since a4198fc65a' : 'first page'}; at 97bf5544dd)`,
    case: {
      method: 'readReferrerRows', variant: cursor ? 'remote+floor+cursor' : 'local',
      run: e => e.readReferrerRows({ sources: ['default'], slugs: ['companies/acme-example'] }, {
        referrerSources: ['default'], storedTypes: ['call'], canonicalTypes: ['meeting'], excludePrivate,
        eligibility: floored ? { floor: 'operator_curated' } : undefined, includeQuarantined: false, type: null,
        cursor: cursor ? ['2026-04-01T00:00:00.000000Z', 'default', 'notes/a-tie'] : null, limit: 3,
      }),
    },
    texts: () => [`${pinnedReferrersCte(excludePrivate, floored)}
     SELECT id, slug, source_id, type, canonical_type, to_char(d AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS d FROM typed
      WHERE ($6::text IS NULL OR canonical_type = $6 OR type = $6)${cursor ? ` AND ((d IS NOT DISTINCT FROM $7::text::timestamptz AND (source_id COLLATE "C", slug COLLATE "C") > ($8::text, $9::text))
                OR ($7::text::timestamptz IS NOT NULL AND (d < $7::text::timestamptz OR d IS NULL)))` : ''}
      ORDER BY d DESC NULLS LAST, source_id COLLATE "C", slug COLLATE "C" LIMIT $${cursor ? 10 : 7}`],
  })),
  ...([[false, false], [true, true]] as const).map(([excludePrivate, floored]): Pin => ({
    from: 'src/core/mentions/referrers.ts:369 readTargetReferences candidates (with referrersCteBatched at mentions/referrers-sql.ts:69; lines at 97bf5544dd)',
    case: {
      method: 'readReferrerRecordCandidates', variant: excludePrivate ? 'remote+floor' : 'local',
      run: e => e.readReferrerRecordCandidates({ sources: ['default', 'default'], slugs: ['companies/acme-example', 'people/alice-example'], indexes: [0, 1] }, {
        referrerSources: ['default'], storedTypes: ['call'], canonicalTypes: ['meeting'], excludePrivate,
        eligibility: floored ? { floor: 'operator_curated' } : undefined, includeQuarantined: false, recordTypes: ['meeting'], perTarget: 5,
      }),
    },
    texts: () => [`WITH tgt AS MATERIALIZED (
      SELECT k.i, t.id FROM pages t JOIN unnest($1::text[], $2::text[], $3::int[]) AS k(s, g, i) ON t.source_id = k.s AND t.slug = k.g
       WHERE t.deleted_at IS NULL${excludePrivate ? ` AND ${privatePagesFilterForCaller('t')}` : ''}
    ),
    refs AS MATERIALIZED (
      SELECT DISTINCT tg.i, l.from_page_id AS id FROM links l JOIN tgt tg ON l.to_page_id = tg.id WHERE true${excludePrivate ? ` AND ${privateLinkOriginFilterForCaller('l')}` : ''}
    ),
    typed AS MATERIALIZED (
      SELECT r.i, f.id, f.slug, f.source_id, f.type,
             COALESCE(f.effective_date, f.updated_at) AS d,
             COALESCE(($6::text[])[array_position($5::text[], f.type)], NULLIF(f.type, ''), 'untyped') AS canonical_type
        FROM refs r JOIN pages f ON f.id = r.id
       WHERE f.deleted_at IS NULL AND f.source_id = ANY($4::text[])
         AND NOT EXISTS (SELECT 1 FROM tgt x WHERE x.i = r.i AND x.id = f.id)${excludePrivate ? ` AND ${privatePagesFilterFastForCaller('f')}` : ''} AND ${pageEligibleSql('f', floored ? { floor: 'operator_curated' } : undefined)} AND ${quarantineFilterFragment('f')}
    )
     SELECT x.i, x.id, x.slug, x.source_id, x.canonical_type, to_char(x.d AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS d
       FROM (SELECT DISTINCT i FROM tgt) q CROSS JOIN LATERAL (
         SELECT * FROM typed t WHERE t.i = q.i AND t.canonical_type = ANY($7::text[])
          ORDER BY t.d DESC NULLS LAST, t.source_id COLLATE "C", t.slug COLLATE "C" LIMIT $8
       ) x
      ORDER BY x.i, x.d DESC NULLS LAST, x.source_id COLLATE "C", x.slug COLLATE "C"`],
  })),
  ...([[false, false], [true, true]] as const).map(([excludePrivate, floored]): Pin => ({
    from: 'src/core/mentions/referrers.ts:131 referrerTypes (with referrersCte at mentions/referrers-sql.ts:43; lines at a4198fc65a)',
    case: {
      method: 'readReferrerTypes', variant: excludePrivate ? 'remote+floor' : 'local',
      run: e => e.readReferrerTypes({ sources: ['default'], slugs: ['companies/acme-example'] }, {
        referrerSources: ['default'], storedTypes: ['call'], canonicalTypes: ['meeting'], excludePrivate,
        eligibility: floored ? { floor: 'operator_curated' } : undefined, includeQuarantined: false,
      }),
    },
    texts: () => [`${pinnedReferrersCte(excludePrivate, floored)} SELECT DISTINCT canonical_type, type FROM typed`],
  })),
  {
    // Not the caller's text: `COLLATE "C"` was added so a Postgres server with a linguistic locale orders the ids
    // in byte order, as PGLite and the Rust engine do (test/engine-parity/source-resolver-reads.test.ts).
    from: 'src/core/ops/backlinks-paged.ts:46 scopeSources and :149 backlinkTypeFilter (at a4198fc65a), plus COLLATE "C"',
    case: { method: 'listSourceIds', variant: 'default', run: e => e.listSourceIds() },
    texts: ['SELECT id FROM sources ORDER BY id COLLATE "C"'],
  },
  ...([
    'src/core/mentions/pass.ts:148 sourcesInScope', 'src/core/access/open-pages.ts:167 openPages', 'src/core/link-single-value.ts:82 previewSingleValue',
    'src/commands/doctor/skill-checks.ts:257 listSourceIds',
  ]).map((from): Pin => ({
    // Not the caller's text: the caller sent 'SELECT id FROM sources ORDER BY id'; COLLATE "C" makes Postgres give byte order.
    from: `${from} (at f579f07cfc), plus COLLATE "C"`,
    case: { method: 'listSourceIds', variant: 'default', run: e => e.listSourceIds() },
    texts: ['SELECT id FROM sources ORDER BY id COLLATE "C"'],
  })),
  {
    // Not the caller's text: the caller sent 'SELECT id FROM sources' with no order; listSourceIds adds ORDER BY id COLLATE "C".
    from: 'src/cli/enforced-member.ts:178 (at f579f07cfc), plus ORDER BY id COLLATE "C"',
    case: { method: 'listSourceIds', variant: 'default', run: e => e.listSourceIds() },
    texts: ['SELECT id FROM sources ORDER BY id COLLATE "C"'],
  },
  ...(['src/core/context/corpus-source.ts:250 soleSourceId', 'src/commands/sweep.ts:230', 'src/commands/doctor/checks/memory-writeback.ts:132 corpusSourceHoldProblem'])
    .map((from): Pin => ({
      from: `${from} (at f579f07cfc)`,
      case: { method: 'readSoleSourceId', variant: 'default', run: e => e.readSoleSourceId() },
      texts: ['SELECT id FROM sources ORDER BY id LIMIT 2'],
    })),
  {
    // Not the caller's text: the caller's id tie-break had no COLLATE "C", so a Postgres server with a linguistic locale
    // picked another first id than PGLite and the Rust engine when no `default` source exists.
    from: 'src/commands/doctor/checks/origin-twins.ts:35 (at f579f07cfc), plus COLLATE "C" on the id tie-break',
    case: { method: 'readFirstSourceId', variant: 'default', run: e => e.readFirstSourceId() },
    texts: [`SELECT id FROM sources ORDER BY (id = 'default') DESC, id COLLATE "C" LIMIT 1`],
  },
  ...(['src/core/persistence/deactivation.ts:298', 'src/core/persistence/pre-activation-release.ts:80']).map((from): Pin => ({
    from: `${from} (at f579f07cfc)`,
    case: { method: 'lockAllSourceRows', variant: 'update', run: e => e.lockAllSourceRows('update') },
    texts: ['SELECT id FROM sources ORDER BY id FOR UPDATE'],
  })),
  {
    from: 'src/core/persistence/skill-activation.ts:56 (at f579f07cfc)',
    case: { method: 'lockAllSourceRows', variant: 'share', run: e => e.lockAllSourceRows('share') },
    texts: ['SELECT id FROM sources ORDER BY id FOR SHARE'],
  },
  {
    from: 'src/core/mentions/referrers.ts:414 hydrateRecords (at 97bf5544dd)',
    case: { method: 'readReferrerRecordPages', variant: 'default', run: e => e.readReferrerRecordPages([7, 3]) },
    texts: [`SELECT id, title, CASE WHEN effective_date IS NULL THEN 'updated_at' ELSE COALESCE(effective_date_source, 'effective_date') END AS date_source
         FROM pages WHERE id = ANY($1::int[])`],
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
    // The caller's statement at eb30f47b89, with `, session_id COLLATE "C"` added to the window's ORDER BY so tied
    // updated_at values rank by session_id bytes on every engine (test/engine-parity/session-state-cap.test.ts).
    from: 'src/core/context/session-state.ts:394 gcSessionContextState (per-client cap), at eb30f47b89',
    case: { method: 'capSessionStatePerClient', variant: 'default', run: e => e.capSessionStatePerClient(1000) },
    texts: [`DELETE FROM session_context_state s
       USING (
         SELECT source_id, client_id, session_id,
                row_number() OVER (
                  PARTITION BY source_id, client_id ORDER BY updated_at DESC, session_id COLLATE "C"
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
    from: 'src/core/access/caller.ts:253 resolveAudienceIdentities (members, then groups; the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'readAudiencePrincipals', variant: 'members-and-groups', run: e => e.readAudiencePrincipals(['alice-example'], ['team-a']) },
    texts: [`SELECT m.id, COALESCE(array_agg(g.group_id ORDER BY g.group_id COLLATE "C") FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
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
    from: 'src/core/access/caller.ts:168 folderAccessForAll (rules, then coverage; at 949a7c98cc; the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'readFolderAccess', variant: 'readers', run: e => e.readFolderAccess(['member:alice-example', 'group:team-a']) },
    texts: ['SELECT source_id, rule_id, readable_by FROM access_rules WHERE readable_by && $1::text[]', `SELECT * FROM (SELECT DISTINCT source_id, prefix FROM access_pending_coverage
      UNION ALL SELECT '!unreadable', '' WHERE gbrain_access_state_unreadable()) c ORDER BY source_id COLLATE "C", prefix COLLATE "C"`],
  },
  {
    from: 'src/core/access/caller.ts:171 folderAccessForAll (no readers reads the coverage only; at 949a7c98cc; the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'readFolderAccess', variant: 'no-readers', run: e => e.readFolderAccess([]) },
    texts: [`SELECT * FROM (SELECT DISTINCT source_id, prefix FROM access_pending_coverage
      UNION ALL SELECT '!unreadable', '' WHERE gbrain_access_state_unreadable()) c ORDER BY source_id COLLATE "C", prefix COLLATE "C"`],
  },
  {
    from: 'src/core/access/policy.ts:92 readAccessStore (at 6e123afe98)',
    case: { method: 'readAccessStoreConfig', variant: 'default', run: e => e.readAccessStoreConfig('src-a') },
    texts: [`SELECT config->>'access_store' AS store FROM sources WHERE id = $1`],
  },
  {
    from: 'src/core/access/policy.ts:99 writeAccessStore (at 6e123afe98)',
    case: { method: 'writeAccessStoreConfig', variant: 'default', run: e => e.writeAccessStoreConfig('src-a', 'database') },
    texts: [`UPDATE sources SET config = jsonb_set(COALESCE(config, '{}'::jsonb), '{access_store}', to_jsonb($2::text)) WHERE id = $1`],
  },
  {
    from: 'src/core/access/policy.ts:104 ensurePolicyState (at 6e123afe98)',
    case: { method: 'ensureAccessPolicyState', variant: 'default', run: e => e.ensureAccessPolicyState('src-a') },
    texts: ['INSERT INTO access_policy_state (source_id) VALUES ($1) ON CONFLICT (source_id) DO NOTHING'],
  },
  {
    from: 'src/core/access/policy.ts:112 and :113 lockSource (at 6e123afe98)',
    case: { method: 'lockAccessPolicy', variant: 'default', run: e => e.lockAccessPolicy('src-a') },
    texts: ['SELECT 1 FROM sources WHERE id = $1 FOR NO KEY UPDATE', 'SELECT 1 FROM access_policy_state WHERE source_id = $1 FOR UPDATE'],
  },
  {
    from: 'src/core/access/policy.ts:117 appliedRules (at 6e123afe98; the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'listAccessRules', variant: 'default', run: e => e.listAccessRules('src-a') },
    texts: ['SELECT rule_id, prefix, readable_by, covers_derived FROM access_rules WHERE source_id = $1 ORDER BY rule_id COLLATE "C"'],
  },
  {
    from: 'src/core/access/policy.ts:123 listRevisions (at 6e123afe98)',
    case: { method: 'readAccessPolicyRevisions', variant: 'recent', run: e => e.readAccessPolicyRevisions({ by: 'recent', sourceId: 'src-a', limit: 50 }) },
    texts: ['SELECT * FROM access_policy_revisions WHERE source_id = $1 ORDER BY revision DESC LIMIT $2'],
  },
  {
    from: 'src/core/access/policy.ts:130 getRevision (latest) (at 6e123afe98)',
    case: { method: 'readAccessPolicyRevisions', variant: 'latest', run: e => e.readAccessPolicyRevisions({ by: 'latest', sourceId: 'src-a' }) },
    texts: ['SELECT * FROM access_policy_revisions WHERE source_id = $1 ORDER BY revision DESC LIMIT 1'],
  },
  {
    from: 'src/core/access/policy.ts:131 getRevision (one revision) (at 6e123afe98)',
    case: { method: 'readAccessPolicyRevisions', variant: 'revision', run: e => e.readAccessPolicyRevisions({ by: 'revision', sourceId: 'src-a', revision: 2 }) },
    texts: ['SELECT * FROM access_policy_revisions WHERE source_id = $1 AND revision = $2'],
  },
  {
    from: 'src/core/access/policy.ts:246 proposeRevision (idempotency read) (at 6e123afe98)',
    case: { method: 'readAccessPolicyRevisions', variant: 'operation', run: e => e.readAccessPolicyRevisions({ by: 'operation', operationId: 'op-1' }) },
    texts: ['SELECT * FROM access_policy_revisions WHERE operation_id = $1'],
  },
  {
    from: 'src/core/access/policy.ts:136 coverageRows (at 6e123afe98; the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'listAccessCoverage', variant: 'default', run: e => e.listAccessCoverage('src-a') },
    texts: ['SELECT prefix, reason, revision, detail FROM access_pending_coverage WHERE source_id = $1 ORDER BY reason COLLATE "C", prefix COLLATE "C"'],
  },
  {
    from: 'src/core/access/policy.ts:151 requireReadableAccessState (at 6e123afe98)',
    case: { method: 'readAccessStateUnreadable', variant: 'default', run: e => e.readAccessStateUnreadable() },
    texts: ['SELECT gbrain_access_state_unreadable() AS unreadable'],
  },
  {
    from: 'src/core/access/policy.ts:168, :174 and :179 installRulebook (at 6e123afe98)',
    case: { method: 'applyAccessRuleChanges', variant: 'default', run: e => e.applyAccessRuleChanges('src-a', { remove: ['old'], insert: [{ rule_id: 'team', prefix: 'team/', readable_by: ['member:alice-example'], covers_derived: true }], pending: ['team/'], revision: 2, actor: 'cli' }) },
    texts: ['DELETE FROM access_rules WHERE source_id = $1 AND rule_id = $2', 'INSERT INTO access_rules (source_id, rule_id, prefix, readable_by, revision, created_by, covers_derived) VALUES ($1, $2, $3, $4::text[], $5, $6, $7)', `INSERT INTO access_pending_coverage (source_id, prefix, reason, revision) VALUES ($1, $2, 'pending', $3)
      ON CONFLICT (source_id, prefix, reason) DO UPDATE SET revision = EXCLUDED.revision`],
  },
  {
    from: 'src/core/access/policy.ts:198 restampSource (batched window) (at 6e123afe98)',
    case: { method: 'restampAccessWindow', variant: 'default', run: e => e.restampAccessWindow('src-a', 0, 2000) },
    texts: [`WITH w AS (SELECT id FROM pages WHERE source_id = $1 AND id > $2 ORDER BY id LIMIT $3),
        u AS (UPDATE pages p SET folder_rule_ids = gbrain_access_folder_rules(p.source_id, p.slug) FROM w
              WHERE p.id = w.id AND p.folder_rule_ids IS DISTINCT FROM gbrain_access_folder_rules(p.source_id, p.slug) RETURNING p.id)
      SELECT (SELECT max(id) FROM w) AS last, (SELECT count(*) FROM w)::int AS scanned, (SELECT count(*) FROM u)::int AS changed`],
  },
  {
    from: 'src/core/access/policy.ts:212, :216 and :217 restampSource (final pass) (at 6e123afe98)',
    case: { method: 'finishAccessRestamp', variant: 'default', run: e => e.finishAccessRestamp('src-a') },
    texts: [`UPDATE pages SET folder_rule_ids = gbrain_access_folder_rules(source_id, slug)
        WHERE source_id = $1 AND folder_rule_ids IS DISTINCT FROM gbrain_access_folder_rules(source_id, slug) RETURNING id`, `DELETE FROM access_pending_coverage WHERE source_id = $1 AND reason = 'pending'`, 'UPDATE access_policy_revisions SET applied_at = now() WHERE source_id = $1 AND applied_at IS NULL'],
  },
  {
    from: 'src/core/access/policy.ts:263 proposeRevision (revision insert) (at 6e123afe98)',
    case: { method: 'insertAccessPolicyRevision', variant: 'default', run: e => e.insertAccessPolicyRevision({ source_id: 'src-a', revision: 2, rules: [], digest: 'd', change_kind: 'narrowing', origin: 'cli', operation_id: null, proposed_by: 'cli', approved_by: 'auto:narrowing', approved: true }) },
    texts: [`INSERT INTO access_policy_revisions (source_id, revision, rules, digest, change_kind, origin, operation_id, proposed_by, approved_by, approved_at)
      VALUES ($1, $2, $3::text::jsonb, $4, $5, $6, $7, $8, $9, CASE WHEN $10::boolean THEN now() END)`],
  },
  {
    from: 'src/core/access/policy.ts:268 proposeRevision (applied mark) (at 6e123afe98)',
    case: { method: 'markAccessRevisionsApplied', variant: 'all', run: e => e.markAccessRevisionsApplied('src-a') },
    texts: ['UPDATE access_policy_revisions SET applied_at = now() WHERE source_id = $1 AND applied_at IS NULL'],
  },
  {
    from: 'src/core/access/policy.ts:388 applyApproved (applied mark) (at 6e123afe98)',
    case: { method: 'markAccessRevisionsApplied', variant: 'up-to', run: e => e.markAccessRevisionsApplied('src-a', 3) },
    texts: ['UPDATE access_policy_revisions SET applied_at = now() WHERE source_id = $1 AND applied_at IS NULL AND revision <= $2'],
  },
  {
    from: 'src/core/access/policy.ts:387 applyApproved (approval) (at 6e123afe98)',
    case: { method: 'approveAccessPolicyRevision', variant: 'default', run: e => e.approveAccessPolicyRevision('src-a', 3, 'cli') },
    texts: ['UPDATE access_policy_revisions SET approved_by = $3, approved_at = now() WHERE source_id = $1 AND revision = $2'],
  },
  {
    from: 'src/core/access/policy.ts:296 resumePolicy (at 6e123afe98)',
    case: { method: 'hasAccessPolicyState', variant: 'default', run: e => e.hasAccessPolicyState('src-a') },
    texts: ['SELECT count(*)::int AS n FROM access_policy_state WHERE source_id = $1'],
  },
  {
    from: 'src/core/access/policy.ts:348 previewApply (derived release) (at 6e123afe98; the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'listAccessPrefixSlugs', variant: 'one-prefix', run: e => e.listAccessPrefixSlugs('src-a', 'team/') },
    texts: ['SELECT slug FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND starts_with(slug, $2) ORDER BY slug COLLATE "C"'],
  },
  {
    from: 'src/core/access/policy.ts:354 previewApply (widened prefixes) (at 6e123afe98; the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'listAccessPrefixSlugs', variant: 'prefixes', run: e => e.listAccessPrefixSlugs('src-a', ['team/', 'old/']) },
    texts: ['SELECT slug FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM unnest($2::text[]) AS pfx WHERE starts_with(slug, pfx)) ORDER BY slug COLLATE "C"'],
  },
  {
    from: 'src/core/access/policy.ts:420 policyStatus (at 6e123afe98)',
    case: { method: 'readAccessPolicyMarks', variant: 'default', run: e => e.readAccessPolicyMarks('src-a') },
    texts: ['SELECT max(revision) FILTER (WHERE applied_at IS NOT NULL) AS applied, max(revision) FILTER (WHERE approved_at IS NOT NULL) AS approved FROM access_policy_revisions WHERE source_id = $1'],
  },
  {
    from: 'src/core/access/policy.ts:420 and :431 policyStatus (with an operation) (at 6e123afe98)',
    case: { method: 'readAccessPolicyMarks', variant: 'operation', run: e => e.readAccessPolicyMarks('src-a', 'op-1') },
    texts: ['SELECT max(revision) FILTER (WHERE applied_at IS NOT NULL) AS applied, max(revision) FILTER (WHERE approved_at IS NOT NULL) AS approved FROM access_policy_revisions WHERE source_id = $1', 'SELECT revision, applied_at, approved_at FROM access_policy_revisions WHERE source_id = $1 AND operation_id = $2'],
  },
  {
    from: 'src/core/access/policy.ts:450 and :452 markPolicyInvalid (at 6e123afe98)',
    case: { method: 'replaceAccessInvalidCoverage', variant: 'prefixes', run: e => e.replaceAccessInvalidCoverage('src-a', ['bad/'], { line: 3 }) },
    texts: [`DELETE FROM access_pending_coverage WHERE source_id = $1 AND reason = 'invalid'`, `INSERT INTO access_pending_coverage (source_id, prefix, reason, detail) VALUES ($1, $2, 'invalid', $3::text::jsonb)`],
  },
  {
    from: 'src/core/access/policy.ts:459 clearPolicyInvalid (at 6e123afe98)',
    case: { method: 'replaceAccessInvalidCoverage', variant: 'clear', run: e => e.replaceAccessInvalidCoverage('src-a', [], null) },
    texts: [`DELETE FROM access_pending_coverage WHERE source_id = $1 AND reason = 'invalid'`],
  },
  {
    from: 'src/core/access/members.ts:124 getMember (one member by id; the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'readAccessMembers', variant: 'by-id', run: e => e.readAccessMembers({ id: 'alice-example' }) },
    texts: [`SELECT m.id, m.display_name, m.email, m.kind, m.labelled_only, m.disabled_at, m.tombstoned_at, m.created_at,
  COALESCE(array_agg(g.group_id ORDER BY g.group_id COLLATE "C") FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
  FROM access_members m LEFT JOIN access_group_members g ON g.member_id = m.id WHERE m.id = $1 GROUP BY m.id`],
  },
  {
    from: 'src/core/access/members.ts:160 memberByEmail and :143 assertEmailFree (members declaring one email; the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'readAccessMembers', variant: 'by-email', run: e => e.readAccessMembers({ email: 'alice@example.com' }) },
    texts: [`SELECT m.id, m.display_name, m.email, m.kind, m.labelled_only, m.disabled_at, m.tombstoned_at, m.created_at,
  COALESCE(array_agg(g.group_id ORDER BY g.group_id COLLATE "C") FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
  FROM access_members m LEFT JOIN access_group_members g ON g.member_id = m.id WHERE m.email = $1 GROUP BY m.id ORDER BY m.id COLLATE "C"`],
  },
  {
    from: 'src/core/access/members.ts:129 listMembers (removed members filtered out; the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'readAccessMembers', variant: 'live', run: e => e.readAccessMembers({ includeRemoved: false }) },
    texts: [`SELECT m.id, m.display_name, m.email, m.kind, m.labelled_only, m.disabled_at, m.tombstoned_at, m.created_at,
  COALESCE(array_agg(g.group_id ORDER BY g.group_id COLLATE "C") FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
  FROM access_members m LEFT JOIN access_group_members g ON g.member_id = m.id WHERE m.tombstoned_at IS NULL GROUP BY m.id ORDER BY m.id COLLATE "C"`],
  },
  {
    from: 'src/core/access/members.ts:129 listMembers (--all; the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'readAccessMembers', variant: 'all', run: e => e.readAccessMembers({ includeRemoved: true }) },
    texts: [`SELECT m.id, m.display_name, m.email, m.kind, m.labelled_only, m.disabled_at, m.tombstoned_at, m.created_at,
  COALESCE(array_agg(g.group_id ORDER BY g.group_id COLLATE "C") FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
  FROM access_members m LEFT JOIN access_group_members g ON g.member_id = m.id GROUP BY m.id ORDER BY m.id COLLATE "C"`],
  },
  {
    from: 'src/commands/access-serves.ts:135 unboundCredentials (tokens) (at 6e123afe98; the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'listUnboundTokenNames', variant: 'default', run: e => e.listUnboundTokenNames() },
    texts: ['SELECT DISTINCT name COLLATE "C" AS name FROM access_tokens WHERE revoked_at IS NULL AND member_id IS NULL ORDER BY name'],
  },
  {
    from: 'src/commands/access-serves.ts:136 unboundCredentials (clients) (at 6e123afe98; the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'listUnboundClientIds', variant: 'default', run: e => e.listUnboundClientIds() },
    texts: ['SELECT client_id FROM oauth_clients WHERE deleted_at IS NULL AND member_id IS NULL ORDER BY client_id COLLATE "C"'],
  },
  {
    from: 'src/commands/access-serves.ts:186 member key plan (live token) (at 6e123afe98)',
    case: { method: 'readLiveAccessToken', variant: 'default', run: e => e.readLiveAccessToken('member-alice-example') },
    texts: ['SELECT member_id, token_hash, source_grant, source_id, federated_read, permissions FROM access_tokens WHERE name = $1 AND revoked_at IS NULL'],
  },
  {
    from: 'src/commands/access-serves.ts:197 member key plan (active sources) (at 6e123afe98); also grants/legacy-token.ts:193 assertActiveSources (at 5a32485552)',
    case: { method: 'listUnarchivedSourceIds', variant: 'default', run: e => e.listUnarchivedSourceIds(['src-a', 'src-b']) },
    texts: ['SELECT id FROM sources WHERE id = ANY($1::text[]) AND archived IS NOT TRUE'],
  },
  {
    from: 'src/commands/access-serves.ts:241 recordSetupReads (at 6e123afe98)',
    case: { method: 'recordTokenSetupReads', variant: 'default', run: e => e.recordTokenSetupReads('member-alice-example', ['src-a']) },
    texts: ["UPDATE access_tokens SET permissions = COALESCE(permissions, '{}'::jsonb) || jsonb_build_object('setup_reads', $2::text[]) WHERE name = $1 AND revoked_at IS NULL AND (permissions IS NULL OR jsonb_typeof(permissions) = 'object')"],
  },
  {
    from: 'src/commands/access-serves.ts:251 keysStillReading (at 6e123afe98; the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'listKeysReadingSource', variant: 'default', run: e => e.listKeysReadingSource('src-a') },
    texts: ["SELECT name, member_id, federated_read FROM access_tokens WHERE revoked_at IS NULL AND member_id IS NOT NULL AND source_grant = 'federated' AND source_id <> $1 AND $1 = ANY(federated_read) ORDER BY name COLLATE \"C\""],
  },
  {
    from: 'src/commands/access-serves.ts:265 companyCounts (at 6e123afe98)',
    case: { method: 'countCompanyPages', variant: 'default', run: e => e.countCompanyPages('company') },
    texts: ["SELECT count(*)::int AS pages, count(*) FILTER (WHERE slug LIKE 'company/calls/%')::int AS calls FROM pages WHERE source_id = $1 AND deleted_at IS NULL"],
  },
  {
    from: 'src/commands/access-serves.ts:339 serves key mint (revoke on a failed key file) (at 6e123afe98)',
    case: { method: 'revokeAccessTokenById', variant: 'default', run: e => e.revokeAccessTokenById('00000000-0000-0000-0000-000000000001') },
    texts: ['UPDATE access_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL'],
  },
  {
    from: 'src/core/access/policy-migrate.ts:41 unfinished (at 6e123afe98)',
    case: { method: 'readUnfinishedAccessMigration', variant: 'default', run: e => e.readUnfinishedAccessMigration('src-a') },
    texts: ["SELECT id, phase, direction, receipts FROM access_policy_migrations WHERE source_id = $1 AND phase <> 'switched' ORDER BY created_at DESC LIMIT 1"],
  },
  {
    from: 'src/core/access/policy-migrate.ts:80 migratePolicyStore (start) (at 6e123afe98)',
    case: { method: 'insertAccessMigration', variant: 'default', run: e => e.insertAccessMigration('mig_1', 'src-a', 'to_git') },
    texts: ["INSERT INTO access_policy_migrations (id, source_id, direction, phase) VALUES ($1, $2, $3, 'started')"],
  },
  {
    from: 'src/core/access/policy-migrate.ts:85 migratePolicyStore (record a phase) (at 6e123afe98)',
    case: { method: 'recordAccessMigrationPhase', variant: 'default', run: e => e.recordAccessMigrationPhase('mig_1', 'exported', { approved: 'abc' }) },
    texts: ['UPDATE access_policy_migrations SET phase = $2, receipts = $3::text::jsonb, updated_at = now() WHERE id = $1'],
  },
  {
    from: 'src/core/access/policy-migrate.ts:104 migratePolicyStore (switch) (at 6e123afe98)',
    case: { method: 'switchAccessMigration', variant: 'default', run: e => e.switchAccessMigration('mig_1', { approved: 'abc' }) },
    texts: ["UPDATE access_policy_migrations SET phase = 'switched', receipts = $2::text::jsonb, updated_at = now() WHERE id = $1"],
  },
  {
    from: 'src/core/access/policy-transfer.ts:34 exportPolicyFiles (at 6e123afe98; the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'listAccessPolicySources', variant: 'default', run: e => e.listAccessPolicySources() },
    texts: ['SELECT source_id FROM access_policy_state ORDER BY source_id COLLATE "C"'],
  },
  {
    from: 'src/core/access/serves.ts:38 unlabeledPeopleFolders (at 6e123afe98; the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'countPeopleFolderPages', variant: 'default', run: e => e.countPeopleFolderPages() },
    texts: [`SELECT source_id, split_part(slug, '/', 2) AS folder, count(*)::int AS pages FROM pages
      WHERE deleted_at IS NULL AND slug LIKE 'people/%/%' GROUP BY 1, 2 ORDER BY source_id COLLATE "C", split_part(slug, '/', 2) COLLATE "C"`],
  },
  {
    from: 'src/core/sweep.ts:216 runMaintenanceSweep pass 1 (the facts-fence pages, at c231d6c992)',
    case: { method: 'listFactsFencePages', variant: 'default', run: e => e.listFactsFencePages({ sourceId: 'default', since: '2026-01-01T00:00:00.000Z', scanCap: 500, limit: 8 }) },
    texts: [`SELECT slug FROM (
             SELECT id, slug, compiled_truth, body_storage, updated_at FROM pages
              WHERE source_id = $1
                AND deleted_at IS NULL
                AND updated_at >= $2::timestamptz
              ORDER BY updated_at DESC
              LIMIT $4
           ) AS recent
            WHERE compiled_truth LIKE $3
               OR (body_storage = 'segmented' AND EXISTS (SELECT 1 FROM page_body_manifest m
                     WHERE m.page_id = recent.id AND m.gen_to IS NULL AND m.staging_id IS NULL AND m.facts_slots <> '[]'::jsonb))
            ORDER BY updated_at DESC
            LIMIT $5`],
  },
  {
    from: 'src/core/sweep.ts:381 runLinksTimelinePass (the link-stale recent pages, at c231d6c992)',
    case: { method: 'listSweepStalePages', variant: 'default', run: e => e.listSweepStalePages({ sourceId: 'default', since: '2026-01-01T00:00:00.000Z', limit: 8, exclude: ['a'] }) },
    texts: [`SELECT slug, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS read_at,
            to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_iso,
            body_storage, body_bytes
       FROM pages
      WHERE source_id = $1
        AND deleted_at IS NULL
        AND updated_at >= $2::timestamptz
        AND (links_extracted_at IS NULL OR updated_at > links_extracted_at)
        AND NOT (slug = ANY($4::text[]))
      ORDER BY updated_at DESC
      LIMIT $3`],
  },
  {
    from: 'src/core/sweep.ts:655 liveDeferredPages (the deferred pages still stale, at c231d6c992)',
    case: { method: 'listSweepDeferredPages', variant: 'default', run: e => e.listSweepDeferredPages({ sourceId: 'default', since: '2026-01-01T00:00:00.000Z', slugs: ['a'] }) },
    texts: [`SELECT slug, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_iso
       FROM pages
      WHERE source_id = $1
        AND deleted_at IS NULL
        AND updated_at >= $2::timestamptz
        AND (links_extracted_at IS NULL OR updated_at > links_extracted_at)
        AND slug = ANY($3::text[])`],
  },
  {
    // An equivalent statement: the caller sent `slug IN ($1, ...)`, 200 slugs to a statement; the member binds every slug
    // as one array (`slug = ANY($1::text[])`), so its text does not change with the number of slugs. A slug named twice
    // reads its pages once, where two chunks could read them twice.
    from: 'src/core/link-reconciliation.ts:442 lookupRefsForSlugs (the links and timeline pass\'s page refs, at 932324b281)',
    case: { method: 'listPageRefsForSlugs', variant: 'default', run: e => e.listPageRefsForSlugs(['a', 'b']) },
    texts: [`SELECT slug, source_id, type, knowledge_revision FROM pages
        WHERE deleted_at IS NULL AND slug = ANY($1::text[])`],
  },
  {
    from: 'src/core/access/open-pages.ts:187 openPages (the open-page count, rendered in the pinned access context)',
    case: { method: 'countOpenPages', variant: 'default', run: e => e.countOpenPages(['default'], [{ source: 'default', prefix: 'x/' }]) },
    texts: () => [`SELECT p.source_id AS source, CASE WHEN strpos(p.slug, '/') > 0 THEN split_part(p.slug, '/', 1) ELSE '(root)' END AS folder,
              p.type AS type, (${privacyPartSql('p')}) AS visible, count(*)::int AS pages
         FROM pages p
        WHERE p.deleted_at IS NULL AND ${accessAllowedSql('p', [], [])} AND p.source_id = ANY($1::text[]) AND NOT (p.source_id = $2 AND starts_with(p.slug, $3))
        GROUP BY 1, 2, 3, 4`],
  },
  {
    from: 'src/core/access/members.ts:199 legacyTokenByName (active tokens with one name)',
    case: { method: 'readAccessCredentials', variant: 'token-name', run: e => e.readAccessCredentials({ tokenName: 'laptop' }) },
    texts: ['SELECT id::text AS id, name FROM access_tokens WHERE name = $1 AND revoked_at IS NULL ORDER BY created_at, id'],
  },
  {
    from: 'src/core/access/members.ts:305/307 boundCredentials (tokens, then clients; the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'readAccessCredentials', variant: 'member', run: e => e.readAccessCredentials({ memberId: 'alice-example' }) },
    texts: ['SELECT id::text AS id, name FROM access_tokens WHERE member_id = $1 AND revoked_at IS NULL ORDER BY name COLLATE "C", id',
      "SELECT client_id AS id, client_name AS name FROM oauth_clients WHERE member_id = $1 AND (to_jsonb(oauth_clients)->>'deleted_at') IS NULL ORDER BY client_id COLLATE \"C\""],
  },
  {
    from: 'src/core/access/members.ts:295 audienceMemberIds (the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'listAudienceAccessMembers', variant: 'default', run: e => e.listAudienceAccessMembers() },
    texts: [`SELECT id FROM access_members WHERE kind = 'audience' AND disabled_at IS NULL AND tombstoned_at IS NULL ORDER BY id COLLATE "C"`],
  },
  {
    from: 'src/core/access/members.ts:345 listGroups (every group; the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'readAccessGroups', variant: 'all', run: e => e.readAccessGroups(null) },
    texts: [`SELECT g.id, COALESCE(array_agg(gm.member_id ORDER BY gm.member_id COLLATE "C") FILTER (WHERE gm.member_id IS NOT NULL), '{}') AS members
     FROM access_groups g LEFT JOIN access_group_members gm ON gm.group_id = g.id
      GROUP BY g.id ORDER BY g.id COLLATE "C"`],
  },
  {
    from: 'src/core/access/members.ts:345 listGroups (one group by id; the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'readAccessGroups', variant: 'by-id', run: e => e.readAccessGroups('team-a') },
    texts: [`SELECT g.id, COALESCE(array_agg(gm.member_id ORDER BY gm.member_id COLLATE "C") FILTER (WHERE gm.member_id IS NOT NULL), '{}') AS members
     FROM access_groups g LEFT JOIN access_group_members gm ON gm.group_id = g.id
     WHERE g.id = $1 GROUP BY g.id ORDER BY g.id COLLATE "C"`],
  },
  {
    from: 'src/core/access/members.ts:303 pagesNaming (the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'listPagesNamingReader', variant: 'default', run: e => e.listPagesNamingReader('member:alice-example') },
    texts: [`SELECT slug, source_id FROM pages WHERE frontmatter ? 'readable_by' AND gbrain_access_readers(frontmatter) @> ARRAY[$1]::text[]
     ORDER BY source_id COLLATE "C", slug COLLATE "C" LIMIT 51`],
  },
  {
    from: 'src/commands/access-read-by-nobody.ts:45 pagesReadByNobodyNaming (at 30750dcd6c; the columns read slug first like the default read, and the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'listPagesNamingReader', variant: 'live', run: e => e.listPagesNamingReader('member:alice-example', { live: true }) },
    texts: [`SELECT slug, source_id FROM pages WHERE deleted_at IS NULL AND frontmatter ? 'readable_by' AND gbrain_access_readers(frontmatter) @> ARRAY[$1]::text[]
     ORDER BY source_id COLLATE "C", slug COLLATE "C" LIMIT 201`],
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
    from: 'src/core/grants/legacy-token.ts:240 rescopeInTransaction by id (at 30750dcd6c)',
    case: { method: 'lockActiveAccessTokens', variant: 'by-id', run: e => e.lockActiveAccessTokens({ id: '00000000-0000-4000-8000-0000000000b1' }) },
    texts: ['SELECT * FROM access_tokens WHERE id = $1::uuid AND revoked_at IS NULL FOR UPDATE'],
  },
  {
    from: 'src/core/grants/legacy-token.ts:241 rescopeInTransaction by name (at 30750dcd6c)',
    case: { method: 'lockActiveAccessTokens', variant: 'by-name', run: e => e.lockActiveAccessTokens({ name: 'laptop' }) },
    texts: ['SELECT * FROM access_tokens WHERE name = $1 AND revoked_at IS NULL FOR UPDATE'],
  },
  {
    from: 'src/core/grants/legacy-token.ts:211 writeTokenGrant (at 5a32485552)',
    case: { method: 'writeAccessTokenGrant', variant: 'default', run: e => e.writeAccessTokenGrant('00000000-0000-4000-8000-0000000000b1',
      { columns: { source_grant: 'federated', source_id: 'default', federated_read: ['default', 'wiki'], allowed_operations: null, takes_holders: ['world'] },
        scopes: ['read'], permissions: { source_id: ['default', 'wiki'] } }) },
    texts: [`UPDATE access_tokens SET source_grant = $2, source_id = $3, federated_read = $4::text[], allowed_operations = $5::text[],
       takes_holders = $6::text[], scopes = COALESCE($7::text[], scopes), grant_revision = grant_revision + 1, permissions = $8::jsonb
     WHERE id = $1::uuid RETURNING grant_revision`],
  },
  {
    from: 'src/core/grants/legacy-token.ts:317 rescopeInTransaction --private-pages (at 5a32485552)',
    case: { method: 'writeAccessTokenPrivateGrant', variant: 'private_pages', run: e => e.writeAccessTokenPrivateGrant('00000000-0000-4000-8000-0000000000b1', 'private_pages', 'granted_sources') },
    texts: ['UPDATE access_tokens SET private_pages = $2 WHERE id = $1::uuid'],
  },
  {
    from: 'src/core/grants/legacy-token.ts:321 rescopeInTransaction --private-facts (at 5a32485552)',
    case: { method: 'writeAccessTokenPrivateGrant', variant: 'private_facts', run: e => e.writeAccessTokenPrivateGrant('00000000-0000-4000-8000-0000000000b1', 'private_facts', 'none') },
    texts: ['UPDATE access_tokens SET private_facts = $2 WHERE id = $1::uuid'],
  },
  {
    from: 'src/core/grants/legacy-token.ts:347 migrateLegacyTokens (at 5a32485552)',
    case: { method: 'lockLegacyAccessTokens', variant: 'default', run: e => e.lockLegacyAccessTokens() },
    texts: ['SELECT * FROM access_tokens WHERE revoked_at IS NULL AND source_grant IS NULL ORDER BY created_at, id FOR UPDATE'],
  },
  {
    from: 'src/core/persistence/identity.ts:404 revokeLocalWriter (at 6631e1bb57)',
    case: { method: 'revokeLocalWriterRow', variant: 'default', run: e => e.revokeLocalWriterRow('00000000-0000-4000-8000-0000000000c1') },
    texts: ['UPDATE persistence_local_writers SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1::uuid RETURNING id'],
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
  {
    from: 'src/core/mentions/coverage.ts:43 readMentionCoverage',
    case: { method: 'readMentionIndexStatus', variant: 'default', run: e => e.readMentionIndexStatus(['default', 'other']) },
    texts: [`SELECT source_id, state, pending, counted_at, last_pass_at, policy_fingerprint FROM mention_index_status WHERE source_id = ANY($1::text[])`],
  },
  {
    from: 'src/core/mentions/coverage.ts:54 readMentionCoverage',
    case: { method: 'countLivePagesInSource', variant: 'default', run: e => e.countLivePagesInSource('default') },
    texts: ['SELECT count(*)::int AS n FROM pages WHERE source_id = $1 AND deleted_at IS NULL'],
  },
  {
    from: 'src/core/mentions/coverage.ts:71 readMentionCoverage',
    case: { method: 'countMentionDueSince', variant: 'default', run: e => e.countMentionDueSince('default', '-infinity', 1) },
    texts: [`SELECT count(*)::int AS n FROM pages p LEFT JOIN page_mention_state s ON s.page_id = p.id
        WHERE p.source_id = $1 AND p.updated_at >= $2::text::timestamptz AND p.deleted_at IS NULL
          AND (s.page_id IS NULL OR s.mention_revision IS DISTINCT FROM p.knowledge_revision OR s.mention_version IS DISTINCT FROM $3)`],
  },
  {
    from: 'src/core/mentions/coverage.ts:63 readMentionCoverage (the recount write)',
    case: { method: 'recountMentionIndexStatus', variant: 'default', run: e => e.recountMentionIndexStatus('default', { pending: 2, fingerprint: 'h;v', expectedFingerprint: null }) },
    texts: [`UPDATE mention_index_status SET pending = $2, counted_at = now(), policy_fingerprint = $3, updated_at = now(),
                state = CASE WHEN state = 'complete' AND $2::int > 0 THEN 'pending' ELSE state END
          WHERE source_id = $1 AND policy_fingerprint IS NOT DISTINCT FROM $4`],
  },
  {
    from: 'src/core/entities/resolve.ts:162 tryOrgDirVariant',
    case: { method: 'readLiveSlugs', variant: 'default', run: e => e.readLiveSlugs('default', ['orgs/acme', 'organizations/acme']) },
    texts: ['SELECT slug FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND slug = ANY($2::text[])'],
  },
  {
    from: 'src/core/entities/resolve.ts:360 findExactBasenameCandidates',
    case: { method: 'readLiveSlugs', variant: 'limit_2', run: e => e.readLiveSlugs('default', ['people/alice-example', 'companies/alice-example'], { limit: 2 }) },
    texts: [`SELECT slug FROM pages
        WHERE source_id = $1 AND deleted_at IS NULL AND slug = ANY($2::text[])
        LIMIT 2`],
  },
  ...([
    ['none', () => ''],
    ['caller', () => `AND ${privatePagesFilterForCaller('p')}`],
    ['floor', () => `AND ${remoteReadFloorSql('p')}`],
  ] as const).map(([privacy, predicate]): Pin => ({
    from: `src/core/entities/resolve.ts:478 resolveStrictEntityReference live (privacy ${privacy})`,
    case: { method: 'readLivePageTypes', variant: privacy, run: e => e.readLivePageTypes('default', ['people/alice-example'], privacy) },
    texts: () => [`SELECT p.slug, p.type FROM pages p
      WHERE p.source_id = $1 AND p.deleted_at IS NULL AND p.slug = ANY($2::text[]) ${predicate()}`],
  })),
  ...([
    ['none', () => ''],
    ['caller', () => `AND ${privatePagesFilterForCaller('p')}`],
    ['floor', () => `AND ${remoteReadFloorSql('p')}`],
  ] as const).flatMap(([privacy, predicate]): Pin[] => [
    {
      from: `src/core/entities/resolve.ts:519 resolveStrictEntityReference same name (privacy ${privacy}; the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)`,
      case: { method: 'readTrigramCandidates', variant: `same_name_${privacy}`, run: e => e.readTrigramCandidates('default', { arm: 'same_name', titleLc: 'alice example', slugFragment: 'alice-example', privacy }) },
      texts: () => [`SELECT p.slug, p.title, p.type FROM pages p
          WHERE p.source_id = $1 AND p.deleted_at IS NULL ${predicate()} AND NOT ${retiredPageSql('p')}
            AND (lower(p.title) % $2 OR p.slug ILIKE '%' || $3 || '%')
          ORDER BY GREATEST(similarity(lower(p.title), $2), similarity(p.slug, $3)) DESC, p.slug COLLATE "C" ASC
          LIMIT 5`],
    },
    {
      from: `src/core/entities/resolve.ts:567 entityReferenceCandidates near (privacy ${privacy}; the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)`,
      case: { method: 'readTrigramCandidates', variant: `near_${privacy}`, run: e => e.readTrigramCandidates('default', { arm: 'near', titleLc: 'alice example', slugFragment: 'alice-example', privacy }) },
      texts: () => [`SELECT p.slug, p.title, p.type FROM pages p
      WHERE p.source_id = $1 AND p.deleted_at IS NULL AND NOT ${retiredPageSql('p')} ${predicate()}
        AND (lower(p.title) % $2 OR p.slug ILIKE '%' || $3 || '%')
      ORDER BY GREATEST(similarity(lower(p.title), $2), similarity(p.slug, $3)) DESC, p.slug COLLATE "C" ASC
      LIMIT 20`],
    },
  ]),
  {
    from: 'src/core/entities/resolve.ts:857 tryFuzzyMatch (the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'readTrigramCandidates', variant: 'fuzzy', run: e => e.readTrigramCandidates('default', { arm: 'fuzzy', titleLc: 'alice example', slugFragment: 'alice-example' }) },
    texts: () => [`SELECT slug, title, type,
         GREATEST(
           similarity(lower(title), $2),
           similarity(slug, $3)
         ) AS score
       FROM pages
       WHERE source_id = $1
         AND deleted_at IS NULL
         AND NOT ${retiredPageSql('pages')}
         AND (
           lower(title) % $2
           OR slug ILIKE '%' || $3 || '%'
         )
       ORDER BY score DESC, slug COLLATE "C" ASC
       LIMIT 5`],
  },
  {
    from: 'src/core/entities/resolve.ts:686 findPrefixCandidates (the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'readPrefixCandidates', variant: 'patterns', run: e => e.readPrefixCandidates('default', { patterns: ['people/alice', 'people/alice-%'] }) },
    texts: () => [`SELECT p.slug,
              ((SELECT COUNT(*)::int FROM links l WHERE l.to_page_id = p.id AND ${rankingLinkSql('l')})
               + (SELECT COUNT(*)::int FROM links l WHERE l.from_page_id = p.id AND ${rankingLinkSql('l')})
               + (SELECT COUNT(*)::int FROM content_chunks WHERE page_id = p.id))
                AS connection_count
       FROM pages p
       WHERE p.source_id = $1
         AND p.deleted_at IS NULL
         AND NOT ${retiredPageSql('p')}
         AND p.slug LIKE ANY($2::text[])
       ORDER BY connection_count DESC, p.slug COLLATE "C" ASC
       LIMIT 10`],
  },
  {
    from: 'src/core/entities/resolve.ts:769 tryPrefixExpansion (the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'readPrefixCandidates', variant: 'pattern', run: e => e.readPrefixCandidates('default', { pattern: 'people/alice-%' }) },
    texts: () => [`SELECT p.slug,
                ((SELECT COUNT(*)::int FROM links l WHERE l.to_page_id = p.id AND ${rankingLinkSql('l')})
                 + (SELECT COUNT(*)::int FROM links l WHERE l.from_page_id = p.id AND ${rankingLinkSql('l')})
                 + (SELECT COUNT(*)::int FROM content_chunks WHERE page_id = p.id))
                  AS connection_count
         FROM pages p
         WHERE p.source_id = $1
           AND p.deleted_at IS NULL
           AND NOT ${retiredPageSql('p')}
           AND p.slug LIKE $2
         ORDER BY connection_count DESC, p.slug COLLATE "C" ASC
         LIMIT 5`],
  },
  {
    from: 'src/core/entities/resolve.ts:732 tryUnambiguousPrefixExpansion dirs',
    case: { method: 'readPrefixDirs', variant: 'default', run: e => e.readPrefixDirs('default', ['people/alice', 'people/alice-%']) },
    texts: () => [`SELECT DISTINCT split_part(slug, '/', 1) AS dir FROM pages
        WHERE source_id = $1 AND deleted_at IS NULL AND NOT ${retiredPageSql('pages')} AND slug LIKE ANY($2::text[])
        LIMIT 2`],
  },
  {
    from: 'src/core/entities/resolve.ts:739 tryUnambiguousPrefixExpansion exact titles',
    case: { method: 'readPrefixTitleMatches', variant: 'default', run: e => e.readPrefixTitleMatches('default', ['companies/acme', 'companies/acme-%'], 'Acme') },
    texts: () => [`SELECT slug, title FROM pages
        WHERE source_id = $1 AND deleted_at IS NULL AND NOT ${retiredPageSql('pages')}
          AND slug LIKE ANY($2::text[]) AND lower(title) = lower($3)
        LIMIT 3`],
  },
  ...([
    ['none', () => ''],
    ['caller', () => `AND ${privatePagesFilterForCaller('p')}`],
    ['floor', () => `AND ${remoteReadFloorSql('p')}`],
  ] as const).map(([privacy, predicate]): Pin => ({
    from: `src/core/entities/resolve.ts:552 entityReferenceCandidates named (privacy ${privacy}; the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)`,
    case: { method: 'readNamedEntitySlugs', variant: privacy, run: e => e.readNamedEntitySlugs('default', ['companies/acme', 'orgs/acme'], privacy) },
    texts: () => [`SELECT p.slug FROM pages p
      WHERE p.source_id = $1 AND p.deleted_at IS NULL AND NOT ${retiredPageSql('p')} AND p.slug = ANY($2::text[]) ${predicate()}
      ORDER BY p.slug COLLATE "C" LIMIT 5`],
  })),
  ...([
    ['all', {}],
    ['sources-run', { sourceIds: ['default'], runId: 'run-1' }],
  ] as const).map(([variant, opts]): Pin => ({
    from: `src/core/persistence/sync-holds.ts:575 readGitSourceHolds (${variant}, at f549f444af; the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)`,
    case: { method: 'readGitHoldRecords', variant, run: e => e.readGitHoldRecords(opts) },
    texts: () => [`SELECT ${READ_HOLD_RECORD_SQL} AS record FROM op_checkpoints h
    JOIN sources s ON s.id=h.completed_keys->0->>'source_id' AND s.incarnation::text=h.completed_keys->0->>'incarnation'
    WHERE h.op=$1 AND ($2::text[] IS NULL OR s.id=ANY($2::text[])) AND ($3::text IS NULL OR h.completed_keys->0->>'run_id'=$3)
    ORDER BY s.id COLLATE "C",h.fingerprint COLLATE "C"`],
  })),
  {
    from: 'src/core/sync-dispatch-read.ts:51 syncDispatchRow',
    case: { method: 'readSyncDispatchRow', variant: 'default', run: e => e.readSyncDispatchRow('default') },
    texts: () => [`SELECT s.id, s.archived, s.config, s.incarnation::text AS incarnation, s.local_path,
  EXISTS(SELECT 1 FROM persistence_source_bindings b WHERE b.source_id=s.id AND b.source_incarnation=s.incarnation) AS claimed,
  EXISTS(SELECT 1 FROM source_ingestion_receipts r WHERE r.source_id=s.id AND r.source_incarnation=s.incarnation AND r.profile='company-brain') AS company_receipt,
  (SELECT COALESCE(jsonb_agg(m.enabled), '[]'::jsonb) FROM (${MANAGED_MODE_SQL}) m) AS modes
  FROM (SELECT $1::text AS want) w LEFT JOIN sources s ON s.id=w.want`],
  },
  {
    // An equivalent statement: the caller read `created_at` alone; the member also reads `archived`, `local_path` and
    // `config` (the generic job source boundary reads them), which this check ignores.
    from: 'src/core/persistence/sync-authority.ts:122 validateSyncAuthority (SELECT created_at FROM sources WHERE id=$1)',
    case: { method: 'readJobSourceState', variant: 'default', run: e => e.readJobSourceState('default') },
    texts: ['SELECT archived, created_at, local_path, config FROM sources WHERE id = $1'],
  },
  {
    from: 'src/core/persistence/sync-holds.ts:1186 readGitHoldRetryPaths',
    case: { method: 'readGitHoldRetryRequest', variant: 'default', run: e => e.readGitHoldRetryRequest('default:1') },
    texts: ['SELECT completed_keys FROM op_checkpoints WHERE op=$1 AND fingerprint=$2'],
  },
  {
    // An equivalent statement: the caller read the pairs unordered into a Set; the member orders them by commit, then path.
    from: 'src/core/reason-trailers.ts:151 scanSyncReasons',
    case: { method: 'readReasonPurgeTombstones', variant: 'default', run: e => e.readReasonPurgeTombstones('default') },
    texts: ['SELECT commit_sha, path FROM reason_purge_tombstones WHERE source_id = $1 ORDER BY commit_sha, path'],
  },
  {
    from: 'src/core/reason-trailers.ts:262 cachedSyncReasonScan',
    case: { method: 'readSourcePurgeEpoch', variant: 'default', run: e => e.readSourcePurgeEpoch('default') },
    texts: ['SELECT purge_epoch FROM sources WHERE id = $1'],
  },
  {
    from: 'src/core/minions/submission-authority.ts assertCurrentRemoteJobPrincipal (OAuth client; the check now reads readOauthClient, this pins readJobPrincipal)',
    case: { method: 'readJobPrincipal', variant: 'oauth-client', run: e => e.readJobPrincipal({ kind: 'oauth_client', id: 'client-1' }) },
    texts: ['SELECT client_id, deleted_at, scope, source_id, bound_slug_prefixes, surface, allowed_operations FROM oauth_clients WHERE client_id = $1'],
  },
  {
    from: 'src/core/minions/submission-authority.ts:160 assertCurrentRemoteJobPrincipal (legacy token)',
    case: { method: 'readJobPrincipal', variant: 'legacy-token', run: e => e.readJobPrincipal({ kind: 'legacy_token', id: 'tok-1' }) },
    texts: ['SELECT * FROM access_tokens WHERE id = $1'],
  },
  {
    from: 'src/core/persistence/sync-holds.ts:1452,1458 buildHoldReport',
    case: { method: 'readGitHoldReportInputs', variant: 'default', run: e => e.readGitHoldReportInputs('default', 'default:1') },
    texts: [`SELECT COALESCE((completed_keys->0->>'count')::int,0) AS count,
      COALESCE((completed_keys->0->>'drift')::int,0) AS drift,
      COALESCE((completed_keys->0->>'images')::int,0) AS images, COALESCE((completed_keys->0->>'fences')::int,0) AS fences, COALESCE((completed_keys->0->>'stalled')::int,0) AS stalled,
      COALESCE((completed_keys->0->>'concurrent')::int,0) AS concurrent, COALESCE((completed_keys->0->>'dirty')::int,0) AS dirty
    FROM op_checkpoints WHERE op=$1 AND fingerprint=$2`, "SELECT config->>'mirror_read_only' AS mirror FROM sources WHERE id=$1"],
  },
  {
    from: 'src/core/persistence/sync-holds.ts:334 lockSummary (at 8b80bd80ab)',
    case: { method: 'lockGitHoldSummary', variant: 'default', run: e => e.lockGitHoldSummary('default', '1') },
    texts: [`INSERT INTO op_checkpoints(op,fingerprint,completed_keys)
      VALUES($1,$2,jsonb_build_array(jsonb_build_object('source_id',$3::text,'incarnation',$4::text,'count',0,'stale',0)))
    ON CONFLICT(op,fingerprint) DO UPDATE SET updated_at=now()
    RETURNING COALESCE((completed_keys->0->>'count')::int,0) AS count`],
  },
  {
    from: 'src/core/persistence/sync-holds.ts:351-352 adjustSummary (SUMMARY_COUNTERS rendered) (at 8b80bd80ab)',
    case: { method: 'adjustGitHoldSummary', variant: 'default', run: e => e.adjustGitHoldSummary('default', '1', 1, { stale: 0, images: 0, fences: 0, concurrent: 0, stalled: 0, dirty: 0, drift: 0 }) },
    texts: () => {
      const pairs = ['stale', 'images', 'fences', 'concurrent', 'stalled', 'dirty', 'drift']
        .map((name, i) => `'${name}',GREATEST(0,COALESCE((completed_keys->0->>'${name}')::int,0)+$${i + 4}::int)`).join(',');
      return [`UPDATE op_checkpoints SET completed_keys=jsonb_build_array((completed_keys->0)||jsonb_build_object(
      'count',GREATEST(0,COALESCE((completed_keys->0->>'count')::int,0)+$3::int),${pairs})),updated_at=now() WHERE op=$1 AND fingerprint=$2`];
    },
  },
  {
    from: 'src/core/persistence/sync-holds.ts:368 readRow (at 8b80bd80ab)',
    case: { method: 'readGitHoldRow', variant: 'default', run: e => e.readGitHoldRow('default', '1', 'a.md') },
    texts: ['SELECT completed_keys->0 AS record FROM op_checkpoints WHERE op=$1 AND fingerprint=$2'],
  },
  {
    from: 'src/core/persistence/sync-holds.ts:395 writeGitHold (at 8b80bd80ab)',
    case: { method: 'writeGitHoldRow', variant: 'default', run: e => e.writeGitHoldRow('default', '1', 'a.md', { path: 'a.md' }) },
    texts: [`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb)
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys,updated_at=now()`],
  },
  {
    from: 'src/core/persistence/sync-holds.ts:456 rewriteHoldMeta (at 8b80bd80ab)',
    case: { method: 'replaceGitHoldRow', variant: 'default', run: e => e.replaceGitHoldRow('default', '1', 'a.md', { path: 'a.md' }, { path: 'a.md', meta: {} }) },
    texts: [`UPDATE op_checkpoints SET completed_keys=$3::text::jsonb, updated_at=now()
      WHERE op=$1 AND fingerprint=$2 AND completed_keys=$4::text::jsonb RETURNING 1`],
  },
  {
    from: 'src/core/persistence/sync-holds.ts:482 clearGitHold (at 8b80bd80ab)',
    case: { method: 'deleteGitHoldRow', variant: 'default', run: e => e.deleteGitHoldRow('default', '1', 'a.md') },
    texts: ['DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=$2'],
  },
  {
    from: 'src/core/persistence/sync-holds.ts:573 countGitHolds (at 8b80bd80ab)',
    case: { method: 'countGitHolds', variant: 'default', run: e => e.countGitHolds('default', '1') },
    texts: ["SELECT COALESCE((completed_keys->0->>'count')::int,0) AS count FROM op_checkpoints WHERE op=$1 AND fingerprint=$2"],
  },
  {
    from: 'src/core/persistence/sync-pass-row.ts:178 readPassRow (at 8b80bd80ab)',
    case: { method: 'readSyncPassRow', variant: 'default', run: e => e.readSyncPassRow('default', '1') },
    texts: ['SELECT completed_keys->0 AS value, updated_at, now() AS read_at FROM op_checkpoints WHERE op=$1 AND fingerprint=$2'],
  },
  {
    from: 'src/core/persistence/sync-pass-row.ts:185 readLivePassRows (at 8b80bd80ab)',
    case: { method: 'readLiveSyncPassRows', variant: 'default', run: e => e.readLiveSyncPassRows(null) },
    texts: [`SELECT s.id AS source_id, c.completed_keys->0 AS value, c.updated_at, now() AS read_at FROM sources s
       JOIN op_checkpoints c ON c.op=$1 AND c.fingerprint=s.id||':'||s.incarnation::text
      WHERE ($2::text[] IS NULL OR s.id=ANY($2::text[]))`],
  },
  ...([
    ['default', {}, '$3::text::jsonb'],
    ['clock', { clock: true }, `jsonb_set($3::text::jsonb,'{telemetry,started_at}',to_jsonb(to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))`],
  ] as const).map(([variant, opts, json]): Pin => ({
    from: 'src/core/persistence/sync-pass-row.ts:206 writePassRow (at 8b80bd80ab)',
    case: { method: 'writeSyncPassRow', variant, run: e => e.writeSyncPassRow('default', '1', { lease_token: 't' }, opts) },
    texts: [`INSERT INTO op_checkpoints(op,fingerprint,completed_keys,updated_at) VALUES($1,$2,jsonb_build_array(${json}),now())
      ON CONFLICT (op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys, updated_at=now()
        WHERE ($4::boolean OR op_checkpoints.completed_keys->0->>'lease_token'=$5) RETURNING 1`],
  })),
  {
    from: 'src/core/persistence/sync-pass-row.ts:204 writePassRow (onlyOpen) (at 8b80bd80ab)',
    case: { method: 'writeSyncPassRow', variant: 'only-open', run: e => e.writeSyncPassRow('default', '1', { lease_token: 't' }, { onlyOpen: true }) },
    texts: [`UPDATE op_checkpoints SET completed_keys=jsonb_build_array($3::text::jsonb), updated_at=now()
      WHERE op=$1 AND fingerprint=$2 AND ($4::boolean OR completed_keys->0->>'lease_token'=$5) AND completed_keys->0->'telemetry'->>'outcome'='open' RETURNING 1`],
  },
  {
    from: 'src/core/persistence/applied-watermark.ts:88,92 readWriteWatermark',
    case: { method: 'readWriteWatermarkRow', variant: 'default', run: e => e.readWriteWatermarkRow('default') },
    texts: [`SELECT s.last_commit, s.last_sync_at, p.pending_min, p.pending_count, p.pending_since
    FROM sources s LEFT JOIN LATERAL (SELECT min(r.sequence) AS pending_min, count(*) AS pending_count, min(r.created_at) AS pending_since FROM persistence_requests r
      WHERE r.source_id=s.id AND r.source_incarnation=s.incarnation AND r.state IN ('queued','deferred','running','recovering')) p ON true WHERE s.id=$1`,
    'SELECT max(sequence) AS sequence FROM persistence_requests'],
  },
  {
    from: 'src/core/persistence/applied-watermark.ts:104 readCheckoutRoot',
    case: { method: 'readSourceCheckoutRoot', variant: 'default', run: e => e.readSourceCheckoutRoot('default', null) },
    texts: [`SELECT s.incarnation::text AS incarnation,
      COALESCE((SELECT h.local_path FROM persistence_host_bindings h JOIN persistence_source_bindings b ON b.worktree_id=h.worktree_id
        WHERE b.source_id=s.id AND h.host_id::text=$2 LIMIT 1), s.local_path) AS root FROM sources s WHERE s.id=$1`],
  },
  {
    from: 'src/core/persistence/applied-watermark.ts:132 readAppliedWatermark',
    case: { method: 'readUnembeddedPageSummary', variant: 'default', run: e => e.readUnembeddedPageSummary('default', 'embedding') },
    texts: () => [`WITH w AS (SELECT DISTINCT p.id, p.updated_at FROM content_chunks cc
        JOIN pages p ON p.id=cc.page_id WHERE ${`cc.${quoteIdentifier('embedding')}`} IS NULL AND p.source_id=$1 AND p.deleted_at IS NULL AND ${chunkGenerationFilter('p', 'cc')}
          AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip'))
      SELECT count(*) AS pages, min(w.updated_at) AS oldest,
        (SELECT count(*) FROM w JOIN page_embedding_budget b ON b.page_id=w.id JOIN pages p ON p.id=w.id WHERE ${budgetRowAppliesFilter('b', 'p')}) AS held FROM w`],
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
      WHERE NOT s.archived ORDER BY s.id COLLATE "C"`],
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
      ORDER BY s.id COLLATE "C" LIMIT 200`],
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
      ORDER BY s.id COLLATE "C" LIMIT 200`],
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
    from: 'src/core/notifier/status.ts:130 readNotifierBlock (the markers; at f24fef9a03; the text sort keys gain COLLATE "C" so Postgres sorts by byte like PGLite and the store)',
    case: { method: 'listSourceWantedMarkers', variant: 'default', run: e => e.listSourceWantedMarkers('source-a') },
    texts: ['SELECT intent, wanted_head, first_due_at, requested_by FROM sync_wanted_markers WHERE source_id = $1 ORDER BY first_due_at, intent COLLATE "C"'],
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
  {
    // The before-state column list is the shared FACT_PREIMAGE_SQL, which the caller interpolated as well.
    from: 'src/core/generations/adapters/fact-rows.ts:50 factPreimages (at ede09fdf45)',
    case: { method: 'readFactPreimages', variant: 'default', run: e => e.readFactPreimages('default', [3, 1]) },
    texts: [`SELECT ${FACT_PREIMAGE_SQL} AS preimage FROM facts f WHERE f.source_id=$1 AND f.id = ANY($2::bigint[]) ORDER BY f.id`],
  },
  {
    from: 'src/core/generations/adapters/page.ts:53 readPageRows (at a2d331ad57) with COLLATE "C" on both sorts, where text of single-page.ts:39',
    case: { method: 'readGenerationPageRows', variant: 'slug', run: e => e.readGenerationPageRows({ sourceId: 'default', match: 'slug', slug: 'dream/summary' }) },
    texts: [`SELECT p.id AS page_id, p.slug, p.type, p.title, p.compiled_truth, p.timeline, p.frontmatter, p.deleted_at IS NOT NULL AS deleted,\n            p.body_storage = 'segmented' AS segmented, COALESCE((SELECT jsonb_agg(t.tag ORDER BY t.tag COLLATE "C") FROM tags t WHERE t.page_id = p.id), '[]'::jsonb) AS tags\n       FROM pages p WHERE p.source_id = $1 AND (p.slug = $2) ORDER BY p.slug COLLATE "C"`],
  },
  {
    from: 'src/core/generations/adapters/page.ts:53 readPageRows (at a2d331ad57) with COLLATE "C" on both sorts, where text of synthesis.ts:53',
    case: { method: 'readGenerationPageRows', variant: 'synthesis', run: e => e.readGenerationPageRows({ sourceId: 'default', match: 'synthesis', slugs: ['synth/a'], locator: 'loc.md' }) },
    texts: [`SELECT p.id AS page_id, p.slug, p.type, p.title, p.compiled_truth, p.timeline, p.frontmatter, p.deleted_at IS NOT NULL AS deleted,\n            p.body_storage = 'segmented' AS segmented, COALESCE((SELECT jsonb_agg(t.tag ORDER BY t.tag COLLATE "C") FROM tags t WHERE t.page_id = p.id), '[]'::jsonb) AS tags\n       FROM pages p WHERE p.source_id = $1 AND (p.slug = ANY($2::text[]) OR (p.deleted_at IS NULL AND $3::text IS NOT NULL\n      AND p.frontmatter->>'raw_source' = $3 AND p.frontmatter->>'dream_generated' = 'true')) ORDER BY p.slug COLLATE "C"`],
  },
  {
    from: 'src/core/generations/adapters/page.ts:53 readPageRows (at a2d331ad57) with COLLATE "C" on both sorts, where text of atoms.ts:90',
    case: { method: 'readGenerationPageRows', variant: 'atoms-source-slug', run: e => e.readGenerationPageRows({ sourceId: 'default', match: 'atoms', slugs: ['atoms/a'], field: 'source_slug', value: 'notes/a' }) },
    texts: [`SELECT p.id AS page_id, p.slug, p.type, p.title, p.compiled_truth, p.timeline, p.frontmatter, p.deleted_at IS NOT NULL AS deleted,\n            p.body_storage = 'segmented' AS segmented, COALESCE((SELECT jsonb_agg(t.tag ORDER BY t.tag COLLATE "C") FROM tags t WHERE t.page_id = p.id), '[]'::jsonb) AS tags\n       FROM pages p WHERE p.source_id = $1 AND (p.type='atom' AND (p.slug = ANY($2::text[]) OR (p.deleted_at IS NULL AND $3::text IS NOT NULL AND p.frontmatter->>'source_slug' = $3))) ORDER BY p.slug COLLATE "C"`],
  },
  {
    from: 'src/core/generations/adapters/page.ts:53 readPageRows (at a2d331ad57) with COLLATE "C" on both sorts, where text of atoms.ts:90',
    case: { method: 'readGenerationPageRows', variant: 'atoms-source-path', run: e => e.readGenerationPageRows({ sourceId: 'default', match: 'atoms', slugs: ['atoms/a'], field: 'source_path', value: 'notes/a.md' }) },
    texts: [`SELECT p.id AS page_id, p.slug, p.type, p.title, p.compiled_truth, p.timeline, p.frontmatter, p.deleted_at IS NOT NULL AS deleted,\n            p.body_storage = 'segmented' AS segmented, COALESCE((SELECT jsonb_agg(t.tag ORDER BY t.tag COLLATE "C") FROM tags t WHERE t.page_id = p.id), '[]'::jsonb) AS tags\n       FROM pages p WHERE p.source_id = $1 AND (p.type='atom' AND (p.slug = ANY($2::text[]) OR (p.deleted_at IS NULL AND $3::text IS NOT NULL AND p.frontmatter->>'source_path' = $3))) ORDER BY p.slug COLLATE "C"`],
  },
  {
    from: 'src/core/generations/adapters/page.ts:53 readPageRows (at a2d331ad57) with COLLATE "C" on both sorts, where text of chronicle-events.ts:162',
    case: { method: 'readGenerationPageRows', variant: 'chronicle', run: e => e.readGenerationPageRows({ sourceId: 'default', match: 'chronicle', slugs: ['events/a'], depth: 'year' }) },
    texts: [`SELECT p.id AS page_id, p.slug, p.type, p.title, p.compiled_truth, p.timeline, p.frontmatter, p.deleted_at IS NOT NULL AS deleted,\n            p.body_storage = 'segmented' AS segmented, COALESCE((SELECT jsonb_agg(t.tag ORDER BY t.tag COLLATE "C") FROM tags t WHERE t.page_id = p.id), '[]'::jsonb) AS tags\n       FROM pages p WHERE p.source_id = $1 AND (p.slug = ANY($2::text[]) OR (p.deleted_at IS NULL AND p.type='event' AND p.frontmatter->'event'->>'depth' = $3\n      AND p.frontmatter->>'captured_via' LIKE 'life-chronicle:%')) ORDER BY p.slug COLLATE "C"`],
  },
  {
    from: 'src/core/generations/adapters/chronicle-events.ts:112 depthRow (at 358967a48a)',
    case: { method: 'readChronicleDepthRow', variant: 'default', run: e => e.readChronicleDepthRow('default', 'people/a') },
    texts: ["SELECT id, deleted_at IS NULL AS live FROM pages WHERE source_id=$1 AND slug=$2 ORDER BY deleted_at NULLS FIRST, id DESC LIMIT 1"],
  },
  {
    from: 'src/core/generations/adapters/chronicle-events.ts:119 ownedEventHashes (at 358967a48a)',
    case: { method: 'listChronicleOwnedHashes', variant: 'default', run: e => e.listChronicleOwnedHashes('default', 7) },
    texts: ["SELECT DISTINCT unnest(event_hashes) AS hash FROM chronicle_page_state WHERE source_id=$1 AND page_id=$2"],
  },
  {
    from: 'src/core/generations/adapters/chronicle-events.ts:126 ledgerRetired (at 358967a48a)',
    case: { method: 'listRetiredGenerationItemKeys', variant: 'default', run: e => e.listRetiredGenerationItemKeys('default', 'chronicle_event', ['events/a']) },
    texts: ["SELECT DISTINCT i.item_key FROM derived_generation_items i JOIN derived_generations g ON g.id=i.generation_id\n      WHERE g.source_id=$1 AND g.kind=$2 AND i.action='retired' AND i.item_key=ANY($3::text[])"],
  },
  {
    from: 'src/core/generations/adapters/chronicle-events.ts:150 projectionRows (at 358967a48a)',
    case: { method: 'listEventProjectionRows', variant: 'default', run: e => e.listEventProjectionRows([3, 1]) },
    texts: ["SELECT event_page_id, date::text AS date, summary, detail FROM timeline_entries WHERE event_page_id = ANY($1::bigint[]) ORDER BY date"],
  },
  {
    from: 'src/core/generations/adapters/chronicle-events.ts:164 readEventItems (at 358967a48a)',
    case: { method: 'listPageContentHashes', variant: 'ids', run: e => e.listPageContentHashes({ sourceId: 'default', match: 'ids', ids: [3, 1] }) },
    texts: ["SELECT slug, content_hash FROM pages WHERE source_id=$1 AND id = ANY($2::bigint[])"],
  },
  {
    from: 'src/core/chronicle/publish.ts:186 writtenEvents (at 358967a48a)',
    case: { method: 'listPageContentHashes', variant: 'live-slugs', run: e => e.listPageContentHashes({ sourceId: 'default', match: 'live_slugs', slugs: ['events/a'] }) },
    texts: ["SELECT slug, content_hash FROM pages WHERE source_id=$1 AND slug=ANY($2::text[]) AND deleted_at IS NULL"],
  },
  {
    from: 'src/core/generations/adapters/chronicle-events.ts:170 readEventItems (at 358967a48a)',
    case: { method: 'listLiveGenerationItems', variant: 'default', run: e => e.listLiveGenerationItems({ sourceId: 'default', kind: 'chronicle_event', ownerKey: 'depth:people/a' }) },
    texts: ["SELECT i.item_key, i.identity_hash FROM derived_generation_items i JOIN derived_generations g ON g.id=i.generation_id\n      WHERE g.source_id=$1 AND g.kind=$2 AND g.owner_key=$3 AND g.state='live' AND i.action <> 'retired'"],
  },
  {
    from: 'src/core/generations/adapters/chronicle-events.ts:197 recordProjectionFlag, where text of publish.ts:306 (at 358967a48a)',
    case: { method: 'readEventProjectionId', variant: 'default', run: e => e.readEventProjectionId(3, '2026-03-02') },
    texts: ["SELECT id FROM timeline_entries WHERE event_page_id=$1 AND date=$2::date"],
  },
  {
    from: 'src/core/generations/adapters/chronicle-events.ts:239 publishItems (at 358967a48a)',
    case: { method: 'pageSlugExists', variant: 'default', run: e => e.pageSlugExists('default', 'events/a') },
    texts: ["SELECT 1 FROM pages WHERE source_id=$1 AND slug=$2"],
  },
  {
    from: 'src/core/generations/adapters/chronicle-events.ts:257 retireItems (at 358967a48a)',
    case: { method: 'deleteEventProjections', variant: 'default', run: e => e.deleteEventProjections('default', ['events/a']) },
    texts: ["DELETE FROM timeline_entries t USING pages p WHERE p.id=t.event_page_id AND p.source_id=$1 AND p.slug=ANY($2::text[])"],
  },
  {
    from: 'src/core/generations/adapters/chronicle-events.ts:269 restoreItem (at 358967a48a)',
    case: { method: 'restoreEventProjection', variant: 'default', run: e => e.restoreEventProjection({ depthPageId: 1, date: '2026-03-02', source: 'life-chronicle:event:events/a', summary: 's', detail: 'd', eventPageId: 3 }) },
    texts: ["INSERT INTO timeline_entries (page_id, date, source, summary, detail, event_page_id) VALUES ($1, $2::date, $3, $4, $5, $6)\n        ON CONFLICT (event_page_id, date) WHERE event_page_id IS NOT NULL DO UPDATE SET summary=EXCLUDED.summary, detail=EXCLUDED.detail, page_id=EXCLUDED.page_id, source=EXCLUDED.source"],
  },
  {
    from: 'src/core/generations/adapters/chronicle-events.ts:280 proofHolds (at 358967a48a)',
    case: { method: 'hasChronicleSkipDecision', variant: 'default', run: e => e.hasChronicleSkipDecision({ sourceId: 'default', pageId: 1, contentHash: 'h', extractorVersion: 2, reason: 'no_events' }) },
    texts: ["SELECT 1 FROM chronicle_page_state WHERE source_id=$1 AND page_id=$2 AND content_hash=$3 AND extractor_version=$4 AND state=$5 AND reason=$6"],
  },
  {
    from: 'src/core/generations/adapters/chronicle-events.ts:288 orphanedDepthKeys (at 358967a48a)',
    case: { method: 'listOrphanedChronicleOwners', variant: 'default', run: e => e.listOrphanedChronicleOwners('default', 'chronicle_event', 50) },
    texts: ["SELECT g.owner_key FROM derived_generations g\n      WHERE g.source_id=$1 AND g.kind=$2 AND g.state='live'\n        AND EXISTS (SELECT 1 FROM derived_generation_items i JOIN pages e ON e.source_id=g.source_id AND e.slug=i.item_key AND e.deleted_at IS NULL\n          WHERE i.generation_id=g.id AND i.action <> 'retired')\n        AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id=g.source_id AND p.slug=substr(g.owner_key, 7) AND p.deleted_at IS NULL)\n      ORDER BY g.updated_at, g.id LIMIT $3"],
  },
  {
    from: 'src/core/chronicle/event-identity.ts:90 resolveChronicleEventSlugs (at 358967a48a)',
    case: { method: 'listChronicleEventSlotRows', variant: 'default', run: e => e.listChronicleEventSlotRows('default', ['events/a']) },
    texts: ["SELECT slug, frontmatter->'event'->>'when' AS \"when\", frontmatter->'event'->>'where' AS \"where\", frontmatter->'event'->>'kind' AS kind\n       FROM pages WHERE source_id=$1 AND slug = ANY($2::text[])"],
  },
  {
    from: 'src/core/generations/adapters/atoms.ts:82 readInput (at ec2fbe7ba3)',
    case: { method: 'readAtomOriginInput', variant: 'default', run: e => e.readAtomOriginInput('default', 'notes/origin') },
    texts: [`SELECT id, content_hash, knowledge_revision::text AS revision,\n        CASE WHEN body_storage = 'segmented' THEN body_bytes ELSE octet_length(COALESCE(compiled_truth, '')) + octet_length(COALESCE(timeline, '')) END AS body_bytes\n       FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL`],
  },
  {
    from: 'src/core/trust/taint.ts:127 lowerToDerivedTier (at d7fb3a97b7; the values bind through sqlFragment, so the placeholders follow text order and the compared tier binds as its rank)',
    case: { method: 'lowerTrustTier', variant: 'pages', run: e => e.lowerTrustTier('pages', [3, 1], 'external_untrusted', { channel: 'derive:test' }) },
    texts: [`UPDATE pages SET trust_tier=$1,write_origin=$2::text::jsonb
      WHERE id=ANY($3::bigint[]) AND ${trustRankSql('trust_tier')}>$4::int RETURNING id`],
  },
  {
    from: 'src/core/trust/taint.ts:235 readDerivedTaintShare (at d7fb3a97b7)',
    case: { method: 'countDerivedRowTaint', variant: 'takes', run: e => e.countDerivedRowTaint('takes') },
    texts: [`SELECT count(*) FILTER (WHERE write_origin ? 'taint_inputs') AS derived,
                count(*) FILTER (WHERE write_origin ? 'taint_inputs' AND trust_tier = 'external_untrusted') AS external FROM takes`],
  },
  {
    from: 'src/core/persistence/derived-retirement-hold.ts:51 stampDerivedRetirement (at d7fb3a97b7)',
    case: { method: 'stampPageFrontmatter', variant: 'retired', run: e => e.stampPageFrontmatter({ match: 'retired', sourceId: 'default', slugs: ['synth/a'], retiredBy: 'synthesis-cleanup', retiredAt: '2026-01-01T00:00:00.000Z' }) },
    texts: [`UPDATE pages SET frontmatter=frontmatter||jsonb_build_object('retired_by',$1::text,'retired_at',$2::text)
    WHERE source_id=$3 AND slug=ANY($4::text[]) AND deleted_at IS NOT NULL`],
  },
  {
    from: 'src/core/generations/adapters/atoms.ts:110 completeItems (at d7fb3a97b7)',
    case: { method: 'stampPageFrontmatter', variant: 'atom-source-hash', run: e => e.stampPageFrontmatter({ match: 'atom_source_hash', sourceId: 'default', slugs: ['atoms/a'], sourceHash: '0123456789abcdef' }) },
    texts: [`UPDATE pages SET frontmatter = frontmatter || jsonb_build_object('source_hash', $1::text)
      WHERE source_id = $2 AND type = 'atom' AND slug = ANY($3::text[]) AND deleted_at IS NULL`],
  },
  {
    from: 'src/core/generations/adapters/page.ts:95 pageVersionEvidence (at ec2fbe7ba3), producer text of atoms.ts:95',
    case: { method: 'listProducerVersionRows', variant: 'extract-atoms', run: e => e.listProducerVersionRows('default', ['atoms/a'], 'extract_atoms') },
    texts: [`SELECT p.slug, v.type, v.title, v.compiled_truth, v.timeline, v.frontmatter, v.tags, p.frontmatter->'visibility' AS live_visibility\n       FROM page_versions v JOIN pages p ON p.id = v.page_id\n      WHERE p.source_id = $1 AND p.slug = ANY($2::text[]) AND v.compiled_truth IS NOT NULL AND v.title IS NOT NULL AND (v.frontmatter->>'extracted_by' LIKE 'extract\\_atoms%')`],
  },
  {
    from: 'src/core/generations/adapters/atoms.ts:127 receiptEvidence (at ec2fbe7ba3)',
    case: { method: 'listAtomWriteReceipts', variant: 'default', run: e => e.listAtomWriteReceipts('default', ['atoms/a']) },
    texts: [`SELECT r.slug, r.intent->>'content' AS content FROM persistence_requests r\n      WHERE r.source_id=$1 AND r.slug=ANY($2::text[]) AND r.state='committed' AND r.intent->>'kind'='managed_atom_page' AND r.intent ? 'content'\n        AND (r.intent->>'activationId' IS NULL OR EXISTS (SELECT 1 FROM derived_generation_activations a WHERE a.id=r.intent->>'activationId' AND a.state='activated'))`],
  },
  {
    from: 'src/core/generations/adapters/extracted-facts.ts:71 storedRows (at 0d76adc0e6)',
    case: { method: 'listFactIdsBySourcePrefix', variant: 'default', run: e => e.listFactIdsBySourcePrefix('default', 'conversations/c', 'cli:extract-conversation-facts') },
    texts: [`SELECT id FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND COALESCE(source,'') LIKE $3 ORDER BY id`],
  },
  {
    from: 'src/core/generations/adapters/extracted-facts.ts:113 retireItems (at 0d76adc0e6)',
    case: { method: 'expireFactRows', variant: 'default', run: e => e.expireFactRows('default', [3, 4]) },
    texts: ['UPDATE facts SET expired_at = now() WHERE source_id=$1 AND id = ANY($2::bigint[]) AND expired_at IS NULL'],
  },
  {
    from: 'src/core/generations/adapters/fact-rows.ts:82 restoreFactRow (at c0a2bbe921)',
    case: { method: 'restoreFactPreimage', variant: 'default', run: e => e.restoreFactPreimage('default', { id: 3, fact: 'f', visibility: 'private', expired_at: null, valid_until: null, superseded_by: null, consolidated_at: null, consolidated_into: null, row_num: 1 }) },
    texts: [`UPDATE facts f SET expired_at=$4::timestamptz, valid_until=$5::timestamptz, superseded_by=$6::bigint,
      consolidated_at=$7::timestamptz, consolidated_into=$8::bigint,
      row_num=CASE WHEN $9::integer IS NULL OR f.row_num IS NOT DISTINCT FROM $9::integer THEN f.row_num
        WHEN NOT EXISTS (SELECT 1 FROM facts o WHERE o.source_id=f.source_id AND o.source_markdown_slug=f.source_markdown_slug AND o.row_num=$9::integer AND o.id<>f.id)
        THEN $9::integer ELSE f.row_num END
    WHERE f.source_id=$1 AND f.id=$2::bigint AND f.fact=$3 AND f.visibility=$10 RETURNING f.id`],
  },
  {
    from: 'src/core/generations/adapters/fact-rows.ts:142 consolidationRestored (at c0a2bbe921)',
    case: { method: 'readGenerationRestored', variant: 'default', run: e => e.readGenerationRestored({ sourceId: 'default', kind: 'consolidation', ownerKey: 'entity:a:cluster:1' }) },
    texts: [`SELECT restore_of IS NOT NULL AS restored FROM derived_generations
    WHERE source_id=$1 AND kind=$2 AND owner_key=$3 AND state='live'`],
  },
  {
    from: 'src/core/generations/adapters/fact-rows.ts:150 clearConsolidationTies (at c0a2bbe921)',
    case: { method: 'clearTieHeldGenerationRows', variant: 'default', run: e => e.clearTieHeldGenerationRows('default', 'consolidation', 'entity:a:cluster:') },
    texts: [`DELETE FROM derived_generations WHERE source_id=$1 AND kind=$2 AND state='held' AND held_reason='tie' AND left(owner_key, $3)=$4`],
  },
  {
    // The before-state column list is the shared TAKE_PREIMAGE_SQL, which the caller interpolated as well.
    from: 'src/core/generations/adapters/take-rows.ts:36 takePreimages (at 46b54a156e)',
    case: { method: 'readTakePreimages', variant: 'by-id', run: e => e.readTakePreimages({ pageId: 1, by: 'id', gone: [3], incoming: [{ row_num: 2, claim: 'c', kind: 'take', holder: 'h' }] }) },
    texts: [`SELECT ${TAKE_PREIMAGE_SQL} AS preimage, k.id = ANY($2::bigint[]) AS gone FROM takes k
      LEFT JOIN jsonb_to_recordset($3::text::jsonb) AS n(row_num integer, claim text, kind text, holder text) ON n.row_num = k.row_num
     WHERE k.page_id = $1 AND (k.id = ANY($2::bigint[]) OR (n.row_num IS NOT NULL AND (k.claim, k.kind, k.holder) IS DISTINCT FROM (n.claim, n.kind, n.holder)))
     ORDER BY k.row_num`],
  },
  {
    from: 'src/core/generations/adapters/take-rows.ts:51 projectTakeFenceGeneration (at 46b54a156e)',
    case: { method: 'readTakePreimages', variant: 'by-row', run: e => e.readTakePreimages({ pageId: 1, by: 'row_num', gone: [3], incoming: [] }) },
    texts: [`SELECT ${TAKE_PREIMAGE_SQL} AS preimage, k.row_num = ANY($2::integer[]) AS gone FROM takes k
      LEFT JOIN jsonb_to_recordset($3::text::jsonb) AS n(row_num integer, claim text, kind text, holder text) ON n.row_num = k.row_num
     WHERE k.page_id = $1 AND (k.row_num = ANY($2::integer[]) OR (n.row_num IS NOT NULL AND (k.claim, k.kind, k.holder) IS DISTINCT FROM (n.claim, n.kind, n.holder)))
     ORDER BY k.row_num`],
  },
];

/** mentions/referrers-sql.ts referrersCte at 97bf5544dd, verbatim, for the floored remote scope or the local one. */
function pinnedReferrersCte(excludePrivate: boolean, floored: boolean): string {
  return `WITH tgt AS MATERIALIZED (
      SELECT t.id FROM pages t JOIN unnest($1::text[], $2::text[]) AS k(s, g) ON t.source_id = k.s AND t.slug = k.g
       WHERE t.deleted_at IS NULL${excludePrivate ? ` AND ${privatePagesFilterForCaller('t')}` : ''}
    ),
    refs AS MATERIALIZED (
      SELECT DISTINCT l.from_page_id AS id FROM links l WHERE l.to_page_id IN (SELECT id FROM tgt)${excludePrivate ? ` AND ${privateLinkOriginFilterForCaller('l')}` : ''}
    ),
    typed AS MATERIALIZED (
      SELECT f.id, f.slug, f.source_id, f.type,
             COALESCE(f.effective_date, f.updated_at) AS d,
             COALESCE(($5::text[])[array_position($4::text[], f.type)], NULLIF(f.type, ''), 'untyped') AS canonical_type
        FROM pages f
       WHERE f.id IN (SELECT id FROM refs)
         AND f.deleted_at IS NULL AND f.source_id = ANY($3::text[])
         AND f.id NOT IN (SELECT id FROM tgt)${excludePrivate ? ` AND ${privatePagesFilterFastForCaller('f')}` : ''} AND ${pageEligibleSql('f', floored ? { floor: 'operator_curated' } : undefined)} AND ${quarantineFilterFragment('f')}
    )`;
}

/** sync-holds.ts READ_HOLD_RECORD_SQL at 8bfcd19ad8, verbatim. */
const READ_HOLD_RECORD_SQL = `CASE WHEN COALESCE(s.config->>'mirror_read_only','false')='true' THEN jsonb_set(h.completed_keys->0,'{read_only_checkout}','true'::jsonb) ELSE h.completed_keys->0 END`;

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
