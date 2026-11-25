/**
 * The statements of the Life Chronicle event adapter (generations/adapters/chronicle-events.ts), its slug assignment
 * (chronicle/event-identity.ts) and its publication (chronicle/publish.ts) as typed engine members: the depth page row,
 * the event hashes the chronicle ledger owns, the event items a chronicle generation retired or still holds live, the
 * event projection rows and their restore, the content hashes and slot fields of event pages, and the live chronicle
 * generations whose depth page is gone. One SQL implementation for both engines; each statement is the text the caller
 * sent through `executeRaw`, with the same parameters, on the engine's own `executeRaw` (the writes run on the caller's
 * transaction engine). These are internal reads of derived pages and ledger rows, not caller page reads, so they take
 * no page read policy, as the statements never did. No statement orders text: each result is read as a set or a map,
 * or ordered by date, `updated_at` and id. The Rust engine serves them from its page, ledger and timeline records
 * (rust/crates/gbrain-store/src/generations/chronicle_events.rs and timeline_queries/event_rows.rs); it keeps no
 * chronicle ledger (`chronicle_page_state`), so the two ledger reads answer empty there.
 */
import type { EngineRawRead } from './cli-reads-ops.ts';
import type { GenerationRowKey } from './derived-generations.ts';

/** The depth page row of a slug (a live one first): its id and whether it is live. */
export interface ChronicleDepthRow { id: number; live: boolean }

/** One event projection row of an event page. `detail` is the stored text (never null on a stored row). */
export interface EventProjectionRow { event_page_id: number; date: string; summary: string; detail: string | null }

/** The content hash of one page. */
export interface PageContentHashRow { slug: string; content_hash: string | null }

/** Which pages `listPageContentHashes` reads: by id (deleted pages included) or by slug (live pages only). */
export type PageContentHashQuery =
  | { sourceId: string; match: 'ids'; ids: readonly number[] }
  | { sourceId: string; match: 'live_slugs'; slugs: readonly string[] };

/** One recent chronicle-shaped page with no event projection yet: its type, stored date and frontmatter date fields. */
export interface ChronicleCoverageGapRow { type: string; effective_date: Date | null; effective_date_source: string | null; fm_date: string | null; fm_start: string | null }

/** The `frontmatter.event` slot fields of one page, as text. */
export interface ChronicleEventSlotRow { slug: string; when: string | null; where: string | null; kind: string | null }

/** One projection row a restored event page puts back on its depth page. */
export interface EventProjectionRestore { depthPageId: number; date: string; source: string; summary: string; detail: string; eventPageId: number }

/** The skip decision the chronicle ledger records for one revision of a depth page. */
export interface ChronicleSkipDecision { sourceId: string; pageId: number; contentHash: string; extractorVersion: number; reason: string }

const DEPTH_ROW_SQL = 'SELECT id, deleted_at IS NULL AS live FROM pages WHERE source_id=$1 AND slug=$2 ORDER BY deleted_at NULLS FIRST, id DESC LIMIT 1';

const OWNED_HASHES_SQL = 'SELECT DISTINCT unnest(event_hashes) AS hash FROM chronicle_page_state WHERE source_id=$1 AND page_id=$2';

const RETIRED_ITEM_KEYS_SQL = `SELECT DISTINCT i.item_key FROM derived_generation_items i JOIN derived_generations g ON g.id=i.generation_id
      WHERE g.source_id=$1 AND g.kind=$2 AND i.action='retired' AND i.item_key=ANY($3::text[])`;

const PROJECTION_ROWS_SQL = 'SELECT event_page_id, date::text AS date, summary, detail FROM timeline_entries WHERE event_page_id = ANY($1::bigint[]) ORDER BY date';

const CONTENT_HASHES_BY_ID_SQL = 'SELECT slug, content_hash FROM pages WHERE source_id=$1 AND id = ANY($2::bigint[])';

const LIVE_CONTENT_HASHES_SQL = 'SELECT slug, content_hash FROM pages WHERE source_id=$1 AND slug=ANY($2::text[]) AND deleted_at IS NULL';

const LIVE_ITEMS_SQL = `SELECT i.item_key, i.identity_hash FROM derived_generation_items i JOIN derived_generations g ON g.id=i.generation_id
      WHERE g.source_id=$1 AND g.kind=$2 AND g.owner_key=$3 AND g.state='live' AND i.action <> 'retired'`;

