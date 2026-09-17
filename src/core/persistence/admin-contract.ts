/** Local administration is deliberately absent from the public operation registry. */
export const PERSISTENCE_ADMIN_OPERATIONS = [
  'writer_status', 'writer_sync', 'writer_claim', 'writer_activate', 'writer_transfer_prepare', 'writer_transfer_accept',
  'local_writer_list', 'local_writer_register', 'local_writer_revoke',
  'source_lifecycle', 'source_add',
] as const;
export type PersistenceAdminOperation = typeof PERSISTENCE_ADMIN_OPERATIONS[number];
export function isPersistenceAdminOperation(value: unknown): value is PersistenceAdminOperation {
  return typeof value === 'string' && (PERSISTENCE_ADMIN_OPERATIONS as readonly string[]).includes(value);
}
