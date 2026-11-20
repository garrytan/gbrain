/**
 * The trust writes of a derivation as typed engine members: the statements trust/taint.ts,
 * persistence/derived-retirement-hold.ts and the atom generation adapter sent through `executeRaw`, byte for byte, with
 * the same parameters. `lowerTrustTier` is the exception: it binds its values through `sqlFragment`, so its placeholders
 * are renumbered in text order and the tier it compares against binds as a rank (`TRUST_TIER_RANK`, 0 for an unknown
 * tier, as the CASE expression gave).
 *
 * - `lowerTrustTier`: lowers rows of one taint table to a derivation's tier and origin, never raising.
 * - `countDerivedRowTaint`: how many take, timeline or page rows carry `taint_inputs`, and how many of those are
 *   external_untrusted (the facts count is `countDerivedFactTaint`).
 * - `stampPageFrontmatter`: one of two fixed frontmatter stamps: the retirement stamp on soft-deleted pages, and the
 *   atom generation's `source_hash` on its live atoms.
 * - `lowerDerivedDependents`: one hop of the derived-tier propagation (trust/propagation.ts): lowers each listed derived
 *   row whose recorded inputs (`derivation_inputs`) are now less trusted than it, and on a managed brain marks a row of a
 *   source the write does not hold `needs_rederive` instead.
 * - `readTierProjectionPage`, `queuePageProjection`: the page whose projection a tier change rebuilds, and the queued
 *   rebuild (page_projection_jobs) every projection writer shares (page-state/projections.ts).
 * - `locateRetierSubjects`, `latestRetierEventKey`: where a retiered row lives, and the newest event that recorded a
 *   ledger subject's tier change (belief/retier.ts).
 *
 * The Rust engine serves them from its page, take, timeline and fact records
 * (rust/crates/gbrain-store/src/trust/derivation.rs). The derivation edges (`derivation_inputs`) are not here.
 */
import type { EngineRawRead } from './cli-reads-ops.ts';
import { KEEP_HIDDEN_AT } from './facts-purge.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';
import { TRUST_TIER_RANK, trustRankSql, trustTierFromRankSql, type TaintTable, type TrustTier, type WriteOrigin } from '../trust/tier.ts';

const TAINT_TABLES: readonly TaintTable[] = ['facts', 'takes', 'pages', 'timeline_entries'];
/** The table text of each taint table, so a statement splices a constant (check:engine-sql-dynamic). */
const TAINT_TABLE_SQL = { facts: 'facts', takes: 'takes', pages: 'pages', timeline_entries: 'timeline_entries' } as const;
const TAINT_SHARE_TABLES = ['takes', 'timeline_entries', 'pages'] as const;

/** A table `countDerivedRowTaint` counts. */
export type DerivedTaintTable = typeof TAINT_SHARE_TABLES[number];

/** A fixed frontmatter stamp on named pages of one source. */
export type PageFrontmatterStamp =
  /** `retired_by` and `retired_at` on the soft-deleted pages of `slugs`. */
  | { match: 'retired'; sourceId: string; slugs: readonly string[]; retiredBy: string; retiredAt: string }
  /** `source_hash` on the live atom pages of `slugs`. */
  | { match: 'atom_source_hash'; sourceId: string; slugs: readonly string[]; sourceHash: string };

/** A derived row `lowerDerivedDependents` lowered: its stored tier before and the tier it has now. */
export interface LoweredDependent { id: number; from_tier: string; to_tier: string }

/** Where a fact, take or page lives (`t` is its table); `slug` is null for a fact with no page or entity. */
export interface RetierSubjectRow { t: 'facts' | 'takes' | 'pages'; id: number; source_id: string; slug: string | null }

function taintTable(member: string, table: string): TaintTable {
  if (!(TAINT_TABLES as readonly string[]).includes(table)) throw new Error(`${member}: unknown table ${JSON.stringify(table)}`);
  return table as TaintTable;
}

