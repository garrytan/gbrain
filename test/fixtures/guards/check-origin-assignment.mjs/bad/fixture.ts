// BAD: a raw origin assignment, no guard.
export async function assign(tx: any): Promise<void> {
  await tx.executeRaw('UPDATE pages SET source_path=$3 WHERE source_id=$1 AND slug=$2', ['default', 'notes/note-example', 'notes/note-example.md']);
}
// BAD: an insert that carries an origin.
export async function insert(tx: any): Promise<void> {
  await tx.executeRaw(`INSERT INTO pages (source_id, slug, source_path) VALUES ($1, $2, $3)`, ['default', 'notes/note-example', 'notes/note-example.md']);
}
// BAD: an aliased multi-column SET that also assigns the origin.
export async function aliased(tx: any): Promise<void> {
  await tx.executeRaw(`UPDATE pages p SET title = $1,
    source_path = COALESCE($2::text, p.source_path) WHERE p.id = $3`, ['T', 'notes/note-example.md', 1]);
}
// BAD: a slug rename that carries the page's origin to a new identity unguarded.
export async function rename(tx: any): Promise<void> {
  await tx.executeRaw('UPDATE pages SET slug = $1, updated_at = now() WHERE slug = $2 AND source_id = $3', ['notes/new-example', 'notes/note-example', 'default']);
}
