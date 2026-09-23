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
 *
 * Sharing a source_path does not by itself make a page a twin: a live page
 * can keep a stale source_path after a cheap rename (#3583), and a full sync
 * resuming from a checkpoint may not re-import its file to heal it. So a twin
 * is retired only when NO file in the working tree derives to its slug —
 * the same liveness rule the rename reconcile uses. An incomplete index (some
 * file's slug unknowable) retires nothing.
 */
import type { BrainEngine } from './engine.ts';
import { withCompanyBrainSource } from './company-brain/profile.ts';
import { insertAliasRow } from './schema-pack/page-to-alias.ts';
import type { SupersededTwin } from './sync-reconcile.ts';

export async function retireSupersededTwins(
  engine: BrainEngine,
  sourceId: string,
  superseded: ReadonlyArray<SupersededTwin>,
  log: (line: string) => void,
  fileSlugs: () => { slugs: ReadonlySet<string>; complete: boolean },
): Promise<number> {
  if (superseded.length === 0) return 0;
  let live: { slugs: ReadonlySet<string>; complete: boolean };
  try {
    live = fileSlugs();
  } catch (err) {
    log(`  Skipped retiring ${superseded.length} old-slug page(s): could not list the files' slugs (${(err as Error).message}).`);
    return 0;
  }
  if (!live.complete) {
    log(`  Skipped retiring ${superseded.length} old-slug page(s): some file's slug could not be read, so a live page cannot be told from a twin.`);
    return 0;
  }
  let retired = 0;
  for (const { slug, canonical } of superseded) {
    if (live.slugs.has(slug)) continue;
    try {
      // One transaction: a twin must never be deleted without its redirect
      // (links to the old slug would break, and a deleted row drops out of the
      // next reconcile, so nothing would retry it). An existing redirect for
      // the old slug — e.g. one the owner set by hand — is kept.
      const done = await withCompanyBrainSource(engine, sourceId, scoped => scoped.transaction(async tx => {
        const deleted = await tx.softDeletePages([slug], { sourceId });
        if (deleted.length === 0) return false;
        await insertAliasRow(tx, sourceId, slug, canonical, 'slug grammar change');
        return true;
      }));
      if (done) retired++;
    } catch (err) {
      log(`  Could not retire old-slug page ${slug} (-> ${canonical}); kept, retried on the next full sync: ${(err as Error).message}`);
    }
  }
  if (retired > 0) {
    log(`  Retired ${retired} old-slug page(s) left by a slug-grammar change (soft-deleted, recoverable 72h; old slugs redirect to the new ones).`);
  }
  return retired;
}
