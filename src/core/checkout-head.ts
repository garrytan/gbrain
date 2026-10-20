/**
 * GBRA-133 2a.4: a checkout's HEAD for the autopilot's HEAD-driven freshness dispatch (commands/autopilot-dispatch.ts).
 * The git directory comes from the checkout's own `.git` entry (a directory, or a worktree/submodule `gitdir:` file),
 * so the probe is one bounded `git rev-parse HEAD` plus a stat per in-progress-operation marker.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileBounded } from './bounded-child-exec.ts';
import { gitChildEnv } from './git-env.ts';
import { GIT_OPERATION_MARKERS } from './git/commit-push.ts';
import { enclosingGitMetadata } from './persistence/root-registry.ts';

/** A checkout's HEAD and whether a rebase, merge, cherry-pick or revert is mid-flight there. Async and bounded; null when git cannot read it. */
export async function readCheckoutHead(root: string): Promise<{ head: string; operation: string | null } | null> {
  const gitDir = enclosingGitMetadata(root);
  if (!gitDir) return null;
  const r = await execFileBounded('git', ['-C', root, 'rev-parse', 'HEAD'], { timeout: 5_000, env: gitChildEnv({ GIT_OPTIONAL_LOCKS: '0' }) });
  const head = r.error ? '' : r.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(head)) return null;
  return { head, operation: GIT_OPERATION_MARKERS.find(marker => existsSync(join(gitDir, marker))) ?? null };
}
