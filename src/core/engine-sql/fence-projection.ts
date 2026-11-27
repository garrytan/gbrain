/**
 * The statements of a page publication's fence projection (persistence/canonical-projections.ts
 * `prepareCanonicalProjections` and `refuseQuotedFenceLoss`), as typed engine members. A put_page that updates a page with a `## Facts` or `## Takes` fence runs
 * them; before, they went through `executeRaw`, so such a write stopped on an engine without raw SQL.
 *
 * One SQL implementation for both engines; each statement is the text its caller sent through `executeRaw`, byte for
 * byte, with the same parameters, on the engine's own `executeRaw` (the writes run on the caller's transaction engine,
 * inside the publication). Statements that splice a builder next to a hand-numbered placeholder are rendered from
 * `trustedSql` pieces with no bound values, so the text stays the one the caller sent. The writer's opened fact ids
 * (`gbrain.write_open_facts`) are a transaction-local setting the expiry reads itself; no member passes them. The Rust
 * store serves the same members (rust/crates/gbrain-store/src/facts/fence_projection.rs, takes/fence_projection.rs,
 * generations.rs `held_for`), as rust/docs/store/facts.md "The fence projection's statements" describes.
 */
import type { BrainEngine } from '../engine.ts';
import { openedFactRowSql } from '../persistence/context.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** A stored take of the page at one of the quoted row numbers. */
export interface QuotedTakeRow { row_num: number; claim: string }
/** A positioned fact of the page, live or not, as the quoted-fence check compares it. */
export interface PageFenceFactCell { row_num: number; fact: string; visibility: string }

const QUOTED_TAKES_SQL = 'SELECT row_num,claim FROM takes WHERE page_id=$1 AND row_num=ANY($2::integer[])';

const PAGE_FENCE_CELLS_SQL = `SELECT row_num,fact,visibility FROM facts
      WHERE source_id=$1 AND source_markdown_slug=$2 AND row_num IS NOT NULL`;

const POSITIONED_FACTS_SQL = `SELECT 1 FROM facts WHERE source_id=$1 AND source_markdown_slug=$2
        AND row_num IS NOT NULL AND COALESCE(source,'') NOT LIKE 'cli:extract-conversation-facts%' LIMIT 1`;

const FENCE_ABSENT_HOLD_SQL = `SELECT 1 FROM derived_generations WHERE source_id=$1 AND kind=$2 AND owner_key=$3 AND state='held' AND held_reason='fence_absent'`;

const PAGE_TAKE_ROWS_SQL = 'SELECT row_num FROM takes WHERE page_id=$1';

