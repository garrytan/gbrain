/**
 * Entity and mention reads the CLI made through `engine.executeRaw` (docs/research/rust-cli-executeraw-map.md): one SQL
 * implementation for both engines, so the call sites can name a typed engine member and a Rust brain can answer them.
 * Each statement is the one its call site ran, with the same parameters; the call site keeps its own fallbacks.
 */
import type { LegacyUnscopedRead } from './brands.ts';
import type { SqlExecutor } from './executor.ts';
import { extractionLagStatement } from './pages.ts';
import { renderFragment, sqlFragment, trustedSql, type SqlFragment } from './fragment.ts';
import { retiredPageSql } from '../entities/resolve.ts';
import { callerAccessAllowedSql, privatePagesFilterForCaller, remoteReadFloorSql } from '../search/private-visibility.ts';
import { quarantineFilterFragment } from '../quarantine.ts';
import { boundedBodyPrefixSql } from '../page-window/bounded-lead.ts';
import { rankingLinkSql } from '../link-ranking-policy.ts';
import { ignoredPrivacyLabelSql, NOTICE_READ_TIMEOUT_MS, privacyLabelKeySql, SCAN_CAP } from '../search/ignored-privacy-labels.ts';

/**
 * An engine's own `executeRaw`, for the reads whose call sites bound them with `timeoutMs` (a transaction-local
 * `statement_timeout` on Postgres; PGLite ignores it). The engine passes itself so the bound holds as before.
 */
export interface TimedRawRead {
  executeRaw<R = Record<string, unknown>>(sql: string, params?: unknown[], opts?: { timeoutMs?: number }): Promise<R[]>;
}

/** The newest mention pass time (ISO, UTC, whole seconds) over every source or one source; null when no pass ran. */
export async function readMentionLastPass(exec: LegacyUnscopedRead, sourceId?: string | null): Promise<string | null> {
  const source = sourceId ?? null;
  const { text, params } = renderFragment(sqlFragment`SELECT to_char(max(last_pass_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last FROM mention_index_status
      WHERE (${source}::text IS NULL OR source_id = ${source})`);
  const [row] = await exec.executeRaw<{ last: string | null }>(text, params);
  return row?.last ?? null;
}


export interface MentionDueQuery {
  /** One source; null or absent counts every source. */
  sourceId?: string | null;
  /** The extractor version a page's mention state must carry to be current. */
  mentionVersion: number;
  /** Also count pages of these types whose derived aliases are behind their content or `version`. */
  aliases?: { types: readonly string[]; version: number };
}

/** One source's mention-index status row (mentions/coverage.ts); the times are what the driver returns. */
export interface MentionIndexStatusRow {
  source_id: string;
  state: string;
  pending: number;
  counted_at: Date | string | null;
  last_pass_at: Date | string | null;
  policy_fingerprint: string | null;
}

/** The mention-index status rows of `sourceIds`, in no defined order; a source with no row has none. */
export async function readMentionIndexStatus(exec: LegacyUnscopedRead, sourceIds: readonly string[]): Promise<MentionIndexStatusRow[]> {
  return exec.executeRaw<MentionIndexStatusRow>(
    `SELECT source_id, state, pending, counted_at, last_pass_at, policy_fingerprint FROM mention_index_status WHERE source_id = ANY($1::text[])`, [sourceIds]);
}

/** The live (not soft-deleted) pages of one source: mention coverage's pending count for a source with no status row. */
export async function countLivePagesInSource(exec: LegacyUnscopedRead, sourceId: string): Promise<number> {
  const [n] = await exec.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE source_id = $1 AND deleted_at IS NULL', [sourceId]);
  return Number(n?.n ?? 0);
}

/**
 * Live pages of one source written at or after `since` (a timestamptz text, `-infinity` for no
 * bound) that are not scanned at their current content or at `mentionVersion`: what mention
 * coverage adds to a status row's saved count. The bound binds as text: postgres.js serializes a
 * timestamptz parameter through `new Date()`, which cannot hold `-infinity`.
 */
