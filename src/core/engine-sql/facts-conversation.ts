/**
 * Group 5 facts statements, conversation fact publication and relink (docs/research/rust-cli-contract-map.md, "Facts queries,
 * purge and unlinked-fact checks"). Each function runs the statement its caller ran through `executeRaw`, with the same text
 * and parameters, on the engine's own `executeRaw`; only its home moved. A statement whose placeholders are numbered in order
 * of appearance is written with `sqlFragment`; one whose placeholders are out of order (or sit in an `IN (...)` list) is a
 * static string with its constants spelled out, which test/facts-conversation-sites-sql-pin.test.ts pins against the helpers
 * it stands in for.
 */
import type { ConversationPageEntry } from '../facts/conversation-publication.ts';
import type { SourceWindow } from '../page-body/derivations.ts';
import type { FactAttribution } from '../engine.ts';
import type { FactVisibility } from '../facts/visibility.ts';
import { AUDIT_ROW_SOURCES, NON_EXTRACTABLE_AUDIT_SOURCE, TERMINAL_AUDIT_SOURCE } from '../facts/audit-sources.ts';
import { retiredPageSql } from '../entities/resolve.ts';
import { folderRestrictedSql } from '../search/private-visibility.ts';
import { ACTIVE_UNLINKED_FACT_SQL, UNBACKED_FACT_SQL, derivedConversationFragment } from './fact-relink-writes.ts';
import { renderFragment, sqlFragment, trustedSql, type SqlFragment } from './fragment.ts';
import type { EngineRawRead } from './cli-reads-ops.ts';

export type { EngineRawRead } from './cli-reads-ops.ts';
export type { ConversationPageEntry } from '../facts/conversation-publication.ts';
export type { SourceWindow } from '../page-body/derivations.ts';

/** The SQL predicate (on alias `f`) of a derived row the free conversation relink linked. */
export const RELINKED_DERIVED_ROW = `f.entity_slug IS NOT NULL AND COALESCE(f.context, '') LIKE '%entity relinked from %'`;
/** Context marker `gbrain repair conversation-labels` appends to the rows it retires. */
export const LABEL_RETIRED_MARKER = 'retired: conversation-labels';

/** `f.source LIKE 'cli:extract-conversation-facts%'` (CONVERSATION_FACTS_SOURCE_PREFIX, pinned by the SQL pin test). */
const CONVERSATION_SOURCE_SQL = `f.source LIKE 'cli:extract-conversation-facts%'`;
/** The constant conversation-source prefix test of a slot read (`CONVERSATION_SLOT_SQL`, pinned by the SQL pin test). */
const CONVERSATION_SLOT_SQL = `COALESCE(source, '') LIKE 'cli:extract-conversation-facts%'`;
/** The window key of an anchored fact: its occurrence, ordinal and text digest. */
const WINDOW_KEY_SQL = `(f.source_window->>'occurrence_id') || ':' || (f.source_window->>'window_ordinal') || ':' || (f.source_window->>'window_text_sha')`;
/** A clear's two OR-ed reasons to expire a row instead of deleting it: an open loop or a later fact points at it. */
const REFERENCED_SQL = 'EXISTS (SELECT 1 FROM open_loops o WHERE o.fact_id=f.id) OR EXISTS (SELECT 1 FROM facts g WHERE g.superseded_by=f.id)';
/** GBRA-574 B2: a row kept expired gives up its slot, so the replacement can hold the same slot key. */
const UNSLOT_SQL = 'dimension=NULL, value=NULL, value_hash=NULL, dim_status=NULL';

// ---------------------------------------------------------------------------------------------------------------------
// conversation publication (src/core/facts/conversation-publication.ts)
// ---------------------------------------------------------------------------------------------------------------------

/** The newest extractor fact id of a page (null when it has none): the next generation's seed. */
export async function readNewestConversationFactId(raw: EngineRawRead, sourceId: string, slug: string): Promise<number | string | null> {
  const [row] = await raw<{ id: number | string | null }>(
    `SELECT max(id) AS id FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND source LIKE 'cli:extract-conversation-facts%'`,
    [sourceId, slug]);
  return row?.id ?? null;
}

