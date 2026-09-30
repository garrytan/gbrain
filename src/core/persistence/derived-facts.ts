import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { currentSubmissionAuthority } from '../minions/submission-authority.ts';
import { withCoordinatedWrite } from './context.ts';
import { currentVerifiedLocalWriter } from './identity.ts';
import { managedPersistenceEnabled } from './ownership.ts';
import { assertPersistenceAccepting } from './service.ts';

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
    throw new OperationError('permission_denied', 'Managed fact maintenance requires a local writer; remote maintenance jobs are not supported.');
  }
  const [source] = await engine.executeRaw<{ archived: boolean }>('SELECT archived FROM sources WHERE id=$1', [sourceId]);
  if (!source || source.archived) throw new OperationError('source_changed', 'The fact maintenance source is not active.');
  return true;
}

/**
 * One committed transaction holding the source capability and the page keys,
 * after revalidating (under a shared source lock, before the page locks) that
 * the source is still active: model work may have outlived an archive.
 */
export async function withDerivedFactsWrite<T>(engine: BrainEngine, sourceId: string, slugs: readonly string[],
  fn: (tx: BrainEngine) => Promise<T>): Promise<T> {
  return engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], async () => {
    const [source] = await tx.executeRaw<{ archived: boolean }>('SELECT archived FROM sources WHERE id=$1 FOR SHARE', [sourceId]);
    if (!source || source.archived) throw new OperationError('source_changed', 'The fact maintenance source changed during extraction; nothing was written.');
    await tx.lockPageKeys(slugs.map(slug => ({ sourceId, slug })));
    return fn(tx);
  }));
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
    if (!page) throw new OperationError('page_not_found', 'The page was deleted during fact extraction; nothing was written.');
    return fn(tx);
  });
}