export async function countMentionDueSince(exec: LegacyUnscopedRead, sourceId: string, since: string, mentionVersion: number): Promise<number> {
  const [n] = await exec.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM pages p LEFT JOIN page_mention_state s ON s.page_id = p.id
        WHERE p.source_id = $1 AND p.updated_at >= $2::text::timestamptz AND p.deleted_at IS NULL
          AND (s.page_id IS NULL OR s.mention_revision IS DISTINCT FROM p.knowledge_revision OR s.mention_version IS DISTINCT FROM $3)`,
      [sourceId, since, mentionVersion]);
  return Number(n?.n ?? 0);
}

/** A recount mention coverage saves on a source's status row (`recountMentionIndexStatus`). */
export interface MentionIndexRecount {
  /** The recounted pending pages. */
  pending: number;
  /** The fingerprint to store: the policy hash and this binary's index version stamp. */
  fingerprint: string;
  /** The fingerprint the caller read; the row is updated only while it still holds this one. */
  expectedFingerprint: string | null;
}

/**
 * Saves a recount on one source's mention-index status row: pending, counted_at, the fingerprint,
 * and `complete` becomes `pending` when the recount is above 0. A compare-and-set on the stored
 * fingerprint, so a pass that finished meanwhile is not overwritten; a source with no row is untouched.
 */
export async function recountMentionIndexStatus(exec: SqlExecutor, sourceId: string, r: MentionIndexRecount): Promise<void> {
  await exec.executeRaw(
        `UPDATE mention_index_status SET pending = $2, counted_at = now(), policy_fingerprint = $3, updated_at = now(),
                state = CASE WHEN state = 'complete' AND $2::int > 0 THEN 'pending' ELSE state END
          WHERE source_id = $1 AND policy_fingerprint IS NOT DISTINCT FROM $4`,
        [sourceId, r.pending, r.fingerprint, r.expectedFingerprint]);
}

/** Live pages due for the mention pass: no mention state, or state behind the page's content or the extractor version. */
export async function countPagesDueForMentions(exec: LegacyUnscopedRead, q: MentionDueQuery): Promise<number> {
  const source = q.sourceId ?? null;
  const due = sqlFragment`(s.page_id IS NULL OR s.mention_revision IS DISTINCT FROM p.knowledge_revision OR s.mention_version IS DISTINCT FROM ${q.mentionVersion})`;
  const aliasDue = q.aliases
    ? sqlFragment` OR (p.type = ANY(${[...q.aliases.types]}::text[]) AND (s.alias_revision IS DISTINCT FROM p.knowledge_revision OR s.alias_version IS DISTINCT FROM ${q.aliases.version}))`
    : sqlFragment``;
  const { text, params } = renderFragment(sqlFragment`SELECT count(*)::int AS n FROM pages p LEFT JOIN page_mention_state s ON s.page_id = p.id
        WHERE p.deleted_at IS NULL AND (${source}::text IS NULL OR p.source_id = ${source}) AND (${due}${aliasDue})`);
  const rows = await exec.executeRaw<{ n: number }>(text, params);
  return Number(rows[0]?.n ?? 0);
}

export interface SiblingCandidateRow { slug: string; title: string | null; type: string | null; identity: string | null }

export interface SiblingCandidateQuery {
  /** Linkable entity types a candidate must have. */
  types: readonly string[];
  /** The normalized title subject: a candidate's lowercased title is it, or ends with `: ` and it. */
  subject: string;
  limit: number;
  /** Apply the private-page predicate (untrusted callers). */
  excludePrivate?: boolean;
  excludeQuarantined?: boolean;
}

/** Live pages of one source whose titles may name `subject`, by slug, with frontmatter `identity` as text. */
export async function readIdentitySiblingCandidates(exec: LegacyUnscopedRead, sourceId: string, q: SiblingCandidateQuery): Promise<SiblingCandidateRow[]> {
  const priv = q.excludePrivate ? sqlFragment` AND ${trustedSql(privatePagesFilterForCaller('pages'))}` : sqlFragment``;
  const quarantined = q.excludeQuarantined ? sqlFragment` AND ${trustedSql(quarantineFilterFragment('pages'))}` : sqlFragment``;
  const like = `%: ${q.subject.replace(/[\\%_]/g, m => `\\${m}`)}`;
  const limit = Math.max(0, Math.floor(q.limit));
  const { text, params } = renderFragment(sqlFragment`SELECT slug, title, type, frontmatter->>'identity' AS identity FROM pages
      WHERE source_id = ${sourceId} AND deleted_at IS NULL AND type = ANY(${[...q.types]}::text[])
        AND (lower(title) = ${q.subject} OR lower(title) LIKE ${like})${priv}${quarantined}
      ORDER BY slug COLLATE "C" LIMIT ${limit}`);
  return exec.executeRaw<SiblingCandidateRow>(text, params);
}

/**
 * The live pages of one source at `slugs`, in no set order, with frontmatter `identity` as text (mentions/siblings.ts
 * `siblingCanonical`: whether two or three pages one name resolved to form one identity-sibling group).
 */
export async function readSiblingGroupRows(exec: LegacyUnscopedRead, sourceId: string, slugs: readonly string[], opts: { excludePrivate?: boolean } = {}): Promise<SiblingCandidateRow[]> {
  const priv = opts.excludePrivate ? sqlFragment` AND ${trustedSql(privatePagesFilterForCaller('pages'))}` : sqlFragment``;
  const { text, params } = renderFragment(sqlFragment`SELECT slug, title, type, frontmatter->>'identity' AS identity FROM pages
        WHERE source_id = ${sourceId} AND deleted_at IS NULL AND slug = ANY(${[...slugs]}::text[])${priv}`);
  return exec.executeRaw<SiblingCandidateRow>(text, params);
}

/**
 * The first of `slugs` at which a live page sits in the source and is (`retired: true`) or is not (`retired: false`) a
 * retired page (entities/resolve.ts `retiredPageSql`), or is either when `retired` is omitted; null otherwise.
 */
export async function findExactSlug(exec: LegacyUnscopedRead, sourceId: string, slugs: readonly string[], opts: { retired?: boolean } = {}): Promise<string | null> {
  if (slugs.length === 0) return null;
  const retired = opts.retired === undefined ? sqlFragment``
    : opts.retired ? sqlFragment` AND ${trustedSql(retiredPageSql('pages'))}` : sqlFragment` AND NOT ${trustedSql(retiredPageSql('pages'))}`;
  // An ordered join, not ORDER BY array_position: the planner then stops at the first index hit.
  const { text, params } = renderFragment(sqlFragment`SELECT pages.slug FROM unnest(${[...slugs]}::text[]) WITH ORDINALITY AS wanted(slug, n)
    JOIN pages ON pages.source_id = ${sourceId} AND pages.slug = wanted.slug AND pages.deleted_at IS NULL${retired}
    ORDER BY wanted.n LIMIT 1`);
  const [row] = await exec.executeRaw<{ slug: string }>(text, params);
  return row?.slug ?? null;
}

export interface FuzzyEntityCandidateRow { slug: string; title: string; type: string | null; score: number }

/**
 * The fuzzy entity lookup's statement (entities/resolve.ts `tryFuzzyMatch`), spelled out because `$2` and `$3` each
 * bind twice: a fragment would number every use. The retirement test is `retiredPageSql('pages')` as text; the pin
 * test (test/entity-fuzzy-candidates-sql.test.ts) holds it to that builder.
 */
const FUZZY_ENTITY_CANDIDATES_SQL = `SELECT slug, title, type,
         GREATEST(
           similarity(lower(title), $2),
           similarity(slug, $3)
         ) AS score
       FROM pages
       WHERE source_id = $1
         AND deleted_at IS NULL
         AND NOT (lower(COALESCE(pages.frontmatter->>'canonical', '')) IN ('false', 'no')
    OR btrim(COALESCE(pages.frontmatter->>'superseded_by', '')) <> ''
    OR btrim(COALESCE(pages.frontmatter->>'merged_into', '')) <> ''
    OR lower(COALESCE(pages.frontmatter->>'status', '')) ~ '(^|[^a-z])(alias|redirect|redirected)([^a-z]|$)')
         AND (
           lower(title) % $2
           OR slug ILIKE '%' || $3 || '%'
         )
       ORDER BY score DESC, slug ASC
       LIMIT 5`;

/**
 * Up to five live, unretired pages of one source whose lowercased title is trigram-similar to `title` (pg_trgm `%`)
 * or whose slug contains `fragment` (ILIKE), scored by the greater of the two pg_trgm similarities, best first and
 * then by slug. A brain without pg_trgm throws its own error (42883); the caller decides what that means.
 */
export async function findFuzzyEntityCandidates(exec: LegacyUnscopedRead, sourceId: string, title: string, fragment: string): Promise<FuzzyEntityCandidateRow[]> {
  return exec.executeRaw<FuzzyEntityCandidateRow>(FUZZY_ENTITY_CANDIDATES_SQL, [sourceId, title, fragment]);
}

/**
 * At most two of `slugs` that hold a live page of the source, in no stated order (entities/resolve.ts
 * `findExactBasenameCandidates`: the `<dir>/<basename>` slugs of a reference).
 */
export async function findExactBasenameCandidates(exec: LegacyUnscopedRead, sourceId: string, slugs: readonly string[]): Promise<string[]> {
  const rows = await exec.executeRaw<{ slug: string }>(
    `SELECT slug FROM pages
        WHERE source_id = $1 AND deleted_at IS NULL AND slug = ANY($2::text[])
        LIMIT 2`,
    [sourceId, [...slugs]],
  );
  return rows.map(r => r.slug);
}

/**
 * The page policy a retirement hop applies to the page it reads (alias `p`), rendered in the caller's access record:
 * none, the caller's page policy (`privatePagesFilterForCaller`), the remote read floor (`remoteReadFloorSql`), or
 * member access alone (`callerAccessAllowedSql`).
 */
export type RetirementPrivacy = 'none' | 'caller' | 'floor' | 'member_access';

/** One entity-card candidate row: the columns the card's tie-break and synopsis read. */
export interface EntityCardRow {
  slug: string;
  source_id: string;
  title: string;
  type: string | null;
  frontmatter: Record<string, unknown> | null;
  /** The bounded body prefix (`boundedBodyPrefixSql`), not the whole body. */
  compiled_truth: string | null;
  updated_at: Date | string | null;
  last_retrieved_at: Date | string | null;
}

/**
 * Which live pages of the source an entity-card read returns: the name arm (`lower(title)` equal to `titleLc`, a slug
 * in `slugs`, or a slug matching the LIKE pattern `slugLike`), or the hydrate arm (a slug in `slugs`).
 */
export type EntityCardMatch = { titleLc: string; slugs: readonly string[]; slugLike: string } | { slugs: readonly string[] };

export const ENTITY_CARD_COLUMNS_SQL = `slug, source_id, title, type, frontmatter, ${boundedBodyPrefixSql('pages')} AS compiled_truth, updated_at,
              GREATEST(last_retrieved_at, (SELECT r.last_retrieved_at FROM page_retrievals r WHERE r.page_id = pages.id)) AS last_retrieved_at`;

/** The entity card's candidate rows for `match`; `excludePrivate` applies the caller's page policy over `pages`. */
export async function readEntityCardRows(exec: LegacyUnscopedRead, sourceId: string, match: EntityCardMatch,
  opts: { excludePrivate?: boolean } = {}): Promise<EntityCardRow[]> {
  const priv = opts.excludePrivate ? sqlFragment` AND ${trustedSql(privatePagesFilterForCaller('pages'))}` : sqlFragment``;
  const cols = trustedSql(ENTITY_CARD_COLUMNS_SQL);
  const { text, params } = 'titleLc' in match
    ? renderFragment(sqlFragment`SELECT ${cols}
         FROM pages
        WHERE deleted_at IS NULL
          AND source_id = ${sourceId}
          AND ( lower(title) = ${match.titleLc}
             OR slug = ANY(${[...match.slugs]}::text[])
             OR slug LIKE ${match.slugLike} )${priv}`)
    : renderFragment(sqlFragment`SELECT ${cols}
           FROM pages
          WHERE deleted_at IS NULL AND source_id = ${sourceId} AND slug = ANY(${[...match.slugs]}::text[])${priv}`);
  return exec.executeRaw<EntityCardRow>(text, params);
}

/** One retirement hop: the page, whether it is retired (`retiredPageSql`), and its trimmed redirect target. */
export interface RetirementHopRow { slug: string; type: string | null; retired: boolean; target: string | null }

function retirementPrivacySql(privacy: RetirementPrivacy): SqlFragment {
  switch (privacy) {
    case 'none': return sqlFragment``;
    case 'caller': return sqlFragment`AND ${trustedSql(privatePagesFilterForCaller('p'))}`;
    case 'floor': return sqlFragment`AND ${trustedSql(remoteReadFloorSql('p'))}`;
    case 'member_access': return sqlFragment`AND ${trustedSql(callerAccessAllowedSql('p'))}`;
  }
}

/**
 * The live page at `slug` in the source with whether it is retired and its `superseded_by` (else `merged_into`)
 * value, trimmed, as the redirect target; null when no live page sits there or `privacy` hides it.
 */
export async function readRetirementHop(exec: LegacyUnscopedRead, sourceId: string, slug: string, privacy: RetirementPrivacy): Promise<RetirementHopRow | null> {
  const { text, params } = renderFragment(sqlFragment`SELECT p.slug, p.type, ${trustedSql(retiredPageSql('p'))} AS retired,
              COALESCE(NULLIF(btrim(p.frontmatter->>'superseded_by'), ''), NULLIF(btrim(p.frontmatter->>'merged_into'), '')) AS target
         FROM pages p
        WHERE p.source_id = ${sourceId} AND p.slug = ${slug} AND p.deleted_at IS NULL ${retirementPrivacySql(privacy)}
        LIMIT 1`);
  const [row] = await exec.executeRaw<RetirementHopRow>(text, params);
  return row ?? null;
}

export interface SlugPatternPageRow { slug: string; title: string | null }

/**
 * Live pages of one source that are not retired (`retiredPageSql`) and whose slug matches one of the LIKE `patterns`,
 * by slug, at most `limit` (doctor's person_title_duplicates stubs).
 */
export async function listUnretiredPagesBySlugPattern(exec: LegacyUnscopedRead, sourceId: string, patterns: readonly string[], limit: number): Promise<SlugPatternPageRow[]> {
  const cap = Math.max(0, Math.floor(limit));
  const { text, params } = renderFragment(sqlFragment`SELECT slug, title FROM pages
          WHERE source_id = ${sourceId} AND deleted_at IS NULL AND slug LIKE ANY(${[...patterns]}::text[]) AND NOT ${trustedSql(retiredPageSql('pages'))}
          ORDER BY slug COLLATE "C" LIMIT ${cap}`);
  return exec.executeRaw<SlugPatternPageRow>(text, params);
}

export interface NameVariantCandidateQuery {
  /** Page types a candidate may have. */
  types: readonly string[];
  /** LIKE patterns a candidate's slug may match instead. */
  slugPatterns: readonly string[];
  /** ILIKE patterns; a candidate's title or slug matches at least one, and `probe_hits` counts the ones it matches. */
  probes: readonly string[];
  limit: number;
}

export interface NameVariantCandidateRow {
  slug: string;
  title: string | null;
  type: string | null;
  frontmatter: Record<string, unknown> | null;
  probe_hits: number;
}

/**
 * The name-variant candidates of one source (verbs/entity-variants.ts `resolveNameVariant`): live pages of one of
 * `types` or with a slug matching `slugPatterns`, whose title or slug matches a probe, most probe hits first, then the
 * shortest title, then by slug, at most `limit`.
 */
export async function listNameVariantCandidates(exec: LegacyUnscopedRead, sourceId: string, q: NameVariantCandidateQuery): Promise<NameVariantCandidateRow[]> {
  const limit = Math.max(0, Math.floor(q.limit));
  const { text, params } = renderFragment(sqlFragment`SELECT slug, title, type, frontmatter,
              (SELECT count(*)::int FROM unnest(${[...q.probes]}::text[]) w WHERE pages.title ILIKE w OR pages.slug ILIKE w) AS probe_hits
         FROM pages
        WHERE deleted_at IS NULL AND source_id = ${sourceId}
          AND (type = ANY(${[...q.types]}::text[]) OR slug LIKE ANY(${[...q.slugPatterns]}::text[]))
          AND (title ILIKE ANY(${[...q.probes]}::text[]) OR slug ILIKE ANY(${[...q.probes]}::text[]))
        ORDER BY probe_hits DESC, length(title), slug COLLATE "C"
        LIMIT ${limit}`);
  return exec.executeRaw<NameVariantCandidateRow>(text, params);
}

/**
 * listNameVariantCandidates under the caller's page policy: with `excludePrivate`, a page the caller may not read
 * (`privatePagesFilterForCaller`) is never a candidate. Most probe hits first, then the shortest title, then slug in
 * byte order, at most `limit` (rank_entities' possible duplicates for a remote caller).
 */
export async function listVisibleNameVariantCandidates(exec: LegacyUnscopedRead, sourceId: string, q: NameVariantCandidateQuery,
  opts: { excludePrivate?: boolean } = {}): Promise<NameVariantCandidateRow[]> {
  const limit = Math.max(0, Math.floor(q.limit));
  const priv = opts.excludePrivate ? sqlFragment` AND ${trustedSql(privatePagesFilterForCaller('pages'))}` : sqlFragment``;
  const { text, params } = renderFragment(sqlFragment`SELECT slug, title, type, frontmatter,
              (SELECT count(*)::int FROM unnest(${[...q.probes]}::text[]) w WHERE pages.title ILIKE w OR pages.slug ILIKE w) AS probe_hits
         FROM pages
        WHERE deleted_at IS NULL AND source_id = ${sourceId}
          AND (type = ANY(${[...q.types]}::text[]) OR slug LIKE ANY(${[...q.slugPatterns]}::text[]))
          AND (title ILIKE ANY(${[...q.probes]}::text[]) OR slug ILIKE ANY(${[...q.probes]}::text[]))${priv}
        ORDER BY probe_hits DESC, length(title), slug COLLATE "C"
        LIMIT ${limit}`);
  return exec.executeRaw<NameVariantCandidateRow>(text, params);
}

/** One name-variant candidate as an entity-card row (`ENTITY_CARD_COLUMNS_SQL`) with its probe hits. */
export interface NameVariantCardCandidateRow extends EntityCardRow { probe_hits: number }

/**
 * listVisibleNameVariantCandidates as entity-card rows (the entity card's name-variant arm, verbs/entity-variants.ts):
 * the same candidates under the same page policy, with the card columns, most probe hits first, then the shortest
 * title, then by slug, at most `limit`.
 */
export async function listNameVariantCardCandidates(exec: LegacyUnscopedRead, sourceId: string, q: NameVariantCandidateQuery,
  opts: { excludePrivate?: boolean } = {}): Promise<NameVariantCardCandidateRow[]> {
  const limit = Math.max(0, Math.floor(q.limit));
  const priv = opts.excludePrivate ? sqlFragment` AND ${trustedSql(privatePagesFilterForCaller('pages'))}` : sqlFragment``;
  const { text, params } = renderFragment(sqlFragment`SELECT ${trustedSql(ENTITY_CARD_COLUMNS_SQL)},
                (SELECT count(*)::int FROM unnest(${[...q.probes]}::text[]) w WHERE pages.title ILIKE w OR pages.slug ILIKE w) AS probe_hits
           FROM pages
          WHERE deleted_at IS NULL AND source_id = ${sourceId}
            AND (type = ANY(${[...q.types]}::text[]) OR slug LIKE ANY(${[...q.slugPatterns]}::text[]))
            AND (title ILIKE ANY(${[...q.probes]}::text[]) OR slug ILIKE ANY(${[...q.probes]}::text[]))${priv}
          ORDER BY probe_hits DESC, length(title), slug COLLATE "C"
          LIMIT ${limit}`);
  return exec.executeRaw<NameVariantCardCandidateRow>(text, params);
}

export interface VariantPageRow { slug: string; title: string | null; type: string | null; frontmatter: Record<string, unknown> | null }

/**
 * The live pages of the source at `slugs`, in `slugs` order (a repeated slug reads once per mention), as the
 * name-variant rows (slug, title, type, frontmatter); with `excludePrivate`, only pages the caller may read
 * (`privatePagesFilterForCaller`).
 */
export async function readVisibleVariantPages(exec: LegacyUnscopedRead, sourceId: string, slugs: readonly string[],
  opts: { excludePrivate?: boolean } = {}): Promise<VariantPageRow[]> {
  if (slugs.length === 0) return [];
  const priv = opts.excludePrivate ? sqlFragment` AND ${trustedSql(privatePagesFilterForCaller('pages'))}` : sqlFragment``;
  const { text, params } = renderFragment(sqlFragment`SELECT pages.slug, pages.title, pages.type, pages.frontmatter
         FROM unnest(${[...slugs]}::text[]) WITH ORDINALITY AS wanted(slug, n)
         JOIN pages ON pages.source_id = ${sourceId} AND pages.slug = wanted.slug AND pages.deleted_at IS NULL${priv}
        ORDER BY wanted.n`);
  return exec.executeRaw<VariantPageRow>(text, params);
}

export interface InboundLinkerCountRow { source_id: string; slug: string; n: number }

/**
 * For each page at (`sourceIds[i]`, `slugs[i]`) with inbound links, the number of distinct pages linking to it, any
 * link kind, deleted or not; pages with none are absent (doctor's person_title_duplicates link counts).
 */
export async function countDistinctInboundLinkers(exec: LegacyUnscopedRead, sourceIds: readonly string[], slugs: readonly string[]): Promise<InboundLinkerCountRow[]> {
  const { text, params } = renderFragment(sqlFragment`SELECT p.source_id, p.slug, count(DISTINCT l.from_page_id)::int AS n
           FROM pages p JOIN links l ON l.to_page_id = p.id
          WHERE (p.source_id, p.slug) IN (SELECT * FROM unnest(${[...sourceIds]}::text[], ${[...slugs]}::text[]))
          GROUP BY p.source_id, p.slug`);
  const rows = await exec.executeRaw<InboundLinkerCountRow>(text, params);
  return rows.map(row => ({ source_id: row.source_id, slug: row.slug, n: Number(row.n) }));
}

export interface ExtractionLagQuery {
  sourceId?: string;
  versionTs: string;
  attendance: boolean;
  held?: boolean;
  guests?: boolean;
  wantedProducers?: readonly string[];
  /** Statement bound; default 10 s. */
  timeoutMs?: number;
}

export interface ExtractionLagCounts { total: number; stale: number; attendance_blocked: number; held: number }

/** The link-extraction lag row (`extractionLagStatement`): live pages, stale, attendance-blocked and held counts. */
export async function readExtractionLagCounts(exec: TimedRawRead, q: ExtractionLagQuery): Promise<ExtractionLagCounts | undefined> {
  const { timeoutMs, ...shape } = q;
  const { text, params } = extractionLagStatement(shape);
  return (await exec.executeRaw<ExtractionLagCounts>(text, params, { timeoutMs: timeoutMs ?? 10_000 }))[0];
}

export interface IgnoredLabelPageRow { type: string | null; frontmatter: Record<string, unknown> | null }

/**
 * Live pages of one source, by slug (`slugs`) or updated since a database timestamp (`since`), that carry a privacy
 * label gbrain does not recognize and no visibility key (ignored-privacy-labels.ts `ignoredPrivacyLabelSql`), at most
 * `limit` (default SCAN_CAP) of them, in no particular order.
 */
export async function readIgnoredPrivacyLabelPages(exec: TimedRawRead, sourceId: string,
  scope: { slugs: readonly string[] } | { since: string }, opts: { limit?: number; timeoutMs?: number } = {}): Promise<IgnoredLabelPageRow[]> {
  const bySlug = 'slugs' in scope;
  const limit = Math.max(0, Math.floor(opts.limit ?? SCAN_CAP));
  const within = bySlug ? sqlFragment`p.slug = ANY(${[...new Set(scope.slugs)]}::text[])` : sqlFragment`p.updated_at >= ${scope.since}::timestamptz`;
  const { text, params } = renderFragment(sqlFragment`SELECT p.type, p.frontmatter FROM pages p
      WHERE p.source_id = ${sourceId} AND ${within} AND p.deleted_at IS NULL
        AND NOT (p.frontmatter ? 'readable_by') AND p.folder_rule_ids IS NULL
        AND ${trustedSql(privacyLabelKeySql('p'))} AND ${trustedSql(ignoredPrivacyLabelSql('p'))}
      LIMIT ${limit}`);
  return exec.executeRaw<IgnoredLabelPageRow>(text, params, { timeoutMs: opts.timeoutMs ?? NOTICE_READ_TIMEOUT_MS });
}

/**
 * The type and frontmatter of the live page at `slug` in the source, or null (put_page's ignored-label notice reads the
 * page it stored back, so the stored frontmatter decides). `timeoutMs` bounds the Postgres statement.
 */
export async function readLivePageFrontmatter(exec: TimedRawRead, sourceId: string, slug: string,
  opts: { timeoutMs?: number } = {}): Promise<IgnoredLabelPageRow | null> {
  const [page] = await exec.executeRaw<IgnoredLabelPageRow>(
    'SELECT type, frontmatter FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL', [sourceId, slug],
    { timeoutMs: opts.timeoutMs ?? NOTICE_READ_TIMEOUT_MS });
  return page ?? null;
}

/** The pages `entityAnchoredPages` reads per entity, besides the entity page (MAX_ANCHORED, search/entity-anchor.ts). */
export const ENTITY_ANCHORED_LIMIT = 10;

export interface EntityAnchoredPages { entity: { id: number; title: string | null } | null; pages: Array<{ id: number; slug: string }> }

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The live entity page at `entitySlug` in the source, then up to ENTITY_ANCHORED_LIMIT other live pages (no question,
 * synthesis or pinned-question page) whose compiled truth names it as a word (its last slug segment or its title, each
 * of three characters or more, case-insensitively) or that link to it by a ranking link, newest first, then by id.
 * The pinned-question marker and the ranking link types are written out: the dynamic-SQL guard allows `$4` twice
 * only in a static statement, and the caller raw-SQL pins rebuild both texts from their constants.
 */
export async function readEntityAnchoredPages(exec: TimedRawRead, sourceId: string, entitySlug: string): Promise<EntityAnchoredPages> {
  const [entity] = await exec.executeRaw<{ id: number; title: string | null }>(
    'SELECT id, title FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL', [sourceId, entitySlug]);
  const names = [...new Set([entitySlug.split('/').pop()!, ...(entity?.title ? [entity.title] : [])].filter(n => n.length >= 3))];
  const pattern = `\\m(${names.map(escapeRegex).join('|')})\\M`;
  const rows = await exec.executeRaw<{ id: number; slug: string }>(
    `SELECT p.id, p.slug FROM pages p WHERE p.source_id = $1 AND p.deleted_at IS NULL AND p.slug <> $2
       AND p.type NOT IN ('question', 'synthesis') AND NOT (p.frontmatter ? 'pinned_question')
       AND (p.compiled_truth ~* $3 OR ($4::integer IS NOT NULL AND EXISTS (SELECT 1 FROM links l WHERE l.from_page_id = p.id AND l.to_page_id = $4::integer AND l.link_type <> ALL(ARRAY['amends']::text[]))))
     ORDER BY COALESCE(p.effective_date, p.updated_at) DESC, p.id DESC LIMIT 10`,
    [sourceId, entitySlug, pattern, entity?.id ?? null]);
  return { entity: entity ? { id: Number(entity.id), title: entity.title } : null, pages: rows.map(r => ({ id: Number(r.id), slug: r.slug })) };
}

/** The title of each page id, deleted or not, in no set order; the anchored rows were authorized by getChunkWindows first. */
export async function readPageTitlesById(exec: TimedRawRead, ids: readonly number[]): Promise<Array<{ id: number; title: string }>> {
  const rows = await exec.executeRaw<{ id: number; title: string }>('SELECT id, title FROM pages WHERE id = ANY($1::int[])', [[...ids]]);
  return rows.map(r => ({ id: Number(r.id), title: r.title }));
}

/**
 * The stored `chunker_version` of the page row with id `pageId`, live, soft-deleted or segmented, as
 * `{ chunker_version }`; null when no row has the id (search/safe-chunks.ts provenanceDistrusted: a negative version
 * is a body write that removed a protected fence).
 */
export async function readPageChunkerVersion(exec: TimedRawRead, pageId: number): Promise<{ chunker_version: number | null } | null> {
  const [row] = await exec.executeRaw<{ chunker_version: number | null }>('SELECT chunker_version FROM pages WHERE id = $1', [pageId]);
  return row ? { chunker_version: row.chunker_version === null ? null : Number(row.chunker_version) } : null;
}

/**
 * Whether the image page at `slug` of the source (any row, live or soft-deleted) carries chunks sealed past the
 * safe-chunk fence, as `{ has_visual }` (whether any chunk holds an image vector); null when no row passes the fence
 * (import-file.ts importImageFile: an unchanged image whose index is complete is skipped). The fence test is written
 * out (`safeChunksFilter('p')`, SAFE_FENCE_CHUNKER_VERSION 4); the caller raw-SQL pins rebuild it from the builder.
 */
export async function readImageSealProbe(exec: TimedRawRead, sourceId: string, slug: string): Promise<{ has_visual: boolean } | null> {
  const [row] = await exec.executeRaw<{ has_visual: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM content_chunks c WHERE c.page_id = p.id AND c.embedding_image IS NOT NULL) AS has_visual
         FROM pages p WHERE p.source_id = $1 AND p.slug = $2 AND p.chunker_version >= 4`,
    [sourceId, slug]);
  return row ? { has_visual: row.has_visual === true } : null;
}