/** Lowers the rows of `ids` whose stored tier ranks above `tier` to `tier` and `origin`; resolves the ids lowered. */
export async function lowerTrustTier(raw: EngineRawRead, table: TaintTable, ids: readonly number[], tier: TrustTier,
  origin: WriteOrigin | null): Promise<number[]> {
  const name = taintTable('lowerTrustTier', table);
  if (!ids.length) return [];
  const { text, params } = renderFragment(sqlFragment`UPDATE ${trustedSql(TAINT_TABLE_SQL[name])} SET trust_tier=${tier},write_origin=${origin ? JSON.stringify(origin) : null}::text::jsonb
      WHERE id=ANY(${[...ids]}::bigint[]) AND ${trustedSql(trustRankSql('trust_tier'))}>${TRUST_TIER_RANK[tier] ?? 0}::int RETURNING id`);
  const rows = await raw<{ id: number | string }>(text, params);
  return rows.map(row => Number(row.id));
}

/** How many rows of `table` carry `taint_inputs` in their write origin, and how many of those are external_untrusted. */
export async function countDerivedRowTaint(raw: EngineRawRead, table: DerivedTaintTable): Promise<{ derived: number; external: number }> {
  if (!(TAINT_SHARE_TABLES as readonly string[]).includes(table)) throw new Error(`countDerivedRowTaint: unknown table ${JSON.stringify(table)}`);
  const [row] = await raw<{ derived: number | string; external: number | string }>(
    `SELECT count(*) FILTER (WHERE write_origin ? 'taint_inputs') AS derived,
                count(*) FILTER (WHERE write_origin ? 'taint_inputs' AND trust_tier = 'external_untrusted') AS external FROM ${table}`);
  return { derived: Number(row?.derived ?? 0), external: Number(row?.external ?? 0) };
}

/** Applies one fixed frontmatter stamp. */
export async function stampPageFrontmatter(raw: EngineRawRead, stamp: PageFrontmatterStamp): Promise<void> {
  if (stamp.match === 'retired') {
    await raw(`UPDATE pages SET frontmatter=frontmatter||jsonb_build_object('retired_by',$1::text,'retired_at',$2::text)
    WHERE source_id=$3 AND slug=ANY($4::text[]) AND deleted_at IS NOT NULL`, [stamp.retiredBy, stamp.retiredAt, stamp.sourceId, [...stamp.slugs]]);
  } else if (stamp.match === 'atom_source_hash') {
    await raw(`UPDATE pages SET frontmatter = frontmatter || jsonb_build_object('source_hash', $1::text)
      WHERE source_id = $2 AND type = 'atom' AND slug = ANY($3::text[]) AND deleted_at IS NULL`, [stamp.sourceHash, stamp.sourceId, [...stamp.slugs]]);
  } else {
    throw new Error(`stampPageFrontmatter: unknown match ${JSON.stringify((stamp as { match: unknown }).match)}`);
  }
}

/** `di.input_id` and `low.derived_id` as a bigint when numeric, else null. */
const INPUT_ID_SQL = "(CASE WHEN di.input_id ~ '^[0-9]+$' THEN di.input_id::bigint END)";
const DERIVED_ID_SQL = "(CASE WHEN low.derived_id ~ '^[0-9]+$' THEN low.derived_id::bigint END)";
/** The source of a derived row `x`: its own column, or its page's for a take or timeline entry. */
const SOURCE_OF_SQL = {
  facts: 'x.source_id', pages: 'x.source_id',
  takes: '(SELECT p.source_id FROM pages p WHERE p.id = x.page_id)', timeline_entries: '(SELECT p.source_id FROM pages p WHERE p.id = x.page_id)',
} as const;
const INPUT_TIER = 'COALESCE(f.trust_tier, k.trust_tier, p.trust_tier, t.trust_tier)';

