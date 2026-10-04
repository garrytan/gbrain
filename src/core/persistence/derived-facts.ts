import type { BrainEngine, NewFact } from '../engine.ts';
import type { Action } from '../agent-output.ts';
import { opError } from '../ops/contract.ts';
import { readFix, trustedCliRequired } from '../ops/op-fix.ts';
import { currentSubmissionAuthority } from '../minions/submission-authority.ts';
import { withCoordinatedWrite } from './context.ts';
import { maintenanceAttribution } from './attribution.ts';
import { currentVerifiedLocalWriter } from './identity.ts';
import { managedPersistenceEnabled } from './ownership.ts';
import { assertPersistenceAccepting } from './service.ts';

const sourcesFix = (sourceId: string): Action => readFix(`Lists sources with their archived state, including ${sourceId}.`, { argv: ['gbrain', 'sources', 'list', '--json'] });

/**
 * Database-only fact rows derived from page text (the fence reconcile, the
 * conversation fact index) never touch a canonical file, so a managed brain
 * publishes them like derived links: inside the coordinator's source
 * capability, serialized on the page key. Returns false on an unmanaged brain.
 * Runs before any provider spend.
 */
export async function managedDerivedFactsPreflight(engine: BrainEngine, sourceId: string): Promise<boolean> {
  if (!await managedPersistenceEnabled(engine)) return false;
  assertPersistenceAccepting(engine);
  const job = currentSubmissionAuthority();
  if (job && job.kind !== 'application' || currentVerifiedLocalWriter()?.remote) {
    throw trustedCliRequired('Managed fact maintenance requires a local writer; remote maintenance jobs are not supported.');
  }
  const [source] = await engine.executeRaw<{ archived: boolean }>('SELECT archived FROM sources WHERE id=$1', [sourceId]);
  if (!source || source.archived) {
    throw opError('source_changed', 'The fact maintenance source is not active.',
      `Source ${sourceId} is archived or missing, so its facts were not maintained and no model was called. Restore the source first if it should be maintained.`,
      { fix: sourcesFix(sourceId) });
  }
  return true;
}

/**
 * One committed transaction holding the source capability and the page keys,
 * after revalidating (under a shared source lock, before the page locks) that
 * the source is still active: model work may have outlived an archive.
 */
export async function withDerivedFactsWrite<T>(engine: BrainEngine, sourceId: string, slugs: readonly string[],
  fn: (tx: BrainEngine) => Promise<T>): Promise<T> {
  const attribution = await maintenanceAttribution(engine);
  return engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], async () => {
    const [source] = await tx.executeRaw<{ archived: boolean }>('SELECT archived FROM sources WHERE id=$1 FOR SHARE', [sourceId]);
    if (!source || source.archived) {
      throw opError('source_changed', 'The fact maintenance source changed during extraction; nothing was written.',
        `Source ${sourceId} was archived or removed while its facts were extracted, so nothing was written. Restore the source before maintaining its facts again.`,
        { fix: sourcesFix(sourceId) });
    }
    await tx.lockPageKeys(slugs.map(slug => ({ sourceId, slug })));
    return fn(tx);
  }, attribution));
}

/**
 * Legacy writers keep their own engine call on unmanaged brains. On a managed
 * brain the page must still be live under its lock, so rows are never
 * published for a page deleted or purged while the model ran.
 */
export async function writeDerivedFacts<T>(engine: BrainEngine, sourceId: string, slug: string,
  fn: (db: BrainEngine) => Promise<T>): Promise<T> {
  if (!await managedPersistenceEnabled(engine)) return fn(engine);
  return withDerivedFactsWrite(engine, sourceId, [slug], async tx => {
    const [page] = await tx.executeRaw('SELECT id FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [sourceId, slug]);
    if (!page) {
      throw opError('page_not_found', 'The page was deleted during fact extraction; nothing was written.',
        `Page ${slug} in source ${sourceId} was deleted while its facts were extracted, so nothing was written. No action is needed unless the page should still exist.`);
    }
    return fn(tx);
  });
}

/**
 * Managed replacement of one page's derived fact batch. Nothing is written
 * while the model runs; afterwards, under the source capability and page key,
 * `isCurrent` rechecks the page the batch was extracted from, then the rows
 * whose `source` starts with `sourcePrefix` are deleted and `build(tx)`'s rows
 * inserted in the same transaction. A failed extraction or a changed page
 * leaves the prior batch in place.
 */
export async function replaceDerivedFactsForPage(engine: BrainEngine, sourceId: string, slug: string, input: {
  sourcePrefix: string;
  isCurrent: (tx: BrainEngine) => Promise<boolean>;
  build: (tx: BrainEngine) => Promise<Array<NewFact & { row_num: number; source_markdown_slug: string }>>;
}): Promise<{ deleted: number; inserted: number }> {
  return withDerivedFactsWrite(engine, sourceId, [slug], async tx => {
    if (!await input.isCurrent(tx)) {
      throw opError('revision_conflict', 'The page changed during fact extraction; its prior facts were kept.',
        `Page ${slug} in source ${sourceId} changed while its facts were extracted, so its prior facts were kept. The next fact maintenance pass extracts from the current page.`);
    }
    const [deleted] = await tx.executeRaw<{ count: string }>(
      `WITH del AS (DELETE FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND source LIKE $3 RETURNING 1)
       SELECT COUNT(*)::text AS count FROM del`, [sourceId, slug, `${input.sourcePrefix}%`]);
    const rows = await input.build(tx);
    const { inserted } = rows.length ? await tx.insertFacts(rows, { source_id: sourceId }) : { inserted: 0 }; // gbrain-allow-direct-insert: managed replacement of a page's derived fact batch inside the coordinator transaction that deleted the prior batch
    return { deleted: Number(deleted?.count ?? 0), inserted };
  });
}
