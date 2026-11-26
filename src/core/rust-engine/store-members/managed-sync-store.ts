/**
 * The managed sync's named statements (BrainEngine `runSyncStatement`; the text PGLite and Postgres run is in
 * engine-sql/managed-sync-store.ts), served from the store's source, page, request, effect, config and checkpoint records
 * (gbrain-store `persistence::managed_sync_store`).
 *
 * Each statement is one `syncStoreRows(name, params)` call (a read) or one `syncStoreWrite(name, params)` call (a write), with the rows
 * the SQL returns. The row locks the SQL takes become stated guarantees (the module doc of managed_sync_store.rs): an explicit
 * transaction is Serialized (it holds the store's writer, so no other commit interleaves with what it read), and under optimistic
 * transactions the rows read are in the transaction's read set, so a racing change aborts the commit with `write_conflict`.
 */
import { SYNC_STATEMENTS, type SyncStatementName, type SyncStatementOptions } from '../../engine-sql/managed-sync-store.ts';
import type { RustEngine } from '../../rust-engine.ts';
import type { StoreBrain } from '../store.ts';
import { storeCall } from './common.ts';
import { heldRefusal, managedServed } from './managed-hold.ts';
import { EARLIER_PAGE_REFUSAL_MESSAGE, LEGACY_KNOCK_ON_CANCEL_MESSAGES, LEGACY_KNOCK_ON_CANCEL_PATTERNS, SYNC_KNOCK_ON_ORIGIN } from '../../persistence/sync-knock-on.ts';

/** The strings the SQL of a statement splices from TypeScript constants: `knock_on_requests` is `syncKnockOnSql('r')` (its text is written out in the statement table). */
function statementExtras(name: SyncStatementName): unknown[] {
  return name === 'knock_on_requests' ? [{ syncKnockOnOrigin: SYNC_KNOCK_ON_ORIGIN, legacyCancelMessages: [...LEGACY_KNOCK_ON_CANCEL_MESSAGES],
    legacyCancelPatterns: [...LEGACY_KNOCK_ON_CANCEL_PATTERNS], earlierPageRefusal: EARLIER_PAGE_REFUSAL_MESSAGE }] : [];
}
import { requestRow } from '../store-codec.ts';
import { PAGE_REMOVAL_OPERATIONS } from '../../persistence/terminal-constants.ts';

/** The statements that answer `SELECT *` of a request: the rows read as the engine's request rows (dates as `Date`). */
const REQUEST_ROW_STATEMENTS: ReadonlySet<SyncStatementName> = new Set(['cursor_open_requests', 'request_for_update']);
/** The values the SQL text of a statement inlines that the store reads as a trailing parameter (the page-removal operations of `supersessionSql`). */
const INLINED_TEXT: Partial<Record<SyncStatementName, readonly unknown[]>> = { refused_checkpoint: [[...PAGE_REMOVAL_OPERATIONS]] };

/** While the managed hold is on (a user's Rust brain) the statement refuses as the `executeRaw` it replaced did (managed-hold.ts). */
export const runSyncStatement = async function runSyncStatement(this: RustEngine, brain: StoreBrain, name: SyncStatementName, params: readonly unknown[] = [], _opts?: SyncStatementOptions): Promise<unknown[]> {
  if (!managedServed(this)) return heldRefusal(this);
  const bound = [...params, ...INLINED_TEXT[name] ?? [], ...statementExtras(name)];
  const rows = await storeCall({ member: 'runSyncStatement' }, () =>
    (SYNC_STATEMENTS[name].kind === 'write' ? brain.syncStoreWrite(name, bound) : brain.syncStoreRows(name, bound)) as Promise<unknown[]>);
  return REQUEST_ROW_STATEMENTS.has(name) ? rows.map(row => requestRow<object>(row)) : rows;
};