// #10055: a row that stays retired keeps its history. Its fence cell renders the stored retirement to the second, a blank
// valid_until cell reads back as today and a superseded row's context renders as the generated `superseded by #N` marker, so
// reading those back would restamp the retirement time, drop the original context and record an unrelated edit as a write of
// the archived row. A changed valid_until or an explicit note in the context cell still updates it. Every row keeps a stored
// valid_from that its cell renders to the second, so the sub-second instant `remember` stored survives an unrelated edit.
const FIELD_ROWS_SQL = `UPDATE facts f SET kind=r.kind,notability=r.notability,context=CASE WHEN f.expired_at IS NOT NULL AND r.expired_at IS NOT NULL AND f.superseded_by IS NOT NULL AND r.context ~* '^superseded by #[0-9]+$' THEN f.context ELSE r.context END,
        valid_from=CASE WHEN r.valid_from IS NULL OR date_trunc('second', f.valid_from) = r.valid_from::timestamptz THEN f.valid_from ELSE r.valid_from::timestamptz END,valid_until=CASE WHEN f.expired_at IS NOT NULL AND r.expired_at IS NOT NULL AND (NOT r.until_cell OR date_trunc('second', f.valid_until) = r.valid_until::timestamptz) THEN f.valid_until ELSE r.valid_until::timestamptz END,expired_at=CASE WHEN r.expired_at IS NULL THEN NULL ELSE COALESCE(f.expired_at, r.expired_at::timestamptz) END,
        source=r.source,confidence=r.confidence,claim_metric=r.claim_metric,claim_value=r.claim_value,claim_unit=r.claim_unit,
        claim_period=r.claim_period,attributed_to=r.attributed_to
      FROM jsonb_to_recordset($3::text::jsonb) AS r(row_num integer,kind text,notability text,context text,valid_from text,valid_until text,until_cell boolean,
        expired_at text,source text,confidence real,claim_metric text,claim_value double precision,claim_unit text,claim_period text,attributed_to text)
      WHERE f.source_id=$1 AND f.source_markdown_slug=$2 AND f.row_num=r.row_num
        AND (f.kind,f.notability,f.context,f.valid_from,f.valid_until,f.expired_at,f.source,f.confidence,f.claim_metric,f.claim_value,f.claim_unit,
          f.claim_period,f.attributed_to) IS DISTINCT FROM (r.kind,r.notability,CASE WHEN f.expired_at IS NOT NULL AND r.expired_at IS NOT NULL AND f.superseded_by IS NOT NULL AND r.context ~* '^superseded by #[0-9]+$' THEN f.context ELSE r.context END,CASE WHEN r.valid_from IS NULL OR date_trunc('second', f.valid_from) = r.valid_from::timestamptz THEN f.valid_from ELSE r.valid_from::timestamptz END,
          CASE WHEN f.expired_at IS NOT NULL AND r.expired_at IS NOT NULL AND (NOT r.until_cell OR date_trunc('second', f.valid_until) = r.valid_until::timestamptz) THEN f.valid_until ELSE r.valid_until::timestamptz END,CASE WHEN r.expired_at IS NULL THEN NULL ELSE COALESCE(f.expired_at, r.expired_at::timestamptz) END,r.source,r.confidence,r.claim_metric,r.claim_value,r.claim_unit,r.claim_period,r.attributed_to)`;

const CLEAR_CHANGED_RESOLUTIONS_SQL = `UPDATE takes k SET resolved_at=NULL,resolved_quality=NULL,
        resolved_outcome=NULL,resolved_source=NULL,resolved_value=NULL,resolved_unit=NULL,resolved_by=NULL
      FROM jsonb_to_recordset($2::text::jsonb) AS n(row_num integer,claim text)
      WHERE k.page_id=$1 AND k.row_num=n.row_num AND k.resolved_at IS NOT NULL AND k.claim IS DISTINCT FROM n.claim`;

const WRITE_RESOLUTIONS_SQL = `UPDATE takes k SET resolved_at=r.resolved_at::timestamptz,resolved_quality=r.resolved_quality,
        resolved_outcome=r.resolved_outcome,resolved_source=r.resolved_source,resolved_value=r.resolved_value,resolved_unit=r.resolved_unit,
        resolved_by=r.resolved_by
      FROM jsonb_to_recordset($2::text::jsonb) AS r(row_num integer,resolved_at text,resolved_quality text,resolved_outcome boolean,
        resolved_source text,resolved_value real,resolved_unit text,resolved_by text)
      WHERE k.page_id=$1 AND k.row_num=r.row_num AND (k.resolved_at,k.resolved_quality,k.resolved_outcome,k.resolved_source,k.resolved_value,k.resolved_unit,
        k.resolved_by) IS DISTINCT FROM (r.resolved_at::timestamptz,r.resolved_quality,r.resolved_outcome,r.resolved_source,r.resolved_value,r.resolved_unit,
        r.resolved_by)`;

/** The page's stored takes at `rowNums` (the rows a write drops), with their claims, for the quoted-fence check. */
export async function listQuotedTakeRows(raw: Raw, pageId: number, rowNums: readonly number[]): Promise<QuotedTakeRow[]> {
  return raw.executeRaw<QuotedTakeRow>(QUOTED_TAKES_SQL, [pageId, [...rowNums]]);
}

