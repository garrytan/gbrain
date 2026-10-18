/**
 * #6665: a delete_page Git effect reported committed while the removal was never committed.
 *
 * Hypothesized mechanism (Windows, unconfirmed): a delete-pending file is gone for Node, but Git for
 * Windows' cached directory listing (core.fscache) still shows it, so `git status` reports the
 * tracked path clean and `commitGitTargets` returned `unchanged`. A PATH git shim models that cache:
 * unless a command runs with `-c core.fscache=false`, `status` hides the path and `commit` sees the
 * file present. The fix stages a tracked, absent path as a removal without trusting status, probes
 * and commits it with core.fscache off, and refuses with retryable `git_target_pending` (counted
 * toward parking, never reported as success) when the index still lists it. Doctor's named fix for a
 * parked git_target_pending target is tested in test/parked-push-retry-6678.test.ts.
 */
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitGitTargets } from '../src/core/persistence/effect-git.ts';
import { withEnv } from './helpers/with-env.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'gbrain-6665-'));
  const root = join(base, 'repo'); mkdirSync(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Example'); git(root, 'config', 'user.email', 'example@example.invalid');
  writeFileSync(join(root, 'gone.md'), 'Body\n');
  writeFileSync(join(root, 'kept.md'), 'Kept\n');
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'seed');
  rmSync(join(root, 'gone.md'));
  const bin = join(base, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'git'), `#!/bin/sh
REAL='${realGit}'
if [ -n "$SHIM_RM_NOOP" ]; then for arg in "$@"; do [ "$arg" = rm ] && exit 0; done; fi
case " $* " in *" core.fscache=false "*) exec "$REAL" "$@" ;; esac
for arg in "$@"; do
  case "$arg" in
    status) "$REAL" "$@" | tr '\\0' '\\n' | grep -v 'gone.md$' | tr '\\n' '\\0'; exit 0 ;;
    commit) printf 'Body\\n' > '${root}/gone.md'; "$REAL" "$@"; code=$?; rm -f '${root}/gone.md'; exit $code ;;
  esac
done
exec "$REAL" "$@"
`);
  chmodSync(join(bin, 'git'), 0o755);
  return { base, root, path: `${bin}:${process.env.PATH}` };
}

test('a tracked path absent on disk is committed as a removal even when status hides it and commit would see it', async () => {
  const { base, root, path } = fixture();
  try {
    const results = await withEnv({ PATH: path }, () => commitGitTargets(root, ['gone.md', 'kept.md']));
    expect(results.get('gone.md')).toEqual({ git: 'committed' });
    expect(results.get('kept.md')).toEqual({ git: 'unchanged' });
    expect(git(root, 'ls-tree', '--name-only', 'HEAD')).not.toContain('gone.md');
    expect(git(root, 'ls-tree', '--name-only', 'HEAD')).toContain('kept.md');
    expect(existsSync(join(root, 'gone.md'))).toBe(false);
    expect(git(root, 'status', '--porcelain')).toBe('');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('a removal the index still lists is git_target_pending, never reported as unchanged', async () => {
  const { base, root, path } = fixture();
  try {
    const results = await withEnv({ PATH: path, SHIM_RM_NOOP: '1' }, () => commitGitTargets(root, ['gone.md']));
    expect(results.get('gone.md')).toMatchObject({ code: 'git_target_pending', message: expect.stringContaining('gone.md') });
    expect(git(root, 'ls-tree', '--name-only', 'HEAD')).toContain('gone.md');
  } finally { rmSync(base, { recursive: true, force: true }); }
});
