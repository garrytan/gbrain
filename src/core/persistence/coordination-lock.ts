import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { OperationError } from '../ops/contract.ts';
import { sha256 } from './digest.ts';
import { localHostId, persistenceHome } from './identity.ts';
import { canonicalFilesystemPath } from './root-registry.ts';

function outside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`);
}

/** A copied checkout must never copy the inode that coordinates its writers. */
export function coordinationLockPath(root: string, worktreeId: string): string {
  const canonicalRoot = canonicalFilesystemPath(root);
  const preferred = canonicalFilesystemPath(join(persistenceHome(), 'locks', `${worktreeId}.lock`));
  if (outside(canonicalRoot, preferred)) return preferred;

  const override = process.env.GBRAIN_COORDINATION_HOME?.trim();
  if (override && (!isAbsolute(override) || override.split(/[\\/]/).includes('..'))) {
    throw new OperationError('invalid_params', 'GBRAIN_COORDINATION_HOME must be an absolute path without ".." segments.');
  }
  const home = override || join(homedir(), '.gbrain', 'persistence');
  // Restored database clones can share a worktree id; shared homes can span hosts.
  const namespace = sha256(`${canonicalRoot}\0${localHostId()}`).slice(0, 32);
  const fallback = canonicalFilesystemPath(join(home, 'locks', namespace, `${worktreeId}.lock`));
  if (outside(canonicalRoot, fallback)) return fallback;
  throw new OperationError('storage_error', 'No coordination lock directory lives outside this canonical checkout.',
    'Point GBRAIN_COORDINATION_HOME at a directory outside the source root.');
}