/** The writer's request `requestId` when its digest is not `digest`, or it was compacted without committing: a spent id. */
export async function findSpentConversationRequest(raw: EngineRawRead, principalKind: string, principalId: string, requestId: string,
  digest: string): Promise<{ request_id: string } | null> {
  const [spent] = await raw<{ request_id: string }>(`SELECT request_id::text AS request_id FROM persistence_requests
      WHERE principal_kind=$1 AND principal_id=$2 AND request_id=$3::uuid AND (digest<>$4 OR (compacted AND state<>'committed'))`,
  [principalKind, principalId, requestId, digest]);
  return spent ?? null;
}

export interface ConversationBatchRequestRow {
  id: string; request_id: string; state: string; error_code: string | null; members: Array<{ generation: string; attempt: number }> | null;
}

/** The writer's unsettled and failed (not yet compacted) conversation-facts batch requests of a source, in journal order. */
export async function listConversationBatchRequests(raw: EngineRawRead, principalKind: string, principalId: string, sourceId: string,
  anchorSlug: string): Promise<ConversationBatchRequestRow[]> {
  return raw<ConversationBatchRequestRow>(
    `SELECT r.id::text AS id, r.request_id::text AS request_id, r.state, r.error_code,
            (SELECT jsonb_agg(jsonb_build_object('generation', p->>'generation', 'attempt', (p->>'attempt')::int)) FROM jsonb_array_elements(r.intent->'pages') p) AS members
       FROM persistence_requests r
      WHERE r.principal_kind=$1 AND r.principal_id=$2 AND r.source_id=$3 AND r.slug=$4 AND r.operation='submit_job'
        AND r.state<>'committed' AND NOT r.compacted
      ORDER BY r.sequence`,
  [principalKind, principalId, sourceId, anchorSlug]);
}

/** The stored entry of `generation` in the batch request row `id` (null when the row or the entry is gone). */
export async function readStoredConversationEntry(raw: EngineRawRead, id: string, generation: string): Promise<ConversationPageEntry | null> {
  const [row] = await raw<{ entry: ConversationPageEntry | null }>(`SELECT p AS entry FROM persistence_requests r, jsonb_array_elements(r.intent->'pages') p
    WHERE r.id=$1::uuid AND NOT r.compacted AND p->>'generation'=$2 LIMIT 1`, [id, generation]);
  return row?.entry ?? null;
}

export interface PersistenceCounterRow { outstanding_count: number | string; terminal_bytes: number | string; lifetime_ids: number | string }

/** A principal's journal counters (outstanding requests, reserved receipt bytes, lifetime ids), null when it has no row. */
export async function readPrincipalCounters(raw: EngineRawRead, key: string): Promise<PersistenceCounterRow | null> {
  const [counter] = await raw<PersistenceCounterRow>('SELECT outstanding_count, terminal_bytes, lifetime_ids FROM persistence_counters WHERE key=$1', [key]);
  return counter ?? null;
}

/** Live pages of the given types in a source that a run would extract: all of them with `force`, else those with no active outcome row. */
export async function countConversationPagesToExtract(raw: EngineRawRead, sourceId: string, pageTypes: string[], force: boolean): Promise<number> {
  const [row] = await raw<{ n: number | string }>(`SELECT count(*)::int AS n FROM pages p
    WHERE p.source_id=$1 AND p.deleted_at IS NULL AND p.type=ANY($2::text[])
      AND ($3::boolean OR NOT EXISTS (SELECT 1 FROM facts f WHERE f.source_id=p.source_id AND f.source_markdown_slug=p.slug
        AND f.source LIKE 'cli:extract-conversation-facts%' AND f.source IN ($4,$5) AND f.expired_at IS NULL))`,
  [sourceId, pageTypes, force, TERMINAL_AUDIT_SOURCE, NON_EXTRACTABLE_AUDIT_SOURCE]);
  return Number(row?.n ?? 0);
}

export interface MergedAliasRow { alias_slug: string; canonical_slug: string }

