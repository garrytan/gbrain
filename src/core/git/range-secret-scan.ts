/**
 * Secret scan over the commits an automatic publish pushes. A commit gbrain did not write (a script's plain
 * `git commit`) never passed the write path's scan, so the publish scans, under its publish lock and for the exact
 * commit it pushes, what each commit in `base..head` adds: its message, the lines it adds file by file (a value a later
 * commit removed is still in the pushed history), and for a merge commit the lines it adds that neither parent has
 * (a conflict resolution). The workspace allowlist (`.gbrain-scan-allow`: path globs and fingerprints) applies.
 * Findings carry the path, line, rule, fingerprint and commit, never the matched value. Binary changes carry no lines;
 * a file whose added text is over the scan cap cannot be scanned and is reported as such, so callers refuse.
 */
import { loadWorkspaceAllowlist, pathAllowlisted } from '../secret-scan-allowlist.ts';
import { scanText, SCAN_MAX_FILE_BYTES } from '../secret-scan.ts';

export interface RangeSecretFinding { path: string; commit: string; line: number; pattern: string; fingerprint: string }
export interface RangeScan { findings: RangeSecretFinding[]; unscanned: Array<{ path: string; commit: string }> }

/** The `git log` arguments whose output findingsInLog reads. */
export function rangeScanArgs(base: string, head: string): string[] {
  return ['-c', 'core.quotePath=false', 'log', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-color', '--diff-merges=dense-combined',
    '--unified=0', '-p', '--format=commit %H%n%B%n%x00', `${base}..${head}`, '--'];
}

/** The commit message as `path` in a finding. */
export const MESSAGE_PATH = '(commit message)';

export function findingsInLog(root: string, log: string): RangeScan {
  const allowlist = loadWorkspaceAllowlist(root);
  const scan: RangeScan = { findings: [], unscanned: [] };
  let commit = '', path: string | null = null, next = 0, combined = false, inMessage = false;
  let added: string[] = [], at: number[] = [];
  const flush = () => {
    if (path && added.length && (path === MESSAGE_PATH || !pathAllowlisted(path, allowlist))) {
      const text = added.join('\n');
      if (Buffer.byteLength(text) > SCAN_MAX_FILE_BYTES) scan.unscanned.push({ path, commit });
      else for (const f of scanText(text, { allowlist })) scan.findings.push({ path, commit, line: at[f.line - 1] ?? f.line, pattern: f.pattern, fingerprint: f.fingerprint });
    }
    added = []; at = [];
  };
  for (const line of log.split('\n')) {
    if (inMessage) {
      if (line === '\0') { flush(); inMessage = false; path = null; continue; }
      added.push(line); at.push(added.length);
      continue;
    }
    if (line.startsWith('commit ') && /^commit [0-9a-f]{40,64}$/.test(line)) { flush(); commit = line.slice(7); path = MESSAGE_PATH; inMessage = true; continue; }
    if (line.startsWith('diff --git ') || line.startsWith('diff --cc ') || line.startsWith('diff --combined ')) { flush(); path = null; combined = !line.startsWith('diff --git '); continue; }
    if (line.startsWith('+++ ')) { path = line === '+++ /dev/null' ? null : line.slice(4).replace(/^"?b\//, '').replace(/"$/, ''); continue; }
    const hunk = /^@@@? -\d+(?:,\d+)? (?:-\d+(?:,\d+)? )?\+(\d+)(?:,\d+)? @@@?/.exec(line);
    if (hunk) { next = Number(hunk[1]); continue; }
    if (!path) continue;
    if (combined) {
      const prefix = line.slice(0, 2);
      if (prefix.includes('-') || prefix.length < 2) continue;
      if (prefix === '++') { added.push(line.slice(2)); at.push(next); }
      next++;
    } else if (line.startsWith('+')) { added.push(line.slice(1)); at.push(next++); }
  }
  flush();
  return scan;
}