/** Every positioned fact of the page (`row_num` set), live or expired, with its claim and visibility. */
export async function listPageFenceFactCells(raw: Raw, sourceId: string, slug: string): Promise<PageFenceFactCell[]> {
  return raw.executeRaw<PageFenceFactCell>(PAGE_FENCE_CELLS_SQL, [sourceId, slug]);
}

/** Whether the page has a positioned fact that is not a conversation-extractor row. */
export async function hasPositionedPageFacts(raw: Raw, sourceId: string, slug: string): Promise<boolean> {
  return (await raw.executeRaw(POSITIONED_FACTS_SQL, [sourceId, slug])).length > 0;
}

/** Whether the generation of (source, kind, owner key) is held because its fence was absent from a write. */
export async function hasFenceAbsentHold(raw: Raw, sourceId: string, kind: string, ownerKey: string): Promise<boolean> {
  return (await raw.executeRaw(FENCE_ABSENT_HOLD_SQL, [sourceId, kind, ownerKey])).length > 0;
}

/** The row number of every take of page `pageId`, in no set order. */
export async function listPageTakeRowNums(raw: Raw, pageId: number): Promise<number[]> {
  return (await raw.executeRaw<{ row_num: number }>(PAGE_TAKE_ROWS_SQL, [pageId])).map(r => Number(r.row_num));
}

/**
 * Expires and detaches the page's positioned facts of `ids` that the incoming fence (`incoming`, the jsonb_to_recordset text
 * of row_num, fact and visibility) does not state as they are: a conversation-extractor row only when a cell claims its
 * number, and never a row `gbrain repair open-facts` opens.
 */
export async function expireFenceFacts(raw: Raw, sourceId: string, slug: string, incoming: string, ids: readonly number[]): Promise<void> {
  const { text, params } = renderFragment(sqlFragment`${trustedSql(`UPDATE facts f SET expired_at=COALESCE(expired_at,now()),row_num=NULL
      WHERE source_id=$1 AND source_markdown_slug=$2 AND row_num IS NOT NULL AND f.id=ANY($4::bigint[])
      AND (COALESCE(f.source,'') NOT LIKE 'cli:extract-conversation-facts%'
        OR EXISTS (SELECT 1 FROM jsonb_to_recordset($3::text::jsonb) AS c(row_num integer) WHERE c.row_num=f.row_num))
      AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset($3::text::jsonb) AS n(row_num integer,fact text,visibility text)
        WHERE n.row_num=f.row_num AND n.fact=f.fact AND n.visibility=f.visibility)
      AND NOT `)}${trustedSql(openedFactRowSql('f', '$3'))}`);
  if (params.length) throw new Error('expireFenceFacts: the statement must bind no fragment values');
  await raw.executeRaw(text, [sourceId, slug, incoming, [...ids]]);
}

/** Writes each fence row's cells (`fieldRows`, the jsonb_to_recordset text) onto the page's fact at that row number, where any differs. */
export async function refreshFenceFactFields(raw: Raw, sourceId: string, slug: string, fieldRows: string): Promise<void> {
  await raw.executeRaw(FIELD_ROWS_SQL, [sourceId, slug, fieldRows]);
}

/** Clears the resolution of each resolved take of the page whose claim differs from the claim at its row number in `claims`. */
export async function clearChangedTakeResolutions(raw: Raw, pageId: number, claims: string): Promise<void> {
  await raw.executeRaw(CLEAR_CHANGED_RESOLUTIONS_SQL, [pageId, claims]);
}

/** Writes each fence row's resolution cells (`resolutions`, the jsonb_to_recordset text) onto the page's take at that row number, where any differs. */
export async function writeFenceTakeResolutions(raw: Raw, pageId: number, resolutions: string): Promise<void> {
  await raw.executeRaw(WRITE_RESOLUTIONS_SQL, [pageId, resolutions]);
}
