/**
 * Folder-rule policy reads (access/open-pages.ts): one SQL implementation for both engines. Each statement is the text
 * its caller ran through `executeRaw`, byte for byte (test/engine-sql-caller-raw-sql-pins.test.ts). Every member runs
 * on the executor it is given, so a member of a transaction-bound engine runs on that transaction.
 */

/** The engine's own executeRaw (a transaction-bound engine inside a transaction). */
export interface AccessPolicyExec {
  executeRaw<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]>;
}

export const STATE_UNREADABLE_SQL = 'SELECT gbrain_access_state_unreadable() AS unreadable';

/** Whether row-level security keeps this database role from reading the folder access tables. */
export async function readAccessStateUnreadable(exec: AccessPolicyExec): Promise<boolean> {
  const [row] = await exec.executeRaw<{ unreadable: boolean }>(STATE_UNREADABLE_SQL);
  return row?.unreadable === true;
}
