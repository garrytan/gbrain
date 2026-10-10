import type { BrainEngine } from '../engine.ts';
import { opError, type OperationContext } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { assertPersistenceAccepting } from './service.ts';
import { authorizeWrite, submissionAuthority } from './authority.ts';
import { managedPersistenceEnabled } from './ownership.ts';
import { initializeLocalPersistence } from './page-mutations.ts';
import { withCoordinatedWrite } from './context.ts';
import { principalAttribution } from './attribution.ts';
import type { WriteTrust } from '../trust/tier.ts';

/**
 * A coordinated, database-only write on a managed brain: rows with no
 * canonical file (manual links, ontology observations) and no receipt. The
 * caller's durable write authority is checked for `authoritySlug`, then
 * `write` runs inside a source-scoped coordinated transaction that revalidates
 * the source incarnation and holds every `lockSlugs` page key, so it
 * serializes with publications of those pages. Returns null on an unmanaged
 * brain; the caller keeps its legacy path.
 */
export async function coordinatedDatabaseWrite<T>(ctx: OperationContext, operation: string, authoritySlug: string,
  lockSlugs: readonly string[], write: (engine: BrainEngine, sourceId: string) => Promise<T>, trust?: WriteTrust): Promise<{ value: T } | null> {
  if (!await managedPersistenceEnabled(ctx.engine)) return null;
  assertPersistenceAccepting(ctx.engine);
  const sourceId = ctx.sourceId ?? 'default';
  const [source] = await ctx.engine.executeRaw<{ incarnation: string; archived: boolean }>(
    'SELECT incarnation,archived FROM sources WHERE id=$1', [sourceId]);
  if (!source || source.archived) {
    throw opError('source_changed', 'The write source is not active.',
      `Source ${sourceId} is archived or missing, so nothing was written. Write to an active source, or ask the user to restore ${sourceId}.`,
      { fix: readFix('Lists sources with their archived state, read-only.', { argv: ['gbrain', 'sources', 'list', '--json'], mcp: { tool: 'sources_list', arguments: {} } }) });
  }
  await initializeLocalPersistence(ctx);
  const authority = await submissionAuthority(ctx, operation, sourceId, source.incarnation, authoritySlug);
  const value = await ctx.engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], async () => {
    const [current] = await tx.executeRaw<{ incarnation: string; archived: boolean }>(
      'SELECT incarnation,archived FROM sources WHERE id=$1 FOR SHARE', [sourceId]);
    if (!current || current.archived || current.incarnation !== source.incarnation) {
      throw opError('source_changed', 'The write source changed before the write.',
        `Source ${sourceId} was archived or recreated before this ${operation} committed, so it rolled back and nothing was written. Check the source, then submit the write again against its current registration.`,
        { fix: readFix('Lists sources with their archived state, read-only.', { argv: ['gbrain', 'sources', 'list', '--json'], mcp: { tool: 'sources_list', arguments: {} } }) });
    }
    await authorizeWrite(tx, authority, operation, authoritySlug, true);
    await tx.lockPageKeys(lockSlugs.map(slug => ({ sourceId, slug })));
    return write(tx, sourceId);
  }, { ...principalAttribution(authority.principal), ...(trust ? { trust } : {}) }));
  return { value };
}
