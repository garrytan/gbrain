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
import { CREDENTIAL_SQL } from '../src/core/engine-sql/access-credentials.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { markedScopeSources } from '../src/core/access/attest-sources.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { resolveTokenGrant, touchTokenLastUsed } from '../src/core/grants/legacy-token.ts';
import { OAuthGrants } from '../src/core/oauth-grants.ts';
import { OAUTH_TOKEN_SQL } from '../src/core/engine-sql/access-credentials.ts';
import { hashToken } from '../src/core/utils.ts';
import { activationSuppressedSql, pageEligibleSql } from '../src/core/eligibility/sql.ts';
import { trustRankSql } from '../src/core/trust/tier.ts';
import { grantedPrivateFactSql, memberFactAdmitSql } from '../src/core/access/member-facts.ts';
import { withCallerAccess } from '../src/core/search/private-visibility.ts';
import { quarantineFilterFragment } from '../src/core/quarantine.ts';
import { MANAGED_MODE_SQL } from '../src/core/persistence/managed-mode.ts';
import { pageReadFilter } from '../src/core/search/read-policy-sql.ts';
import type { TrustTier } from '../src/core/trust/tier.ts';
import { privateFactFilterForReader } from '../src/core/search/private-visibility.ts';
import { projectionEligibleSql } from '../src/core/eligibility/sql.ts';
import { SAVED_FACT_COLLAPSE_COLUMNS } from '../src/core/search/saved-fact-collapse.ts';
import { PINNED_QUESTION_MARKER } from '../src/core/questions/identity.ts';
import { MAX_ANCHORED } from '../src/core/search/entity-anchor.ts';

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
         SELECT * FROM typed t WHERE t.canonical_type = c.canonical_type ORDER BY t.d DESC NULLS LAST, t.source_id, t.slug LIMIT $6
       ) x
      ORDER BY c.canonical_type, x.d DESC NULLS LAST, x.source_id, x.slug`],
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
      WHERE ($6::text IS NULL OR canonical_type = $6 OR type = $6)${cursor ? ` AND ((d IS NOT DISTINCT FROM $7::text::timestamptz AND (source_id, slug) > ($8::text, $9::text))
                OR ($7::text::timestamptz IS NOT NULL AND (d < $7::text::timestamptz OR d IS NULL)))` : ''}
      ORDER BY d DESC NULLS LAST, source_id, slug LIMIT $${cursor ? 10 : 7}`],
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
          ORDER BY t.d DESC NULLS LAST, t.source_id, t.slug LIMIT $8
       ) x
      ORDER BY x.i, x.d DESC NULLS LAST, x.source_id, x.slug`],
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
    from: 'src/core/facts/derivation-inputs.ts:39 recordDerivationInputs, at 30232f54c3 (member ported from a359a2201b)',
    case: { method: 'recordDerivationEdges', variant: 'default', run: e => e.recordDerivationEdges({ table: 'facts', id: '7' }, 's1', [{ table: 'pages', id: '3' }, { table: 'facts', id: '2' }]) },
    texts: [`INSERT INTO derivation_inputs(derived_table,derived_id,input_table,input_id,source_id)
    SELECT $1,$2,e.input_table,e.input_id,$3 FROM jsonb_to_recordset($4::text::jsonb) AS e(input_table text,input_id text)
    ON CONFLICT DO NOTHING`],
  },
  {
    from: 'src/core/belief/writers.ts:41 ontologyStreamSlugs, at 432ac446f4',
    case: { method: 'listOntologyStreamSlugs', variant: 'default', run: e => e.listOntologyStreamSlugs('default', 'people/a', 'role') },
    texts: [`SELECT DISTINCT source_markdown_slug AS slug FROM facts
    WHERE source_id = $1 AND entity_slug = $2 AND dimension = $3 AND expired_at IS NULL AND valid_until IS NULL AND COALESCE(source, '') NOT LIKE 'cli:extract-conversation-facts%'`],
  },
  {
    from: 'src/core/trust/supersede-handlers.ts:169 contestOntologySupersession, at 432ac446f4',
    case: { method: 'readOntologyRival', variant: 'default', run: e => e.readOntologyRival('default', 'people/a', 'role', 1) },
    texts: [`SELECT id, trust_tier FROM facts WHERE source_id = $1 AND entity_slug = $2 AND dimension = $3 AND id <> $4
       AND expired_at IS NULL AND valid_until IS NULL AND (dim_status IS NULL OR dim_status = 'active') AND COALESCE(source, '') NOT LIKE 'cli:extract-conversation-facts%'
     ORDER BY valid_from DESC NULLS LAST, confidence DESC, id DESC LIMIT 1`],
  },
  {
    from: 'src/core/eligibility/activation.ts:57 activationVerdicts (facts), at d2671f1342',
    case: { method: 'listActivationVerdictRows', variant: 'facts', run: e => e.listActivationVerdictRows('facts', [1, 2]) },
    texts: () => [`SELECT a.id, a.trust_tier, ${activationSuppressedSql('facts', 'a')} AS flagged FROM facts a WHERE a.id = ANY($1::bigint[])`],
  },
  {
    from: 'src/core/eligibility/activation.ts:57 activationVerdicts (takes), at d2671f1342',
    case: { method: 'listActivationVerdictRows', variant: 'takes', run: e => e.listActivationVerdictRows('takes', [1]) },
    texts: () => [`SELECT a.id, a.trust_tier, ${activationSuppressedSql('takes', 'a')} AS flagged FROM takes a WHERE a.id = ANY($1::bigint[])`],
  },
  {
    from: 'src/core/eligibility/activation.ts:57 activationVerdicts (timeline_entries), at d2671f1342',
    case: { method: 'listActivationVerdictRows', variant: 'timeline_entries', run: e => e.listActivationVerdictRows('timeline_entries', [1]) },
    texts: () => [`SELECT a.id, a.trust_tier, ${activationSuppressedSql('timeline_entries', 'a')} AS flagged FROM timeline_entries a WHERE a.id = ANY($1::bigint[])`],
  },
  {
    from: 'src/core/eligibility/activation.ts:57 activationVerdicts (pages), at d2671f1342',
    case: { method: 'listActivationVerdictRows', variant: 'pages', run: e => e.listActivationVerdictRows('pages', [1]) },
    texts: () => [`SELECT a.id, a.trust_tier, ${activationSuppressedSql('pages', 'a')} AS flagged FROM pages a WHERE a.id = ANY($1::bigint[])`],
  },
  {
    from: 'src/core/belief/writers.ts:29 beliefStreamSlugs (facts), at d2671f1342',
    case: { method: 'listBeliefStreamSlugs', variant: 'facts', run: e => e.listBeliefStreamSlugs('facts', [1, 2]) },
    texts: ['SELECT COALESCE(source_markdown_slug, entity_slug) AS slug FROM facts WHERE id = ANY($1::bigint[])'],
  },
  {
    from: 'src/core/belief/writers.ts:29 beliefStreamSlugs (takes), at d2671f1342',
    case: { method: 'listBeliefStreamSlugs', variant: 'takes', run: e => e.listBeliefStreamSlugs('takes', [1]) },
    texts: ['SELECT p.slug FROM takes t JOIN pages p ON p.id = t.page_id WHERE t.id = ANY($1::bigint[])'],
  },
  {
    from: 'src/core/belief/writers.ts:29 beliefStreamSlugs (pages), at d2671f1342',
    case: { method: 'listBeliefStreamSlugs', variant: 'pages', run: e => e.listBeliefStreamSlugs('pages', [1]) },
    texts: ['SELECT slug FROM pages WHERE id = ANY($1::int[])'],
  },
  {
    from: 'src/core/search/transcript-quote.ts:511 ownerTierFacts, at d2671f1342',
    case: { method: 'listFactIdsAtTrustRank', variant: 'default', run: e => e.listFactIdsAtTrustRank([1, 2], 5) },
    texts: () => [`SELECT id FROM facts WHERE id = ANY($1::bigint[]) AND ${trustRankSql('trust_tier')} >= $2`],
  },
  {
    from: 'src/core/trust/privacy-hold-reply.ts:67 hiddenHoldRefs (a private-facts grant), at d2671f1342',
    case: { method: 'listUnreadablePrivacyHoldIds', variant: 'granted', run: e => withCallerAccess({ privateFactSources: ['default'] }, () => e.listUnreadablePrivacyHoldIds([1, 2])) },
    texts: () => withCallerAccess({ privateFactSources: ['default'] }, () => {
      const admits = [memberFactAdmitSql('f'), grantedPrivateFactSql('f')];
      return [`SELECT tp.id FROM trust_proposals tp LEFT JOIN facts f ON tp.target_table = 'facts' AND f.id = tp.target_id
        WHERE tp.id = ANY($1::bigint[]) AND tp.action = 'supersede_fact' AND tp.before_state->'visibility' IS NOT NULL
          AND (f.id IS NULL OR NOT (${admits.join(' OR ')}))`];
    }),
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
      from: `src/core/entities/resolve.ts:519 resolveStrictEntityReference same name (privacy ${privacy})`,
      case: { method: 'readTrigramCandidates', variant: `same_name_${privacy}`, run: e => e.readTrigramCandidates('default', { arm: 'same_name', titleLc: 'alice example', slugFragment: 'alice-example', privacy }) },
      texts: () => [`SELECT p.slug, p.title, p.type FROM pages p
          WHERE p.source_id = $1 AND p.deleted_at IS NULL ${predicate()} AND NOT ${retiredPageSql('p')}
            AND (lower(p.title) % $2 OR p.slug ILIKE '%' || $3 || '%')
          ORDER BY GREATEST(similarity(lower(p.title), $2), similarity(p.slug, $3)) DESC, p.slug ASC
          LIMIT 5`],
    },
    {
      from: `src/core/entities/resolve.ts:567 entityReferenceCandidates near (privacy ${privacy})`,
      case: { method: 'readTrigramCandidates', variant: `near_${privacy}`, run: e => e.readTrigramCandidates('default', { arm: 'near', titleLc: 'alice example', slugFragment: 'alice-example', privacy }) },
      texts: () => [`SELECT p.slug, p.title, p.type FROM pages p
      WHERE p.source_id = $1 AND p.deleted_at IS NULL AND NOT ${retiredPageSql('p')} ${predicate()}
        AND (lower(p.title) % $2 OR p.slug ILIKE '%' || $3 || '%')
      ORDER BY GREATEST(similarity(lower(p.title), $2), similarity(p.slug, $3)) DESC, p.slug ASC
      LIMIT 20`],
    },
  ]),
  {
    from: 'src/core/entities/resolve.ts:857 tryFuzzyMatch',
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
       ORDER BY score DESC, slug ASC
       LIMIT 5`],
  },
  {
    from: 'src/core/entities/resolve.ts:686 findPrefixCandidates',
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
       ORDER BY connection_count DESC, p.slug ASC
       LIMIT 10`],
  },
  {
    from: 'src/core/entities/resolve.ts:769 tryPrefixExpansion',
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
         ORDER BY connection_count DESC, p.slug ASC
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
    from: `src/core/entities/resolve.ts:552 entityReferenceCandidates named (privacy ${privacy})`,
    case: { method: 'readNamedEntitySlugs', variant: privacy, run: e => e.readNamedEntitySlugs('default', ['companies/acme', 'orgs/acme'], privacy) },
    texts: () => [`SELECT p.slug FROM pages p
      WHERE p.source_id = $1 AND p.deleted_at IS NULL AND NOT ${retiredPageSql('p')} AND p.slug = ANY($2::text[]) ${predicate()}
      ORDER BY p.slug LIMIT 5`],
  })),
  ...([
    ['all', {}],
    ['sources-run', { sourceIds: ['default'], runId: 'run-1' }],
  ] as const).map(([variant, opts]): Pin => ({
    from: `src/core/persistence/sync-holds.ts:575 readGitSourceHolds (${variant}, at f549f444af)`,
    case: { method: 'readGitHoldRecords', variant, run: e => e.readGitHoldRecords(opts) },
    texts: () => [`SELECT ${READ_HOLD_RECORD_SQL} AS record FROM op_checkpoints h
    JOIN sources s ON s.id=h.completed_keys->0->>'source_id' AND s.incarnation::text=h.completed_keys->0->>'incarnation'
    WHERE h.op=$1 AND ($2::text[] IS NULL OR s.id=ANY($2::text[])) AND ($3::text IS NULL OR h.completed_keys->0->>'run_id'=$3)
    ORDER BY s.id COLLATE "C",h.fingerprint`],
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
    // An equivalent statement: the caller read `created_at` alone; the member also reads `archived`, which the check ignores.
    from: 'src/core/persistence/sync-authority.ts:122 validateSyncAuthority (SELECT created_at FROM sources WHERE id=$1)',
    case: { method: 'readJobSourceState', variant: 'default', run: e => e.readJobSourceState('default') },
    texts: ['SELECT archived, created_at FROM sources WHERE id = $1'],
  },
  {
    from: 'src/core/persistence/sync-holds.ts:1186 readGitHoldRetryPaths',
    case: { method: 'readGitHoldRetryRequest', variant: 'default', run: e => e.readGitHoldRetryRequest('default:1') },
    texts: ['SELECT completed_keys FROM op_checkpoints WHERE op=$1 AND fingerprint=$2'],
  },
  {
    from: 'src/core/reason-trailers.ts:151 scanSyncReasons',
    case: { method: 'readReasonPurgeTombstones', variant: 'default', run: e => e.readReasonPurgeTombstones('default') },
    texts: ['SELECT commit_sha, path FROM reason_purge_tombstones WHERE source_id = $1'],
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
    from: 'src/core/reason-trailers.ts:151 scanSyncReasons',
    case: { method: 'readReasonPurgeTombstones', variant: 'default', run: e => e.readReasonPurgeTombstones('default') },
    texts: ['SELECT commit_sha, path FROM reason_purge_tombstones WHERE source_id = $1'],
  },
  {
    from: 'src/core/reason-trailers.ts:262 cachedSyncReasonScan',
    case: { method: 'readSourcePurgeEpoch', variant: 'default', run: e => e.readSourcePurgeEpoch('default') },
    texts: ['SELECT purge_epoch FROM sources WHERE id = $1'],
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
    from: 'src/core/notifier/status.ts:130 readNotifierBlock (the markers; at f24fef9a03)',
    case: { method: 'listSourceWantedMarkers', variant: 'default', run: e => e.listSourceWantedMarkers('source-a') },
    texts: ['SELECT intent, wanted_head, first_due_at, requested_by FROM sync_wanted_markers WHERE source_id = $1 ORDER BY first_due_at, intent'],
  },
  {
    from: 'src/core/persistence/semantic-pages.ts:101 prepareSemanticPageMutation (the flagged entry\'s row id; at 0740badd2c)',
    case: { method: 'readNewestTimelineEntryId', variant: 'default', run: e => e.readNewestTimelineEntryId('default', 'people/alice-example', '2026-01-02', 'Met for coffee') },
    texts: [`SELECT t.id FROM timeline_entries t JOIN pages p ON p.id = t.page_id
      WHERE p.source_id = $1 AND p.slug = $2 AND t.date = $3::date AND t.summary = $4 ORDER BY t.id DESC LIMIT 1`],
  },
  {
    from: 'src/core/mentions/newer-mentions.ts:77 readNewerMentions (the entity page date; at d1ec6f64c1)',
    case: { method: 'readPageReferenceDate', variant: 'default', run: e => e.readPageReferenceDate('default', 'people/alice-example') },
    texts: [`SELECT to_char(COALESCE(effective_date, updated_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS d
         FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL`],
  },
  {
    from: 'src/core/search/saved-facts-match.ts:58 headStems (the english configuration; at d1ec6f64c1)',
    case: { method: 'matchHeadStems', variant: 'default', run: e => e.matchHeadStems(['widget'], ['widgets']) },
    texts: [`SELECT h, ARRAY(SELECT t.i FROM unnest($2::text[]) WITH ORDINALITY AS t(term, i)
       WHERE to_tsvector('english'::regconfig, h) @@ plainto_tsquery('english'::regconfig, t.term)) AS i
     FROM unnest($1::text[]) AS h`],
  },
  {
    from: 'src/core/search/ignored-privacy-labels.ts:179 withIgnoredPrivacyLabelNotice (the stored page; at efeb078093)',
    case: { method: 'readLivePageFrontmatter', variant: 'default', run: e => e.readLivePageFrontmatter('default', 'people/alice-example') },
    // The caller's NOTICE_READ_TIMEOUT_MS bound rides along: the same server-side envelope its executeRaw call sent.
    texts: ['BEGIN READ WRITE; SET LOCAL statement_timeout = 1000',
      'SELECT type, frontmatter FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL', 'COMMIT'],
  },
  {
    from: 'src/core/ops/search-type-filter.ts:42 reconcileTypeFilter (a remote caller, one empty set; at efeb078093)',
    case: { method: 'probePageTypes', variant: 'remote', run: e => e.probePageTypes([['person', 'people'], [], ['deal']], { sourceId: 'default', excludePrivate: true }) },
    // The caller's JIT-off bound rides along: the same server-side envelope its executeRaw call sent.
    texts: () => ["SELECT current_setting('jit') AS jit", 'BEGIN READ WRITE; SET LOCAL jit = off', pinnedTypeProbe([['person', 'people'], [], ['deal']], { sourceId: 'default', excludePrivate: true }), 'COMMIT'],
  },
  {
    from: 'src/core/ops/search-type-filter.ts:42 reconcileTypeFilter (federated sources under a trust floor; at efeb078093)',
    case: { method: 'probePageTypes', variant: 'floored', run: e => e.probePageTypes([['note']], { sourceIds: ['default', 'wiki'], minTrust: 'operator_curated' }) },
    // The caller's JIT-off bound rides along: the same server-side envelope its executeRaw call sent.
    texts: () => ["SELECT current_setting('jit') AS jit", 'BEGIN READ WRITE; SET LOCAL jit = off', pinnedTypeProbe([['note']], { sourceIds: ['default', 'wiki'], minTrust: 'operator_curated' }), 'COMMIT'],
  },
  {
    from: 'src/core/search/entity-facts.ts:53 newestFacts (a local caller under a trust floor; at efeb078093)',
    case: { method: 'readEntityNewestFacts', variant: 'local', run: e => e.readEntityNewestFacts({ sourceId: 'default', slugs: ['people/alice-example'], remote: false, worldOnly: false, minTrust: 'operator_curated' }) },
    texts: () => [pinnedNewestFacts(false, false, 'operator_curated')],
  },
  {
    from: 'src/core/search/entity-facts.ts:53 newestFacts (a remote caller with world-only facts; at efeb078093)',
    case: { method: 'readEntityNewestFacts', variant: 'remote', run: e => e.readEntityNewestFacts({ sourceId: 'default', slugs: ['people/alice-example', 'alice-example'], remote: true, worldOnly: true }) },
    texts: () => [pinnedNewestFacts(true, true)],
  },
  {
    from: 'src/core/search/entity-facts.ts:53 newestFacts (a remote caller with private facts allowed; at efeb078093)',
    case: { method: 'readEntityNewestFacts', variant: 'remotePrivate', run: e => e.readEntityNewestFacts({ sourceId: 'default', slugs: ['people/alice-example'], remote: true, worldOnly: false }) },
    texts: () => [pinnedNewestFacts(true, false)],
  },
  {
    from: 'src/core/search/entity-anchor.ts:38 and :42 entityAnchoredPages (the entity page, then the anchored pages; at efeb078093)',
    case: { method: 'readEntityAnchoredPages', variant: 'default', run: e => e.readEntityAnchoredPages('default', 'people/alice-example') },
    // The second statement is written out in engine-sql (the dynamic-SQL guard allows `$4` twice only in a static
    // statement); the caller's interpolations are rebuilt here from their constants, so a drift in either fails.
    texts: () => ['SELECT id, title FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL',
      `SELECT p.id, p.slug FROM pages p WHERE p.source_id = $1 AND p.deleted_at IS NULL AND p.slug <> $2
       AND p.type NOT IN ('question', 'synthesis') AND NOT (p.frontmatter ? '${PINNED_QUESTION_MARKER}')
       AND (p.compiled_truth ~* $3 OR ($4::integer IS NOT NULL AND EXISTS (SELECT 1 FROM links l WHERE l.from_page_id = p.id AND l.to_page_id = $4::integer AND ${rankingLinkSql('l')})))
     ORDER BY COALESCE(p.effective_date, p.updated_at) DESC, p.id DESC LIMIT ${MAX_ANCHORED}`],
  },
  {
    from: 'src/core/search/entity-anchor.ts:116 applyEntityAnchoring (the anchored page titles; at efeb078093)',
    case: { method: 'readPageTitlesById', variant: 'default', run: e => e.readPageTitlesById([1, 2]) },
    texts: ['SELECT id, title FROM pages WHERE id = ANY($1::int[])'],
  },
];

/** search/entity-facts.ts newestFacts's statement at efeb078093, verbatim (`worldOnly` stands for `worldOnlyFacts(opts.remote)`). */
function pinnedNewestFacts(remote: boolean, worldOnly: boolean, minTrust?: TrustTier): string {
  const visibility = remote ? `${worldOnly ? `AND (f.visibility = 'world' OR ${grantedPrivateFactSql('f')})` : ''} AND ${privateFactFilterForReader('f')}` : '';
  return `SELECT f.id, f.fact, f.entity_slug, f.kind, f.valid_from::text AS valid_from, f.source, ${SAVED_FACT_COLLAPSE_COLUMNS}
       FROM facts f
      WHERE f.source_id = $1 AND f.entity_slug = ANY($2::text[])
        AND f.expired_at IS NULL AND (f.valid_until IS NULL OR f.valid_until > now())
        AND f.source != ALL($3::text[])
        ${visibility}
        AND ${projectionEligibleSql('facts', 'f', { floor: minTrust })}
      ORDER BY f.valid_from DESC, f.id DESC
      LIMIT 50`;
}

/** ops/search-type-filter.ts reconcileTypeFilter's probe statement at efeb078093, verbatim (`{ ...scope, excludePrivate }`). */
function pinnedTypeProbe(expanded: string[][], scope: { sourceId?: string; sourceIds?: string[]; minTrust?: TrustTier; excludePrivate?: boolean }): string {
  const params: unknown[] = [];
  const filter = pageReadFilter('p', scope, params, true);
  const probes = expanded.flatMap((set, i) => {
    if (set.length === 0) return [];
    params.push(set);
    return [{ name: `t${i}`, sql: `EXISTS (SELECT 1 FROM pages p WHERE ${filter} AND p.type = ANY($${params.length}::text[])) AS t${i}` }];
  });
  return `SELECT probe.*, CASE WHEN ${probes.map(p => `probe.${p.name}`).join(' AND ')} THEN NULL
         ELSE ARRAY(SELECT DISTINCT p.type FROM pages p WHERE ${filter} LIMIT 500) END AS available
       FROM (SELECT ${probes.map(p => p.sql).join(', ')} OFFSET 0) probe`;
}

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
  // The drift pin: issue() stays on the grant transaction's SqlQuery (it runs under the client row lock, so an engine
  // write on another connection would wait on the foreign key and deadlock), so the member's constant text and
  // parameter order must keep matching the templates it was captured from. The refresh token is the second INSERT.
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
