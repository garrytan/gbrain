import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PHYSICAL_ROOT_MARKER } from '../../src/core/persistence/physical-root-record.ts';

/** Deletes and recreates the directory at the same path: a new inode and birth time, the same bytes. */
export function recreateRoot(root: string, opts: { keepStamp: boolean }): void {
  const stamp = readFileSync(join(root, PHYSICAL_ROOT_MARKER));
  const before = statSync(root, { bigint: true });
  rmSync(root, { recursive: true });
  mkdirSync(join(root, '..', `decoy-${randomUUID().slice(0, 8)}`));
  mkdirSync(root);
  writeFileSync(join(root, 'note.md'), 'Canonical example');
  if (opts.keepStamp) writeFileSync(join(root, PHYSICAL_ROOT_MARKER), stamp, { mode: 0o600 });
  const after = statSync(root, { bigint: true });
  if (after.ino === before.ino && after.birthtimeNs === before.birthtimeNs) throw new Error('fixture: the recreated directory kept its identity');
}

