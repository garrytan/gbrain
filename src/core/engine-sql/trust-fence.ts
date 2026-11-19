/**
 * The fence guard's read of a page's facts-fence rows with their trust tier (trust/fence-guard.ts `guardFenceRows`): the
 * rows a page publish may not simply expire, because the writer is less trusted than the row, a widening proposal holds
 * the row narrower, or `gbrain repair open-facts` opens it. One SQL implementation for both engines; the statement is the
 * text `guardFenceRows` sent through `executeRaw`, except that the incoming fence document is bound once (`v.incoming`) in
 * place of a hand-numbered `$3` (test/fixtures/fold-hook-noop-6712.json pins the statement). The decisions (which rows
 * are kept, moved or contested) stay in the caller.
 *
 * The writer's tier (`gbrain.write_trust_tier`) and the opened fact ids (`gbrain.write_open_facts`) are transaction-local
 * settings the SQL reads itself; this member passes neither.
 */
import type { BrainEngine } from '../engine.ts';
import { heldRowSql } from '../eligibility/fence-overlay.ts';
import { activationSuppressedSql } from '../eligibility/sql.ts';
import { openedFactRowSql } from '../persistence/context.ts';
import { trustRankSql } from '../trust/tier.ts';
import type { LegacyUnscopedRead } from './brands.ts';
import { sqlFragment, trustedSql } from './fragment.ts';

/** SQL for the writer's trust rank: the transaction's declared tier (`gbrain.write_trust_tier`), `unknown` when undeclared. */
export const WRITER_RANK_SQL = trustRankSql(`COALESCE(NULLIF(current_setting('gbrain.write_trust_tier', true), ''), 'unknown')`);

/** What `guardFenceRows` asks of a page: its source, slug and the incoming fence (`jsonb_to_recordset` text of row_num, fact, visibility). */
export interface FenceRowsTarget { sourceId: string; slug: string; incoming: string }

/**
 * A live fence row of the page that the incoming fence does not state as it is and that the guard must look at: `above`
 * says it is more trusted than the writer, `opened` that `gbrain repair open-facts` opens it. `trust_tier` is the stored
 * tier.
 */
export interface FenceFactRow { id: number; row_num: number; fact: string; visibility: string; trust_tier: string; above: boolean; opened: boolean }

/**
 * The page's fence rows the writer may not supersede, by row number, locked (`FOR UPDATE OF f`): live, numbered, not a
 * conversation-extractor row unless the incoming fence claims its number, not stated unchanged by the incoming fence, and
 * more trusted than the writer, held narrower by a widening proposal that the fence still asks to widen, or opened.
 */
export async function listFenceFactRows(exec: LegacyUnscopedRead, target: FenceRowsTarget): Promise<FenceFactRow[]> {
  // A contested row a widening proposal stored narrower (pending, rejected or undone) is held while the fence still asks for world at its position.
  const held = trustedSql(`f.visibility <> 'world' AND EXISTS (SELECT 1 FROM trust_proposals tp WHERE tp.action IN ('supersede_fact', 'confirm') AND tp.related_table = 'facts'
      AND tp.related_id = f.id AND tp.status IN ('pending', 'rejected', 'undone') AND tp.before_state->'visibility' IS NOT NULL)
    AND EXISTS (SELECT 1 FROM jsonb_to_recordset(v.incoming::text::jsonb) AS w(row_num integer, fact text, visibility text)
      WHERE w.row_num = f.row_num AND w.fact = f.fact AND w.visibility = 'world')`);
  const opened = trustedSql(openedFactRowSql('f', 'v.incoming'));
  const above = trustedSql(`${trustRankSql('f.trust_tier')} > ${WRITER_RANK_SQL}`);
  const rows = (await exec.run<FenceFactRow>(sqlFragment`SELECT f.id, f.row_num, f.fact, f.visibility, f.trust_tier, ${above} AS above, ${opened} AS opened FROM facts f
      CROSS JOIN (SELECT ${target.incoming}::text AS incoming) v
      WHERE f.source_id = ${target.sourceId} AND f.source_markdown_slug = ${target.slug} AND f.row_num IS NOT NULL AND f.expired_at IS NULL
        AND (COALESCE(f.source, '') NOT LIKE 'cli:extract-conversation-facts%'
          OR EXISTS (SELECT 1 FROM jsonb_to_recordset(v.incoming::text::jsonb) AS c(row_num integer) WHERE c.row_num = f.row_num))
        AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(v.incoming::text::jsonb) AS n(row_num integer, fact text, visibility text)
          WHERE n.row_num = f.row_num AND n.fact = f.fact AND n.visibility = f.visibility)
        AND (${above} OR (${held}) OR ${opened})
      ORDER BY f.row_num FOR UPDATE OF f`)).rows;
  return rows;
}

