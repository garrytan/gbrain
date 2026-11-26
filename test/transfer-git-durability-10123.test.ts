/**
 * #10123: a cross-host `transfer accept` created the successor's host binding with `git_durability` NULL and said
 * nothing, so page writes on the successor completed their Git effect as skipped (`durability_not_enabled`) and nothing
 * was committed or pushed. Accept now carries the previous owner's setting: `enabled` only when the same read-only push
 * probe `git-durability --enable` runs passes on the successor checkout, `disabled` as is; otherwise the binding stays
 * unrecorded and the accept result carries the `git_durability_not_enabled` warning `writer activate` prints, naming
 * the probe failure.
 *
 * Synthetic content only. PGLite.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { acceptWriterTransfer, claimWorktree, getWorktreeBinding, prepareWriterTransfer } from '../src/core/persistence/ownership.ts';
import { existingHostIdFor, registerLocalWriter } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { reviewedWriterIntent } from './helpers/writer-admin-intent.ts';
import { withEnv } from './helpers/with-env.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

describe('#10123 transfer accept carries git durability', () => {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'gbrain-transfer-durability-10123-')));
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
  afterAll(async () => {
    await withEnv({ GBRAIN_HOME: directory }, () => disposePersistenceConsumer(engine));
    await engine.disconnect();
    rmSync(directory, { recursive: true, force: true });
  });
  const env = { GBRAIN_HOME: directory, GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: undefined, GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1' };

  /** A source owned by another host, its Git checkout tracking a bare remote, prepared for transfer; the successor checkout is a copy. */
  async function preparedTransfer(setting: 'enabled' | 'disabled') {
    const id = `xfer-${randomUUID().replace(/-/g, '').slice(0, 16)}`, root = join(directory, id), remote = join(directory, `${id}.git`);
    mkdirSync(join(root, 'notes'), { recursive: true });
    writeFileSync(join(root, 'notes', 'alice-example.md'), '---\ntitle: Alice Example\ntype: note\n---\nA synthetic observation.\n');
    git(root, 'init', '-q', '-b', 'main'); git(root, 'add', '-A');
    git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'fixture');
    mkdirSync(remote); git(remote, 'init', '-q', '--bare');
    git(root, 'remote', 'add', 'origin', remote); git(root, 'push', '-q', '-u', 'origin', 'main');
    const ownerHost = randomUUID();
    await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)', [id, root, '{}']);
    const binding = await claimWorktree(engine, id, root, ownerHost);
    await engine.executeRaw('UPDATE persistence_host_bindings SET git_durability=$3 WHERE worktree_id=$1::uuid AND host_id=$2::uuid', [binding.worktree_id, ownerHost, setting]);
    const prepared = await prepareWriterTransfer(engine, id, ownerHost);
    const successor = join(directory, `${id}-successor`);
    cpSync(root, successor, { recursive: true });
    return { id, successor, prepared };
  }

  test('an enabled owner with a working remote: the successor binding is enabled', () => withEnv(env, async () => {
    const t = await preparedTransfer('enabled'), successorHost = randomUUID();
    await acceptWriterTransfer(engine, t.id, t.successor, t.prepared.owner_epoch, t.prepared.manifest.digest, successorHost);
    const binding = (await getWorktreeBinding(engine, t.id, successorHost))!;
    expect(binding.owner_host_id).toBe(successorHost);
    expect(binding.git_durability).toBe('enabled');
  }), 120_000);

  test('an enabled owner whose successor cannot push: the binding stays unrecorded and accept warns with the probe failure', () => withEnv(env, async () => {
    await registerLocalWriter(engine, 'cli');
    const t = await preparedTransfer('enabled');
    git(t.successor, 'remote', 'set-url', 'origin', join(directory, 'missing-remote.git'));
    const accepted = await runPersistenceAdministration(engine, 'writer_transfer_accept', { source_id: t.id, path: t.successor,
      expected_epoch: t.prepared.owner_epoch, manifest: t.prepared.manifest.digest, ...await reviewedWriterIntent(engine, 'writer_transfer_accept') }) as Record<string, any>;
    expect(accepted.transferred).toBe(true);
    expect(accepted.binding).toMatchObject({ owner_host_id: existingHostIdFor(engine), git_durability: null });
    expect(accepted.warnings).toEqual([expect.objectContaining({ code: 'git_durability_not_enabled', source_id: t.id, state: 'unknown',
      enable_command: `gbrain sources writer git-durability ${t.id} --enable --dry-run` })]);
    expect(accepted.warnings[0].message).toContain('push probe');
  }), 120_000);

  test('a disabled owner: the successor binding is disabled', () => withEnv(env, async () => {
    const t = await preparedTransfer('disabled'), successorHost = randomUUID();
    await acceptWriterTransfer(engine, t.id, t.successor, t.prepared.owner_epoch, t.prepared.manifest.digest, successorHost);
    expect((await getWorktreeBinding(engine, t.id, successorHost))!.git_durability).toBe('disabled');
  }), 120_000);
});
