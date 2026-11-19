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
import { boundedBodyPrefixSql } from '../src/core/page-window/bounded-lead.ts';
import { callerAccessAllowedSql, privateLinkOriginFilterForCaller, privatePagesFilterFastForCaller, privatePagesFilterForCaller, remoteReadFloorSql } from '../src/core/search/private-visibility.ts';
import { activationSuppressedSql, pageEligibleSql } from '../src/core/eligibility/sql.ts';
import { quarantineFilterFragment } from '../src/core/quarantine.ts';

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
  {
    from: 'src/core/verbs/entity-card.ts:691 assembleCard open loops',
    case: { method: 'readEntityOpenLoops', variant: 'default', run: e => e.readEntityOpenLoops('people/alice-example', 'default', 3) },
    texts: [`SELECT id, loop_type, summary, due_at, last_activity_at, fact_id
       FROM open_loops
       WHERE status = 'open' AND counterparty_slug = $1
         AND COALESCE(counterparty_source_id, source_id) = $2
       ORDER BY last_activity_at DESC
       LIMIT 3`],
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