/** Entity slugs that became aliases of a live page (and no longer name a live page of their own): alias to canonical. */
export async function listMergedEntityAliases(raw: EngineRawRead, sourceId: string, slugs: string[]): Promise<MergedAliasRow[]> {
  return raw<MergedAliasRow>(`SELECT a.alias_slug, a.canonical_slug FROM slug_aliases a
    WHERE a.source_id=$1 AND a.alias_slug=ANY($2::text[])
      AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id=a.source_id AND p.slug=a.alias_slug AND p.deleted_at IS NULL)
      AND EXISTS (SELECT 1 FROM pages c WHERE c.source_id=a.source_id AND c.slug=a.canonical_slug AND c.deleted_at IS NULL)`, [sourceId, [...new Set(slugs)]]);
}

/**
 * Re-anchors a page's extractor facts from each `from` window key to its `to` window (ids unchanged) in one statement, so a
 * chain of moves among windows of the same text applies at once.
 */
export async function moveConversationSourceWindows(raw: EngineRawRead, sourceId: string, slug: string,
  moves: ReadonlyArray<{ from: string; to: SourceWindow }>): Promise<void> {
  await raw(`UPDATE facts f SET source_window = r.w FROM jsonb_to_recordset($3::text::jsonb) AS r(k text, w jsonb)
    WHERE f.source_id = $1 AND f.source_markdown_slug = $2 AND f.source LIKE 'cli:extract-conversation-facts%' AND (f.source_window->>'occurrence_id') || ':' || (f.source_window->>'window_ordinal') || ':' || (f.source_window->>'window_text_sha') = r.k`,
  [sourceId, slug, JSON.stringify(moves.map(m => ({ k: m.from, w: m.to })))]);
}

/** Anchors one batch of freshly inserted facts to their windows; one JSON bind, so JSONB stays an object. */
export async function stampConversationSourceWindows(raw: EngineRawRead, pairs: ReadonlyArray<{ id: number; w: SourceWindow | null }>): Promise<void> {
  await raw(`UPDATE facts f SET source_window = r.w FROM jsonb_to_recordset($1::text::jsonb) AS r(id bigint, w jsonb) WHERE f.id = r.id`, [JSON.stringify(pairs)]);
}

/** A page's active conversation facts, audit rows aside. */
export async function countActiveConversationFacts(raw: EngineRawRead, sourceId: string, slug: string): Promise<number> {
  const { text, params } = renderFragment(sqlFragment`SELECT count(*)::int AS n FROM facts f WHERE f.source_id=${sourceId} AND f.source_markdown_slug=${slug}
    AND ${trustedSql(CONVERSATION_SOURCE_SQL)} AND f.expired_at IS NULL AND NOT (f.source = ANY(${[...AUDIT_ROW_SOURCES]}::text[]))`);
  const [row] = await raw<{ n: number }>(text, params);
  return Number(row?.n ?? 0);
}

/** The value hash of the slot's latest conversation-source value at or before `validFrom`, null when there is none. */
export async function readConversationSlotValueHash(raw: EngineRawRead, sourceId: string, entitySlug: string, dimension: string,
  validFrom: Date | string): Promise<{ value_hash: string } | null> {
  const { text, params } = renderFragment(sqlFragment`SELECT value_hash FROM facts
      WHERE source_id=${sourceId} AND entity_slug=${entitySlug} AND dimension=${dimension} AND value_hash IS NOT NULL AND expired_at IS NULL AND superseded_by IS NULL AND ${trustedSql(CONVERSATION_SLOT_SQL)}
        AND valid_from <= ${new Date(validFrom).toISOString()}::timestamptz ORDER BY valid_from DESC, id DESC LIMIT 1`);
  const [prior] = await raw<{ value_hash: string }>(text, params);
  return prior ?? null;
}

/** Deletes a page's audit (outcome) rows; returns the ids removed. */
export async function deleteConversationOutcomeRows(raw: EngineRawRead, sourceId: string, slug: string): Promise<Array<{ id: number }>> {
  return raw<{ id: number }>(`DELETE FROM facts
      WHERE source_id=$1 AND source_markdown_slug=$2 AND source = ANY($3::text[]) RETURNING id`, [sourceId, slug, [...AUDIT_ROW_SOURCES]]);
}

