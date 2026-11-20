/**
 * The scans of `gbrain repair` that ran through `executeRaw`, each with the statement text and parameters its caller used;
 * only its home moved. Every one orders by byte (`COLLATE "C"`), so a repair preview lists its items, and its item cursors
 * point, in the same order on every engine whatever the database locale is (test/engine-parity/collate-repair-scans.test.ts).
 * The text of each is pinned in test/engine-sql-caller-raw-sql-pins.test.ts.
 *
 * `listPagelessEntityFacts` and `listSourceIncarnations` carry the names and signatures the memory-records-rest lane gave
 * them (2eb69f4613, src/core/engine-sql/facts-repair.ts), with the byte order this wave pins.
 */
import type { EngineRawRead } from './cli-reads-ops.ts';

const MISSING = (alias: string, column: string) =>
  `NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id=${alias}.source_id AND p.slug=${alias}.${column})`;
const SOFT_DELETED = (alias: string, column: string) =>
  `EXISTS (SELECT 1 FROM pages p WHERE p.source_id=${alias}.source_id AND p.slug=${alias}.${column} AND p.deleted_at IS NOT NULL)`;

export interface OrphanedAliasCount { source_id: string; slug_redirects: number; page_aliases: number }

/** Per source, the alias rows (both tables) whose target page row is absent, in byte order of source id (repair/aliases.ts `ORPHANED_ALIAS_COUNTS_SQL`). */
export async function countOrphanedAliasRows(raw: EngineRawRead): Promise<OrphanedAliasCount[]> {
  return raw<OrphanedAliasCount>(`SELECT source_id,sum(slug_redirects)::int AS slug_redirects,sum(page_aliases)::int AS page_aliases FROM (
    SELECT sa.source_id,1 AS slug_redirects,0 AS page_aliases FROM slug_aliases sa WHERE ${MISSING('sa', 'canonical_slug')}
    UNION ALL SELECT pa.source_id,0,1 FROM page_aliases pa WHERE ${MISSING('pa', 'slug')}) o GROUP BY source_id ORDER BY source_id COLLATE "C"`);
}

export interface OrphanedAliasTarget { source_id: string; slug: string; page_aliases: number; slug_redirects: number }

/** Per (source, target slug) of these sources, the alias rows whose target page row is absent, in byte order of source id then slug (repair/aliases.ts `plan`). */
export async function listOrphanedAliasTargets(raw: EngineRawRead, sourceIds: readonly string[]): Promise<OrphanedAliasTarget[]> {
  return raw<OrphanedAliasTarget>(
    `SELECT source_id,slug,sum(page_aliases)::int AS page_aliases,sum(slug_redirects)::int AS slug_redirects FROM (
         SELECT pa.source_id,pa.slug,1 AS page_aliases,0 AS slug_redirects FROM page_aliases pa WHERE pa.source_id=ANY($1::text[]) AND ${MISSING('pa', 'slug')}
         UNION ALL SELECT sa.source_id,sa.canonical_slug,0,1 FROM slug_aliases sa WHERE sa.source_id=ANY($1::text[]) AND ${MISSING('sa', 'canonical_slug')}
       ) o GROUP BY source_id,slug ORDER BY source_id COLLATE "C",slug COLLATE "C"`, [[...sourceIds]]);
}

/** How many alias rows of these sources (both tables) name a soft-deleted page (repair/aliases.ts `plan`). */
export async function countSoftDeletedAliasTargets(raw: EngineRawRead, sourceIds: readonly string[]): Promise<number> {
  const [soft] = await raw<{ n: number }>(`SELECT
        (SELECT count(*)::int FROM page_aliases pa WHERE pa.source_id=ANY($1::text[]) AND ${SOFT_DELETED('pa', 'slug')})
      + (SELECT count(*)::int FROM slug_aliases sa WHERE sa.source_id=ANY($1::text[]) AND ${SOFT_DELETED('sa', 'canonical_slug')}) AS n`, [[...sourceIds]]);
  return Number(soft?.n ?? 0);
}

export interface DuplicateFactRow {
  id: number | string; source_id: string; visibility: string; fp: string; fact: string; entity_slug: string | null;
  fenced: boolean; row_num: number | string | null; source_markdown_slug: string | null; speaker: string;
}

/**
 * The active facts of these sources that share a fingerprint, speaker, visibility and source with another, as
 * repair/duplicate-facts.ts `findDuplicateFacts` groups them: in (source, visibility, fingerprint, speaker) order by byte,
 * the fenced copies first, then oldest first. `auditSources` are the fact `source` values left out.
 */