/**
 * Up to ENTITY_ANCHORED_LIMIT live pages of the source whose slug starts with `prefix` (taken literally: `\`, `%` and
 * `_` are escaped for LIKE), no question, synthesis or pinned-question page, newest first by
 * `COALESCE(effective_date, updated_at)`, then by id (search/entity-anchor.ts prefixAnchoredPages). The pinned-question
 * marker and the limit are written out, as in readEntityAnchoredPages; the caller raw-SQL pins rebuild both.
 */
export async function readPrefixAnchoredPages(exec: TimedRawRead, sourceId: string, prefix: string): Promise<Array<{ id: number; slug: string }>> {
  const rows = await exec.executeRaw<{ id: number; slug: string }>(
    `SELECT id, slug FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND slug LIKE $2
       AND type NOT IN ('question', 'synthesis') AND NOT (frontmatter ? 'pinned_question')
     ORDER BY COALESCE(effective_date, updated_at) DESC, id DESC LIMIT 10`,
    [sourceId, `${prefix.replace(/[\\%_]/g, '\\$&')}%`]);
  return rows.map(r => ({ id: Number(r.id), slug: r.slug }));
}

/** One page a text-mention probe lists; `date` is `COALESCE(effective_date, updated_at)`. */
export interface TextMentionPageRow { slug: string; source_id: string; title: string | null; type: string | null; frontmatter: Record<string, unknown> | null; date: Date | string | null }