/** The positions (1-based) of the claims that match a purge tombstone (under their own entity, or any subject for an unbacked name key). */
export async function listPurgeTombstoneMatches(raw: EngineRawRead, sourceId: string,
  claims: { facts: string[]; visibilities: string[]; entitySlugs: Array<string | null>; sources: Array<string | null> }): Promise<Array<{ ord: number | string }>> {
  return raw<{ ord: number | string }>(`SELECT n.ord FROM unnest($2::text[], $3::text[], $4::text[], $5::text[]) WITH ORDINALITY AS n(fact, visibility, entity_slug, source, ord)
    WHERE NOT (n.source IN ('cli:extract-conversation-facts:terminal:v2','cli:extract-conversation-facts:non-extractable:v2','cli:extract-conversation-facts:terminal') AND n.fact IN ('EXTRACTION_COMPLETE','EXTRACTION_NOT_APPLICABLE')) AND EXISTS (SELECT 1 FROM fact_purges p WHERE p.source_id=$1 AND p.visibility=n.visibility
      AND (p.subject IN ('*', n.entity_slug) OR COALESCE(strpos(n.entity_slug, '/') = 0 AND NOT EXISTS (SELECT 1 FROM pages unbacked_page
    WHERE unbacked_page.source_id = $1 AND unbacked_page.slug = n.entity_slug AND unbacked_page.deleted_at IS NULL), false)) AND p.fact_hash IN (gbrain_fact_fingerprint(n.fact), gbrain_fact_fingerprint_v2(n.fact)))`,
  [sourceId, claims.facts, claims.visibilities, claims.entitySlugs, claims.sources]);
}

/** The largest row number any fact of the page holds (null for none). */
export async function maxConversationRowNum(raw: EngineRawRead, sourceId: string, slug: string): Promise<number | string | null> {
  const [top] = await raw<{ n: number | string | null }>('SELECT max(row_num) AS n FROM facts WHERE source_id=$1 AND source_markdown_slug=$2', [sourceId, slug]);
  return top?.n ?? null;
}

export interface HeldFactSlotRow { entity_slug: string; dimension: string; value_hash: string; valid_from: Date | string }

/** The slot keys the page's facts already hold. */
export async function listHeldFactSlots(raw: EngineRawRead, sourceId: string, slug: string): Promise<HeldFactSlotRow[]> {
  return raw<HeldFactSlotRow>(
    'SELECT entity_slug, dimension, value_hash, valid_from FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND dimension IS NOT NULL', [sourceId, slug]);
}

/** The page's conversation facts, audit rows aside: what a clear would lose that a window extraction may not see again. */
export async function countPageConversationFacts(raw: EngineRawRead, sourceId: string, slug: string): Promise<number> {
  const { text, params } = renderFragment(sqlFragment`SELECT count(*)::text AS count FROM facts f WHERE f.source_id=${sourceId} AND f.source_markdown_slug=${slug}
    AND ${trustedSql(CONVERSATION_SOURCE_SQL)} AND NOT (f.source = ANY(${[...AUDIT_ROW_SOURCES]}::text[]))`);
  const [row] = await raw<{ count: string }>(text, params);
  return Number(row?.count ?? 0);
}

/** The page's active conversation facts anchored to window `key`. */
export async function countConversationWindowFacts(raw: EngineRawRead, sourceId: string, slug: string, key: string): Promise<number> {
  const { text, params } = renderFragment(sqlFragment`SELECT count(*)::text AS count FROM facts f WHERE f.source_id=${sourceId} AND f.source_markdown_slug=${slug}
    AND ${trustedSql(CONVERSATION_SOURCE_SQL)} AND f.expired_at IS NULL AND f.source_window IS NOT NULL AND ${trustedSql(WINDOW_KEY_SQL)} = ${key}`);
  const [row] = await raw<{ count: string }>(text, params);
  return Number(row?.count ?? 0);
}

/** The page's active conversation facts a settled collection keeping window `keys` removes: anchored to another window, or unanchored. */
export async function countConversationFactsOutsideWindows(raw: EngineRawRead, sourceId: string, slug: string, keys: readonly string[]): Promise<number> {
  const { text, params } = renderFragment(sqlFragment`SELECT count(*)::text AS count FROM facts f WHERE f.source_id=${sourceId} AND f.source_markdown_slug=${slug}
    AND ${trustedSql(CONVERSATION_SOURCE_SQL)} AND NOT (f.source = ANY(${[...AUDIT_ROW_SOURCES]}::text[])) AND f.expired_at IS NULL
    AND (f.source_window IS NULL OR NOT (${trustedSql(WINDOW_KEY_SQL)} = ANY(${[...keys]}::text[])))`);
  const [row] = await raw<{ count: string }>(text, params);
  return Number(row?.count ?? 0);
}

