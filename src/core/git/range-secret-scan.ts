/**
 * Secret scan over the commits an automatic publish would push. A push from a checkout gbrain did not write (a script's
 * plain `git commit`) never passed the write path's scan, so before refresh publishes a diverged checkout on its own every
 * blob a commit in `base..head` adds or changes is scanned once with the workspace allowlist (`.gbrain-scan-allow`).
 * Findings carry the path, line, rule and fingerprint, never the matched value. Merge commits are not listed (their
 * parents' blobs are), binary and over-cap blobs are skipped like scanFiles skips them.
 */
import { spawn } from 'node:child_process';
import { gitChildEnv } from '../git-env.ts';
import { loadWorkspaceAllowlist, pathAllowlisted } from '../secret-scan-allowlist.ts';
import { looksBinaryBuffer, scanText, SCAN_MAX_FILE_BYTES } from '../secret-scan.ts';

export interface RangeSecretFinding { path: string; commit: string; line: number; pattern: string; fingerprint: string }

function run(root: string, args: string[], input?: string): Promise<{ code: number; stdout: Buffer }> {
  return new Promise(resolve => {
    const child = spawn('git', ['-C', root, '-c', 'core.quotePath=false', ...args], { env: gitChildEnv({ GIT_TERMINAL_PROMPT: '0' }), stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', () => resolve({ code: -1, stdout: Buffer.alloc(0) }));
    child.on('close', code => resolve({ code: code ?? -1, stdout: Buffer.concat(chunks) }));
    child.stdin.end(input ?? '');
  });
}

/** Findings in the blobs `base..head` adds or changes; null when git cannot list or read them (callers refuse). */
export async function scanCommitRange(root: string, base: string, head: string): Promise<RangeSecretFinding[] | null> {
  const log = await run(root, ['log', '--no-renames', '--raw', '--no-abbrev', '--format=commit %H', `${base}..${head}`, '--']);
  if (log.code !== 0) return null;
  const blobs = new Map<string, { path: string; commit: string }>();
  let commit = '';
  for (const line of log.stdout.toString('utf8').split('\n')) {
    if (line.startsWith('commit ')) { commit = line.slice(7).trim(); continue; }
    const raw = /^:\d+ (\d+) [0-9a-f]+ ([0-9a-f]+) [AMT]\t(.+)$/.exec(line);
    if (raw && raw[1] !== '160000' && !/^0+$/.test(raw[2]) && !blobs.has(raw[2])) blobs.set(raw[2], { path: raw[3], commit });
  }
  if (!blobs.size) return [];
  const allowlist = loadWorkspaceAllowlist(root);
  const wanted = [...blobs].filter(([, at]) => !pathAllowlisted(at.path, allowlist));
  const sizes = await run(root, ['cat-file', '--batch-check=%(objectname) %(objectsize)'], wanted.map(([sha]) => sha).join('\n') + '\n');
  if (sizes.code !== 0) return null;
  const small = new Set(sizes.stdout.toString('utf8').split('\n').map(line => line.split(' ')).filter(([, size]) => Number(size) <= SCAN_MAX_FILE_BYTES).map(([sha]) => sha));
  const read = wanted.filter(([sha]) => small.has(sha));
  if (!read.length) return [];
  const batch = await run(root, ['cat-file', '--batch'], read.map(([sha]) => sha).join('\n') + '\n');
  if (batch.code !== 0) return null;
  const out: RangeSecretFinding[] = [];
  let at = 0;
  for (const [sha, where] of read) {
    const headerEnd = batch.stdout.indexOf(0x0a, at);
    const [name, , size] = batch.stdout.subarray(at, headerEnd).toString('utf8').split(' ');
    if (name !== sha) return null;
    const body = batch.stdout.subarray(headerEnd + 1, headerEnd + 1 + Number(size));
    at = headerEnd + 1 + Number(size) + 1;
    if (looksBinaryBuffer(body)) continue;
    for (const f of scanText(body.toString('utf8'), { allowlist })) out.push({ path: where.path, commit: where.commit, line: f.line, pattern: f.pattern, fingerprint: f.fingerprint });
  }
  return out;
}
