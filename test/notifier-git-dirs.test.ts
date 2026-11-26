import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveGitDirs } from '../src/core/notifier/detect.ts';
import { withEnv } from './helpers/with-env.ts';

test.skipIf(process.platform === 'win32')('checkout probes distinguish an ordinary directory, Git errors and a real checkout', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'gbrain-notifier-git-'));
  try {
    const checkout = join(fixture, 'checkout');
    const ordinary = join(fixture, 'ordinary');
    const emptyPath = join(fixture, 'empty-path');
    const testBins = join(fixture, 'bin');
    for (const path of [checkout, ordinary, emptyPath, testBins]) mkdirSync(path);
    execFileSync('git', ['init', '-q', checkout]);
    expect(await resolveGitDirs(checkout)).toMatchObject({ gitDir: expect.stringMatching(/checkout[/\\]\.git$/) });
    expect(await resolveGitDirs(ordinary)).toEqual({ reason: 'Git found no checkout on this host' });
    await withEnv({ PATH: emptyPath }, async () => {
      expect(await resolveGitDirs(checkout)).toEqual({ reason: 'Git executable unavailable on this host' });
    });

    const fakeGit = join(testBins, 'git');
    writeFileSync(fakeGit, '#!/bin/sh\necho "fatal: cannot open Git directory: Permission denied" >&2\nexit 128\n', { mode: 0o700 });
    await withEnv({ PATH: testBins }, async () => {
      expect(await resolveGitDirs(checkout)).toEqual({ reason: 'permission denied while checking the Git checkout' });
    });
    writeFileSync(fakeGit, '#!/bin/sh\nexec /bin/sleep 60\n');
    await withEnv({ PATH: testBins }, async () => {
      expect(await resolveGitDirs(checkout)).toEqual({ reason: 'Git checkout detection timed out' });
    });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}, 15_000);
