import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { git, gitAsync } from './helpers/git-publication.ts';
import { withEnv } from './helpers/with-env.ts';

// A git that ends without an exit status (by signal here; a Bun.spawnSync that
// gave up under oven-sh/bun#34069 looks the same to the caller) must fail the
// test that called it, not return '' as if it had succeeded.
async function withSignalledGit<T>(run: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-fake-git-'));
  try {
    const fake = join(dir, 'git');
    writeFileSync(fake, '#!/bin/sh\nkill -KILL $$\n');
    chmodSync(fake, 0o755);
    return await withEnv({ PATH: `${dir}${delimiter}${process.env.PATH ?? ''}` }, run);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test.skipIf(process.platform === 'win32')('a git call that ends without an exit status throws, synchronously and asynchronously', async () => {
  await withSignalledGit(async () => {
    expect(() => git(tmpdir(), 'rev-parse', 'HEAD')).toThrow(/git rev-parse HEAD in .*: no exit status \(signal SIGKILL\)/);
    await expect(gitAsync(tmpdir(), 'rev-parse', 'HEAD')).rejects.toThrow(/git rev-parse HEAD in .*: (?:no exit status|exit 137) \(signal SIGKILL\)/);
  });
});

test('a non-zero exit carries the command, the status and git\'s stderr', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-not-a-repo-'));
  try {
    expect(() => git(dir, 'rev-parse', 'HEAD')).toThrow(/git rev-parse HEAD in .*: exit 128\n.*not a git repository/i);
    await expect(gitAsync(dir, 'rev-parse', 'HEAD')).rejects.toThrow(/exit 128\n.*not a git repository/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
