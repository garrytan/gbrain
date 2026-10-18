import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { markBeliefCommits } from '../belief/append.ts';
import { contentHash } from '../utils.ts';
import { assertInlineBody } from '../page-body/page-shape.ts';
import { assertPageRevision, type PageSnapshot } from './types.ts';
import { withCoordinatedWrite } from '../persistence/context.ts';
import { maintenanceAttribution } from '../persistence/attribution.ts';
import { coverageActive, readLedgerSource, withBeliefBatch } from '../belief/ledger.ts';
import { createPageVersion } from './versions.ts';

/** Persist an effective withdrawal overlay without inventing a second logical edit. */
export async function materializePageSnapshot(engine: BrainEngine, snapshot: PageSnapshot): Promise<void> {
  const sourceId = snapshot.page.source_id;
  const slug = snapshot.page.slug;
  const attribution = await maintenanceAttribution(engine);
  const publicationId = randomUUID();
  const report = { appended: 0 };
  await engine.transaction(async tx => {
    await tx.lockPageKeys([{ sourceId, slug }]);
    const current = await tx.readPageSnapshot(slug, { sourceId, includeDeleted: true });
    assertPageRevision(current, { expectedRevision: snapshot.revision });
    if (!current || current.sourceIncarnation !== snapshot.sourceIncarnation) throw new Error('Page source incarnation changed');
    assertInlineBody(current.page, 'materializePageSnapshot');
    const previous = await tx.executeRaw<{ revision: string | null }>("SELECT current_setting('gbrain.materializing_revision',true) AS revision");
    await tx.executeRaw("SELECT set_config('gbrain.materializing_revision',$1,true)", [current.revision]);
    // Only database-derived canonical bytes may use the bypass. Callers cannot
    // smuggle arbitrary content in the supplied snapshot at an old revision.
    const page = current.page;
    // W1 (docs/designs/BELIEF_LEDGER.md section 10): the body this rewrite replaces stays readable at its revision, and the ledger records the view change.
    const ledger = await readLedgerSource(tx, sourceId);
    const stored = ledger && coverageActive(ledger.coverage)
      ? (await tx.executeRaw<{ content_hash: string | null }>('SELECT content_hash FROM pages WHERE id=$1', [page.id]))[0]?.content_hash : undefined;
    const hash = contentHash({ ...page, tags: current.tags });
    if (stored !== undefined && stored !== hash) await createPageVersion(tx, slug, sourceId, current);
    await withCoordinatedWrite(tx, [sourceId], () => withBeliefBatch(tx, { sourceId, slugs: [slug], publicationId, op: 'withdrawal_materialize', pageEventType: 'page.view_changed', report },
      () => tx.executeRaw(`UPDATE pages SET compiled_truth=$1,timeline=$2,content_hash=$3
      WHERE id=$4 AND knowledge_revision=$5::uuid`,
    [page.compiled_truth, page.timeline, hash, page.id, current.revision])), attribution);
    await tx.executeRaw("SELECT set_config('gbrain.materializing_revision',$1,true)", [previous[0]?.revision ?? '']);
  });
  if (report.appended) await markBeliefCommits(engine, [publicationId]).catch(() => undefined);
}
