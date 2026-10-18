// GOOD: a clear is not an assignment.
export async function clear(tx: any): Promise<void> {
  await tx.executeRaw('UPDATE pages SET source_path = NULL WHERE id = $1', [1]);
}
// GOOD: source_path only compared, never assigned.
export async function compare(tx: any): Promise<void> {
  await tx.executeRaw('UPDATE pages SET title=$1 WHERE source_id=$2 AND source_path=$3', ['T', 'default', 'notes/note-example.md']);
}
// GOOD: an insert without an origin.
export async function insert(tx: any): Promise<void> {
  await tx.executeRaw('INSERT INTO pages (source_id, slug) VALUES ($1, $2)', ['default', 'notes/note-example']);
}
// GOOD: a guarded site that keeps its SQL inline, marked.
export async function guarded(tx: any, assertOriginUnclaimed: (tx: any) => Promise<void>): Promise<void> {
  await assertOriginUnclaimed(tx);
  // origin-guard-ok: assertOriginUnclaimed above, in the same transaction
  await tx.executeRaw('UPDATE pages SET source_path=$1 WHERE id=$2', ['notes/note-example.md', 1]);
}
// GOOD: a marked rename (the origin guard ran in the same transaction).
export async function rename(tx: any, assertOriginUnclaimed: (tx: any) => Promise<void>): Promise<void> {
  await assertOriginUnclaimed(tx);
  // origin-guard-ok: assertOriginUnclaimed (rebind) above
  await tx.executeRaw('UPDATE pages SET slug = $1 WHERE slug = $2 AND source_id = $3', ['notes/new-example', 'notes/note-example', 'default']);
}
// GOOD: a slug only compared, never assigned.
export async function seal(tx: any): Promise<void> {
  await tx.executeRaw('UPDATE pages SET chunker_version = $1 WHERE slug = $2', [1, 'notes/note-example']);
}
/** A doc comment naming UPDATE pages SET source_path = $1 is not a statement. */
export const documented = true;
