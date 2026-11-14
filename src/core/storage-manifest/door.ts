/**
 * The storage manifest's write door (GST-1943), kept free of heavy imports because the page door imports it: the
 * storage verbs mark the context they write through with a symbol no request parameter can carry, and a source with
 * the storage role refuses every other page writer.
 */
import { opError, type OperationContext } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import type { BrainEngine } from '../engine.ts';

export const STORAGE_SOURCE_ID = 'storage';
export const STORAGE_ROLE = 'storage_manifest';

/** Set by the storage verbs on the context they write through; a symbol, so no request parameter can carry it. */
export const STORAGE_DOOR: unique symbol = Symbol('gbrain.storage_door');
export function storageDoorContext(ctx: OperationContext): OperationContext {
  return Object.assign({ ...ctx }, { [STORAGE_DOOR]: true });
}
export function isStorageDoor(ctx: OperationContext): boolean {
  return (ctx as unknown as Record<symbol, unknown>)[STORAGE_DOOR] === true;
}

/**
 * The page door's check: a source with the storage role takes page writes only from the storage verbs and from the
 * owner's import of commits already in its hosted repository. Everything else is refused with the verb to use.
 */
export function assertStorageSourceWriter(ctx: OperationContext, sourceId: string, role: string | null, opts: { managedFileImport?: boolean }): void {
  if (role !== STORAGE_ROLE || isStorageDoor(ctx) || opts.managedFileImport === true) return;
  throw opError('storage_source_managed', `Source ${sourceId} is the storage manifest; only the storage verbs write it, so nothing was written.`,
    'Register a card with gbrain storage-register, or change one with gbrain storage-update and the card\'s current revision from storage_get.',
    { fix: readFix('Lists the cards on the storage shelf, read-only.', { argv: ['gbrain', 'storage-list', '--json'], mcp: { tool: 'storage_list', arguments: {} } }) });
}


/** Derived writers (dream's phases, enrichment) skip the storage shelf: only the storage verbs change a card. */
export async function isStorageManifestSource(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string): Promise<boolean> {
  return (await engine.executeRaw('SELECT 1 FROM sources WHERE id = $1 AND config->>\'role\' = $2', [sourceId, STORAGE_ROLE])).length > 0;
}
