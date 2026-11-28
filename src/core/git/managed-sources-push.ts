import { closeSync, mkdtempSync, openSync, readSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from '../spawn.ts';
import { gitChildEnv } from '../git-env.ts';
import { GIT_ENV, GIT_ENV_AUTH } from '../git-transport.ts';
import { OperationError } from '../ops/contract.ts';
import { acquireNativeLock } from '../persistence/native-lock.ts';
import { withSession, type GitSession } from '../persistence/effect-git.ts';
import { execFileBounded } from '../bounded-child-exec.ts';
import { loadWorkspaceAllowlist, matchesGlob, pathAllowlisted, withoutRuleAllowed } from '../secret-scan-allowlist.ts';
import { scanText, SCAN_MAX_FILE_BYTES } from '../secret-scan.ts';
import { PUSH_DENY_GLOBS } from '../workspace-push.ts';
import { PUBLISH_LOCK_NAME } from './commit-push.ts';
import { DEFAULT_SCAN_TIMEOUT_MS, rangeSecretRefusal, scanRange } from './range-secret-scan.ts';

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const BATCH_BYTES = 32 * 1024 * 1024;
const fail = (what: string) => new OperationError('publish_scan_unreadable',
  `The managed push cannot scan ${what} completely; nothing was pushed.`,
  'Check the checkout and retry with a longer --scan-timeout if needed. No files or commits were changed.');

/** Reads the actual blobs added by every unpublished commit, including binary blobs and merge parents. */
function scanBlobs(session: GitSession, base: string, head: string, deadline: number): void {
  const root = session.root;
  const allowlist = loadWorkspaceAllowlist(root);
  const run = (args: string[], input = '', out?: number) => {
    const timeout = deadline - Date.now();
    if (timeout <= 0) throw fail('the unpublished history within the time budget');
    const result = spawnSync('git', ['-C', root, '-c', `core.hooksPath=${session.hooks}`, ...args], {
      input, stdio: ['pipe', out ?? 'pipe', 'pipe'], timeout, maxBuffer: 64 * 1024 * 1024,
      env: gitChildEnv({ ...GIT_ENV, GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_SHALLOW_FILE: process.platform === 'win32' ? 'NUL' : '/dev/null', LC_ALL: 'C' }),
    });
    if (result.error || result.status !== 0) throw fail('the unpublished Git objects');
    return result.stdout as Buffer;
  };
  const commits = run(['rev-list', base ? `${base}..${head}` : head, '--']).toString('ascii').split('\n').filter(Boolean);
  if (commits.some(sha => !OID.test(sha))) throw fail('the commit list');
  if (!commits.length) return;
  const raw = run(['diff-tree', '--stdin', '--root', '-m', '-r', '--no-renames', '--no-commit-id', '--raw', '-z', '--no-abbrev'], commits.join('\n') + '\n');
  const fields: Buffer[] = [];
  let at = 0;
  for (let end; (end = raw.indexOf(0, at)) !== -1; at = end + 1) fields.push(raw.subarray(at, end));
  if (at !== raw.length || fields.length % 2) throw fail('the changed-path listing');
  const paths = new Map<string, Set<string>>();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let i = 0; i < fields.length; i += 2) {
    const match = /^:[0-7]{6} ([0-7]{6}) [0-9a-f]+ ([0-9a-f]+) ([A-Z])$/.exec(fields[i]!.toString('ascii'));
    let path: string;
    try { path = decoder.decode(fields[i + 1]!); } catch { throw fail('a non-UTF-8 Git path'); }
    if (!match || !path || !OID.test(match[2]!)) throw fail('the changed-path listing');
    if (match[1] === '000000') continue; // deleting a previously published file adds no blob
    if (PUSH_DENY_GLOBS.some(glob => matchesGlob(glob, path))) {
      throw new OperationError('blocked_tracked_deny', `Unpublished history contains deny-listed path ${path}; nothing was pushed.`,
        'Remove it from every unpublished commit before retrying; removing it only from HEAD does not remove it from history.');
    }
    if (match[1] === '160000') throw fail(`the submodule entry ${path}`);
    if (pathAllowlisted(path, allowlist)) continue;
    const group = paths.get(match[2]!) ?? new Set<string>();
    group.add(path); paths.set(match[2]!, group);
  }
  const ids = [...paths.keys()];
  if (!ids.length) return;
  const checks = run(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], ids.join('\n') + '\n').toString('ascii').trimEnd().split('\n');
  if (checks.length !== ids.length) throw fail('the blob sizes');
  const sizes = checks.map((line, i) => {
    const match = /^([0-9a-f]+) blob (\d+)$/.exec(line);
    if (!match || match[1] !== ids[i]) throw fail('the blob sizes');
    const size = Number(match[2]);
    if (!Number.isSafeInteger(size) || size > SCAN_MAX_FILE_BYTES) throw fail(`the oversized blob at ${[...paths.get(ids[i]!)!][0]}`);
    return size;
  });
  const scratch = mkdtempSync(join(tmpdir(), 'gbrain-managed-scan-'));
  try {
    for (let start = 0; start < ids.length;) {
      let end = start, bytes = 0;
      while (end < ids.length && end - start < 256 && (end === start || bytes + sizes[end]! <= BATCH_BYTES)) bytes += sizes[end++]!;
      const batch = ids.slice(start, end), fd = openSync(join(scratch, 'blobs'), 'w+', 0o600);
      try {
        run(['cat-file', '--batch'], batch.join('\n') + '\n', fd);
        let position = 0;
        const readAt = (size: number) => {
          const buffer = Buffer.alloc(size);
          for (let got = 0; got < size;) {
            const n = readSync(fd, buffer, got, size - got, position + got);
            if (!n) throw fail('a committed blob');
            got += n;
          }
          position += size;
          return buffer;
        };
        for (let i = 0; i < batch.length; i++) {
          const expected = Buffer.from(`${batch[i]} blob ${sizes[start + i]}\n`);
          if (!readAt(expected.length).equals(expected)) throw fail('a committed blob header');
          const blob = readAt(sizes[start + i]!);
          if (readAt(1)[0] !== 10) throw fail('a committed blob');
          const text = blob.toString('utf8');
          const found = scanText(text, { allowlist });
          for (const path of paths.get(batch[i]!)!) {
            const findings = withoutRuleAllowed(found, path, allowlist);
            if (findings.length) {
              const first = findings[0]!;
              throw new OperationError('blocked_secrets', `Unpublished history contains a secret at ${path}:${first.line} [${first.pattern}] (${first.fingerprint}); nothing was pushed.`,
                'Remove the credential from the unpublished history or explicitly allowlist a reviewed false positive, then retry.');
            }
          }
          if (Date.now() > deadline) throw fail('the unpublished history within the time budget');
        }
      } finally { closeSync(fd); }
      start = end;
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

/** Caller holds the verified worktree owner lock. Never mutates HEAD, index or worktree. */
export async function pushManagedSourcesHead(root: string, timeoutMs = DEFAULT_SCAN_TIMEOUT_MS): Promise<{ status: 'pushed'; head: string } | { status: 'skipped'; reason: 'no_tracking_remote' | 'publish_in_flight' }> {
  return withSession(root, undefined, undefined, false, async session => {
    const git = async (session: GitSession, args: string[]) => {
      const result = await execFileBounded('git', ['-C', root, '-c', `core.hooksPath=${session.hooks}`, ...args], {
        timeout: 120_000, maxBuffer: 1024 * 1024,
        env: gitChildEnv({ ...GIT_ENV_AUTH, GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: process.platform === 'win32' ? 'NUL' : '/dev/null',
          GIT_SHALLOW_FILE: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' }),
      });
      return { ...result, code: result.error ? typeof result.error.code === 'number' ? result.error.code : -1 : 0 };
    };
    const read = async (args: string[]) => {
      const result = await git(session, args);
      if (result.code !== 0) throw fail(`Git ${args[0]}`);
      return result.stdout.trim();
    };
    const gitPath = await read(['rev-parse', '--git-path', PUBLISH_LOCK_NAME]);
    const publishLock = await acquireNativeLock(isAbsolute(gitPath) ? gitPath : resolve(root, gitPath), { timeoutMs: 0 });
    if (!publishLock) return { status: 'skipped', reason: 'publish_in_flight' };
    try {
      const branch = await git(session, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
      if (branch.code !== 0) return { status: 'skipped', reason: 'no_tracking_remote' };
      const remote = await git(session, ['config', '--get', `branch.${branch.stdout.trim()}.remote`]);
      const merge = await git(session, ['config', '--get', `branch.${branch.stdout.trim()}.merge`]);
      if (remote.code !== 0 || merge.code !== 0 || !remote.stdout.trim() || remote.stdout.trim() === '.') return { status: 'skipped', reason: 'no_tracking_remote' };
      const ref = merge.stdout.trim();
      if (!ref.startsWith('refs/heads/') || (await git(session, ['check-ref-format', ref])).code !== 0) throw fail('the configured tracking branch');
      const head = await read(['rev-parse', '--verify', 'HEAD^{commit}']);
      if (!OID.test(head)) throw fail('the committed HEAD');
      if (await read(['symbolic-ref', '--quiet', '--short', 'HEAD']) !== branch.stdout.trim()) throw fail('a branch that moved while HEAD was read');
      const destinations = (await read(['remote', 'get-url', '--push', '--all', remote.stdout.trim()])).split('\n').filter(Boolean);
      if (destinations.length !== 1) throw fail('a remote with multiple push destinations');
      const destination = destinations[0]!;
      const protocols = ['-c', 'http.followRedirects=false', '-c', `protocol.file.allow=${process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT === '1' ? 'always' : 'never'}`, '-c', 'protocol.ext.allow=never'];
      const advertised = await read([...protocols, 'ls-remote', '--heads', '--', destination, ref]);
      const lines = advertised ? advertised.split('\n') : [];
      if (lines.length > 1) throw fail('the remote branch advertisement');
      const pieces = lines[0]?.split('\t');
      const base = pieces?.[0] ?? '';
      if (pieces && (pieces.length !== 2 || pieces[1] !== ref || !OID.test(base))) throw fail('the remote branch advertisement');
      if (base && (await git(session, ['cat-file', '-e', `${base}^{commit}`])).code !== 0) {
        const fetched = await git(session, [...protocols, 'fetch', '--no-recurse-submodules', '--no-tags', '--no-write-fetch-head', '--', destination, base]);
        if (fetched.code !== 0) throw fail('the remote commit');
      }
      if (base && (await git(session, ['merge-base', '--is-ancestor', base, head])).code !== 0) {
        throw new OperationError('push_unconfirmed', 'The remote branch is not an ancestor of committed HEAD; nothing was pushed.',
          'Use gbrain sources refresh to reconcile the remote without pulling into the managed checkout.');
      }
      const deadline = Date.now() + timeoutMs;
      scanBlobs(session, base, head, deadline);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw fail('the unpublished history within the time budget');
      const scan = scanRange(root, base, head, remaining, undefined, { includePageWrites: true });
      const refusal = rangeSecretRefusal(root, base, head, scan, { timeoutMs, retryArgv: ['gbrain', 'sources', 'push', '--path', root] });
      if (refusal) throw refusal;
      const pushed = await git(session, [...protocols, '-c', 'push.gpgSign=false', 'push', '--no-verify', '--no-follow-tags', '--recurse-submodules=no',
        `--force-with-lease=${ref}:${base}`, '--', destination, `${head}:${ref}`]);
      if (pushed.code !== 0) throw new OperationError('push_unconfirmed', 'The remote changed or refused the managed push; nothing was confirmed pushed.',
        'Retry after checking the remote and its credentials. The checkout was not changed.');
      return { status: 'pushed', head };
    } finally { await publishLock.release(); }
  });
}
