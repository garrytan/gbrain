/**
 * GBRA-133: the read-only push probe of `gbrain sources writer git-durability --enable` refused a checkout whose
 * remote branch had moved since the last fetch (`[rejected] ... (fetch first)` or `(non-fast-forward)`), so enable
 * failed with git_push_unavailable even though the Git effect publishes that case itself: it merges the remote commits
 * in memory and pushes the merge without moving the checkout (#7010, `pushGitRoot`). The probe now passes a
 * remote-moved rejection (`remote_moved`), and auth, protected-branch and unreachable failures stay refused.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { probeDurabilityPush } from '../src/core/persistence/git-durability-administration.ts';
import { claimWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { localHostId, registerLocalWriter } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { gitAsync } from './helpers/git-publication.ts';
import { withEnv } from './helpers/with-env.ts';
import { reviewedWriterIntent } from './helpers/writer-admin-intent.ts';

let engine: PGLiteEngine;
const homes: string[] = [];
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); for (const home of homes) rmSync(home, { recursive: true, force: true }); });

async function isolated<T>(run: (home: string) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-probe-moved-')); homes.push(home);
  try {
    return await withEnv({ GBRAIN_HOME: home, GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined,
      GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1' }, async () => { await registerLocalWriter(engine, 'cli'); return run(home); });
  } finally { await disposePersistenceConsumer(engine); }
}

async function identity(root: string): Promise<void> {
  await gitAsync(root, 'config', 'user.name', 'Example Writer');
  await gitAsync(root, 'config', 'user.email', 'writer@example.invalid');
}

/** A checkout tracking a bare remote, and a second clone of that remote standing in for another writer. */
async function checkoutWithRemote(home: string): Promise<{ root: string; remote: string; other: string }> {
  const id = randomUUID().slice(0, 8);
  const root = join(home, `root-${id}`); mkdirSync(root);
  await gitAsync(root, 'init', '-q', '-b', 'main'); await identity(root);
  writeFileSync(join(root, 'initial.md'), 'Initial\n');
  await gitAsync(root, 'add', '-A'); await gitAsync(root, 'commit', '-q', '-m', 'Initial');
  const remote = join(home, `remote-${id}.git`); mkdirSync(remote);
  await gitAsync(remote, 'init', '-q', '--bare');
  await gitAsync(root, 'remote', 'add', 'origin', remote); await gitAsync(root, 'push', '-q', '-u', 'origin', 'main');
  const other = join(home, `other-${id}`);
  await gitAsync(home, 'clone', '-q', '-b', 'main', remote, other); await identity(other);
  return { root, remote, other };
}

async function commit(root: string, file: string): Promise<void> {
  writeFileSync(join(root, file), `${file}\n`);
  await gitAsync(root, 'add', file); await gitAsync(root, 'commit', '-q', '-m', file);
}

async function moveRemote(other: string): Promise<void> {
  await commit(other, 'remote-only.md');
  await gitAsync(other, 'push', '-q', 'origin', 'main');
}

const tracking = { remote: 'origin', merge: 'refs/heads/main' };
const same = (text: string) => text;

/** A `git` earlier on PATH that answers `push` with the given stderr and exit 1, and hands every other command to the real git. */
function stubPush(home: string, stderr: string): string {
  const realGit = Bun.which('git')!;
  const dir = join(home, `stub-${randomUUID().slice(0, 8)}`); mkdirSync(dir);
  const script = join(dir, 'git');
  writeFileSync(script, `#!/bin/sh\nfor a in "$@"; do if [ "$a" = push ]; then printf '%s\\n' '${stderr.replace(/'/g, "'\\''")}' >&2; exit 1; fi; done\nexec '${realGit}' "$@"\n`);
  chmodSync(script, 0o755);
  return `${dir}:${process.env.PATH ?? ''}`;
}

