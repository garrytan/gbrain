/**
 * The read of `gbrain repair stale-atoms` (src/core/repair/stale-atoms.ts): `listStaleAtoms`, the live atoms whose origin
 * page is gone or moved past them with a completed extraction of its new content. Both SQL engines delegate here; the
 * Rust store serves the same member (rust/crates/gbrain-store/src/page_ops/stale_atoms.rs). The statement reuses the
 * origin-slug and managed-completion builders (persistence/atom-origin.ts, persistence/managed-atom-sql.ts), vetted in
 * scripts/check-engine-sql-dynamic.ts.
 */
import type { BrainEngine } from '../engine.ts';
import { managedAtomCompletedSql } from '../persistence/managed-atom-sql.ts';
import { atomOriginSlugSql } from '../persistence/atom-origin.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** One stale atom with what its retirement binds. */
export interface StaleAtomRow {
  id: number; source_id: string; incarnation: string; slug: string; revision: string; class: 'origin_gone' | 'origin_changed'; managed: boolean;
  origin_slug: string; origin_page_id: number | null; origin_hash: string | null; evidence: string | null; chars: number;
}

/** The two bound clauses, kept as plain constants so the composed statement holds no literal placeholder. */
const SOURCE_SCOPE = 'a.source_id=ANY($1::text[])';
const ATOM_SCOPE = '($2::int IS NULL OR a.id=$2::int)';
const STALE_ATOMS_SQL = `
    WITH atom AS (
      SELECT a.id, a.source_id, (SELECT s.incarnation::text FROM sources s WHERE s.id=a.source_id) AS incarnation,
             a.slug, a.knowledge_revision::text AS revision,
             a.frontmatter->>'source_slug' AS origin_slug,
             COALESCE(a.frontmatter->>'managed_extraction','')='true' AS managed,
             regexp_replace(COALESCE(a.frontmatter->>'source_hash',''),'^pending:','') AS atom_hash,
             length(COALESCE(a.compiled_truth,'')) AS chars,
             o.id AS origin_page_id, o.slug AS origin_live_slug, o.source_id AS origin_source_id,
             o.content_hash AS origin_hash, o.deleted_at IS NOT NULL AS origin_deleted
        FROM pages a
        LEFT JOIN pages o ON o.source_id=a.source_id AND o.slug=${atomOriginSlugSql('a')}
       WHERE ${SOURCE_SCOPE} AND a.type='atom' AND a.deleted_at IS NULL
         AND NULLIF(a.frontmatter->>'source_slug','') IS NOT NULL
         AND NULLIF(a.frontmatter->>'imported_from','') IS NULL
         AND ${ATOM_SCOPE}
    ), classified AS (
      SELECT atom.*, CASE
          WHEN origin_page_id IS NULL OR origin_deleted THEN 'origin_gone'
          WHEN origin_hash IS NOT NULL AND atom_hash<>substring(origin_hash from 1 for 16) THEN 'origin_changed'
        END AS class,
        CASE WHEN managed THEN (SELECT ac.fingerprint FROM op_checkpoints ac WHERE ${managedAtomCompletedSql({ sourceId: 'atom.origin_source_id',
            pageId: 'atom.origin_page_id', contentHash: 'atom.origin_hash' })}
            AND EXISTS (SELECT 1 FROM pages r WHERE r.source_id=atom.source_id AND r.type='atom' AND r.deleted_at IS NULL
              AND r.frontmatter->>'source_slug' IN (atom.origin_slug, atom.origin_live_slug)
              AND regexp_replace(COALESCE(r.frontmatter->>'source_hash',''),'^pending:','')=substring(atom.origin_hash from 1 for 16))
            ORDER BY ac.fingerprint LIMIT 1)
          ELSE (SELECT 'unmanaged:'||e.id FROM pages e WHERE e.source_id=atom.source_id AND e.type='atom' AND e.deleted_at IS NULL
            AND COALESCE(e.frontmatter->>'managed_extraction','')<>'true' AND e.frontmatter->>'source_slug' IN (atom.origin_slug, atom.origin_live_slug)
            AND e.frontmatter->>'source_hash'=substring(atom.origin_hash from 1 for 16) ORDER BY e.id LIMIT 1)
        END AS completion
        FROM atom
    )
    SELECT id, source_id, incarnation, slug, revision, class, managed, origin_slug,
           origin_page_id,
           CASE WHEN class='origin_gone' THEN NULL ELSE origin_hash END AS origin_hash,
           CASE WHEN class='origin_gone' THEN NULL ELSE completion END AS evidence, chars
      FROM classified
     WHERE class='origin_gone' OR (class='origin_changed' AND completion IS NOT NULL)
     ORDER BY CASE class WHEN 'origin_gone' THEN 1 ELSE 2 END, id`;

/** The stale atoms of these sources in (class, id) order; `atomId` narrows to one atom. */
export async function listStaleAtoms(raw: Raw, sourceIds: readonly string[], atomId: number | null): Promise<StaleAtomRow[]> {
  const rows = await raw.executeRaw<StaleAtomRow>(STALE_ATOMS_SQL, [[...sourceIds], atomId]);
  return rows.map(row => ({ ...row, id: Number(row.id), managed: row.managed === true,
    origin_page_id: row.origin_page_id === null ? null : Number(row.origin_page_id), chars: Number(row.chars) }));
}
