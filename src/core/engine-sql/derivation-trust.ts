/**
 * The trust writes of a derivation as typed engine members: the statements trust/taint.ts,
 * persistence/derived-retirement-hold.ts and the atom generation adapter sent through `executeRaw`, byte for byte, with
 * the same parameters. `lowerTrustTier` is the exception: it binds its values through `sqlFragment`, so its placeholders
 * are renumbered in text order and the tier it compares against binds as a rank (`TRUST_TIER_RANK`); a tier that names
 * no trust tier is refused before the statement (`assertLowerTrustTier`).
 *
 * - `lowerTrustTier`: lowers rows of one taint table to a derivation's tier and origin, never raising.
 * - `countDerivedRowTaint`: how many take, timeline or page rows carry `taint_inputs`, and how many of those are
 *   external_untrusted (the facts count is `countDerivedFactTaint`).
 * - `stampPageFrontmatter`: one of two fixed frontmatter stamps: the retirement stamp on soft-deleted pages, and the
 *   atom generation's `source_hash` on its live atoms.
 *
 * The Rust engine serves them from its page, take, timeline and fact records
 * (rust/crates/gbrain-store/src/trust/derivation.rs). The derivation edges (`derivation_inputs`) are not here.
 */
import type { EngineRawRead } from './cli-reads-ops.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';
import { isTrustTier, TRUST_TIER_RANK, trustRankSql, type TaintTable, type TrustTier, type WriteOrigin } from '../trust/tier.ts';

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

function taintTable(member: string, table: string): TaintTable {
  if (!(TAINT_TABLES as readonly string[]).includes(table)) throw new Error(`${member}: unknown table ${JSON.stringify(table)}`);
  return table as TaintTable;
}

/**
 * Refuses a lowering tier that names no trust tier. Without it the SQL ranked the tier 0 and lowered every ranked row to
 * the bad name (the tier CHECK then refused the write), but updated nothing and resolved [] when no row ranked above 0,
 * while the Rust store refused every call: one call, two answers.
 */
export function assertLowerTrustTier(tier: unknown): asserts tier is TrustTier {
  if (!isTrustTier(tier)) throw new Error(`lowerTrustTier: unknown trust tier ${JSON.stringify(tier)}`);
}

/** Lowers the rows of `ids` whose stored tier ranks above `tier` to `tier` and `origin`; resolves the ids lowered. An unknown tier is refused. */
export async function lowerTrustTier(raw: EngineRawRead, table: TaintTable, ids: readonly number[], tier: TrustTier,
  origin: WriteOrigin | null): Promise<number[]> {
  const name = taintTable('lowerTrustTier', table);
  if (!ids.length) return [];
  assertLowerTrustTier(tier);
  const { text, params } = renderFragment(sqlFragment`UPDATE ${trustedSql(TAINT_TABLE_SQL[name])} SET trust_tier=${tier},write_origin=${origin ? JSON.stringify(origin) : null}::text::jsonb
      WHERE id=ANY(${[...ids]}::bigint[]) AND ${trustedSql(trustRankSql('trust_tier'))}>${TRUST_TIER_RANK[tier]}::int RETURNING id`);
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
