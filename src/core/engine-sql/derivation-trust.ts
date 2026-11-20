/**
 * The trust writes of a derivation as typed engine members: the statements trust/taint.ts, facts/derivation-inputs.ts,
 * persistence/derived-retirement-hold.ts and the atom generation adapter sent through `executeRaw`, byte for byte, with
 * the same parameters.
 *
 * - `lowerTrustTier`: lowers rows of one taint table to a derivation's tier and origin, never raising.
 * - `countDerivedRowTaint`: how many take, timeline or page rows carry `taint_inputs`, and how many of those are
 *   external_untrusted (the facts count is `countDerivedFactTaint`).
 * - `insertDerivationInputs`: records the input edges of one derived row (`derivation_inputs`), idempotently.
 * - `listDerivationDependents`: one hop of the derived-row walk: the rows derived from a frontier of inputs.
 * - `stampPageFrontmatter`: one of two fixed frontmatter stamps: the retirement stamp on soft-deleted pages, and the
 *   atom generation's `source_hash` on its live atoms.
 *
 * The Rust engine serves them from its page records and the trust family's derivation edges
 * (rust/crates/gbrain-store/src/trust/derivation.rs).
 */
import type { EngineRawRead } from './cli-reads-ops.ts';
import { trustRankSql, type TaintTable, type TrustTier, type WriteOrigin } from '../trust/tier.ts';

const TAINT_TABLES: readonly TaintTable[] = ['facts', 'takes', 'pages', 'timeline_entries'];
const TAINT_SHARE_TABLES = ['takes', 'timeline_entries', 'pages'] as const;

/** A table `countDerivedRowTaint` counts. */
export type DerivedTaintTable = typeof TAINT_SHARE_TABLES[number];

/** One derivation edge end: a row's table and its id as text. */
export interface DerivationEdgeRef { input_table: string; input_id: string }

/** A row derived from an input. */
export interface DerivationDependentRow { derived_table: string; derived_id: string }

/** The derived row whose input edges `insertDerivationInputs` records. */
export interface DerivedRowKey { table: string; id: string; sourceId: string | null }

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

/** Lowers the rows of `ids` whose stored tier ranks above `tier` to `tier` and `origin`; resolves the ids lowered. */
export async function lowerTrustTier(raw: EngineRawRead, table: TaintTable, ids: readonly number[], tier: TrustTier,
  origin: WriteOrigin | null): Promise<number[]> {
  const name = taintTable('lowerTrustTier', table);
  if (!ids.length) return [];
  const rows = await raw<{ id: number | string }>(
    `UPDATE ${name} SET trust_tier=$2,write_origin=$3::text::jsonb
      WHERE id=ANY($1::bigint[]) AND ${trustRankSql('trust_tier')}>${trustRankSql('$2::text')} RETURNING id`,
    [[...ids], tier, origin ? JSON.stringify(origin) : null]);
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

/** Records an edge from `derived` to each of `inputs`; an edge already recorded is left as it is. */
export async function insertDerivationInputs(raw: EngineRawRead, derived: DerivedRowKey, inputs: readonly DerivationEdgeRef[]): Promise<void> {
  if (!inputs.length) return;
  await raw(`INSERT INTO derivation_inputs(derived_table,derived_id,input_table,input_id,source_id)
    SELECT $1,$2,e.input_table,e.input_id,$3 FROM jsonb_to_recordset($4::text::jsonb) AS e(input_table text,input_id text)
    ON CONFLICT DO NOTHING`, [derived.table, derived.id, derived.sourceId, JSON.stringify(inputs.map(e => ({ input_table: e.input_table, input_id: e.input_id })))]);
}

/** The distinct rows derived from any of `frontier`, by table then id, at most `limit`. */
export async function listDerivationDependents(raw: EngineRawRead, frontier: readonly DerivationEdgeRef[], limit: number): Promise<DerivationDependentRow[]> {
  if (!frontier.length) return [];
  return raw<DerivationDependentRow>(`SELECT DISTINCT d.derived_table,d.derived_id
      FROM derivation_inputs d JOIN jsonb_to_recordset($1::text::jsonb) AS f(input_table text,input_id text)
        ON d.input_table=f.input_table AND d.input_id=f.input_id
      ORDER BY d.derived_table,d.derived_id LIMIT $2`, [JSON.stringify(frontier.map(f => ({ input_table: f.input_table, input_id: f.input_id }))), limit]);
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