/**
 * One hop of the derived-tier propagation: of the `table` rows among `ids` (derived row ids, as `derivation_inputs`
 * records them), each whose least trusted recorded input ranks below it is lowered to that input's tier, with
 * `write_origin.input_lowered` naming the tier it had. On a managed brain a row of a source the enclosing coordinated
 * write does not hold is marked `needs_rederive` (reason `input_lowered`) instead. Resolves the rows lowered, by id.
 */
export async function lowerDerivedDependents(raw: EngineRawRead, table: TaintTable, ids: readonly string[], managed: boolean): Promise<LoweredDependent[]> {
  const name = taintTable('lowerDerivedDependents', table);
  if (!ids.length) return [];
  const tableSql = trustedSql(TAINT_TABLE_SQL[name]), source = trustedSql(SOURCE_OF_SQL[name]), inputId = trustedSql(INPUT_ID_SQL);
  const select = renderFragment(sqlFragment`WITH low AS (
      SELECT di.derived_id, min(${trustedSql(trustRankSql(INPUT_TIER))}) AS r FROM derivation_inputs di
        LEFT JOIN facts f ON di.input_table = 'facts' AND f.id = ${inputId}
        LEFT JOIN takes k ON di.input_table = 'takes' AND k.id = ${inputId}
        LEFT JOIN pages p ON di.input_table = 'pages' AND p.id = ${inputId}
        LEFT JOIN timeline_entries t ON di.input_table = 'timeline_entries' AND t.id = ${inputId}
      WHERE di.derived_table = ${name} AND di.derived_id = ANY(${[...ids]}::text[]) AND ${trustedSql(INPUT_TIER)} IS NOT NULL
      GROUP BY di.derived_id)
    SELECT x.id, ${source} AS source_id, x.trust_tier AS from_tier, ${trustedSql(trustTierFromRankSql('low.r'))} AS to_tier, (NOT ${managed}::boolean OR COALESCE(NULLIF(current_setting('gbrain.write_sources', true), ''), '[]')::jsonb ? ${source}) AS writable
      FROM low JOIN ${tableSql} x ON x.id = ${trustedSql(DERIVED_ID_SQL)} WHERE low.r < ${trustedSql(trustRankSql('x.trust_tier'))}
      ORDER BY x.id FOR UPDATE OF x`);
  const candidates = await raw<{ id: number; source_id: string | null; from_tier: string; to_tier: string; writable: boolean }>(select.text, select.params);
  const writable = candidates.filter(c => c.writable);
  const deferred = candidates.filter(c => !c.writable);
  if (writable.length) {
    const rows = JSON.stringify(writable.map(c => ({ id: Number(c.id), from_tier: c.from_tier, to_tier: c.to_tier })));
    const update = renderFragment(sqlFragment`UPDATE ${tableSql} x SET trust_tier = c.to_tier,
          write_origin = COALESCE(x.write_origin, '{}'::jsonb) || jsonb_build_object('input_lowered', jsonb_build_object('from', c.from_tier, 'at', now()::text))
        FROM jsonb_to_recordset(${rows}::text::jsonb) AS c(id bigint, from_tier text, to_tier text) WHERE x.id = c.id`);
    await raw(update.text, update.params);
  }
  if (deferred.length) {
    const marks = JSON.stringify(deferred.map(d => ({ derived_table: name, derived_id: String(d.id), source_id: d.source_id })));
    const mark = renderFragment(sqlFragment`INSERT INTO needs_rederive(derived_table, derived_id, source_id, reason)
      SELECT d.derived_table, d.derived_id, d.source_id, 'input_lowered' FROM jsonb_to_recordset(${marks}::text::jsonb) AS d(derived_table text, derived_id text, source_id text)
      ON CONFLICT (derived_table, derived_id) DO UPDATE SET reason = EXCLUDED.reason, marked_at = ${trustedSql(KEEP_HIDDEN_AT)}`);
    await raw(mark.text, mark.params);
  }
  return writable.map(c => ({ id: Number(c.id), from_tier: c.from_tier, to_tier: c.to_tier }));
}