export async function listDuplicateFactRows(raw: EngineRawRead, sourceIds: readonly string[], auditSources: readonly string[]): Promise<DuplicateFactRow[]> {
  return raw<DuplicateFactRow>(`
    SELECT * FROM (
      SELECT f.id, f.source_id, f.visibility, gbrain_fact_fingerprint(f.fact) AS fp, f.fact, f.entity_slug, f.row_num, f.source_markdown_slug, f.created_at,
             COALESCE(f.attributed_to, '') AS speaker,
             (f.row_num IS NOT NULL AND f.source_markdown_slug IS NOT NULL AND COALESCE(f.source, '') NOT LIKE 'cli:%') AS fenced,
             count(*) OVER (PARTITION BY f.source_id, f.visibility, COALESCE(f.attributed_to, ''), gbrain_fact_fingerprint(f.fact)) AS n
        FROM facts f
       WHERE f.source_id = ANY($1::text[]) AND f.expired_at IS NULL AND (f.valid_until IS NULL OR f.valid_until > now())
         AND f.superseded_by IS NULL AND COALESCE(f.source, '') <> ALL($2::text[])
    ) d WHERE d.n > 1
    ORDER BY d.source_id COLLATE "C", d.visibility COLLATE "C", d.fp COLLATE "C", d.speaker COLLATE "C", d.fenced DESC, d.created_at, d.id`,
  [[...sourceIds], [...auditSources]]);
}

export interface PagelessEntityFactRow { source_id: string; slug: string; ids: Array<number | string> | null; fenced: number | string }

/** Per page-less `entity_slug` of these sources: the database-only fact ids (id order) and the count of fence-held facts, in (source, slug) order by byte. */
export async function listPagelessEntityFacts(raw: EngineRawRead, sourceIds: string[]): Promise<PagelessEntityFactRow[]> {
  return raw<PagelessEntityFactRow>(`
    SELECT f.source_id, f.entity_slug AS slug,
           array_agg(f.id ORDER BY f.id) FILTER (WHERE f.row_num IS NULL) AS ids,
           count(*) FILTER (WHERE f.row_num IS NOT NULL) AS fenced
      FROM facts f
     WHERE f.source_id = ANY($1::text[]) AND f.entity_slug IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id = f.source_id AND p.slug = f.entity_slug AND p.deleted_at IS NULL)
     GROUP BY f.source_id, f.entity_slug
     ORDER BY f.source_id COLLATE "C", f.entity_slug COLLATE "C"`, [sourceIds]);
}

/** The id and incarnation (as text) of each named source, in byte order of id: what a rehome, duplicate-facts or consolidate-ties preview hash binds. */
export async function listSourceIncarnations(raw: EngineRawRead, sourceIds: readonly string[]): Promise<Array<{ id: string; incarnation: string }>> {
  return raw<{ id: string; incarnation: string }>('SELECT id, incarnation::text AS incarnation FROM sources WHERE id=ANY($1::text[]) ORDER BY id COLLATE "C"', [[...sourceIds]]);
}

export interface ClosedTieRow {
  source_id: string; id: number | string; entity_slug: string; take_id: number | string; valid_from: string; partners: Array<number | string> | null;
}

/** The facts the pre-#6023 writeback closed at their own instant (repair/consolidate-ties.ts `findClosedTies`), with the facts consolidated into the same take that state the same claim at the same instant, in (source, id) order by byte of source. */
export async function listClosedConsolidationTies(raw: EngineRawRead, sourceIds: readonly string[]): Promise<ClosedTieRow[]> {
  return raw<ClosedTieRow>(`
    SELECT f.source_id, f.id, f.entity_slug, f.consolidated_into AS take_id, f.valid_from::text AS valid_from,
           (SELECT array_agg(g.id ORDER BY g.id) FROM facts g
             WHERE g.source_id = f.source_id AND g.id <> f.id AND g.consolidated_into = f.consolidated_into
               AND g.claim_metric = f.claim_metric AND g.claim_unit IS NOT DISTINCT FROM f.claim_unit
               AND g.claim_period IS NOT DISTINCT FROM f.claim_period AND g.valid_from = f.valid_from) AS partners
      FROM facts f
     WHERE f.source_id = ANY($1::text[]) AND f.expired_at IS NULL AND f.claim_metric IS NOT NULL
       AND f.consolidated_into IS NOT NULL AND f.valid_until = f.valid_from AND f.entity_slug IS NOT NULL
     ORDER BY f.source_id COLLATE "C", f.id`, [[...sourceIds]]);
}
