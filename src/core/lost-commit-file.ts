import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

/**
 * Puts back a file that a transaction callback published before a commit the database then lost. The multi-user Rust
 * engine runs the callback again after a commit lost on write_conflict (design interface I-1), and the rerun must find the
 * bytes the first run found, or its own file check refuses the write as an outside edit while the file keeps a change the
 * database rolled back. Only a file that still holds `published` is put back: an edit made since then is kept, and the
 * rerun's check reports it; returns whether it put the file back. `before` null: the file did not exist. `staged`: the temporary file the publish renamed from,
 * written again so the rerun can rename it.
 */
export function restoreLostPublication(path: string, published: string, before: string | null, staged?: { path: string; body: string }): boolean {
  if ((existsSync(path) ? readFileSync(path, 'utf-8') : null) !== published) return false;
  if (staged) writeFileSync(staged.path, staged.body, 'utf-8');
  if (before === null) rmSync(path, { force: true });
  else {
    // A sibling file renamed over the target, as the publish did, so a crash leaves either version whole.
    const restore = `${path}.restore-${randomUUID()}`;
    writeFileSync(restore, before, 'utf-8');
    renameSync(restore, path);
  }
  return true;
}