/** The live pages at `slugs` in `sourceIds`, in no set order (the entity card's text-mention probe; the caller keeps the keyword hits only). */
export async function readTextMentionPages(exec: TimedRawRead, sourceIds: readonly string[], slugs: readonly string[]): Promise<TextMentionPageRow[]> {
  return exec.executeRaw<TextMentionPageRow>(
    `SELECT slug, source_id, title, type, frontmatter, COALESCE(effective_date, updated_at) AS date
       FROM pages WHERE deleted_at IS NULL AND source_id = ANY($1::text[]) AND slug = ANY($2::text[])`,
    [[...sourceIds], [...slugs]]);
}

/**
 * The slugs among `slugs` at which a live page sits in the source, retired or not, each once, in no set order
 * (entities/resolve.ts `tryOrgDirVariant`); `limit: 2` stops at two (`findExactBasenameCandidates`).
 */
export async function readLiveSlugs(exec: LegacyUnscopedRead, sourceId: string, slugs: readonly string[], opts: { limit?: 2 } = {}): Promise<string[]> {
  const rows = opts.limit === 2
    ? await exec.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages
        WHERE source_id = $1 AND deleted_at IS NULL AND slug = ANY($2::text[])
        LIMIT 2`, [sourceId, [...slugs]])
    : await exec.executeRaw<{ slug: string }>(
      'SELECT slug FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND slug = ANY($2::text[])', [sourceId, [...slugs]]);
  return rows.map(row => row.slug);
}

/** The entity resolver's privacy on a page read: none, the caller page policy, or the remote read floor. */
export type ResolverPrivacy = Exclude<RetirementPrivacy, 'member_access'>;

/** A live page the entity resolver weighs: its slug and type. */
export interface LivePageTypeRow { slug: string; type: string | null }

/**
 * The live pages of the source among `slugs`, retired or not, with their types, that `privacy` admits, each once, in
 * no set order (entities/resolve.ts `resolveStrictEntityReference`).
 */
export async function readLivePageTypes(exec: LegacyUnscopedRead, sourceId: string, slugs: readonly string[], privacy: ResolverPrivacy): Promise<LivePageTypeRow[]> {
  const { text, params } = renderFragment(sqlFragment`SELECT p.slug, p.type FROM pages p
      WHERE p.source_id = ${sourceId} AND p.deleted_at IS NULL AND p.slug = ANY(${[...slugs]}::text[]) ${retirementPrivacySql(privacy)}`);
  return exec.executeRaw<LivePageTypeRow>(text, params);
}

/**
 * Which title-similarity read of the entity resolver: `same_name` (the strict resolver's same-name arm, five pages),
 * `near` (the refusal's nearest entity pages, twenty) or `fuzzy` (`tryFuzzyMatch`, five, with the score, no privacy).
 */
export type TrigramCandidateQuery =
  | { arm: 'same_name' | 'near'; titleLc: string; slugFragment: string; privacy: ResolverPrivacy }
  | { arm: 'fuzzy'; titleLc: string; slugFragment: string };

/** A title-similarity candidate; `score` (the larger of the title and slug trigram similarity) only on the `fuzzy` arm. */
export interface TrigramCandidateRow { slug: string; title: string; type: string | null; score?: number }

/**
 * The live, non-retired pages of the source whose lowered title is trigram-similar (`%`) to `titleLc` or whose slug
 * contains `slugFragment` (ILIKE, so `%` and `_` stay wildcards), best similarity first, then by slug. The statements
 * name `$1` the source, `$2` the lowered title and `$3` the slug fragment by hand, as entities/resolve.ts sent them,
 * because the title and fragment appear twice; no interpolated value is bound. Throws pg_trgm's error where the
 * extension is missing (the callers catch it).
 */
export async function readTrigramCandidates(exec: LegacyUnscopedRead, sourceId: string, q: TrigramCandidateQuery): Promise<TrigramCandidateRow[]> {
  const retired = trustedSql(retiredPageSql(q.arm === 'fuzzy' ? 'pages' : 'p'));
  const fragment = q.arm === 'fuzzy'
    ? sqlFragment`${trustedSql(`SELECT slug, title, type,
         GREATEST(
           similarity(lower(title), $2),
           similarity(slug, $3)
         ) AS score
       FROM pages
       WHERE source_id = $1
         AND deleted_at IS NULL
         AND NOT `)}${retired}${trustedSql(`
         AND (
           lower(title) % $2
           OR slug ILIKE '%' || $3 || '%'
         )
       ORDER BY score DESC, slug COLLATE "C" ASC
       LIMIT 5`)}`
    : q.arm === 'same_name'
      ? sqlFragment`${trustedSql(`SELECT p.slug, p.title, p.type FROM pages p
          WHERE p.source_id = $1 AND p.deleted_at IS NULL `)}${retirementPrivacySql(q.privacy)} AND NOT ${retired}${trustedSql(`
            AND (lower(p.title) % $2 OR p.slug ILIKE '%' || $3 || '%')
          ORDER BY GREATEST(similarity(lower(p.title), $2), similarity(p.slug, $3)) DESC, p.slug COLLATE "C" ASC
          LIMIT 5`)}`
      : sqlFragment`${trustedSql(`SELECT p.slug, p.title, p.type FROM pages p
      WHERE p.source_id = $1 AND p.deleted_at IS NULL AND NOT `)}${retired} ${retirementPrivacySql(q.privacy)}${trustedSql(`
        AND (lower(p.title) % $2 OR p.slug ILIKE '%' || $3 || '%')
      ORDER BY GREATEST(similarity(lower(p.title), $2), similarity(p.slug, $3)) DESC, p.slug COLLATE "C" ASC
      LIMIT 20`)}`;
  const { text, params } = renderFragment(fragment);
  if (params.length !== 0) throw new Error('readTrigramCandidates: a fragment bound a value ahead of the hand-numbered parameters');
  return exec.executeRaw<TrigramCandidateRow>(text, [sourceId, q.titleLc, q.slugFragment]);
}

/** Which prefix read of the entity resolver: `patterns` (findPrefixCandidates, `LIKE ANY`, ten) or `pattern` (tryPrefixExpansion, one `LIKE`, five). */
export type PrefixCandidateQuery = { patterns: readonly string[] } | { pattern: string };

/** A prefix candidate with its connection count: inbound plus outbound ranking links plus content chunks. */
export interface PrefixCandidateRow { slug: string; connection_count: number }

/**
 * The live, non-retired pages of the source whose slug matches the LIKE pattern (or any of the patterns), most connected
 * first (inbound and outbound ranking links, `rankingLinkSql`, plus every content chunk), then by slug.
 */
export async function readPrefixCandidates(exec: LegacyUnscopedRead, sourceId: string, q: PrefixCandidateQuery): Promise<PrefixCandidateRow[]> {
  const inbound = trustedSql(rankingLinkSql('l'));
  const retired = trustedSql(retiredPageSql('p'));
  const fragment = 'patterns' in q
    ? sqlFragment`SELECT p.slug,
              ((SELECT COUNT(*)::int FROM links l WHERE l.to_page_id = p.id AND ${inbound})
               + (SELECT COUNT(*)::int FROM links l WHERE l.from_page_id = p.id AND ${inbound})
               + (SELECT COUNT(*)::int FROM content_chunks WHERE page_id = p.id))
                AS connection_count
       FROM pages p
       WHERE p.source_id = ${sourceId}
         AND p.deleted_at IS NULL
         AND NOT ${retired}
         AND p.slug LIKE ANY(${[...q.patterns]}::text[])
       ORDER BY connection_count DESC, p.slug COLLATE "C" ASC
       LIMIT 10`
    : sqlFragment`SELECT p.slug,
                ((SELECT COUNT(*)::int FROM links l WHERE l.to_page_id = p.id AND ${inbound})
                 + (SELECT COUNT(*)::int FROM links l WHERE l.from_page_id = p.id AND ${inbound})
                 + (SELECT COUNT(*)::int FROM content_chunks WHERE page_id = p.id))
                  AS connection_count
         FROM pages p
         WHERE p.source_id = ${sourceId}
           AND p.deleted_at IS NULL
           AND NOT ${retired}
           AND p.slug LIKE ${q.pattern}
         ORDER BY connection_count DESC, p.slug COLLATE "C" ASC
         LIMIT 5`;
  const { text, params } = renderFragment(fragment);
  return exec.executeRaw<PrefixCandidateRow>(text, params);
}

/**
 * The distinct entity directories (`split_part(slug, '/', 1)`) of the live, non-retired pages of the source whose slug
 * matches any LIKE pattern, at most two and in no set order: tryUnambiguousPrefixExpansion asks only whether there is one.
 */
export async function readPrefixDirs(exec: LegacyUnscopedRead, sourceId: string, patterns: readonly string[]): Promise<string[]> {
  const { text, params } = renderFragment(sqlFragment`SELECT DISTINCT split_part(slug, '/', 1) AS dir FROM pages
        WHERE source_id = ${sourceId} AND deleted_at IS NULL AND NOT ${trustedSql(retiredPageSql('pages'))} AND slug LIKE ANY(${[...patterns]}::text[])
        LIMIT 2`);
  return (await exec.executeRaw<{ dir: string }>(text, params)).map(r => r.dir);
}

/** A prefix page whose title is the bare name. */
export interface PrefixTitleRow { slug: string; title: string | null }

/**
 * The live, non-retired pages of the source whose slug matches any LIKE pattern and whose lowered title equals the
 * lowered `title`, at most three and in no set order (tryUnambiguousPrefixExpansion keeps only an exact single match).
 */
export async function readPrefixTitleMatches(exec: LegacyUnscopedRead, sourceId: string, patterns: readonly string[], title: string): Promise<PrefixTitleRow[]> {
  const { text, params } = renderFragment(sqlFragment`SELECT slug, title FROM pages
        WHERE source_id = ${sourceId} AND deleted_at IS NULL AND NOT ${trustedSql(retiredPageSql('pages'))}
          AND slug LIKE ANY(${[...patterns]}::text[]) AND lower(title) = lower(${title})
        LIMIT 3`);
  return exec.executeRaw<PrefixTitleRow>(text, params);
}

/**
 * The live, non-retired pages among `slugs` in the source that `privacy` admits, by slug, at most five: the named
 * pages (basename directories, org-directory variants, aliases, prefix candidates) entityReferenceCandidates offers.
 */
export async function readNamedEntitySlugs(exec: LegacyUnscopedRead, sourceId: string, slugs: readonly string[], privacy: ResolverPrivacy): Promise<string[]> {
  const { text, params } = renderFragment(sqlFragment`SELECT p.slug FROM pages p
      WHERE p.source_id = ${sourceId} AND p.deleted_at IS NULL AND NOT ${trustedSql(retiredPageSql('p'))} AND p.slug = ANY(${[...slugs]}::text[]) ${retirementPrivacySql(privacy)}
      ORDER BY p.slug COLLATE "C" LIMIT 5`);
  return (await exec.executeRaw<{ slug: string }>(text, params)).map(r => r.slug);
}