const PROJECTION_ID_SQL = 'SELECT id FROM timeline_entries WHERE event_page_id=$1 AND date=$2::date';

const SLUG_EXISTS_SQL = 'SELECT 1 FROM pages WHERE source_id=$1 AND slug=$2';

const DELETE_PROJECTIONS_SQL = `DELETE FROM timeline_entries t USING pages p WHERE p.id=t.event_page_id AND p.source_id=$1 AND p.slug=ANY($2::text[])`;

const RESTORE_PROJECTION_SQL = `INSERT INTO timeline_entries (page_id, date, source, summary, detail, event_page_id) VALUES ($1, $2::date, $3, $4, $5, $6)
        ON CONFLICT (event_page_id, date) WHERE event_page_id IS NOT NULL DO UPDATE SET summary=EXCLUDED.summary, detail=EXCLUDED.detail, page_id=EXCLUDED.page_id, source=EXCLUDED.source`;

const SKIP_DECISION_SQL = 'SELECT 1 FROM chronicle_page_state WHERE source_id=$1 AND page_id=$2 AND content_hash=$3 AND extractor_version=$4 AND state=$5 AND reason=$6';

const ORPHANED_OWNERS_SQL = `SELECT g.owner_key FROM derived_generations g
      WHERE g.source_id=$1 AND g.kind=$2 AND g.state='live'
        AND EXISTS (SELECT 1 FROM derived_generation_items i JOIN pages e ON e.source_id=g.source_id AND e.slug=i.item_key AND e.deleted_at IS NULL
          WHERE i.generation_id=g.id AND i.action <> 'retired')
        AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id=g.source_id AND p.slug=substr(g.owner_key, 7) AND p.deleted_at IS NULL)
      ORDER BY g.updated_at, g.id LIMIT $3`;

const EVENT_SLOTS_SQL = `SELECT slug, frontmatter->'event'->>'when' AS "when", frontmatter->'event'->>'where' AS "where", frontmatter->'event'->>'kind' AS kind
       FROM pages WHERE source_id=$1 AND slug = ANY($2::text[])`;

/** The page at `slug` of `sourceId` (the live one first, then the newest), or null when no row has the slug. */
export async function readChronicleDepthRow(raw: EngineRawRead, sourceId: string, slug: string): Promise<ChronicleDepthRow | null> {
  const [row] = await raw<{ id: number | string; live: boolean }>(DEPTH_ROW_SQL, [sourceId, slug]);
  return row ? { id: Number(row.id), live: row.live } : null;
}

/** Every event content hash the chronicle ledger recorded for the depth page `pageId`, distinct, in no set order. */
export async function listChronicleOwnedHashes(raw: EngineRawRead, sourceId: string, pageId: number): Promise<string[]> {
  return (await raw<{ hash: string }>(OWNED_HASHES_SQL, [sourceId, pageId])).map(row => row.hash);
}

/** The keys of `itemKeys` that a generation of `kind` in `sourceId` recorded as retired, distinct, in no set order. */
export async function listRetiredGenerationItemKeys(raw: EngineRawRead, sourceId: string, kind: string, itemKeys: readonly string[]): Promise<string[]> {
  return (await raw<{ item_key: string }>(RETIRED_ITEM_KEYS_SQL, [sourceId, kind, [...itemKeys]])).map(row => row.item_key);
}

/** The projection rows whose event page is one of `eventPageIds`, by date. */
export async function listEventProjectionRows(raw: EngineRawRead, eventPageIds: readonly number[]): Promise<EventProjectionRow[]> {
  const rows = await raw<EventProjectionRow>(PROJECTION_ROWS_SQL, [[...eventPageIds]]);
  return rows.map(row => ({ event_page_id: Number(row.event_page_id), date: row.date, summary: row.summary, detail: row.detail }));
}

/** The content hash of each page `query` selects, in no set order. */
export async function listPageContentHashes(raw: EngineRawRead, query: PageContentHashQuery): Promise<PageContentHashRow[]> {
  return query.match === 'ids'
    ? raw<PageContentHashRow>(CONTENT_HASHES_BY_ID_SQL, [query.sourceId, [...query.ids]])
    : raw<PageContentHashRow>(LIVE_CONTENT_HASHES_SQL, [query.sourceId, [...query.slugs]]);
}

