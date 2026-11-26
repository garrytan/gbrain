/**
 * #6825: the atoms atom_provenance_drift reads (ATOM_PROVENANCE_CTE) and the re-check that clears the drift of atoms
 * whose source page changed only in metadata or a gbrain-managed fence (unchangedBodyAtoms). Inline pages only.
 */
import type { BrainEngine } from '../../../core/engine.ts';
import { contentHash } from '../../../core/utils.ts';
import { stripFenceSections } from '../../../core/cycle/concept-publication.ts';
import { isSegmentedPage } from '../../../core/page-body/page-shape.ts';
import type { BodyStorage } from '../../../core/page-body/types.ts';

/** The atom CTE atom_provenance_drift reads, kept beside the statements that use it (engine-sql/doctor-derived.ts). */
export { ATOM_PROVENANCE_CTE } from '../../../core/engine-sql/doctor-derived.ts';

/**
 * #6825: drifted atoms of a live inline page whose prose did not change. An atom's source_hash names the page edition
 * it was extracted from; when one of the page's recent versions hashes to it and its body without the gbrain-managed
 * facts and takes sections (stripFenceSections, the narrative concept synthesis compares) equals the page's, the move
 * was a metadata or fence write, not an edit of what the atom summarises. An edition no version still holds, and a
 * segmented page, keep their drift verdict.
 */
export async function unchangedBodyAtoms(engine: BrainEngine): Promise<number> {
  const groups = await engine.listBodyRecheckGroups();
  const json = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;
  const narrative = (body: { compiled_truth: string; timeline: string | null }) => [stripFenceSections(body.compiled_truth), stripFenceSections(body.timeline ?? '')];
  let unchanged = 0;
  for (const group of groups) {
    const page = await engine.readBodyRecheckPage(group.page_id);
    if (!page || isSegmentedPage(page as { body_storage: BodyStorage | null }) || page.compiled_truth == null) continue;
    const versions = await engine.listBodyRecheckVersions(group.page_id);
    const edition = versions.find(v => contentHash({ title: v.title, type: v.type as never, compiled_truth: v.compiled_truth!, timeline: v.timeline ?? '',
      frontmatter: json<Record<string, unknown>>(v.frontmatter) ?? {}, tags: json<string[] | null>(v.tags) ?? [] }).startsWith(group.sh));
    if (!edition) continue;
    const [was, is] = [narrative({ compiled_truth: edition.compiled_truth!, timeline: edition.timeline }), narrative({ compiled_truth: page.compiled_truth, timeline: page.timeline })];
    if (was[0] === is[0] && was[1] === is[1]) unchanged += Number(group.n);
  }
  return unchanged;
}
