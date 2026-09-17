import type { BrainEngine } from '../engine.ts';
import { contentHash } from '../utils.ts';
import { assertPageRevision, type PageSnapshot } from './types.ts';
import { withCoordinatedWrite } from '../persistence/context.ts';

/** Persist an effective withdrawal overlay without inventing a second logical edit. */
export async function materializePageSnapshot(engine: BrainEngine, snapshot: PageSnapshot): Promise<void> {
  const sourceId = snapshot.page.source_id;
  const slug = snapshot.page.slug;
  await engine.transaction(async tx => {
    await tx.lockPageKeys([{ sourceId, slug }]);
    const current = await tx.readPageSnapshot(slug, { sourceId, includeDeleted: true });
    assertPageRevision(current, { expectedRevision: snapshot.revision });
    if (!current || current.sourceIncarnation !== snapshot.sourceIncarnation) throw new Error('Page source incarnation changed');
    const previous = await tx.executeRaw<{ revision: string | null }>("SELECT current_setting('gbrain.materializing_revision',true) AS revision");
    await tx.executeRaw("SELECT set_config('gbrain.materializing_revision',$1,true)", [current.revision]);
    // Only database-derived canonical bytes may use the bypass. Callers cannot
    // smuggle arbitrary content in the supplied snapshot at an old revision.
    const page = current.page;
    await withCoordinatedWrite(tx, [sourceId], () => tx.executeRaw(`UPDATE pages SET compiled_truth=$1,timeline=$2,content_hash=$3
      WHERE id=$4 AND knowledge_revision=$5::uuid`,
    [page.compiled_truth, page.timeline, contentHash({ ...page, tags: current.tags }), page.id, current.revision]));
    await tx.executeRaw("SELECT set_config('gbrain.materializing_revision',$1,true)", [previous[0]?.revision ?? '']);
  });
}
