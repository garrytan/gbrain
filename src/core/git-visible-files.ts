import { execFileSync } from 'child_process';
import { lstatSync } from 'fs';
import { join } from 'path';

/**
 * Return files visible to git from `dir`, respecting .gitignore,
 * .git/info/exclude, and global git excludes. Returns null when `dir` is not
 * inside a git work tree or git is unavailable, so callers can keep their
 * existing filesystem-walk fallback.
 */
export function collectGitVisibleFiles(
  dir: string,
  acceptRelPath: (relPath: string) => boolean,
): string[] | null {
  let stdout: string;
  try {
    stdout = execFileSync(
      'git',
      ['-C', dir, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch {
    return null;
  }

  const ignoredTracked = new Set<string>();
  try {
    const ignoredStdout = execFileSync(
      'git',
      ['-C', dir, 'ls-files', '-ci', '--exclude-standard', '-z'],
      { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    for (const rel of ignoredStdout.split('\0')) {
      if (rel) ignoredTracked.add(rel);
    }
  } catch {
    // Best effort: older Git or unusual worktrees still get the standard list.
  }

  const files: string[] = [];
  for (const rel of stdout.split('\0')) {
    if (!rel) continue;
    if (ignoredTracked.has(rel)) continue;
    const normalizedRel = rel.replace(/\\/g, '/');
    if (!acceptRelPath(normalizedRel)) continue;

    const full = join(dir, rel);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink() || !st.isFile()) continue;
    files.push(full);
  }

  return files.sort();
}