/**
 * Clears a page's prior extractor batch before a replacement, keeping the history other records depend on: a row an open loop
 * or another fact's `superseded_by` references is expired, never deleted, and rows `gbrain repair conversation-labels` retired
 * stay expired. A row `gbrain facts relink --conversation` linked is expired too, so the replacement inherits its entity; the
 * previous clear's expired relinked rows go first. With `windows`, only the page's anchored facts whose window key is in `keys`
 * (`keep` false) or not in it (`keep` true), and its unanchored facts when `unanchored`. Returns the rows removed from the
 * active batch.
 */
export async function clearConversationPageFacts(raw: EngineRawRead, sourceId: string, slug: string,
  windows?: { keys: readonly string[]; keep: boolean; unanchored: boolean }): Promise<number> {
  const page = windows
    ? sqlFragment`f.source_id=${sourceId} AND f.source_markdown_slug=${slug} AND ${trustedSql(CONVERSATION_SOURCE_SQL)} AND NOT (f.source = ANY(${[...AUDIT_ROW_SOURCES]}::text[])) AND (CASE WHEN f.source_window IS NULL THEN ${windows.unanchored}::boolean ELSE (${trustedSql(WINDOW_KEY_SQL)} = ANY(${[...windows.keys]}::text[])) <> ${windows.keep}::boolean END)`
    : sqlFragment`f.source_id=${sourceId} AND f.source_markdown_slug=${slug} AND ${trustedSql(CONVERSATION_SOURCE_SQL)}`;
  const run = (fragment: SqlFragment) => {
    const { text, params } = renderFragment(fragment);
    return raw<{ count: string }>(text, params);
  };
  await run(sqlFragment`DELETE FROM facts f WHERE ${page} AND f.expired_at IS NOT NULL AND ${trustedSql(RELINKED_DERIVED_ROW)} AND NOT (${trustedSql(REFERENCED_SQL)})`);
  await run(sqlFragment`UPDATE facts f SET ${trustedSql(UNSLOT_SQL)} WHERE ${page} AND f.expired_at IS NOT NULL AND f.dimension IS NOT NULL`);
  const [relinked] = await run(sqlFragment`WITH up AS (UPDATE facts f SET expired_at=now(), ${trustedSql(UNSLOT_SQL)}
    WHERE ${page} AND f.expired_at IS NULL AND ${trustedSql(RELINKED_DERIVED_ROW)} RETURNING 1) SELECT COUNT(*)::text AS count FROM up`);
  const [expired] = await run(sqlFragment`WITH up AS (UPDATE facts f SET expired_at=now(), ${trustedSql(UNSLOT_SQL)}
    WHERE ${page} AND f.expired_at IS NULL AND (${trustedSql(REFERENCED_SQL)}) RETURNING 1) SELECT COUNT(*)::text AS count FROM up`);
  const [deleted] = await run(sqlFragment`WITH del AS (DELETE FROM facts f
    WHERE ${page} AND NOT (${trustedSql(REFERENCED_SQL)}) AND COALESCE(f.context,'') NOT LIKE '%${trustedSql(LABEL_RETIRED_MARKER)}%' AND NOT (${trustedSql(RELINKED_DERIVED_ROW)}) RETURNING 1)
    SELECT COUNT(*)::text AS count FROM del`);
  return Number(relinked?.count ?? 0) + Number(expired?.count ?? 0) + Number(deleted?.count ?? 0);
}

// ---------------------------------------------------------------------------------------------------------------------
// relink publication (src/core/facts/relink-publish.ts)
// ---------------------------------------------------------------------------------------------------------------------

