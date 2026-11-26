/**
 * The registry operations a client of a Rust brain's owner sends whole (whole-op.ts forwardOwnerOperation). A module of
 * names only, so the registry loader (operation-load.ts) can tell which handlers to route without loading the owner
 * socket code.
 */

/** Sent whole whenever the owner reports persistence_journal. */
export const OWNER_FORWARDED_OPERATIONS: ReadonlySet<string> = new Set(['put_page']);

/**
 * Multi-user mode only: more registry writes a client sends whole, because their handlers open a transaction (the
 * write journal's admission) that cannot run from a second process. The owner runs each with its own handler, in its
 * own transaction; a trusted local caller only (the same rule as put_page). Off, these run in process as before.
 * Uploads, batches and file paths stay out (append_page, capture, put_pages): their arguments are not plain values.
 */
export const MULTIUSER_FORWARDED_OPERATIONS: ReadonlySet<string> = new Set([
  'add_tag', 'remove_tag', 'add_timeline_entry', 'add_link', 'remove_link', 'remember', 'forget',
  'delete_page', 'restore_page', 'revert_version', 'edit_page',
  'takes_add', 'takes_update', 'takes_supersede', 'takes_resolve', 'takes_remove',
]);

/** True when a client may send registry operation `name` whole (`multiuser`: this brain runs in multi-user mode). */
export function forwardsWhole(name: string, multiuser: boolean): boolean {
  return OWNER_FORWARDED_OPERATIONS.has(name) || (multiuser && MULTIUSER_FORWARDED_OPERATIONS.has(name));
}
