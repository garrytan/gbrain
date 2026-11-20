/**
 * Entity and mention reads the CLI made through `engine.executeRaw` (docs/research/rust-cli-executeraw-map.md): one SQL
 * implementation for both engines, so the call sites can name a typed engine member and a Rust brain can answer them.
 * Each statement is the one its call site ran, with the same parameters; the call site keeps its own fallbacks.
 */
import type { LegacyUnscopedRead } from './brands.ts';
import { extractionLagStatement } from './pages.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';
import { retiredPageSql } from '../entities/resolve.ts';
import { privatePagesFilterForCaller } from '../search/private-visibility.ts';
import { quarantineFilterFragment } from '../quarantine.ts';
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
      ORDER BY slug LIMIT ${limit}`);
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

export interface SlugPatternPageRow { slug: string; title: string | null }

/**
 * Live pages of one source that are not retired (`retiredPageSql`) and whose slug matches one of the LIKE `patterns`,
 * by slug, at most `limit` (doctor's person_title_duplicates stubs).
 */
export async function listUnretiredPagesBySlugPattern(exec: LegacyUnscopedRead, sourceId: string, patterns: readonly string[], limit: number): Promise<SlugPatternPageRow[]> {
  const cap = Math.max(0, Math.floor(limit));
  const { text, params } = renderFragment(sqlFragment`SELECT slug, title FROM pages
          WHERE source_id = ${sourceId} AND deleted_at IS NULL AND slug LIKE ANY(${[...patterns]}::text[]) AND NOT ${trustedSql(retiredPageSql('pages'))}
          ORDER BY slug LIMIT ${cap}`);
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
        ORDER BY probe_hits DESC, length(title), slug
        LIMIT ${limit}`);
  return exec.executeRaw<NameVariantCandidateRow>(text, params);
}

export interface PageRetirementRow { slug: string; type: string | null; retired: boolean; target: string | null }

/**
 * The live page at `slug` in the source, whether it is retired (`retiredPageSql`) and its trimmed `superseded_by`
 * (else `merged_into`) value; null when no live page sits there (entities/resolve.ts `followRetirement`).
 */
export async function readPageRetirement(exec: LegacyUnscopedRead, sourceId: string, slug: string): Promise<PageRetirementRow | null> {
  const { text, params } = renderFragment(sqlFragment`SELECT p.slug, p.type, ${trustedSql(retiredPageSql('p'))} AS retired,
              COALESCE(NULLIF(btrim(p.frontmatter->>'superseded_by'), ''), NULLIF(btrim(p.frontmatter->>'merged_into'), '')) AS target
         FROM pages p
        WHERE p.source_id = ${sourceId} AND p.slug = ${slug} AND p.deleted_at IS NULL
        LIMIT 1`);
  const [row] = await exec.executeRaw<PageRetirementRow>(text, params);
  return row ?? null;
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
