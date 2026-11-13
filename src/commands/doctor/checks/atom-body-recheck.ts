/**
 * #6825: the atoms atom_provenance_drift reads (ATOM_PROVENANCE_CTE) and the re-check that clears the drift of atoms
 * whose source page changed only in metadata or a gbrain-managed fence (unchangedBodyAtoms). Inline pages only.
 */
import type { BrainEngine } from '../../../core/engine.ts';
import { contentHash } from '../../../core/utils.ts';
import { stripFenceSections } from '../../../core/cycle/concept-publication.ts';
import { isSegmentedPage } from '../../../core/page-body/page-shape.ts';
import type { BodyStorage } from '../../../core/page-body/types.ts';

/** The page-bound and slug-unbound atoms atom_provenance_drift reads (`ss` NULL: slug-unbound), as a CTE body. */
export const ATOM_PROVENANCE_CTE = `atom AS (
         SELECT a.source_id,
                -- managed atoms keep their provisional prefix for good (#5770)
                CASE WHEN a.frontmatter->>'managed_extraction' = 'true'
                     THEN regexp_replace(a.frontmatter->>'source_hash', '^pending:', '')
                     ELSE a.frontmatter->>'source_hash' END AS sh,
                -- NULL = slug-unbound: transcript-minted (source_path only) or
                -- pre-binding-era. \`ss IS NULL\` is THE predicate for that
                -- population everywhere below (#4799 / #4806).
                NULLIF(a.frontmatter->>'source_slug', '') AS ss,
                CASE WHEN a.frontmatter->>'extracted_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
                     THEN a.frontmatter->>'extracted_at' END AS ext
           FROM pages a
          WHERE a.type = 'atom'
            AND a.deleted_at IS NULL
            AND a.frontmatter->>'source_hash' IS NOT NULL
            -- in-flight marker written before an unmanaged extraction commits
            AND (a.frontmatter->>'source_hash' NOT LIKE 'pending:%' OR a.frontmatter->>'managed_extraction' = 'true')
         )`;

/** (page, source_hash) groups of drifted atoms unchangedBodyAtoms re-checks per run; the rest keep their drift verdict. */
const BODY_RECHECK_GROUPS = 200;
/** The newest versions of a page searched for an atom's extraction edition. */
const BODY_RECHECK_VERSIONS = 20;

/**
 * #6825: drifted atoms of a live inline page whose prose did not change. An atom's source_hash names the page edition
 * it was extracted from; when one of the page's recent versions hashes to it and its body without the gbrain-managed
 * facts and takes sections (stripFenceSections, the narrative concept synthesis compares) equals the page's, the move
 * was a metadata or fence write, not an edit of what the atom summarises. An edition no version still holds, and a
 * segmented page, keep their drift verdict.
 */
export async function unchangedBodyAtoms(engine: BrainEngine): Promise<number> {
  const groups = await engine.executeRaw<{ page_id: number; sh: string; n: number }>(
    `WITH ${ATOM_PROVENANCE_CTE}, live_hashes AS MATERIALIZED (
       SELECT DISTINCT source_id, substring(content_hash from 1 for 16) AS sh FROM pages WHERE deleted_at IS NULL AND content_hash IS NOT NULL
     )
     SELECT p.id AS page_id, atom.sh, count(*)::int AS n
       FROM atom
       JOIN pages p ON p.source_id = atom.source_id AND p.slug = atom.ss AND p.deleted_at IS NULL AND p.body_storage = 'inline'
       LEFT JOIN live_hashes h ON h.source_id = atom.source_id AND h.sh = atom.sh
      WHERE h.sh IS NULL AND length(atom.sh) = 16
      GROUP BY p.id, atom.sh ORDER BY p.id, atom.sh LIMIT ${BODY_RECHECK_GROUPS}`, []);
  const json = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;
  const narrative = (body: { compiled_truth: string; timeline: string | null }) => [stripFenceSections(body.compiled_truth), stripFenceSections(body.timeline ?? '')];
  let unchanged = 0;
  for (const group of groups) {
    const [page] = await engine.executeRaw<{ body_storage: BodyStorage | null; compiled_truth: string | null; timeline: string | null }>(
      'SELECT body_storage, compiled_truth, timeline FROM pages WHERE id = $1', [group.page_id]);
    if (!page || isSegmentedPage(page) || page.compiled_truth == null) continue;
    const versions = await engine.executeRaw<{ compiled_truth: string | null; timeline: string | null; title: string; type: string; frontmatter: unknown; tags: unknown }>(
      `SELECT compiled_truth, timeline, title, type, frontmatter, tags FROM page_versions
        WHERE page_id = $1 AND body_storage = 'inline' AND compiled_truth IS NOT NULL ORDER BY id DESC LIMIT ${BODY_RECHECK_VERSIONS}`, [group.page_id]);
    const edition = versions.find(v => contentHash({ title: v.title, type: v.type as never, compiled_truth: v.compiled_truth!, timeline: v.timeline ?? '',
      frontmatter: json<Record<string, unknown>>(v.frontmatter) ?? {}, tags: json<string[] | null>(v.tags) ?? [] }).startsWith(group.sh));
    if (!edition) continue;
    const [was, is] = [narrative({ compiled_truth: edition.compiled_truth!, timeline: edition.timeline }), narrative({ compiled_truth: page.compiled_truth, timeline: page.timeline })];
    if (was[0] === is[0] && was[1] === is[1]) unchanged += Number(group.n);
  }
  return unchanged;
}
