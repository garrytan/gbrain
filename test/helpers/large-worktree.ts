import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Writes `count` small Markdown files under `root` with realistic path lengths,
 * so a per-file manifest map passes the 1 MiB metadata bound near 10k files.
 * Returns the total content bytes written.
 */
export function writeLargeWorktree(root: string, count: number): number {
  let bytes = 0;
  for (let i = 0; i < count; i++) {
    const dir = join(root, 'notes', `batch-${String(Math.floor(i / 500)).padStart(3, '0')}`);
    if (i % 500 === 0) mkdirSync(dir, { recursive: true });
    const body = `---\ntitle: Example ${i}\ntype: note\n---\n\nGeneric example body ${i}.\n`;
    writeFileSync(join(dir, `example-note-${String(i).padStart(6, '0')}.md`), body);
    bytes += Buffer.byteLength(body);
  }
  return bytes;
}

/**
 * Commits `root` as a fixture repository. Automatic gc and maintenance are off in the repository's own
 * config: a commit of ~7k+ loose objects otherwise starts a detached `git gc --auto` that packs and prunes
 * them while the test clones, reads or deletes the repository (a local clone then dies with
 * "failed to copy file ... No such file or directory"). Git's stderr is kept for the thrown error.
 */
export function commitFixtureRepository(root: string): void {
  const git = (args: string[]) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
  git(['init', '--quiet']);
  git(['config', 'gc.auto', '0']);
  git(['config', 'maintenance.auto', 'false']);
  git(['add', '-A']);
  git(['commit', '--quiet', '-m', 'fixture']);
}

/** Commits a large worktree and returns a local bare repository cloned from it. */
export function largeBareRepository(directory: string, count: number): string {
  const work = join(directory, 'bare-work'), bare = join(directory, 'large.git');
  mkdirSync(work, { recursive: true });
  writeLargeWorktree(work, count);
  commitFixtureRepository(work);
  execFileSync('git', ['clone', '--quiet', '--bare', work, bare], { cwd: directory, stdio: ['ignore', 'ignore', 'pipe'] });
  return bare;
}