/** The items the live generation of `key` holds without retiring them, with their identities, in no set order. */
export async function listLiveGenerationItems(raw: EngineRawRead, key: GenerationRowKey): Promise<Array<{ item_key: string; identity_hash: string }>> {
  return raw<{ item_key: string; identity_hash: string }>(LIVE_ITEMS_SQL, [key.sourceId, key.kind, key.ownerKey]);
}

/** The id of the projection row of `eventPageId` on `date`, or null. */
export async function readEventProjectionId(raw: EngineRawRead, eventPageId: number, date: string): Promise<number | null> {
  const [row] = await raw<{ id: number | string }>(PROJECTION_ID_SQL, [eventPageId, date]);
  return row ? Number(row.id) : null;
}

/** Whether `sourceId` has a page row at `slug`, a soft-deleted one included. */
export async function pageSlugExists(raw: EngineRawRead, sourceId: string, slug: string): Promise<boolean> {
  return (await raw(SLUG_EXISTS_SQL, [sourceId, slug])).length > 0;
}

/** Deletes the projection rows whose event page is one of `slugs` of `sourceId` (soft-deleted pages included). */
export async function deleteEventProjections(raw: EngineRawRead, sourceId: string, slugs: readonly string[]): Promise<void> {
  await raw(DELETE_PROJECTIONS_SQL, [sourceId, [...slugs]]);
}

/** Puts one projection row of a restored event page back on its depth page (an update when the (event, date) row exists). */
export async function restoreEventProjection(raw: EngineRawRead, row: EventProjectionRestore): Promise<void> {
  await raw(RESTORE_PROJECTION_SQL, [row.depthPageId, row.date, row.source, row.summary, row.detail, row.eventPageId]);
}

/** Whether the chronicle ledger records the skip decision `decision` for that revision of the depth page. */
export async function hasChronicleSkipDecision(raw: EngineRawRead, decision: ChronicleSkipDecision): Promise<boolean> {
  return (await raw(SKIP_DECISION_SQL, [decision.sourceId, decision.pageId, decision.contentHash, decision.extractorVersion, 'skipped', decision.reason])).length > 0;
}

/**
 * The owner keys of the live generations of `kind` in `sourceId` whose depth page (`owner_key` after `depth:`) has no
 * live row and that still hold an item with a live page, oldest update first, at most `limit`.
 */
export async function listOrphanedChronicleOwners(raw: EngineRawRead, sourceId: string, kind: string, limit: number): Promise<string[]> {
  return (await raw<{ owner_key: string }>(ORPHANED_OWNERS_SQL, [sourceId, kind, limit])).map(row => row.owner_key);
}

/** The `frontmatter.event` when, where and kind of each page of `slugs` (soft-deleted pages included), in no set order. */
export async function listChronicleEventSlotRows(raw: EngineRawRead, sourceId: string, slugs: readonly string[]): Promise<ChronicleEventSlotRow[]> {
  return raw<ChronicleEventSlotRow>(EVENT_SLOTS_SQL, [sourceId, [...slugs]]);
}

const COVERAGE_GAP_SQL = `SELECT p.type, p.effective_date, p.effective_date_source, p.frontmatter->>'date' AS fm_date, p.frontmatter->>'start' AS fm_start
           FROM pages p
          WHERE p.type IN ('meeting','conversation','calendar-event') AND p.deleted_at IS NULL
            AND p.updated_at > now() - interval '30 days'
            AND NOT EXISTS (
              SELECT 1 FROM timeline_entries te
              WHERE te.page_id = p.id AND te.event_page_id IS NOT NULL
            )`;

/**
 * The chronicle advisor's coverage-gap read (advisor/collect-chronicle.ts): the live meeting, conversation and
 * calendar-event pages of every source updated in the last 30 days (by the database clock) that no timeline row with an
 * event page projects yet, with the date fields the caller filters on. In no set order. `effective_date` comes back as a
 * Date (or null) on every engine.
 */
export async function listChronicleCoverageGapRows(raw: EngineRawRead): Promise<ChronicleCoverageGapRow[]> {
  const rows = await raw<Omit<ChronicleCoverageGapRow, 'effective_date'> & { effective_date: Date | string | null }>(COVERAGE_GAP_SQL);
  return rows.map(r => ({ ...r, effective_date: r.effective_date == null ? null : new Date(r.effective_date) }));
}
