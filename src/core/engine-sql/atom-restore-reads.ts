/**
 * The reads of `gbrain repair atoms-restore` (src/core/repair/atoms-restore.ts): the restorable re-extraction
 * retirements of `atomRetirementsSql` (persistence/atom-retirement-hold.ts) and the counts of the ones the rule keeps.
 * Both SQL engines delegate here; the Rust store serves the same members
 * (rust/crates/gbrain-store/src/page_ops/atom_restore.rs).
 *
 * The apply recheck (`atomId`) scopes the rule by the atom's source and origin; the atom's own origin group is the
 * same under either scope, so its row is too.
 */
import type { BrainEngine } from '../engine.ts';
import { atomOriginScopeSql, atomRetirementsSql } from '../persistence/atom-retirement-hold.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** One restorable retirement with what an apply restores it to. */
export interface RestorableAtomRow {
  id: number; source_id: string; incarnation: string; slug: string; revision: string; origin_kind: 'page' | 'transcript'; origin: string;
  origin_page_id: number | null; hash: string; retired_at: string | null; version_id: number | null;
}

const SOURCE_SCOPE = 'p.source_id=ANY($1::text[])';
const RESTORABLE_SQL = (scope: string, one: boolean) => `
    SELECT c.id, c.source_id, (SELECT s.incarnation::text FROM sources s WHERE s.id=c.source_id) AS incarnation,
           a.slug, a.knowledge_revision::text AS revision, c.origin_kind, c.origin, c.origin_page_id, c.hash, c.retired_at,
           (SELECT v.id FROM page_versions v WHERE v.page_id=a.id AND v.is_deleted=false AND v.frontmatter->>'retired_by' IS NULL
               AND regexp_replace(COALESCE(v.frontmatter->>'source_hash',''),'^pending:','')=c.hash
             ORDER BY v.id DESC LIMIT 1) AS version_id
      FROM (${atomRetirementsSql(scope)}) c JOIN pages a ON a.id=c.id
     WHERE c.restorable${one ? ' AND c.id=$2::bigint' : ''}
     ORDER BY c.id`;
const ALL_SQL = RESTORABLE_SQL(SOURCE_SCOPE, false);
const ONE_SQL = RESTORABLE_SQL(`${SOURCE_SCOPE} AND ${atomOriginScopeSql('$2::bigint')}`, true);
const KEPT_SQL = `
    SELECT count(*) FILTER (WHERE NOT origin_live)::int AS origin_gone,
           count(*) FILTER (WHERE origin_live AND replaced)::int AS replaced,
           count(*) FILTER (WHERE origin_live AND NOT replaced AND NOT latest)::int AS older_generation
      FROM (${atomRetirementsSql(SOURCE_SCOPE)}) kept`;

/** Restorable atoms of these sources in id order; `atomId` narrows to that atom. */
export async function listRestorableAtoms(raw: Raw, sourceIds: readonly string[], atomId: number | null): Promise<RestorableAtomRow[]> {
  const rows = await raw.executeRaw<RestorableAtomRow>(atomId === null ? ALL_SQL : ONE_SQL, atomId === null ? [[...sourceIds]] : [[...sourceIds], atomId]);
  return rows.map(row => ({ ...row, id: Number(row.id), origin_page_id: row.origin_page_id === null ? null : Number(row.origin_page_id),
    version_id: row.version_id === null ? null : Number(row.version_id) }));
}

/** The re-extraction retirements of these sources the rule keeps, by reason. */
export async function countKeptAtomRetirements(raw: Raw, sourceIds: readonly string[]): Promise<{ origin_gone: number; replaced: number; older_generation: number }> {
  const [row] = await raw.executeRaw<{ origin_gone: number; replaced: number; older_generation: number }>(KEPT_SQL, [[...sourceIds]]);
  return { origin_gone: Number(row?.origin_gone ?? 0), replaced: Number(row?.replaced ?? 0), older_generation: Number(row?.older_generation ?? 0) };
}
