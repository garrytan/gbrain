/**
 * #7168: the `rank_entities` aggregate, one statement for both engines.
 *
 * Counting (the definition the op documents): an edge is a distinct
 * (from page, to page, link_type) triple over `links` rows whose both
 * endpoints are live (`deleted_at IS NULL`, get_health's liveness rule,
 * #6940) and inside the scope. Provenance duplicates (one triple written by
 * several `link_source` / `origin_page_id` rows) count once; self-links never
 * count; non-ranking link types (link-ranking-policy.ts) never count; mention
 * rows (`link_source = 'mentions'`) count only with `includeMentions`, the
 * backlink-count convention. `inbound` and `outbound` count edges, and
 * `neighbors` counts the distinct pages on the other end in either direction.
 *
 * Folding: a retired page (entities/resolve.ts `retiredPageSql`) whose
 * `superseded_by` (else `merged_into`) chain reaches a live, non-retired page
 * in the same source within MAX_RETIREMENT_HOPS hops hands its edges to that
 * page before counting: edges are deduplicated after folding and an edge that
 * folds into a self-link is dropped. Every page on the chain and the target
 * must pass the same endpoint predicate, so a hidden target or hop never
 * folds: the retired page keeps its own row (it is visible itself, and its
 * redirect field is its own content), and a hidden retired page contributes
 * nothing at all. The chain walks only retired pages and stops at the hop
 * cap, so a cycle terminates.
 *
 * Visibility: with `remote` set, every endpoint, chain hop and fold target
 * must be in `sourceIds`, live, unquarantined, in an unarchived source and
 * (with `excludePrivate`) not private; a row's origin page, when set, must
 * pass the same predicate (the backlink-count origin rule in
 * search/read-enrichment.ts). Without `remote` (trusted local CLI) pages need
 * only be live and in scope. Every value binds as a parameter; only
 * code-constant aliases and predicates are spliced.
 *
 * Cost: the readable-page predicate runs once per page (the `readable` CTE),
 * never per link row; edges hash-join links against it. A whole-graph ranking
 * scans every link in scope, so the op runs it under a statement deadline.
 * On Postgres 16 with 200k pages and 985k links a brain-wide ranking took
 * about 3 s locally and remotely.
 */
import { renderFragment, sqlFragment, trustedSql, type SqlFragment } from './fragment.ts';
import { entityTypePredicateSql, type EntityTypeFilter } from '../schema-pack/entity-types.ts';
import { privatePagesFilterForCaller } from '../search/private-visibility.ts';
import { quarantineFilterFragment } from '../quarantine.ts';
import { rankingLinkSql } from '../link-ranking-policy.ts';
import { MAX_RETIREMENT_HOPS, retiredPageSql } from '../entities/resolve.ts';
import { staleForExtractionSql } from './pages.ts';
import { ALIAS_DERIVATION_VERSION, MENTION_EXTRACTOR_VERSION } from '../mentions/pass.ts';

export type RankDirection = 'in' | 'out' | 'both';

export interface RankEntitiesStatementOpts {
  direction: RankDirection;
  /** The ranked page's type must match; an empty filter matches nothing. */
  types: EntityTypeFilter;
  /** Both endpoints of every counted edge; undefined is brain-wide (trusted local only). */
  sourceIds?: string[];
  linkType?: string;
  includeMentions: boolean;
  limit: number;
  /** Folded slugs returned per row; folded_total counts them all. */
  foldedCap: number;
  /** Untrusted caller: authorize endpoints, chain hops, fold targets and link origins. */
  remote?: { excludePrivate: boolean };
}

export interface RankEntityRow {
  slug: string;
  title: string | null;
  type: string | null;
  source_id: string;
  inbound: number;
  outbound: number;
  neighbors: number;
  folded_total: number;
  folded: unknown;
}

const RANK_KEYS = { in: 'd.inbound', out: 'd.outbound', both: '(d.inbound + d.outbound)' } as const;

