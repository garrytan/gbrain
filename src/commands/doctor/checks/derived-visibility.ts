/**
 * derived_visibility doctor check (#5525): extracted atoms and synthesized
 * concepts without an explicit `visibility`, and ones stored looser than their
 * origin (a transcript or missing origin counts as private, as in the repair).
 * Remote reads treat unstamped rows as private; the warning names the
 * tighten-only backfill `gbrain repair visibility` that stamps the stored rows.
 * One indexed aggregate query; counts are exact.
 */
import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { privateSnapshotFilterFragment } from '../../../core/search/private-visibility.ts';

export async function derivedVisibilityCheck(engine: BrainEngine, sourceId?: string): Promise<Check> {
  const name = 'derived_visibility';
  try {
    const [row] = await engine.executeRaw<{ unstamped_atoms: number; unstamped_concepts: number; looser_atoms: number; looser_concepts: number }>(
      `WITH derived AS (
         SELECT p.* FROM pages p WHERE p.deleted_at IS NULL ${sourceId ? 'AND p.source_id=$1' : ''}
           AND (p.type='atom' OR (p.type='concept' AND p.frontmatter->>'synthesized_by' IS NOT NULL)))
       SELECT
         COUNT(*) FILTER (WHERE d.type='atom' AND d.frontmatter->>'visibility' IS NULL)::int AS unstamped_atoms,
         COUNT(*) FILTER (WHERE d.type='concept' AND d.frontmatter->>'visibility' IS NULL)::int AS unstamped_concepts,
         COUNT(*) FILTER (WHERE d.type='atom' AND d.frontmatter->>'visibility'='world' AND NOT EXISTS (SELECT 1 FROM pages o
           WHERE o.source_id=d.source_id AND o.slug=d.frontmatter->>'source_slug' AND o.deleted_at IS NULL
             AND ${privateSnapshotFilterFragment('o')}))::int AS looser_atoms,
         COUNT(*) FILTER (WHERE d.type='concept' AND d.frontmatter->>'visibility'='world' AND EXISTS (SELECT 1 FROM links l
           JOIN pages a ON a.id=l.to_page_id WHERE l.from_page_id=d.id AND l.link_source='concept-provenance' AND l.link_type='synthesized_from'
             AND (COALESCE(a.frontmatter->>'visibility','private')='private' OR EXISTS (SELECT 1 FROM pages ao WHERE ao.source_id=a.source_id
               AND ao.slug=a.frontmatter->>'source_slug' AND ao.frontmatter->>'visibility'='private'))))::int AS looser_concepts
       FROM derived d`, sourceId ? [sourceId] : []);
    const details = { ...row, count: 'exact', truncated: false, repair: 'visibility' };
    const unstamped = row.unstamped_atoms + row.unstamped_concepts;
    const looser = row.looser_atoms + row.looser_concepts;
    if (unstamped + looser === 0) return { name, status: 'ok', details, message: 'Every extracted atom and synthesized concept carries an explicit visibility no looser than its origin.' };
    return { name, status: 'warn', details, message: `${unstamped} derived page(s) have no explicit visibility (${row.unstamped_atoms} atoms, ${row.unstamped_concepts} concepts) `
      + `and ${looser} are stored looser than their origin; remote reads treat the unstamped ones as private. `
      + `Preview: gbrain repair visibility — apply: gbrain repair visibility --apply` };
  } catch (e) {
    return { name, status: 'warn', message: `derived visibility check skipped: ${e instanceof Error ? e.message : String(e)}`,
      details: { count: 'lower_bound', truncated: true, health: 'unknown' } };
  }
}