describe('GBRA-133 git-durability push probe: a moved remote is publishable', () => {
  test('the remote moves after a local commit: the probe passes remote_moved, enable succeeds, and nothing is pulled into the checkout', () => isolated(async home => {
    const { root, other } = await checkoutWithRemote(home);
    await commit(root, 'local.md');
    await moveRemote(other);
    const head = (await gitAsync(root, 'rev-parse', 'HEAD')).trim();

    expect(await probeDurabilityPush(root, tracking, same)).toMatchObject({ ok: true, remote_moved: true, detail: expect.stringContaining('merges them in memory') });

    const sourceId = `vault-${randomUUID().slice(0, 8)}`;
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
    await claimWorktree(engine, sourceId, root, localHostId());
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    try {
      const preview = await runPersistenceAdministration(engine, 'writer_git_durability', { source_id: sourceId, enable: true, dry_run: true });
      expect(preview).toMatchObject({ dry_run: true, push_probe: { ok: true, remote_moved: true } });
      const applied = await runPersistenceAdministration(engine, 'writer_git_durability', { source_id: sourceId, enable: true, ...await reviewedWriterIntent(engine, 'writer_git_durability') });
      expect(applied).toMatchObject({ applied: true, git_durability: { before: null, after: 'enabled' }, push_probe: { ok: true, remote_moved: true } });
      expect((await getWorktreeBinding(engine, sourceId, localHostId()))!.git_durability).toBe('enabled');
    } finally {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    }
    // A dry-run probe never fetches into, merges into or moves the checkout.
    expect((await gitAsync(root, 'rev-parse', 'HEAD')).trim()).toBe(head);
    expect((await gitAsync(root, 'ls-files')).split('\n')).not.toContain('remote-only.md');
  }), 120_000);

  test('a diverged branch whose remote commits were already fetched (non-fast-forward) passes the same way', () => isolated(async home => {
    const { root, other } = await checkoutWithRemote(home);
    await moveRemote(other);
    await gitAsync(root, 'fetch', '-q', 'origin');
    await commit(root, 'local.md');
    expect(await probeDurabilityPush(root, tracking, same)).toMatchObject({ ok: true, remote_moved: true });
  }), 120_000);

  test('an up-to-date checkout probes plain ok, and no tracking remote is still skipped', () => isolated(async home => {
    const { root } = await checkoutWithRemote(home);
    await commit(root, 'local.md');
    expect(await probeDurabilityPush(root, tracking, same)).toEqual({ ok: true });
    expect(await probeDurabilityPush(root, { remote: null, merge: null }, same)).toEqual({ ok: true, skipped: 'no_tracking_remote' });
  }), 120_000);

  test('a missing remote stays refused, and enable records nothing', () => isolated(async home => {
    const { root, remote } = await checkoutWithRemote(home);
    await commit(root, 'local.md');
    rmSync(remote, { recursive: true, force: true });
    const probe = await probeDurabilityPush(root, tracking, same);
    expect(probe.ok).toBe(false);
    expect(probe).not.toHaveProperty('remote_moved');

    const sourceId = `vault-${randomUUID().slice(0, 8)}`;
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
    await claimWorktree(engine, sourceId, root, localHostId());
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    try {
      const refused = await runPersistenceAdministration(engine, 'writer_git_durability', { source_id: sourceId, enable: true, ...await reviewedWriterIntent(engine, 'writer_git_durability') })
        .then(() => null, (error: unknown) => error as { code?: string });
      expect(refused?.code).toBe('git_push_unavailable');
      expect((await getWorktreeBinding(engine, sourceId, localHostId()))!.git_durability).not.toBe('enabled');
    } finally {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    }
  }), 120_000);

  test.each([
    ['auth', 'fatal: Authentication failed for the example remote'],
    ['auth', 'remote: Permission to example/brain.git denied to example-bot. The requested URL returned error: 403'],
    ['protected', ' ! [remote rejected] HEAD -> main (protected branch hook declined)'],
    ['unreachable', 'fatal: unable to access the example remote: Could not resolve host: git.example.invalid'],
  ] as const)('a refusal classified %s stays refused, never read as a moved remote', (reason, stderr) => isolated(async home => {
    const { root } = await checkoutWithRemote(home);
    await commit(root, 'local.md');
    const probe = await withEnv({ PATH: stubPush(home, stderr) }, () => probeDurabilityPush(root, tracking, same));
    expect(probe).toMatchObject({ ok: false, reason });
    expect(probe).not.toHaveProperty('remote_moved');
  }), 120_000);
});