/** The redirect field of alias rp as a slug: [[people/x|X]], people/x.md and /people/x read people/x (resolve.ts redirectSlug). */
const REDIRECT_TARGET_SQL = "regexp_replace(regexp_replace(btrim(split_part(regexp_replace(regexp_replace("
  + "COALESCE(NULLIF(btrim(rp.frontmatter->>'superseded_by'), ''), NULLIF(btrim(rp.frontmatter->>'merged_into'), ''), ''),"
  + " '^\\[\\[', ''), '\\]\\]$', ''), '|', 1)), '\\.md$', '', 'i'), '^/+', '')";

const FOLD_REASON_SQL = "CASE WHEN btrim(COALESCE(rp.frontmatter->>'superseded_by', '')) <> '' THEN 'superseded_by' ELSE 'merged_into' END";

/** The pages (alias vp) a counted edge, chain hop, fold target or link origin may touch, evaluated once per page. */
function readablePageSql(opts: Pick<RankEntitiesStatementOpts, 'sourceIds' | 'remote'>): SqlFragment {
  const scope = opts.sourceIds ? sqlFragment` AND vp.source_id = ANY(${opts.sourceIds}::text[])` : sqlFragment``;
  if (!opts.remote) return sqlFragment`vp.deleted_at IS NULL${scope}`;
  const privacy = opts.remote.excludePrivate ? trustedSql(` AND ${privatePagesFilterForCaller('vp')}`) : sqlFragment``;
  return sqlFragment`vp.deleted_at IS NULL${scope} AND ${trustedSql(quarantineFilterFragment('vp'))}${privacy}
      AND EXISTS (SELECT 1 FROM sources rank_source WHERE rank_source.id = vp.source_id AND NOT rank_source.archived)`;
}

/**
 * A remote caller's coverage for one source, over the pages it may read (the
 * same readable predicate as the ranking): does any readable page still owe
 * link extraction, and (with mentionTypes) a mention pass? Pages the caller
 * cannot read never move the state.
 */
export function rankCoverageStatement(opts: { sourceId: string; excludePrivate: boolean; versionTs: string; mentionTypes?: string[] }): { text: string; params: unknown[] } {
  const readable = readablePageSql({ sourceIds: [opts.sourceId], remote: { excludePrivate: opts.excludePrivate } });
  const mentionDue = opts.mentionTypes
    ? sqlFragment`EXISTS (SELECT 1 FROM pages p LEFT JOIN page_mention_state s ON s.page_id = p.id
        WHERE p.id IN (SELECT id FROM readable) AND (s.page_id IS NULL OR s.mention_revision IS DISTINCT FROM p.knowledge_revision
          OR s.mention_version IS DISTINCT FROM ${MENTION_EXTRACTOR_VERSION}
          OR (p.type = ANY(${opts.mentionTypes}::text[]) AND (s.alias_revision IS DISTINCT FROM p.knowledge_revision OR s.alias_version IS DISTINCT FROM ${ALIAS_DERIVATION_VERSION}))))`
    : sqlFragment`false`;
  return renderFragment(sqlFragment`
    WITH readable AS MATERIALIZED (SELECT vp.id FROM pages vp WHERE ${readable})
    SELECT EXISTS (SELECT 1 FROM pages WHERE id IN (SELECT id FROM readable) AND ${staleForExtractionSql(opts.versionTs)}) AS link_behind,
           ${mentionDue} AS mention_due`);
}