/** The oldest active fence row of the page holding the same claim and source, whatever its visibility. */
export async function findSameClaimFenceRow(raw: EngineRawRead, sourceId: string, slug: string, fact: string,
  source: string | null): Promise<{ id: number | string; visibility: string } | null> {
  const [same] = await raw<{ id: number | string; visibility: string }>(
    `SELECT id, visibility FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND row_num IS NOT NULL
         AND expired_at IS NULL AND fact=$3 AND source IS NOT DISTINCT FROM $4 ORDER BY id LIMIT 1`,
    [sourceId, slug, fact, source]);
  return same ?? null;
}

/** An ontology observation the page already holds at the same key as fact `factId` (preferring an active one). */
export async function findOntologyTwin(raw: EngineRawRead, sourceId: string, slug: string, factId: number): Promise<{ id: number | string } | null> {
  const [held] = await raw<{ id: number | string }>(
    `SELECT t.id FROM facts m JOIN facts t ON t.source_id = m.source_id AND t.dimension = m.dimension AND t.value_hash = m.value_hash
             AND t.valid_from = m.valid_from AND t.id <> m.id
           WHERE m.source_id=$1 AND m.id=$3 AND t.entity_slug=$2 AND t.source_markdown_slug=$2
           ORDER BY (t.expired_at IS NULL) DESC, t.id LIMIT 1`, [sourceId, slug, factId]);
  return held ?? null;
}

export interface RelinkSourceRow { incarnation: string; archived: boolean; local_path: string | null; kind: string | null }

/** The source row a relink publication checks before it writes (null when the source is not registered). */
export async function readRelinkSource(raw: EngineRawRead, sourceId: string): Promise<RelinkSourceRow | null> {
  const [source] = await raw<RelinkSourceRow>(
    "SELECT incarnation, archived, local_path, config->>'kind' AS kind FROM sources WHERE id = $1", [sourceId]);
  return source ?? null;
}

// ---------------------------------------------------------------------------------------------------------------------
// reextract memo (src/core/facts/conversation-memo.ts)
// ---------------------------------------------------------------------------------------------------------------------

/** Whether the brain has the `fact_relink_attempts` table. */
export async function factRelinkAttemptsTableExists(raw: EngineRawRead): Promise<boolean> {
  const [table] = await raw<{ t: string | null }>(`SELECT to_regclass('fact_relink_attempts')::text AS t`);
  return !!table?.t;
}

/** The page's newest active terminal outcome row and the content hash of its live page (null when it has none). */
export async function readReextractOutcomeRow(raw: EngineRawRead, sourceId: string, slug: string): Promise<{ id: number | string; hash: string } | null> {
  const [outcome] = await raw<{ id: number | string; hash: string }>(
    `SELECT f.id, COALESCE(p.content_hash, '') AS hash FROM facts f JOIN pages p ON p.source_id = f.source_id AND p.slug = f.source_markdown_slug AND p.deleted_at IS NULL
      WHERE f.source_id = $1 AND f.source_markdown_slug = $2 AND f.source = $3 AND f.expired_at IS NULL ORDER BY f.id DESC LIMIT 1`, [sourceId, slug, TERMINAL_AUDIT_SOURCE]);
  return outcome ?? null;
}

// ---------------------------------------------------------------------------------------------------------------------
// conversation relink (src/core/facts/conversation-relink.ts)
// ---------------------------------------------------------------------------------------------------------------------

export interface UnbackedConversationRow {
  id: number | string; fact: string; context: string | null; visibility: FactVisibility; slug: string; attributed_to: FactAttribution | null; entity_slug: string;
}
export interface UnlinkedConversationRow {
  id: number | string; fact: string; context: string | null; visibility: FactVisibility; slug: string; attributed_to: FactAttribution | null;
}

/** Derived rows of these pages that sit on an unbacked name key, in (page, id) order. */
export async function listUnbackedConversationRows(raw: EngineRawRead, sourceId: string, slugs: string[]): Promise<UnbackedConversationRow[]> {
  const { text, params } = renderFragment(sqlFragment`SELECT f.id, f.fact, f.context, f.visibility, f.source_markdown_slug AS slug, f.attributed_to, f.entity_slug FROM facts f
      WHERE f.source_id = ${sourceId} AND f.source_markdown_slug = ANY(${slugs}::text[]) AND ${trustedSql(UNBACKED_FACT_SQL)} AND ${derivedConversationFragment()}
      ORDER BY f.source_markdown_slug COLLATE "C", f.id`);
  return raw<UnbackedConversationRow>(text, params);
}

