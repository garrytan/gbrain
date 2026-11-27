
import { activationSuppressedSql } from '../eligibility/sql.ts';
import { heldRowSql } from '../eligibility/fence-overlay.ts';
import { holdAppliesToPageSql } from '../write-gate-binding.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';

/** The engine's `executeRaw` (bound), with the two bounds these reads use. */
export type EngineRawRead = <R = Record<string, unknown>>(sql: string, params?: unknown[], opts?: { timeoutMs?: number; jitOff?: boolean; prepare?: boolean }) => Promise<R[]>;

/** One facts-fence cell of a page's text: its row number (-1 for a fragment), its claim, and whether a chunk boundary cut it. */
export interface HeldFenceCellKey { sourceId: string; slug: string; rowNum: number; claim: string; partial: boolean }
/** A fence cell held from the current caller (fence-overlay.ts `heldRowSql`). */
export interface HeldFenceCellRow { source_id: string; slug: string; row_num: number; claim: string }

/**
 * GST-2891: the fence cells among `keys` held from the current caller, whose fact reads are world-only
 * (fence-overlay.ts `heldRowSql`, rendered for the caller in context: its member page and its private-facts grant). One
 * row per distinct held (source, slug, row number, claim); the order is not defined.
 */
export async function listHeldFenceCells(raw: EngineRawRead, keys: readonly HeldFenceCellKey[]): Promise<HeldFenceCellRow[]> {
  if (!keys.length) return [];
  const { text, params } = renderFragment(sqlFragment`SELECT DISTINCT k.source_id, k.slug, k.row_num, k.claim FROM unnest(${keys.map(k => k.sourceId)}::text[], ${keys.map(k => k.slug)}::text[], ${keys.map(k => k.rowNum)}::int[], ${keys.map(k => k.claim)}::text[], ${keys.map(k => (k.partial ? 't' : 'f'))}::text[]) AS k(source_id, slug, row_num, claim, partial)
        WHERE ${trustedSql(heldRowSql('k.source_id', 'k.slug', 'k.row_num', 'k.claim', "k.partial = 't'"))}`);
  const rows = await raw<{ source_id: string; slug: string; row_num: number | string; claim: string }>(text, params);
  return rows.map(r => ({ source_id: r.source_id, slug: r.slug, row_num: Number(r.row_num), claim: r.claim }));
}

/** One world fence row of a page body, as the fence overlay asks about it: its row number, claim, visibility and hold fingerprint (null: no hold check). */
export interface FenceOverlayIncomingRow { row_num: number; claim: string; visibility: string; fp: string | null }
/**
 * What the fence overlay reads for one incoming row: the live page's tier, the tier of the page's newest fact at the row
 * number and whether that fact is activation-suppressed (null when the page or the fact is missing), whether a fact
 * purge, a held write-gate hold or, for a world-only fact reader, a narrower stored fact (`narrower`) hides the row.
 */
export interface FenceOverlayRow { row_num: number; page_tier: string | null; row_tier: string | null; row_flagged: boolean | null; purged: boolean; held: boolean; narrower: boolean }

/**
 * #5575 ENG-1: the fence overlay's read of one page (eligibility/fence-overlay.ts `loadFenceChunkOverlay`), one row per
 * incoming row in incoming order. `held` is a `kind = 'fact'` hold with status `held` for the row's fingerprint on the
 * page (never for a null fingerprint). `narrower` is `heldRowSql` for the caller in context when `hideHeld` is set, and
 * false otherwise.
 */
export async function readFenceOverlayRows(raw: EngineRawRead, page: { sourceId: string; slug: string }, incoming: readonly FenceOverlayIncomingRow[], opts: { hideHeld: boolean }): Promise<FenceOverlayRow[]> {
  if (!incoming.length) return [];
  const narrower = trustedSql(opts.hideHeld ? heldRowSql('v.source_id', 'v.slug', 'i.row_num', 'i.claim') : 'false');
  const flagged = trustedSql(activationSuppressedSql('facts', 'f'));
  const { text, params } = renderFragment(sqlFragment`WITH v AS MATERIALIZED (SELECT ${page.sourceId}::text AS source_id, ${page.slug}::text AS slug)
  SELECT i.row_num,
    (SELECT p.trust_tier FROM pages p WHERE p.source_id = v.source_id AND p.slug = v.slug AND p.deleted_at IS NULL LIMIT 1) AS page_tier,
    (SELECT f.trust_tier FROM facts f WHERE f.source_id = v.source_id AND f.source_markdown_slug = v.slug AND f.row_num = i.row_num
      ORDER BY f.id DESC LIMIT 1) AS row_tier,
    (SELECT ${flagged} FROM facts f WHERE f.source_id = v.source_id AND f.source_markdown_slug = v.slug AND f.row_num = i.row_num
      ORDER BY f.id DESC LIMIT 1) AS row_flagged,
    EXISTS (SELECT 1 FROM fact_purges fp WHERE fp.source_id = v.source_id AND fp.visibility = i.visibility
      AND fp.fact_hash = gbrain_fact_fingerprint(i.claim) AND (fp.subject = '*' OR fp.subject = v.slug)) AS purged,
    EXISTS (SELECT 1 FROM write_gate_holds h WHERE h.kind = 'fact' AND h.source_id = v.source_id
      AND h.status = 'held' AND h.fingerprint = i.fp
      AND ${trustedSql(holdAppliesToPageSql('h', '(SELECT p.id FROM pages p WHERE p.source_id = v.source_id AND p.slug = v.slug)', 'v.slug'))}) AS held,
    ${narrower} AS narrower
  FROM ROWS FROM (jsonb_to_recordset(${JSON.stringify(incoming)}::text::jsonb) AS (row_num integer, claim text, visibility text, fp text)) WITH ORDINALITY AS i(row_num, claim, visibility, fp, ord)
  CROSS JOIN v
  ORDER BY i.ord`);
  const rows = await raw<{ row_num: number | string; page_tier: string | null; row_tier: string | null; row_flagged: boolean | null; purged: boolean; held: boolean; narrower: boolean }>(text, params);
  return rows.map(r => ({ row_num: Number(r.row_num), page_tier: r.page_tier, row_tier: r.row_tier, row_flagged: r.row_flagged, purged: r.purged === true, held: r.held === true, narrower: r.narrower === true }));
}
