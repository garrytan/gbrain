import type { BrainEngine } from '../engine.ts';
import type { OperationContext } from '../ops/contract.ts';
import { coordinatedDatabaseWrite } from './database-write.ts';

/**
 * `add_link` / `remove_link` on a managed brain (#5280): a coordinated,
 * database-only write, like derived links. Manual edges live only in the
 * database, so there is no canonical file to write and no receipt to keep.
 * The caller's durable write authority is checked for the `from` page, then the
 * edge commits inside a source-scoped coordinated transaction that holds both
 * endpoint page keys, so it serializes with publications of either page.
 * Returns null on an unmanaged brain; the caller keeps its legacy path.
 */
export async function coordinatedManualLinkWrite<T>(ctx: OperationContext, operation: 'add_link' | 'remove_link',
  from: string, to: string, write: (engine: BrainEngine, sourceId: string) => Promise<T>): Promise<{ value: T } | null> {
  return coordinatedDatabaseWrite(ctx, operation, from, [from, to], write);
}
