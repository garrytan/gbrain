/**
 * Retire old-slug twins found by a full-sync reconcile (see
 * sync-reconcile.ts:planReconcileDeletes `superseded`).
 *
 * A slug-grammar change (ADR-0001) re-keys a file on the next full sync: the
 * import writes a NEW page under the current slug while the page minted under
 * the old grammar keeps the same source_path. The twin's content lives in the
 * sibling, so the twin is soft-deleted (recoverable 72h, like every reconcile
 * delete) and its slug redirects to the sibling through slug_aliases, so
 * wikilinks and get_page calls on the old slug still land. Soft-deleting also
 * removes the twin from alias resolution (tryAliasExact filters live pages),
 * which a name both pages claim would otherwise leave ambiguous.
 */
import type { BrainEngine } from './engine.ts';
import { softDeleteSyncPages } from './company-brain/profile.ts';

export async function retireSupersededTwins(
  engine: BrainEngine,
  sourceId: string,
  superseded: ReadonlyArray<{ slug: string; canonical: string }>,
  log: (line: string) => void,
): Promise<number> {
  let retired = 0;
  for (const { slug, canonical } of superseded) {
    try {
      const deleted = await softDeleteSyncPages(engine, [slug], { sourceId });
      if (deleted.length === 0) continue;
      await engine.executeRaw(
        `INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug, notes)
         VALUES ($1, $2, $3, 'slug grammar change')
         ON CONFLICT (source_id, alias_slug) DO UPDATE SET canonical_slug = EXCLUDED.canonical_slug`,
        [sourceId, slug, canonical],
      );
      retired++;
    } catch {
      // Best-effort like the reconcile deletes: a twin that will not retire
      // stays visible and is retried on the next full sync.
    }
  }
  if (retired > 0) {
    log(`  Retired ${retired} old-slug page(s) left by a slug-grammar change (soft-deleted, recoverable 72h; old slugs redirect to the new ones).`);
  }
  return retired;
}
