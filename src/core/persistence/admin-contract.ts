/** Local administration is deliberately absent from the public operation registry. */
/** Reserved brain-level config key set only by `gbrain sources writer lock|unlock`; generic config writes refuse it. */
export const WRITER_ADMIN_LOCK_KEY = 'persistence.writer_admin_lock';
export const PERSISTENCE_ADMIN_OPERATIONS = [
  'writer_status', 'writer_sync', 'writer_refresh', 'writer_extract_stale', 'writer_reindex_code', 'writer_retry_effects', 'writer_embed_facts', 'writer_claim', 'writer_activate', 'writer_transfer_prepare', 'writer_transfer_accept',
  'writer_deactivate', 'writer_lock', 'writer_unlock', 'writer_git_durability',
  'local_writer_list', 'local_writer_register', 'local_writer_revoke',
  'source_lifecycle', 'source_add', 'company_brain_preview', 'company_brain_connect', 'company_brain_resume',
  'writer_reconcile_preview', 'writer_reconcile_apply', 'writer_reconcile_audit', 'writer_reconcile_backups',
  // #5575 DX-2/ENG-15: owner trust actions while a resident serve holds the brain (trust/owner-ipc.ts).
  'trust_read', 'trust_preview', 'trust_apply',
] as const;
/**
 * #6650: administration added after the capability list froze. A client validates every entry of a resident owner's
 * `administration` list against its own known set and drops the owner when one is unknown, so a new operation is never
 * added there: the owner advertises it in `administration_extensions`, which older clients ignore, and a client calls
 * one only when the owner lists it.
 */
export const PERSISTENCE_ADMIN_EXTENSIONS = ['writer_failures', 'writer_transfer_cancel'] as const;
export type PersistenceAdminExtension = typeof PERSISTENCE_ADMIN_EXTENSIONS[number];
export type PersistenceAdminOperation = typeof PERSISTENCE_ADMIN_OPERATIONS[number] | PersistenceAdminExtension;
export function isPersistenceAdminOperation(value: unknown): value is PersistenceAdminOperation {
  return typeof value === 'string' && ((PERSISTENCE_ADMIN_OPERATIONS as readonly string[]).includes(value) || (PERSISTENCE_ADMIN_EXTENSIONS as readonly string[]).includes(value));
}
export function isPersistenceAdminExtension(value: unknown): value is PersistenceAdminExtension {
  return typeof value === 'string' && (PERSISTENCE_ADMIN_EXTENSIONS as readonly string[]).includes(value);
}