/** The page whose chunks render the fact, take or page `id`: a fact's provenance page, a take's page, or the page itself; null when none. */
export async function readTierProjectionPage(raw: EngineRawRead, table: 'facts' | 'takes' | 'pages', id: number): Promise<{ source_id: string; slug: string } | null> {
  const sql = table === 'facts' ? 'SELECT source_id, source_markdown_slug AS slug FROM facts WHERE id = $1 AND source_markdown_slug IS NOT NULL'
    : table === 'takes' ? 'SELECT p.source_id, p.slug FROM takes t JOIN pages p ON p.id = t.page_id WHERE t.id = $1'
      : table === 'pages' ? 'SELECT source_id, slug FROM pages WHERE id = $1' : null;
  if (!sql) throw new Error(`readTierProjectionPage: unknown table ${JSON.stringify(table)}`);
  const [page] = await raw<{ source_id: string; slug: string }>(sql, [id]);
  return page ? { source_id: page.source_id, slug: page.slug } : null;
}

/** Queues the live page's latest revision for a projection rebuild with `reason`; nothing when the page is gone. */
export async function queuePageProjection(raw: EngineRawRead, sourceId: string, slug: string, reason: string): Promise<void> {
  await raw(`INSERT INTO page_projection_jobs(source_incarnation,slug,revision,reason)
    SELECT s.incarnation,p.slug,p.knowledge_revision,$3 FROM pages p JOIN sources s ON s.id=p.source_id
    WHERE p.source_id=$1 AND p.slug=$2 AND p.deleted_at IS NULL
    ON CONFLICT(source_incarnation,slug) DO UPDATE SET revision=EXCLUDED.revision,reason=EXCLUDED.reason,updated_at=now()`, [sourceId, slug, reason]);
}

/** Where each listed fact, take and page lives: a fact's stream is its provenance page, else its entity. */
export async function locateRetierSubjects(raw: EngineRawRead, ids: { facts: readonly number[]; takes: readonly number[]; pages: readonly number[] }): Promise<RetierSubjectRow[]> {
  const rows = await raw<{ t: RetierSubjectRow['t']; id: number | string; source_id: string; slug: string | null }>(`
    SELECT 'facts' AS t, id, source_id, COALESCE(source_markdown_slug, entity_slug) AS slug FROM facts WHERE id = ANY($1::bigint[])
    UNION ALL SELECT 'takes', t.id, p.source_id, p.slug FROM takes t JOIN pages p ON p.id = t.page_id WHERE t.id = ANY($2::bigint[])
    UNION ALL SELECT 'pages', id, source_id, slug FROM pages WHERE id = ANY($3::bigint[])`, [[...ids.facts], [...ids.takes], [...ids.pages]]);
  return rows.map(r => ({ t: r.t, id: Number(r.id), source_id: r.source_id, slug: r.slug }));
}

/** The hex key of the newest `trust.retiered` event or bulk summary naming `subjectKey` in the source, or null. */
export async function latestRetierEventKey(raw: EngineRawRead, sourceId: string, subjectKey: string): Promise<string | null> {
  const [row] = await raw<{ key: string }>(`SELECT encode(k.event_key, 'hex') AS key FROM (
        SELECT e.id, e.event_key FROM belief_events e WHERE e.source_id = $1 AND e.subject_key = $2 AND e.event_type = 'trust.retiered'
        UNION ALL SELECT e.id, e.event_key FROM belief_retier_manifest m JOIN belief_events e ON e.id = m.summary_event
          WHERE m.source_id = $1 AND m.subject_key = $2) k ORDER BY k.id DESC LIMIT 1`, [sourceId, subjectKey]);
  return row?.key ?? null;
}
