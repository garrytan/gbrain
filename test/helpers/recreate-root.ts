import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PHYSICAL_ROOT_MARKER } from '../../src/core/persistence/physical-root-record.ts';

/** Deletes and recreates the directory at the same path: a new inode and birth time, the same bytes. */
export function recreateRoot(root: string, opts: { keepStamp: boolean }): void {
  const stamp = readFileSync(join(root, PHYSICAL_ROOT_MARKER));
  const before = statSync(root, { bigint: true });
  rmSync(root, { recursive: true });
  // ext4 and XFS hand a freed inode straight back to the next mkdir, so take
  // decoys until the recreated root gets a different one (the tests compare
  // the reservation's recorded inode with the live directory).
  for (let attempt = 0; attempt < 64; attempt++) {
    mkdirSync(join(root, '..', `decoy-${randomUUID().slice(0, 8)}`));
    mkdirSync(root);
    if (statSync(root, { bigint: true }).ino !== before.ino) break;
    rmSync(root, { recursive: true });
  }
  writeFileSync(join(root, 'note.md'), 'Canonical example');
  if (opts.keepStamp) writeFileSync(join(root, PHYSICAL_ROOT_MARKER), stamp, { mode: 0o600 });
  const after = statSync(root, { bigint: true });
  if (after.ino === before.ino) throw new Error('fixture: the recreated directory kept its inode after 64 decoys');
}

