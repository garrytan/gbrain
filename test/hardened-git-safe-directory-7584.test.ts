/**
 * #7584: a source repository owned by another user. Git refuses it ("dubious ownership") unless the operator allows the
 * directory with `safe.directory` in system or global config or the `GIT_CONFIG_*` environment. The hardened reads that sync
 * uses scrub all three, so sync failed with "HEAD does not name a commit" even after the operator allowed it. Now only the
 * `safe.directory` entries are carried: every other key in those places stays out.
 *
 * Ownership by another user is forced with Git's own `GIT_TEST_ASSUME_DIFFERENT_OWNER` through a `git` wrapper first on
 * PATH, because the hardened environment drops every `GIT_*` variable a test could set.
 */
import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { hardenedGitStream, hardenedGitSync } from '../src/core/hardened-git.ts';
import { gitChildEnv } from '../src/core/git-env.ts';
import { withEnv } from './helpers/with-env.ts';
import { makeGitFixture } from './helpers/git-fixture.ts';

const LIMITS = { timeoutMs: 10_000, maxBytes: 1024 * 1024 };
const head = (root: string) => hardenedGitSync(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], LIMITS);
const ignored = (root: string) => hardenedGitSync(root, ['check-ignore', '--', 'a.md'], LIMITS);

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-7584-'));
  const root = join(dir, 'repo');
  execFileSync('mkdir', ['-p', root]);
  await makeGitFixture(root);
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const shim = join(dir, 'bin');
  execFileSync('mkdir', ['-p', shim]);
  writeFileSync(join(shim, 'git'), `#!/bin/sh\nGIT_TEST_ASSUME_DIFFERENT_OWNER=1 PATH='${process.env.PATH}' exec "${realGit}" "$@"\n`);
  chmodSync(join(shim, 'git'), 0o755);
  const excludes = join(dir, 'excludes');
  writeFileSync(excludes, '*.md\n');
  const empty = join(dir, 'empty-config');
  writeFileSync(empty, '');
  const config = (name: string, safe: string) => {
    const file = join(dir, name);
    writeFileSync(file, `[safe]\n\tdirectory = ${safe}\n[core]\n\texcludesFile = ${excludes}\n`);
    return file;
  };
  const base = { PATH: `${shim}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_SYSTEM: empty, GIT_CONFIG_NOSYSTEM: undefined,
    GIT_CONFIG_COUNT: undefined, GIT_CONFIG_KEY_0: undefined, GIT_CONFIG_VALUE_0: undefined, GIT_CONFIG_KEY_1: undefined, GIT_CONFIG_VALUE_1: undefined };
  return { dir, root, excludes, config, base };
}

describe.skipIf(process.platform === 'win32')('#7584 hardened reads of a repository owned by another user', () => {
  test('without an allowance the hardened read is refused, as plain git refuses it', async () => {
    const { root, base } = await setup();
    await withEnv(base, () => {
      expect(head(root)).toEqual({ ok: false, reason: 'exit', status: 128 });
    });
  });

  test('a global safe.directory is honoured, and no other global key is read', async () => {
    const { root, config, base } = await setup();
    const global = config('global', root);
    await withEnv({ ...base, GIT_CONFIG_GLOBAL: global }, async () => {
      expect(execFileSync('git', ['-C', root, 'check-ignore', 'a.md'], { encoding: 'utf8', env: gitChildEnv() }).trim()).toBe('a.md');
      expect(head(root).ok).toBe(true);
      expect((await hardenedGitStream(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { ...LIMITS, onChunk: () => {} })).ok).toBe(true);
      expect(ignored(root)).toEqual({ ok: false, reason: 'exit', status: 1 });
    });
  });

  test('a system safe.directory is honoured, and no other system key is read', async () => {
    const { root, config, base } = await setup();
    await withEnv({ ...base, GIT_CONFIG_SYSTEM: config('system', root) }, () => {
      expect(head(root).ok).toBe(true);
      expect(ignored(root)).toEqual({ ok: false, reason: 'exit', status: 1 });
    });
  });

  test('a GIT_CONFIG_* safe.directory is honoured, and no other environment key is carried', async () => {
    const { root, excludes, base } = await setup();
    await withEnv({ ...base, GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.excludesFile', GIT_CONFIG_VALUE_0: excludes,
      GIT_CONFIG_KEY_1: 'safe.directory', GIT_CONFIG_VALUE_1: root }, () => {
      expect(head(root).ok).toBe(true);
      expect(ignored(root)).toEqual({ ok: false, reason: 'exit', status: 1 });
    });
  });

  test('an allowance for another directory does not open this one', async () => {
    const { dir, root, config, base } = await setup();
    await withEnv({ ...base, GIT_CONFIG_GLOBAL: config('global', join(dir, 'elsewhere')) }, () => {
      expect(head(root)).toEqual({ ok: false, reason: 'exit', status: 128 });
    });
  });
});

test('#7584 gitChildEnv carries the environment safe.directory entries and drops every other GIT_CONFIG key', () => {
  const source = { PATH: '/usr/bin', GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: '/tmp/x',
    GIT_CONFIG_KEY_1: 'Safe.Directory', GIT_CONFIG_VALUE_1: '/srv/notes', GIT_CONFIG_KEY_2: 'core.hooksPath', GIT_CONFIG_VALUE_2: '/tmp/h',
    GIT_CONFIG_KEY_3: 'safe.directory', GIT_CONFIG_VALUE_3: '/beyond-count' };
  expect(gitChildEnv({}, source)).toEqual({ PATH: '/usr/bin', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '/srv/notes' });
  expect(gitChildEnv({}, { PATH: '/usr/bin', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '/srv/notes' })).toEqual({ PATH: '/usr/bin' });
});