/** Derived rows of these pages that are live and have no entity, in (page, id) order. */
export async function listUnlinkedConversationRows(raw: EngineRawRead, sourceId: string, slugs: string[]): Promise<UnlinkedConversationRow[]> {
  const { text, params } = renderFragment(sqlFragment`SELECT f.id, f.fact, f.context, f.visibility, f.source_markdown_slug AS slug, f.attributed_to FROM facts f
      WHERE f.source_id = ${sourceId} AND f.source_markdown_slug = ANY(${slugs}::text[]) AND ${trustedSql(ACTIVE_UNLINKED_FACT_SQL)} AND ${derivedConversationFragment()}
      ORDER BY f.source_markdown_slug COLLATE "C", f.id`);
  return raw<UnlinkedConversationRow>(text, params);
}

// ---------------------------------------------------------------------------------------------------------------------
// entity hints (src/core/facts/conversation-entity-hints.ts)
// ---------------------------------------------------------------------------------------------------------------------

export interface EntityHintPageRow { slug: string; type: string | null; frontmatter: unknown; retired: boolean; folder_restricted: boolean }

/** The live pages among `slugs` with their retirement and folder-restriction flags. */
export async function listEntityHintPages(raw: EngineRawRead, sourceId: string, slugs: string[]): Promise<EntityHintPageRow[]> {
  const { text, params } = renderFragment(sqlFragment`SELECT p.slug, p.type, p.frontmatter, ${trustedSql(retiredPageSql('p'))} AS retired, ${trustedSql(folderRestrictedSql('p'))} AS folder_restricted FROM pages p
      WHERE p.source_id = ${sourceId} AND p.slug = ANY(${slugs}::text[]) AND p.deleted_at IS NULL`);
  return raw<EntityHintPageRow>(text, params);
}

// ---------------------------------------------------------------------------------------------------------------------
// incremental publication (src/core/facts/conversation-incremental.ts)
// ---------------------------------------------------------------------------------------------------------------------

/** Locks one page row until the transaction ends. */
export async function lockPageById(raw: EngineRawRead, pageId: number): Promise<void> {
  await raw('SELECT id FROM pages WHERE id = $1 FOR UPDATE', [pageId]);
}

// ---------------------------------------------------------------------------------------------------------------------
// relinked-row carry (src/core/facts/conversation-relink-carry.ts)
// ---------------------------------------------------------------------------------------------------------------------

export interface ClearedRelinkedFactRow { fact: string; entity_slug: string; context: string }

/** The page's expired conversation facts that a relink had linked to a still-live entity page, newest first. */
export async function listClearedRelinkedFacts(raw: EngineRawRead, sourceId: string, slug: string): Promise<ClearedRelinkedFactRow[]> {
  const { text, params } = renderFragment(sqlFragment`SELECT f.fact, f.entity_slug, f.context FROM facts f
      WHERE f.source_id = ${sourceId} AND f.source_markdown_slug = ${slug} AND f.source LIKE 'cli:extract-conversation-facts%' AND f.expired_at IS NOT NULL
        AND ${trustedSql(RELINKED_DERIVED_ROW)}
        AND EXISTS (SELECT 1 FROM pages p WHERE p.source_id = f.source_id AND p.slug = f.entity_slug AND p.deleted_at IS NULL)
      ORDER BY f.id DESC`);
  return raw<ClearedRelinkedFactRow>(text, params);
}

// ---------------------------------------------------------------------------------------------------------------------
// relink (src/core/facts/relink.ts)
// ---------------------------------------------------------------------------------------------------------------------

/** How many of the facts `ids` carry an embedding. */
export async function countEmbeddedFactsAmong(raw: EngineRawRead, sourceId: string, ids: number[]): Promise<number> {
  const [eligible] = await raw<{ n: number | string }>(
    'SELECT COUNT(*) AS n FROM facts WHERE source_id = $1 AND id = ANY($2::bigint[]) AND embedding IS NOT NULL', [sourceId, ids]);
  return Number(eligible?.n ?? 0);
}