export function rankEntitiesStatement(opts: RankEntitiesStatementOpts): { text: string; params: unknown[] } {
  const mentions = opts.includeMentions ? sqlFragment`` : sqlFragment` AND l.link_source IS DISTINCT FROM 'mentions'`;
  const linkType = opts.linkType !== undefined ? sqlFragment` AND l.link_type = ${opts.linkType}` : sqlFragment``;
  const origin = opts.remote
    ? sqlFragment` AND (l.origin_page_id IS NULL OR EXISTS (SELECT 1 FROM readable og WHERE og.id = l.origin_page_id))`
    : sqlFragment``;
  const key = trustedSql(RANK_KEYS[opts.direction]);
  return renderFragment(sqlFragment`
    WITH RECURSIVE readable AS MATERIALIZED (
      SELECT vp.id FROM pages vp WHERE ${readablePageSql(opts)}
    ),
    retired AS MATERIALIZED (
      SELECT rp.id, rp.source_id, ${trustedSql(REDIRECT_TARGET_SQL)} AS target_slug
        FROM pages rp
        JOIN readable rv ON rv.id = rp.id
       WHERE ${trustedSql(retiredPageSql('rp'))}
    ),
    chain AS (
      SELECT r.id AS start_id, r.source_id, r.target_slug, 1 AS hop FROM retired r WHERE r.target_slug <> ''
      UNION ALL
      SELECT c.start_id, c.source_id, r2.target_slug, c.hop + 1
        FROM chain c
        JOIN pages nx ON nx.source_id = c.source_id AND nx.slug = c.target_slug
        JOIN retired r2 ON r2.id = nx.id
       WHERE c.hop < ${MAX_RETIREMENT_HOPS}::int AND r2.target_slug <> ''
    ),
    fold AS MATERIALIZED (
      SELECT DISTINCT ON (c.start_id) c.start_id AS retired_id, t.id AS target_id
        FROM chain c
        JOIN pages t ON t.source_id = c.source_id AND t.slug = c.target_slug
        JOIN readable tv ON tv.id = t.id
       WHERE t.id <> c.start_id AND NOT ${trustedSql(retiredPageSql('t'))}
       ORDER BY c.start_id, c.hop
    ),
    edges AS MATERIALIZED (
      SELECT DISTINCT COALESCE(ff.target_id, l.from_page_id) AS src, COALESCE(ft.target_id, l.to_page_id) AS dst, l.link_type
        FROM links l
        JOIN readable a ON a.id = l.from_page_id
        JOIN readable b ON b.id = l.to_page_id
        LEFT JOIN fold ff ON ff.retired_id = l.from_page_id
        LEFT JOIN fold ft ON ft.retired_id = l.to_page_id
       WHERE l.from_page_id <> l.to_page_id
         AND ${trustedSql(rankingLinkSql('l'))}${mentions}${linkType}${origin}
    ),
    ends AS (
      SELECT e.dst AS node, e.src AS other, 1 AS inb, 0 AS outb FROM edges e WHERE e.src <> e.dst
      UNION ALL
      SELECT e.src AS node, e.dst AS other, 0 AS inb, 1 AS outb FROM edges e WHERE e.src <> e.dst
    ),
    d AS (
      SELECT x.node, sum(x.inb)::int AS inbound, sum(x.outb)::int AS outbound, count(DISTINCT x.other)::int AS neighbors
        FROM ends x
        JOIN pages p ON p.id = x.node
       WHERE ${entityTypePredicateSql('p', opts.types)}
       GROUP BY x.node
    )
    SELECT p.slug, p.title, p.type, p.source_id, d.inbound, d.outbound, d.neighbors,
           (SELECT count(*)::int FROM fold f WHERE f.target_id = p.id) AS folded_total,
           (SELECT jsonb_agg(jsonb_build_object('slug', fx.slug, 'reason', fx.reason) ORDER BY fx.slug COLLATE "C")
              FROM (SELECT rp.slug, ${trustedSql(FOLD_REASON_SQL)} AS reason
                      FROM fold f JOIN pages rp ON rp.id = f.retired_id
                     WHERE f.target_id = p.id
                     ORDER BY rp.slug COLLATE "C"
                     LIMIT ${opts.foldedCap}::int) fx) AS folded
      FROM d
      JOIN pages p ON p.id = d.node
     WHERE ${key} > 0
     ORDER BY ${key} DESC, p.slug COLLATE "C", p.source_id COLLATE "C"
     LIMIT ${opts.limit}::int
  `);
}
