/**
 * Has the upstream been rewritten under this checkout? An automatic publish merges the remote into the local commits
 * and pushes; after a force-push that removed a commit (to purge a page or a secret) the local branch may still hold
 * it, and the merge would bring it back. Before the fetch, upstreamBeforeFetch collects every commit the upstream is
 * recorded at (its reflog, the reflog file's first and last lines, and any record the caller adds); after the fetch,
 * upstreamRewriteReason names a local commit the upstream held then and lacks now, or says there is no record at all.
 * The fetch in between must log ref updates (`-c core.logAllRefUpdates=true`), so the next run has a record.
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

/** Runs git in the checkout; a non-zero exit outside `expected` throws. */
export type GitRead = (args: string[], ...expected: number[]) => Promise<{ stdout: string }>;

export interface UpstreamRecord { held: string[]; recorded: boolean }

const isSha = (sha: string) => /^[0-9a-f]{40,64}$/.test(sha) && !/^0+$/.test(sha);
const lines = (out: string) => out.split('\n').map(sha => sha.trim());

export async function upstreamBeforeFetch(read: GitRead, alsoRecorded: readonly string[] = []): Promise<UpstreamRecord> {
  const upstreamFull = (await read(['rev-parse', '--symbolic-full-name', '@{upstream}'])).stdout.trim();
  const logged = lines((await read(['log', '-g', '-n', '1000', '--format=%H', upstreamFull, '--'], 128)).stdout);
  let reflog = '';
  try {
    const fd = openSync((await read(['rev-parse', '--path-format=absolute', '--git-path', `logs/${upstreamFull}`])).stdout.trim(), 'r');
    try {
      const size = fstatSync(fd).size;
      const first = Buffer.alloc(Math.min(size, 512));
      const tail = Buffer.alloc(Math.min(size, 262_144));
      readSync(fd, first, 0, first.length, 0);
      readSync(fd, tail, 0, tail.length, size - tail.length);
      reflog = `${first.toString('utf8').split('\n')[0]}\n${tail.toString('utf8')}`;
    } finally { closeSync(fd); }
  } catch { /* no reflog file: a reftable repository, or no reflog */ }
  const columns = reflog.split('\n').flatMap(line => line.split(' ').slice(0, 2));
  const recorded = [...logged, ...columns, ...alsoRecorded].filter(isSha);
  const preFetch = (await read(['rev-parse', '--verify', '-q', '@{upstream}^{commit}'], 1)).stdout.trim();
  const unlogged = ['false', 'no', 'off', '0'].includes((await read(['config', '--get', 'core.logAllRefUpdates'], 1)).stdout.trim().toLowerCase());
  return { held: [...new Set([preFetch, ...recorded].filter(isSha))], recorded: recorded.length > 0 || (isSha(preFetch) && !unlogged) };
}

export async function upstreamRewriteReason(read: GitRead, before: UpstreamRecord, upstreamRef: string, targetHead: string, oldHead: string): Promise<string | null> {
  const tips = before.held.filter(sha => sha !== targetHead);
  const held = new Set(tips.length ? lines((await read(['rev-list', '--ignore-missing', `^${targetHead}`, ...tips])).stdout) : []);
  const removed = lines((await read(['rev-list', `${targetHead}..${oldHead}`])).stdout).find(sha => sha && held.has(sha));
  if (removed) return `${upstreamRef} no longer contains ${removed}, which it held before: its history was rewritten (a force-push), and publishing would merge back the commits the rewrite removed.`;
  if (!before.recorded) return `gbrain has no record of what ${upstreamRef} held before this fetch (no reflog entry and no completed refresh), so it cannot tell a force-push from local commits.`;
  return null;
}
