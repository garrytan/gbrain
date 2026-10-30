/**
 * The link check for a linked Git worktree (G7b-2; GBRA-133's review of the hosted layout). A linked worktree reaches its
 * repository through a `.git` file naming an entry under the repository's `worktrees/`, and that entry's `gitdir` file
 * names the worktree back. `git worktree prune` deletes an entry whose worktree it cannot see, and a checkout moved to
 * another path leaves the entry naming the old one, so the next prune deletes it. Either way a canonical worktree would
 * commit through a link that is gone or about to go, so a claim refuses it with `git_worktree_link_broken`.
 * A submodule's `.git` file names a module directory with no back link; only its existence is checked.
 */
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { opError } from '../ops/contract.ts';

const real = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };

/** Why the nearest `.git` at or above `root` is a broken worktree link, or null when it is intact or not a link. */
export function linkedWorktreeProblem(root: string): string | null {
  for (let dir = root; ; dir = dirname(dir)) {
    const marker = join(dir, '.git');
    let isFile: boolean;
    try { isFile = lstatSync(marker).isFile(); } catch { if (dir === dirname(dir)) return null; continue; }
    if (!isFile) return null;
    const named = /^gitdir:\s*(.+)$/m.exec(readFileSync(marker, 'utf8'))?.[1]?.trim();
    if (!named) return `${marker} names no repository entry`;
    const entry = resolve(dir, named);
    if (!existsSync(entry)) return `the repository entry ${entry} that ${marker} names is gone (git worktree prune removes the entry of a worktree it cannot see)`;
    if (!existsSync(join(entry, 'commondir'))) return null;
    let back: string;
    try { back = readFileSync(join(entry, 'gitdir'), 'utf8').trim(); } catch { return `the repository entry ${entry} has no gitdir file naming its worktree`; }
    if (real(resolve(entry, back)) !== real(marker)) return `the repository entry ${entry} names ${back}, not ${marker} (the checkout moved)`;
    return null;
  }
}

export function assertLinkedWorktreeIntact(root: string): void {
  const problem = linkedWorktreeProblem(root);
  if (!problem) return;
  throw opError('git_worktree_link_broken', `${root} is a linked Git worktree whose link to its repository is broken: ${problem}.`,
    `Nothing was claimed. From the repository, run git worktree repair ${root} when both still exist, or add the worktree again with git worktree add, then rerun.`);
}