/**
 * What the fence chunk overlay asks of a page (eligibility/fence-overlay.ts loadFenceChunkOverlay): its source, slug, the
 * world fence cells of its body (`incoming`, the `jsonb_to_recordset` text of row_num, claim, visibility and the hold
 * fingerprint `fp`), whether to look up held cells (`holds`: a hold fingerprint is installed) and whether to mark the
 * cells held from a world-only reader (`hideHeld`, heldRowSql).
 */
export interface FenceOverlayTarget { sourceId: string; slug: string; incoming: string; holds: boolean; hideHeld: boolean }

/**
 * One incoming cell's overlay facts: the live page's tier, the tier and activation flag of the newest facts row at that
 * row number (any state), whether a purge tombstone names its claim, whether a held fact hold has its fingerprint, and
 * whether it is held from a world-only reader. A lookup the target turns off answers false.
 */
export interface FenceOverlayRow { row_num: number; page_tier: string | null; row_tier: string | null; row_flagged: boolean | null; purged: boolean; held: boolean; narrower: boolean }

/** The overlay facts of each incoming cell, one row per cell, in no set order. */
export async function readFenceOverlayRows(exec: LegacyUnscopedRead, target: FenceOverlayTarget): Promise<FenceOverlayRow[]> {
  const held = trustedSql(target.holds ? `EXISTS (SELECT 1 FROM write_gate_holds h WHERE h.kind='fact' AND h.source_id=v.source_id AND h.slug=v.slug
      AND h.status='held' AND h.fingerprint=incoming.fp)` : 'false');
  const narrower = trustedSql(target.hideHeld ? heldRowSql('v.source_id', 'v.slug', 'incoming.row_num', 'incoming.claim') : 'false');
  const flagged = trustedSql(activationSuppressedSql('facts', 'f'));
  return (await exec.run<FenceOverlayRow>(sqlFragment`WITH v AS MATERIALIZED (SELECT ${target.sourceId}::text AS source_id, ${target.slug}::text AS slug),
    incoming AS MATERIALIZED (
      SELECT i.row_num, i.claim, i.visibility, i.fp FROM jsonb_to_recordset(${target.incoming}::text::jsonb) AS i(row_num integer, claim text, visibility text, fp text))
    SELECT incoming.row_num,
      (SELECT p.trust_tier FROM pages p WHERE p.source_id=v.source_id AND p.slug=v.slug AND p.deleted_at IS NULL LIMIT 1) AS page_tier,
      (SELECT f.trust_tier FROM facts f WHERE f.source_id=v.source_id AND f.source_markdown_slug=v.slug AND f.row_num=incoming.row_num
        ORDER BY f.id DESC LIMIT 1) AS row_tier,
      (SELECT ${flagged} FROM facts f WHERE f.source_id=v.source_id AND f.source_markdown_slug=v.slug AND f.row_num=incoming.row_num
        ORDER BY f.id DESC LIMIT 1) AS row_flagged,
      EXISTS (SELECT 1 FROM fact_purges fp WHERE fp.source_id=v.source_id AND fp.visibility=incoming.visibility
        AND fp.fact_hash=gbrain_fact_fingerprint(incoming.claim) AND (fp.subject='*' OR fp.subject=v.slug)) AS purged,
      ${held} AS held,
      ${narrower} AS narrower
    FROM incoming CROSS JOIN v`)).rows;
}

/** What a fence append restores on its page after the page write (trust/fence-append.ts withPageTierKept). */
export interface PageTrustRestore { pageId: number; trustTier: string; /** JSON text, or null for none. */ writeOrigin: string | null }

/**
 * Puts back the page's trust tier and write origin a fence append's page write restamped. The tier trigger still runs: a
 * raise back to the prior tier needs the promotion the caller opens (persistence/context.ts withTrustPromotion).
 */
export async function restorePageTrust(raw: Pick<BrainEngine, 'executeRaw'>, spec: PageTrustRestore): Promise<void> {
  await raw.executeRaw('UPDATE pages SET trust_tier=$2, write_origin=$3::text::jsonb WHERE id=$1', [spec.pageId, spec.trustTier, spec.writeOrigin]);
}
