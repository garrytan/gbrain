/**
 * BrainEngine members that return a store object whose async methods run on the engine (or the transaction) they
 * came from. A served client gets a proxy for each (served/engine.ts): a method call crosses as `<member>.<method>`
 * inside a transaction, or as the whole operation `servedStoreCall` (owner-ops.ts) on the engine itself.
 */
export const STORE_RETURNING_MEMBERS: ReadonlySet<string> = new Set([
  'worktreeClaimStore', 'writerAdminStore', 'writerReleaseStore', 'publicationJournalStore', 'chronicleStore',
]);
export const SERVED_STORE_CALL = 'servedStoreCall';
