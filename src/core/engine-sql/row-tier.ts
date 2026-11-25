/**
 * The statements of a tier-only change of one row (trust/page-handlers.ts `setRowTier`) and of the projection queue it
 * feeds (trust/page-write.ts `queueTierProjection`), as typed engine members: the row's stored tier before the change,
 * the change itself (tier plus an `owner_decision` key merged into `write_origin`), and the page whose chunks render the
 * row. One SQL implementation for both engines; each statement is the text its caller sent through `executeRaw`, byte for
 * byte, one constant per table, with the same parameters. The tier trigger still runs on the update, so a raise needs
 * the promotion the caller opens (persistence/context.ts withTrustPromotion). The Rust store serves facts and takes
 * (rust/crates/gbrain-store/src/trust/row_tier.rs); a page row refuses there by name.
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** The tables a tier-only change writes. */
export type RowTierTable = 'facts' | 'takes' | 'pages';

const READ_TIER_SQL = {
  facts: 'SELECT trust_tier FROM facts WHERE id = $1',
  takes: 'SELECT trust_tier FROM takes WHERE id = $1',
  pages: 'SELECT trust_tier FROM pages WHERE id = $1',
} as const;

const SET_TIER_SQL = {
  facts: `UPDATE facts SET trust_tier = $2,
            write_origin = COALESCE(write_origin, '{}'::jsonb) || jsonb_build_object('owner_decision', $3::text::jsonb)
          WHERE id = $1 RETURNING id`,
  takes: `UPDATE takes SET trust_tier = $2,
            write_origin = COALESCE(write_origin, '{}'::jsonb) || jsonb_build_object('owner_decision', $3::text::jsonb)
          WHERE id = $1 RETURNING id`,
  pages: `UPDATE pages SET trust_tier = $2,
            write_origin = COALESCE(write_origin, '{}'::jsonb) || jsonb_build_object('owner_decision', $3::text::jsonb)
          WHERE id = $1 RETURNING id`,
} as const;

const PROJECTION_PAGE_SQL = {
  facts: 'SELECT source_id, source_markdown_slug AS slug FROM facts WHERE id = $1 AND source_markdown_slug IS NOT NULL',
  takes: 'SELECT p.source_id, p.slug FROM takes t JOIN pages p ON p.id = t.page_id WHERE t.id = $1',
  pages: 'SELECT source_id, slug FROM pages WHERE id = $1',
} as const;

function tableOf(member: string, table: RowTierTable): RowTierTable {
  if (table !== 'facts' && table !== 'takes' && table !== 'pages') throw new Error(`${member}: unknown table ${String(table)}`);
  return table;
}

/** The stored tier of row `id` of `table`, or null when no row has the id. */
export async function readRowTrustTier(raw: Raw, table: RowTierTable, id: number): Promise<{ trust_tier: string } | null> {
  return (await raw.executeRaw<{ trust_tier: string }>(READ_TIER_SQL[tableOf('readRowTrustTier', table)], [id]))[0] ?? null;
}

/**
 * Sets row `id` of `table` to `tier` and merges `decision` (JSON text) into its `write_origin` under `owner_decision`;
 * returns the ids it changed (one, or none when no row has the id).
 */
export async function setRowTrustTier(raw: Raw, table: RowTierTable, id: number, tier: string, decision: string): Promise<number[]> {
  return (await raw.executeRaw<{ id: number }>(SET_TIER_SQL[tableOf('setRowTrustTier', table)], [id, tier, decision])).map(r => Number(r.id));
}

/** The page whose chunks render row `id` of `table`: the fact's markdown page, the take's page, or the page itself; null for none. */
export async function readTierProjectionPage(raw: Raw, table: RowTierTable, id: number): Promise<{ source_id: string; slug: string } | null> {
  return (await raw.executeRaw<{ source_id: string; slug: string }>(PROJECTION_PAGE_SQL[tableOf('readTierProjectionPage', table)], [id]))[0] ?? null;
}
