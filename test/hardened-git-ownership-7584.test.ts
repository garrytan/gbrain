/**
 * Cross-owner source reads must find HEAD and its committed tree. Reverting the
 * scoped exception breaks these reads; existing filter tests use same-owner
 * repos. No production seam: inject Git's native ownership-test switch into
 * real child processes after the environment scrub.
 */
import { expect, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hardenedGitEnvironment, hardenedGitSync } from '../src/core/hardened-git.ts';
import { readTreeLevel } from '../src/core/persistence/sync-git-stream.ts';

test('hardened source reads accept a checkout across ownership boundaries', async () => {
  const root = mkdtempSync(join(tmpdir(), 'git-ownership-'));
  const nativeSync = childProcess.spawnSync;
  const nativeSpawn = childProcess.spawn;
  const env = hardenedGitEnvironment();
  const git = (args: string[], input?: string) => {
    const result = nativeSync('git', ['-C', root, ...args], { env, input, encoding: 'utf8' });
    expect(result.status).toBe(0);
    return result.stdout.trim();
  };
  let restoreSync: (() => void) | undefined;
  let restoreStream: (() => void) | undefined;
  try {
    git(['init', '-q']);
    writeFileSync(join(root, 'note.md'), 'memory\n');
    git(['add', 'note.md']);
    const tree = git(['write-tree']);
    const head = git(['hash-object', '-w', '-t', 'commit', '--stdin'],
      `tree ${tree}\nauthor Fixture <> 1000000000 +0000\ncommitter Fixture <> 1000000000 +0000\n\nseed\n`);
    git(['update-ref', 'HEAD', head]);
    const ownershipEnv = { ...env, GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' };
    const refused = nativeSync('git', ['-C', root, 'rev-parse', 'HEAD'], { env: ownershipEnv, encoding: 'utf8' });
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('dubious ownership');

    const syncSpy = spyOn(childProcess, 'spawnSync').mockImplementation((command: any, args: any, options: any) =>
      nativeSync(command, args, { ...options, env: { ...options.env, GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' } }) as any);
    restoreSync = () => syncSpy.mockRestore();
    const streamSpy = spyOn(childProcess, 'spawn').mockImplementation((command: any, args: any, options: any) =>
      nativeSpawn(command, args, { ...options, env: { ...options.env, GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' } }) as any);
    restoreStream = () => streamSpy.mockRestore();

    const result = hardenedGitSync(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { timeoutMs: 5000, maxBytes: 1024 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.stdout.toString().trim()).toBe(head);
    const entries = await readTreeLevel(root, head, '');
    expect([...entries.keys()]).toEqual(['note.md']);
    expect(entries.get('note.md')?.oid).toBe(git(['rev-parse', 'HEAD:note.md']));
    // Trust must remain invocation-local.
    expect(nativeSync('git', ['-C', root, 'rev-parse', 'HEAD'], { env: ownershipEnv }).status).not.toBe(0);
  } finally {
    restoreSync?.();
    restoreStream?.();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
