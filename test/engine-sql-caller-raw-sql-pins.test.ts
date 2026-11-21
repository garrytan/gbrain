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
import { accessAllowedSql, callerAccessAllowedSql, folderRulesAllowedSql, privacyPartSql, privateLinkOriginFilterForCaller, privatePagesFilterForCaller, privateSnapshotFilterFragment, readersAllowedSql, remoteReadFloorSql } from '../src/core/search/private-visibility.ts';
import { ownerOnlyPageSql } from '../src/core/access/owner-only.ts';
import { ruleCoversSql } from '../src/core/access/folder-rules.ts';
import { OPEN_TWINS_PAGES } from '../src/core/access/open-twins.ts';

/** caller.ts MEMBER_SQL at 7470c703ed: MEMBERS_WHERE_SQL(`m.id = (${member})`), copied verbatim. */
const memberSql = (member: string) => `SELECT m.id, COALESCE(array_agg(g.group_id ORDER BY g.group_id) FILTER (WHERE g.group_id IS NOT NULL), '{}') AS groups
  FROM access_members m LEFT JOIN access_group_members g ON g.member_id = m.id
  WHERE m.id = (${member}) AND m.disabled_at IS NULL AND m.tombstoned_at IS NULL
  GROUP BY m.id`;

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
    from: 'src/core/access/caller.ts:94 liveIdentity (member id: :120 stdioMember, :146 stdioMemberIdentity)',
    case: { method: 'readLiveMember', variant: 'member', run: e => e.readLiveMember('member', 'alice-example') },
    texts: [memberSql('$1')],
  },
  {
    from: 'src/core/access/caller.ts:94 liveIdentity (stdio config: :121)',
    case: { method: 'readLiveMember', variant: 'stdio-config', run: e => e.readLiveMember('stdio_config', 'mcp.stdio_member') },
    texts: [memberSql(`SELECT ${edgeTrimSql('value')} FROM config WHERE key = $1`)],
  },
  {
    from: 'src/core/access/caller.ts:94 liveIdentity (legacy token: :123)',
    case: { method: 'readLiveMember', variant: 'legacy-token', run: e => e.readLiveMember('legacy_token', 'tok-1') },
    texts: [memberSql('SELECT member_id FROM access_tokens WHERE id::text = $1 AND revoked_at IS NULL')],
  },
  {
    from: 'src/core/access/caller.ts:94 liveIdentity (OAuth client: :123)',
    case: { method: 'readLiveMember', variant: 'oauth-client', run: e => e.readLiveMember('oauth_client', 'client-1') },
    texts: [memberSql('SELECT member_id FROM oauth_clients WHERE client_id = $1 AND deleted_at IS NULL')],
  },
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
    // The version-aware test (ownerOnlyLineageReadable): a current schema reads the lineage function; below v320 the source test alone.
    texts: ['SELECT gbrain_owner_only_lineage() AS present'],
  },
  {
    from: 'src/core/access/owner-only.ts:66 sourceIsOwnerOnly',
    case: { method: 'readOwnerOnlySourceConfig', variant: 'default', run: e => e.readOwnerOnlySourceConfig('default') },
    texts: ['SELECT config FROM sources WHERE id = $1'],
  },
  {
    from: 'src/core/access/open-pages.ts:190 openPages at 8d2e667543 (the open-page count, rendered in the pinned access context)',
    case: { method: 'countOpenPages', variant: 'default', run: e => e.countOpenPages(['default'], [{ source: 'default', prefix: 'x/' }]) },
    texts: () => [`SELECT p.source_id AS source, CASE WHEN strpos(p.slug, '/') > 0 THEN split_part(p.slug, '/', 1) ELSE '(root)' END AS folder,
              p.type AS type, (${privacyPartSql('p')}) AS visible, count(*)::int AS pages
         FROM pages p
        WHERE p.deleted_at IS NULL AND ${accessAllowedSql('p', [], [])} AND p.source_id = ANY($1::text[]) AND NOT (p.source_id = $2 AND starts_with(p.slug, $3))
        GROUP BY 1, 2, 3, 4`],
  },
  {
    from: 'src/core/access/open-pages.ts:159 withOpenScope at 8d2e667543 (the folder-rule state check)',
    case: { method: 'readAccessStateUnreadable', variant: 'default', run: e => e.readAccessStateUnreadable() },
    texts: ['SELECT gbrain_access_state_unreadable() AS unreadable'],
  },
  {
    // Equivalent, not verbatim: the caller ran `SELECT id FROM sources ORDER BY id`; the member sorts by byte order
    // (COLLATE "C") so the three engines list source ids in one order whatever the database collation.
    from: 'src/core/access/open-pages.ts:167 withOpenScope at 8d2e667543 (every source when no member reads one)',
    case: { method: 'listSourceIds', variant: 'default', run: e => e.listSourceIds() },
    texts: ['SELECT id FROM sources ORDER BY id COLLATE "C"'],
  },
  ...(['mode', 'fn', 'closed'] as const).map(form => ({
    from: `src/commands/access.ts:183 whoCanRead at 8d2e667543 (every row of the slug, owner-only form ${form})`,
    case: { method: 'listWhoCanReadPages', variant: `all-sources-${form}`, run: (e: Parameters<SqlCase['run']>[0]) => e.listWhoCanReadPages('notes/a', undefined, form) },
    texts: () => [`SELECT p.slug, p.source_id, p.type, p.frontmatter, p.folder_rule_ids, ${ownerOnlyPageSql('p', form)} AS owner_only
       FROM pages p WHERE p.slug = $1 ORDER BY p.source_id`],
  })),
  {
    from: 'src/commands/access.ts:183 whoCanRead at 8d2e667543 (the rows of the slug in one source)',
    case: { method: 'listWhoCanReadPages', variant: 'one-source', run: e => e.listWhoCanReadPages('notes/a', 'default', 'mode') },
    texts: () => [`SELECT p.slug, p.source_id, p.type, p.frontmatter, p.folder_rule_ids, ${ownerOnlyPageSql('p', 'mode')} AS owner_only
       FROM pages p WHERE p.slug = $1 AND p.source_id = $2 ORDER BY p.source_id`],
  },
  {
    from: 'src/commands/access.ts:211 whoCanRead at 8d2e667543 (does the read path admit one member)',
    case: { method: 'readPageAdmitsCaller', variant: 'member', run: e => e.readPageAdmitsCaller('default', 'notes/a', ['alice-example', 'group:team-a']) },
    texts: () => [`SELECT 1 FROM pages p WHERE p.source_id = $1 AND p.slug = $2 AND ${accessAllowedSql('p', ['alice-example', 'group:team-a'])}`],
  },
  {
    from: 'src/commands/access.ts:222 whoCanRead at 8d2e667543 (do the owner\'s folder rules admit an audience page)',
    case: { method: 'readPageFolderRulesAdmit', variant: 'rules', run: e => e.readPageFolderRulesAdmit('default', 'notes/a', ['default:r1']) },
    texts: () => [`SELECT 1 FROM pages p WHERE p.source_id = $1 AND p.slug = $2 AND ${folderRulesAllowedSql('p', ['default:r1'])}`],
  },
  {
    from: 'src/commands/access.ts:225 whoCanRead at 8d2e667543 (the rules that keep derived rows to their readers)',
    case: { method: 'countLineageClosingRules', variant: 'default', run: e => e.countLineageClosingRules(['default:r1'], 'default') },
    texts: ["SELECT count(*)::int AS n FROM unnest($1::text[]) AS x WHERE NOT EXISTS (SELECT 1 FROM access_rules r WHERE r.source_id = $2 AND x = $2 || ':' || r.rule_id AND NOT r.covers_derived)"],
  },
  {
    from: 'src/core/access/members.ts:226-229 addMember at 8d2e667543 (the member, its groups and its group members, one transaction; ensureGroups at :188)',
    case: { method: 'insertAccessMember', variant: 'groups', run: e => e.insertAccessMember({ id: 'alice-example', displayName: 'Alice', email: null, kind: 'person', groups: ['team-a'], bindTokenId: null }) },
    texts: ['INSERT INTO access_members (id, display_name, email, kind) VALUES ($1, $2, $3, $4)', 'INSERT INTO access_groups (id) VALUES ($1) ON CONFLICT (id) DO NOTHING RETURNING id',
      'INSERT INTO access_group_members (group_id, member_id) VALUES ($1, $2) ON CONFLICT DO NOTHING'],
  },
  {
    from: 'src/core/access/members.ts:227-230 addMember at 8d2e667543 (with --bind-token: the token bound in the same transaction)',
    case: { method: 'insertAccessMember', variant: 'bind-token', run: e => e.insertAccessMember({ id: 'alice-example', displayName: null, email: null, kind: 'person', groups: [], bindTokenId: 'tok-1' }) },
    texts: ['INSERT INTO access_members (id, display_name, email, kind) VALUES ($1, $2, $3, $4)', 'UPDATE access_tokens SET member_id = $2 WHERE id::text = $1'],
  },
  ...([true, false] as const).map(disabled => ({
    from: `src/core/access/members.ts:238 setDisabled at 8d2e667543 (${disabled ? 'disable' : 'enable'})`,
    case: { method: 'setAccessMemberDisabled', variant: disabled ? 'disable' : 'enable', run: (e: Parameters<SqlCase['run']>[0]) => e.setAccessMemberDisabled('alice-example', disabled) },
    texts: [`UPDATE access_members SET disabled_at = ${disabled ? 'COALESCE(disabled_at, now())' : 'NULL'}, updated_at = now() WHERE id = $1`],
  })),
  {
    from: 'src/core/access/members.ts:252 setMemberEmail at 8d2e667543',
    case: { method: 'setAccessMemberEmail', variant: 'default', run: e => e.setAccessMemberEmail('alice-example', 'a@example.com') },
    texts: ['UPDATE access_members SET email = $2, updated_at = now() WHERE id = $1 AND tombstoned_at IS NULL RETURNING id'],
  },
  {
    from: 'src/core/access/members.ts:284 setMemberKind at 8d2e667543',
    case: { method: 'setAccessMemberKind', variant: 'default', run: e => e.setAccessMemberKind('alice-example', 'audience') },
    texts: ['UPDATE access_members SET kind = $2, updated_at = now() WHERE id = $1 AND tombstoned_at IS NULL'],
  },
  {
    from: 'src/core/access/labelled-only.ts:41 setMemberLabelledOnly at 8d2e667543',
    case: { method: 'setAccessMemberLabelledOnly', variant: 'default', run: e => e.setAccessMemberLabelledOnly('alice-example', true) },
    texts: ['UPDATE access_members SET labelled_only = $2, updated_at = now() WHERE id = $1 AND tombstoned_at IS NULL'],
  },
  {
    from: 'src/core/access/members.ts:326-327 removeMember at 8d2e667543 (one transaction)',
    case: { method: 'tombstoneAccessMember', variant: 'default', run: e => e.tombstoneAccessMember('alice-example') },
    texts: ['UPDATE access_members SET tombstoned_at = now(), disabled_at = COALESCE(disabled_at, now()), email = NULL, updated_at = now() WHERE id = $1',
      'DELETE FROM access_group_members WHERE member_id = $1'],
  },
  {
    from: 'src/core/access/members.ts:358-360 addGroup at 8d2e667543 (one transaction; ensureGroups at :188)',
    case: { method: 'addAccessGroupMembers', variant: 'default', run: e => e.addAccessGroupMembers('team-a', ['alice-example']) },
    texts: ['INSERT INTO access_groups (id) VALUES ($1) ON CONFLICT (id) DO NOTHING RETURNING id', 'INSERT INTO access_group_members (group_id, member_id) VALUES ($1, $2) ON CONFLICT DO NOTHING'],
  },
  {
    from: 'src/core/access/members.ts:368 removeGroupMembers at 8d2e667543 (one statement per member)',
    case: { method: 'removeAccessGroupMembers', variant: 'default', run: e => e.removeAccessGroupMembers('team-a', ['alice-example', 'bob-example']) },
    texts: ['DELETE FROM access_group_members WHERE group_id = $1 AND member_id = $2', 'DELETE FROM access_group_members WHERE group_id = $1 AND member_id = $2'],
  },
  {
    from: 'src/core/access/members.ts:382 removeGroup at 8d2e667543',
    case: { method: 'deleteAccessGroup', variant: 'default', run: e => e.deleteAccessGroup('team-a') },
    texts: ['DELETE FROM access_groups WHERE id = $1'],
  },
  ...(['token', 'client'] as const).flatMap(kind => ([false, true] as const).map(unscoped => ({
    from: `src/core/access/members.ts:432-433 bindCredential at 8d2e667543 (the ${kind} row FOR UPDATE${unscoped ? ', with reads_unscoped' : ''})`,
    case: { method: 'readCredentialBindingForUpdate', variant: `${kind}${unscoped ? '-unscoped' : ''}`, run: (e: Parameters<SqlCase['run']>[0]) => e.readCredentialBindingForUpdate({ kind, id: 'cred-1' }, { readsUnscoped: unscoped }) },
    texts: [`SELECT member_id, may_act_for, attest_actor, attest_ops, attest_sources, attest_read${kind === 'client' ? ', grant_types, client_secret_hash IS NOT NULL AS confidential' : ''}${unscoped ? ', reads_unscoped' : ''} FROM ${kind === 'token' ? 'access_tokens' : 'oauth_clients'} WHERE ${kind === 'token' ? 'id::text' : 'client_id'} = $1 FOR UPDATE`],
  }))),
  ...(['token', 'client'] as const).map(kind => ({
    from: `src/core/access/members.ts:470-471 bindCredential at 8d2e667543 (the ${kind} binding columns)`,
    case: { method: 'writeCredentialBinding', variant: kind, run: (e: Parameters<SqlCase['run']>[0]) => e.writeCredentialBinding({ kind, id: 'cred-1' }, { member: 'alice-example', mayActFor: null, attestActor: null, attestOps: null, attestSources: null, attestRead: null }) },
    texts: [`UPDATE ${kind === 'token' ? 'access_tokens' : 'oauth_clients'} SET member_id = $2, may_act_for = $3::text[], attest_actor = $4, attest_ops = $5::text[], attest_sources = $6::text[], attest_read = $7 WHERE ${kind === 'token' ? 'id::text' : 'client_id'} = $1`],
  })),
  ...(['token', 'client'] as const).map(kind => ({
    from: `src/core/access/members.ts:478 bindCredential at 8d2e667543 (the ${kind} reads_unscoped stamp)`,
    case: { method: 'writeCredentialReadsUnscoped', variant: kind, run: (e: Parameters<SqlCase['run']>[0]) => e.writeCredentialReadsUnscoped({ kind, id: 'cred-1' }, true) },
    texts: [`UPDATE ${kind === 'token' ? 'access_tokens' : 'oauth_clients'} SET reads_unscoped = CASE WHEN $2::boolean THEN now() ELSE NULL END WHERE ${kind === 'token' ? 'id::text' : 'client_id'} = $1`],
  })),
  {
    from: 'src/core/wakeshift/forget.ts:23-27 forgetWakePrincipal (a member) at 8d2e667543',
    case: { method: 'forgetWakeMember', variant: 'default', run: e => e.forgetWakeMember('alice-example') },
    texts: [`INSERT INTO wake_forgets (wake_user) SELECT DISTINCT wake_user FROM wake_subscriptions WHERE member_id = $1
        ON CONFLICT (wake_user) WHERE state = 'pending' DO NOTHING RETURNING id`,
    `UPDATE wake_subscriptions SET state = 'ended', last_error = 'principal_revoked', lease_until = NULL, updated_at = now()
        WHERE member_id = $1 AND state = 'open' RETURNING id`,
    'DELETE FROM wake_terms_acceptances WHERE principal_key = $1'],
  },
  // Equivalent, not verbatim, where marked: the old-line policy statements add COLLATE "C" to the ORDER BY of the rule
  // list, the pending prefixes and the prefix slugs, so they come in byte order whatever the database collation.
  {
    from: "src/core/access/policy.ts:92 readAccessStore at 8d2e667543",
    case: { method: 'readAccessStoreConfig', variant: 'default', run: e => e.readAccessStoreConfig('default') },
    texts: [`SELECT config->>'access_store' AS store FROM sources WHERE id = $1`],
  },
  {
    from: "src/core/access/policy.ts:99 writeAccessStore at 8d2e667543",
    case: { method: 'writeAccessStoreConfig', variant: 'default', run: e => e.writeAccessStoreConfig('default', 'database') },
    texts: [`UPDATE sources SET config = jsonb_set(COALESCE(config, '{}'::jsonb), '{access_store}', to_jsonb($2::text)) WHERE id = $1`],
  },
  {
    from: "src/core/access/policy.ts:104 ensurePolicyState at 8d2e667543",
    case: { method: 'ensureAccessPolicyState', variant: 'default', run: e => e.ensureAccessPolicyState('default') },
    texts: ['INSERT INTO access_policy_state (source_id) VALUES ($1) ON CONFLICT (source_id) DO NOTHING'],
  },
  {
    from: "src/core/access/policy.ts:112-113 lockSource at 8d2e667543",
    case: { method: 'lockAccessPolicy', variant: 'default', run: e => e.lockAccessPolicy('default') },
    texts: ['SELECT 1 FROM sources WHERE id = $1 FOR NO KEY UPDATE', 'SELECT 1 FROM access_policy_state WHERE source_id = $1 FOR UPDATE'],
  },
  {
    from: "src/core/access/policy.ts:118 appliedRules at 8d2e667543 (equivalent: COLLATE \"C\" on the ORDER BY)",
    case: { method: 'listAccessRules', variant: 'default', run: e => e.listAccessRules('default') },
    texts: ['SELECT rule_id, prefix, readable_by, covers_derived FROM access_rules WHERE source_id = $1 ORDER BY rule_id COLLATE "C"'],
  },
  {
    from: "src/core/access/policy.ts:124 listRevisions at 8d2e667543",
    case: { method: 'readAccessPolicyRevisions', variant: 'recent', run: e => e.readAccessPolicyRevisions({ by: 'recent', sourceId: 'default', limit: 50 }) },
    texts: ['SELECT * FROM access_policy_revisions WHERE source_id = $1 ORDER BY revision DESC LIMIT $2'],
  },
  {
    from: "src/core/access/policy.ts:130 getRevision at 8d2e667543 (the newest)",
    case: { method: 'readAccessPolicyRevisions', variant: 'latest', run: e => e.readAccessPolicyRevisions({ by: 'latest', sourceId: 'default' }) },
    texts: ['SELECT * FROM access_policy_revisions WHERE source_id = $1 ORDER BY revision DESC LIMIT 1'],
  },
  {
    from: "src/core/access/policy.ts:131 getRevision at 8d2e667543 (one revision)",
    case: { method: 'readAccessPolicyRevisions', variant: 'revision', run: e => e.readAccessPolicyRevisions({ by: 'revision', sourceId: 'default', revision: 2 }) },
    texts: ['SELECT * FROM access_policy_revisions WHERE source_id = $1 AND revision = $2'],
  },
  {
    from: "src/core/access/policy.ts:246 proposeRevision at 8d2e667543 (the operation id)",
    case: { method: 'readAccessPolicyRevisions', variant: 'operation', run: e => e.readAccessPolicyRevisions({ by: 'operation', operationId: 'op-1' }) },
    texts: ['SELECT * FROM access_policy_revisions WHERE operation_id = $1'],
  },
  {
    from: "src/core/access/policy.ts:137 coverageRows at 8d2e667543 (equivalent: COLLATE \"C\" on the ORDER BY)",
    case: { method: 'listAccessCoverage', variant: 'default', run: e => e.listAccessCoverage('default') },
    texts: ['SELECT prefix, reason, revision, detail FROM access_pending_coverage WHERE source_id = $1 ORDER BY reason COLLATE "C", prefix COLLATE "C"'],
  },
  {
    from: "src/core/access/policy.ts:168-180 installRulebook at 8d2e667543 (deletes, inserts, then pending prefixes)",
    case: { method: 'applyAccessRuleChanges', variant: 'default', run: e => e.applyAccessRuleChanges('default', { remove: ['old'], insert: [{ rule_id: 'r1', prefix: 'notes/', readable_by: ['member:alice-example'], covers_derived: true }], pending: ['notes/'], revision: 2, actor: 'local' }) },
    texts: ['DELETE FROM access_rules WHERE source_id = $1 AND rule_id = $2', 'INSERT INTO access_rules (source_id, rule_id, prefix, readable_by, revision, created_by, covers_derived) VALUES ($1, $2, $3, $4::text[], $5, $6, $7)', `INSERT INTO access_pending_coverage (source_id, prefix, reason, revision) VALUES ($1, $2, 'pending', $3)
      ON CONFLICT (source_id, prefix, reason) DO UPDATE SET revision = EXCLUDED.revision`],
  },
  {
    from: "src/core/access/policy.ts:199 restampSource at 8d2e667543 (one window)",
    case: { method: 'restampAccessWindow', variant: 'default', run: e => e.restampAccessWindow('default', 0, 2000) },
    texts: [`WITH w AS (SELECT id FROM pages WHERE source_id = $1 AND id > $2 ORDER BY id LIMIT $3),
        u AS (UPDATE pages p SET folder_rule_ids = gbrain_access_folder_rules(p.source_id, p.slug) FROM w
              WHERE p.id = w.id AND p.folder_rule_ids IS DISTINCT FROM gbrain_access_folder_rules(p.source_id, p.slug) RETURNING p.id)
      SELECT (SELECT max(id) FROM w) AS last, (SELECT count(*) FROM w)::int AS scanned, (SELECT count(*) FROM u)::int AS changed`],
  },
  {
    from: "src/core/access/policy.ts:213-218 restampSource at 8d2e667543 (the final pass)",
    case: { method: 'finishAccessRestamp', variant: 'default', run: e => e.finishAccessRestamp('default') },
    texts: [`UPDATE pages SET folder_rule_ids = gbrain_access_folder_rules(source_id, slug)
        WHERE source_id = $1 AND folder_rule_ids IS DISTINCT FROM gbrain_access_folder_rules(source_id, slug) RETURNING id`, `DELETE FROM access_pending_coverage WHERE source_id = $1 AND reason = 'pending'`, 'UPDATE access_policy_revisions SET applied_at = now() WHERE source_id = $1 AND applied_at IS NULL'],
  },
  {
    from: "src/core/access/policy.ts:263 proposeRevision at 8d2e667543 (the revision)",
    case: { method: 'insertAccessPolicyRevision', variant: 'default', run: e => e.insertAccessPolicyRevision({ source_id: 'default', revision: 1, rules: [], digest: 'd', change_kind: 'narrowing', origin: 'cli', operation_id: null, proposed_by: 'local', approved_by: 'auto:narrowing', approved: true }) },
    texts: [`INSERT INTO access_policy_revisions (source_id, revision, rules, digest, change_kind, origin, operation_id, proposed_by, approved_by, approved_at)
      VALUES ($1, $2, $3::text::jsonb, $4, $5, $6, $7, $8, $9, CASE WHEN $10::boolean THEN now() END)`],
  },
  {
    from: "src/core/access/policy.ts:268 proposeRevision at 8d2e667543 (applied)",
    case: { method: 'markAccessRevisionsApplied', variant: 'all', run: e => e.markAccessRevisionsApplied('default') },
    texts: ['UPDATE access_policy_revisions SET applied_at = now() WHERE source_id = $1 AND applied_at IS NULL'],
  },
  {
    from: "src/core/access/policy.ts:388 applyApproved at 8d2e667543 (applied up to)",
    case: { method: 'markAccessRevisionsApplied', variant: 'up-to', run: e => e.markAccessRevisionsApplied('default', 2) },
    texts: ['UPDATE access_policy_revisions SET applied_at = now() WHERE source_id = $1 AND applied_at IS NULL AND revision <= $2'],
  },
  {
    from: "src/core/access/policy.ts:387 applyApproved at 8d2e667543 (approved)",
    case: { method: 'approveAccessPolicyRevision', variant: 'default', run: e => e.approveAccessPolicyRevision('default', 2, 'local') },
    texts: ['UPDATE access_policy_revisions SET approved_by = $3, approved_at = now() WHERE source_id = $1 AND revision = $2'],
  },
  {
    from: "src/core/access/policy.ts:296 resumePolicy at 8d2e667543",
    case: { method: 'hasAccessPolicyState', variant: 'default', run: e => e.hasAccessPolicyState('default') },
    texts: ['SELECT count(*)::int AS n FROM access_policy_state WHERE source_id = $1'],
  },
  {
    from: "src/core/access/policy.ts:349 previewApply at 8d2e667543 (one prefix) (equivalent: COLLATE \"C\" on the ORDER BY)",
    case: { method: 'listAccessPrefixSlugs', variant: 'one', run: e => e.listAccessPrefixSlugs('default', 'notes/') },
    texts: ['SELECT slug FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND starts_with(slug, $2) ORDER BY slug COLLATE "C"'],
  },
  {
    from: "src/core/access/policy.ts:355 previewApply at 8d2e667543 (several prefixes) (equivalent: COLLATE \"C\" on the ORDER BY)",
    case: { method: 'listAccessPrefixSlugs', variant: 'several', run: e => e.listAccessPrefixSlugs('default', ['notes/', 'docs/']) },
    texts: ['SELECT slug FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM unnest($2::text[]) AS pfx WHERE starts_with(slug, pfx)) ORDER BY slug COLLATE "C"'],
  },
  {
    from: "src/core/access/policy.ts:421, :432 policyStatus at 8d2e667543",
    case: { method: 'readAccessPolicyMarks', variant: 'operation', run: e => e.readAccessPolicyMarks('default', 'op-1') },
    texts: ['SELECT max(revision) FILTER (WHERE applied_at IS NOT NULL) AS applied, max(revision) FILTER (WHERE approved_at IS NOT NULL) AS approved FROM access_policy_revisions WHERE source_id = $1', 'SELECT revision, applied_at, approved_at FROM access_policy_revisions WHERE source_id = $1 AND operation_id = $2'],
  },
  {
    from: "src/core/access/policy.ts:452 markPolicyInvalid at 8d2e667543",
    case: { method: 'replaceAccessInvalidCoverage', variant: 'one', run: e => e.replaceAccessInvalidCoverage('default', ['notes/'], { error: 'x' }) },
    texts: [`DELETE FROM access_pending_coverage WHERE source_id = $1 AND reason = 'invalid'`, `INSERT INTO access_pending_coverage (source_id, prefix, reason, detail) VALUES ($1, $2, 'invalid', $3::text::jsonb)`],
  },
  {
    from: 'src/commands/access-rules.ts:150 previewRules at 8d2e667543 (pages one prefix covers)',
    case: { method: 'countRuleCoveredPages', variant: 'one', run: e => e.countRuleCoveredPages('default', 'notes/') },
    texts: () => [`SELECT count(*)::int AS n FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND ${ruleCoversSql('slug', '$2::text')}`],
  },
  {
    from: 'src/commands/access-rules.ts:204-205 previewRules at 8d2e667543 (pages the new prefixes cover)',
    case: { method: 'countRuleCoveredPages', variant: 'several', run: e => e.countRuleCoveredPages('default', ['notes/', 'docs/']) },
    texts: () => [`SELECT count(*)::int AS n FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM unnest($2::text[]) AS pfx WHERE ${ruleCoversSql('slug', 'pfx')})`],
  },
  {
    from: 'src/commands/access-rules.ts:157-158 previewRules at 8d2e667543 (slugs the changed prefixes cover)',
    case: { method: 'listRuleCoveredSlugs', variant: 'default', run: e => e.listRuleCoveredSlugs('default', ['notes/', 'docs/']) },
    texts: () => [`SELECT slug FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM unnest($2::text[]) AS pfx WHERE ${ruleCoversSql('slug', 'pfx')})`],
  },
  {
    from: 'src/commands/access-rules.ts:197 previewRules at 8d2e667543 (pages a narrowing covers, for the open-twin check)',
    case: { method: 'listRuleCoveredPages', variant: 'default', run: e => e.listRuleCoveredPages('default', 'notes/') },
    texts: () => [`SELECT source_id, slug FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND ${ruleCoversSql('slug', '$2::text')} ORDER BY slug LIMIT ${OPEN_TWINS_PAGES}`],
  },
  // Row 32b-2: the member keys and owner setup of gbrain access serves several, the people folders and the open twins.
  {
    from: 'src/commands/access-serves.ts:136 unboundCredentials at 8d2e667543 (tokens) (equivalent: COLLATE "C" on the ORDER BY)',
    case: { method: 'listUnboundTokenNames', variant: 'default', run: e => e.listUnboundTokenNames() },
    texts: ['SELECT DISTINCT name COLLATE "C" AS name FROM access_tokens WHERE revoked_at IS NULL AND member_id IS NULL ORDER BY name'],
  },
  {
    from: 'src/commands/access-serves.ts:137 unboundCredentials at 8d2e667543 (OAuth clients) (equivalent: COLLATE "C" on the ORDER BY)',
    case: { method: 'listUnboundClientIds', variant: 'default', run: e => e.listUnboundClientIds() },
    texts: ['SELECT client_id FROM oauth_clients WHERE deleted_at IS NULL AND member_id IS NULL ORDER BY client_id COLLATE "C"'],
  },
  {
    from: 'src/commands/access-serves.ts:187 plan at 8d2e667543 (the live member key)',
    case: { method: 'readLiveAccessToken', variant: 'default', run: e => e.readLiveAccessToken('member-alice-example') },
    texts: ['SELECT member_id, token_hash, source_grant, source_id, federated_read, permissions FROM access_tokens WHERE name = $1 AND revoked_at IS NULL'],
  },
  {
    from: 'src/commands/access-serves.ts:242-244 recordSetupReads at 8d2e667543',
    case: { method: 'recordTokenSetupReads', variant: 'default', run: e => e.recordTokenSetupReads('member-alice-example', ['default']) },
    texts: ["UPDATE access_tokens SET permissions = COALESCE(permissions, '{}'::jsonb) || jsonb_build_object('setup_reads', $2::text[]) WHERE name = $1 AND revoked_at IS NULL AND (permissions IS NULL OR jsonb_typeof(permissions) = 'object')"],
  },
  {
    from: 'src/commands/access-serves.ts:252-253 keysStillReading at 8d2e667543 (equivalent: COLLATE "C" on the ORDER BY)',
    case: { method: 'listKeysReadingSource', variant: 'default', run: e => e.listKeysReadingSource('company') },
    texts: ["SELECT name, member_id, federated_read FROM access_tokens WHERE revoked_at IS NULL AND member_id IS NOT NULL AND source_grant = 'federated' AND source_id <> $1 AND $1 = ANY(federated_read) ORDER BY name COLLATE \"C\""],
  },
  {
    from: 'src/commands/access-serves.ts:266-267 companyCounts at 8d2e667543',
    case: { method: 'countCompanyPages', variant: 'default', run: e => e.countCompanyPages('company') },
    texts: ["SELECT count(*)::int AS pages, count(*) FILTER (WHERE slug LIKE 'company/calls/%')::int AS calls FROM pages WHERE source_id = $1 AND deleted_at IS NULL"],
  },
  {
    from: 'src/commands/access-serves.ts:340 labelSeveral at 8d2e667543 (revoke a key whose file failed)',
    case: { method: 'revokeAccessTokenById', variant: 'default', run: e => e.revokeAccessTokenById('00000000-0000-0000-0000-000000000000') },
    texts: ['UPDATE access_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL'],
  },
  {
    from: 'src/core/access/serves.ts:39-41 unlabeledPeopleFolders at 8d2e667543 (equivalent: COLLATE "C" on the ORDER BY)',
    case: { method: 'countPeopleFolderPages', variant: 'default', run: e => e.countPeopleFolderPages() },
    texts: [`SELECT source_id, split_part(slug, '/', 2) AS folder, count(*)::int AS pages FROM pages
      WHERE deleted_at IS NULL AND slug LIKE 'people/%/%' GROUP BY 1, 2 ORDER BY source_id COLLATE "C", split_part(slug, '/', 2) COLLATE "C"`],
  },
  {
    from: 'src/core/access/open-twins.ts:30-35 openTwins at 8d2e667543 (the outside readers are the empty identity and one member; equivalent: the window arrays bind again as $3, $4 for the exclusion instead of reusing $1, $2)',
    case: { method: 'listOpenTwinRows', variant: 'default', run: e => e.listOpenTwinRows([{ source_id: 'default', slug: 'partners/alice/deal' }], [{ identity: [], satisfied: [] }, { identity: ['member:bob-example'], satisfied: ['default:team'] }], 50) },
    texts: () => [`SELECT t.source_id, t.slug, min(c.source_id) AS twin_of,
      count(*) OVER ()::int AS n FROM unnest($1::text[], $2::text[]) AS c(source_id, slug)
    JOIN pages t ON t.slug = c.slug AND t.source_id <> c.source_id AND t.deleted_at IS NULL
    WHERE NOT EXISTS (SELECT 1 FROM unnest($3::text[], $4::text[]) AS w(source_id, slug) WHERE w.source_id = t.source_id AND w.slug = t.slug)
      AND ${privateSnapshotFilterFragment('t')} AND (${[[[], []], [['member:bob-example'], ['default:team']]].map(([identity, satisfied]) => `(${readersAllowedSql('t', identity)} AND ${folderRulesAllowedSql('t', satisfied)})`).join(' OR ')})
    GROUP BY t.source_id, t.slug ORDER BY t.source_id, t.slug LIMIT 50`],
  },
  // Row 32d-1: the bearer checks' token reads and last-use stamp.
  {
    from: "src/core/oauth-provider.ts:697 verifyAccessToken at 8d2e667543 (the OAuth token read, rung 0)",
    case: { method: 'readOauthAccessTokenRows', variant: 'rung0', run: e => e.readOauthAccessTokenRows('hash', 0) },
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
    from: "src/core/oauth-provider.ts:743 verifyAccessToken at 8d2e667543 (the OAuth token read, rung 1)",
    case: { method: 'readOauthAccessTokenRows', variant: 'rung1', run: e => e.readOauthAccessTokenRows('hash', 1) },
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
    from: "src/core/oauth-provider.ts:760 verifyAccessToken at 8d2e667543 (the OAuth token read, rung 2)",
    case: { method: 'readOauthAccessTokenRows', variant: 'rung2', run: e => e.readOauthAccessTokenRows('hash', 2) },
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
    from: "src/core/oauth-provider.ts:777 verifyAccessToken at 8d2e667543 (the OAuth token read, rung 3)",
    case: { method: 'readOauthAccessTokenRows', variant: 'rung3', run: e => e.readOauthAccessTokenRows('hash', 3) },
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
    from: "src/core/oauth-provider.ts:792 verifyAccessToken at 8d2e667543 (the OAuth token read, rung 4)",
    case: { method: 'readOauthAccessTokenRows', variant: 'rung4', run: e => e.readOauthAccessTokenRows('hash', 4) },
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
    from: "src/core/oauth-provider.ts:941 verifyAccessToken at 8d2e667543 (the legacy token read)",
    case: { method: 'readActiveAccessTokenByHash', variant: 'provider', run: e => e.readActiveAccessTokenByHash('hash', 'provider') },
    texts: [`
      SELECT * FROM access_tokens
      WHERE token_hash = $1 AND revoked_at IS NULL
    `],
  },
  {
    from: "src/mcp/http-transport.ts:299 validateToken at 8d2e667543",
    case: { method: 'readActiveAccessTokenByHash', variant: 'transport', run: e => e.readActiveAccessTokenByHash('hash', 'transport') },
    texts: [`
        SELECT * FROM access_tokens
        WHERE token_hash = $1 AND revoked_at IS NULL
      `],
  },
  {
    from: "src/core/grants/legacy-token.ts:454-456 touchTokenLastUsed at 8d2e667543 (a row with source_grant)",
    case: { method: 'touchAccessTokenLastUsed', variant: 'unified', run: e => e.touchAccessTokenLastUsed('00000000-0000-0000-0000-000000000000', true) },
    texts: [`UPDATE access_tokens SET last_used_at = now()
        WHERE id IN (SELECT id FROM access_tokens WHERE id = $1::uuid AND source_grant IS NOT NULL
          AND (last_used_at IS NULL OR last_used_at < now() - interval '60 seconds') FOR UPDATE SKIP LOCKED)`],
  },
  {
    from: "src/core/grants/legacy-token.ts:457-459 touchTokenLastUsed at 8d2e667543 (a legacy-shape row)",
    case: { method: 'touchAccessTokenLastUsed', variant: 'legacy', run: e => e.touchAccessTokenLastUsed('00000000-0000-0000-0000-000000000000', false) },
    texts: [`UPDATE access_tokens SET last_used_at = now()
        WHERE id IN (SELECT id FROM access_tokens WHERE id = $1::uuid
          AND (last_used_at IS NULL OR last_used_at < now() - interval '60 seconds') FOR UPDATE SKIP LOCKED)`],
  },
  // Equivalent, not verbatim (the next four): the old-line statements add COLLATE "C" to every ORDER BY, so groups,
  // group members and pages come in byte order on every engine whatever the database collation.
  {
    from: 'src/core/access/members.ts:336-340 listGroups at 8d2e667543 (every group)',
    case: { method: 'readAccessGroups', variant: 'all', run: e => e.readAccessGroups(null) },
    texts: [`SELECT g.id, COALESCE(array_agg(gm.member_id ORDER BY gm.member_id COLLATE "C") FILTER (WHERE gm.member_id IS NOT NULL), '{}') AS members
     FROM access_groups g LEFT JOIN access_group_members gm ON gm.group_id = g.id
      GROUP BY g.id ORDER BY g.id COLLATE "C"`],
  },
  {
    from: 'src/core/access/members.ts:336-340 listGroups at 8d2e667543 (one group)',
    case: { method: 'readAccessGroups', variant: 'by-id', run: e => e.readAccessGroups('team-a') },
    texts: [`SELECT g.id, COALESCE(array_agg(gm.member_id ORDER BY gm.member_id COLLATE "C") FILTER (WHERE gm.member_id IS NOT NULL), '{}') AS members
     FROM access_groups g LEFT JOIN access_group_members gm ON gm.group_id = g.id
     WHERE g.id = $1 GROUP BY g.id ORDER BY g.id COLLATE "C"`],
  },
  {
    from: 'src/core/access/members.ts:304-306 pagesNaming at 8d2e667543',
    case: { method: 'listPagesNamingReader', variant: 'default', run: e => e.listPagesNamingReader('member:alice-example') },
    texts: [`SELECT slug, source_id FROM pages WHERE frontmatter ? 'readable_by' AND gbrain_access_readers(frontmatter) @> ARRAY[$1]::text[]
     ORDER BY source_id COLLATE "C", slug COLLATE "C" LIMIT 51`],
  },
  {
    // Also the column order: the caller selected `source_id, slug`; the rows are read by name.
    from: 'src/commands/access-read-by-nobody.ts:44-46 pagesReadByNobodyNaming at 8d2e667543',
    case: { method: 'listPagesNamingReader', variant: 'live', run: e => e.listPagesNamingReader('member:alice-example', { live: true }) },
    texts: [`SELECT slug, source_id FROM pages WHERE deleted_at IS NULL AND frontmatter ? 'readable_by' AND gbrain_access_readers(frontmatter) @> ARRAY[$1]::text[]
     ORDER BY source_id COLLATE "C", slug COLLATE "C" LIMIT 201`],
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
