/**
 * Git first-commit dates as the creation anchor for undated files (A12).
 *
 * A fresh clone stamps every file with the clone time, so an undated note in
 * a ten-year-old vault got today's date as its effective-date fallback. One
 * `git log --diff-filter=A` pass per import run maps each path to the date its
 * oldest adding commit was authored. Opt-in (`sync.git_first_commit_dates`)
 * because effective_date feeds recency-intent ranking and since/until
 * filters. Shallow clones and git failures return null: the file timestamps
 * stay the fallback.
 */

import { execFileSync } from 'child_process';
import { realpathSync } from 'fs';
import { relative } from 'path';

export interface GitFirstCommitDates {
  /** The first-commit date for a file under the repo, if git recorded one. */
  get(filePath: string): Date | undefined;
}

export function gitFirstCommitDates(dir: string): GitFirstCommitDates | null {
  try {
    const git = (args: string[], cwd: string) => execFileSync('git', ['-C', cwd, ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024, timeout: 120_000 });
    const top = git(['rev-parse', '--show-toplevel'], dir).trim();
    if (git(['rev-parse', '--is-shallow-repository'], top).trim() === 'true') return null;
    const dates = new Map<string, Date>();
    // Newest first, so the oldest adding commit is written last and wins.
    for (const entry of git(['-c', 'core.quotePath=false', 'log', '--diff-filter=A', '--no-renames', '--format=%x00%at', '--name-only'], top).split('\0')) {
      const [stamp, ...paths] = entry.split('\n');
      const at = new Date(Number(stamp) * 1000);
      if (!Number.isFinite(at.getTime())) continue;
      for (const path of paths) if (path) dates.set(path, at);
    }
    return { get: filePath => { try { return dates.get(relative(top, realpathSync(filePath)).replace(/\\/g, '/')); } catch { return undefined; } } };
  } catch {
    return null;
  }
}
