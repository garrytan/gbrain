/**
 * Byte-identical pins for the caller raw SQL that became typed engine members (Rust engine lane 11).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member sends Postgres exactly the statement text its caller ran through `executeRaw` before the
 *    move. Each expected text below is copied verbatim from the caller at 7470c703ed, except where a pin's comment
 *    names an equivalent statement.
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
import { rankingLinkSql } from '../src/core/link-ranking-policy.ts';
import { boundedBodyPrefixSql } from '../src/core/page-window/bounded-lead.ts';
import { MANAGED_MODE_SQL } from '../src/core/persistence/managed-mode.ts';
import { callerAccessAllowedSql, privateLinkOriginFilterForCaller, privatePagesFilterForCaller, remoteReadFloorSql } from '../src/core/search/private-visibility.ts';

interface Pin {
  /** The caller site the statement came from, at 7470c703ed. */
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
    from: `src/core/persistence/sync-holds.ts:575 readGitSourceHolds (${variant})`,
    case: { method: 'readGitHoldRecords', variant, run: e => e.readGitHoldRecords(opts) },
    texts: () => [`SELECT ${READ_HOLD_RECORD_SQL} AS record FROM op_checkpoints h
    JOIN sources s ON s.id=h.completed_keys->0->>'source_id' AND s.incarnation::text=h.completed_keys->0->>'incarnation'
    WHERE h.op=$1 AND ($2::text[] IS NULL OR s.id=ANY($2::text[])) AND ($3::text IS NULL OR h.completed_keys->0->>'run_id'=$3)
    ORDER BY s.id,h.fingerprint`],
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
];

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
