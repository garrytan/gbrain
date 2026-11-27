/**
 * #10122: the managed-root registry resolved every recorded root with realpath and tolerated only ENOENT, so an old
 * recorded root under a directory this user cannot traverse (EACCES/EPERM, typical after a transfer to a host that runs
 * gbrain as another OS user) aborted `transfer accept` (its managed-root refresh rolled the accept back) and every
 * reader of the registry (doctor: "Managed-root ownership records are unreadable", with no file or cause). Such a
 * root now keeps fencing by its literal path; any other failure still refuses, naming the record file and the cause.
 *
 * Synthetic content only. PGLite. The permission cases need a non-root user (root traverses a 0000 directory).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configDir } from '../src/core/config.ts';
import { acceptWriterTransfer, claimWorktree, getWorktreeBinding, prepareWriterTransfer } from '../src/core/persistence/ownership.ts';
import { canonicalManagedRoots, recordManagedRoots, registeredManagedRootRecords } from '../src/core/persistence/root-registry.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const unprivileged = process.getuid?.() !== 0;

describe('#10122 managed-root registry and untraversable recorded roots', () => {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'gbrain-root-eacces-10122-')));
  const locked: string[] = [];
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
  afterAll(async () => {
    for (const path of locked) chmodSync(path, 0o700);
    await withEnv({ GBRAIN_HOME: directory }, () => disposePersistenceConsumer(engine));
    await engine.disconnect();
    rmSync(directory, { recursive: true, force: true });
  });
  const env = () => ({ GBRAIN_HOME: join(directory, `home-${randomUUID().slice(0, 8)}`), GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: undefined });
  /** A root inside a directory this user can no longer traverse. */
  function lockedRoot(): { parent: string; root: string } {
    const parent = join(directory, `locked-${randomUUID().slice(0, 8)}`), root = join(parent, 'old-root');
    mkdirSync(root, { recursive: true });
    return { parent, root };
  }
  const lock = (parent: string) => { chmodSync(parent, 0o000); locked.push(parent); };

  test.if(unprivileged)('a root under an untraversable parent canonicalizes to its literal path instead of throwing EACCES', () => {
    const { parent, root } = lockedRoot();
    lock(parent);
    expect(canonicalManagedRoots([{ local_path: root, source_id: 'source-a' }])).toEqual([{ local_path: root, source_id: 'source-a' }]);
  });

  test.if(unprivileged)('a registry record for an untraversable root stays readable and keeps fencing its literal path', () => withEnv(env(), () => {
    const { parent, root } = lockedRoot();
    recordManagedRoots(randomUUID(), [{ local_path: root, source_id: 'source-a' }]);
    lock(parent);
    expect(registeredManagedRootRecords()).toEqual([{ root, source_id: 'source-a' }]);
  }));

  test('an unreadable registry record refuses naming the record file and the cause', () => withEnv(env(), () => {
    recordManagedRoots(randomUUID(), [{ local_path: join(directory, 'some-root'), source_id: 'source-a' }]);
    const registry = join(configDir(), 'persistence', 'managed-roots');
    const [file] = readdirSync(registry);
    writeFileSync(join(registry, file!), '{ not json');
    let error: any;
    try { registeredManagedRootRecords(); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: 'writer_coordinator_required', message: 'Managed-root ownership records are unreadable.' });
    expect(error.suggestion).toContain(join(registry, file!));
    expect(error.suggestion).toMatch(/JSON/);
  }));

  test.if(unprivileged)('transfer accept succeeds when the old recorded root is no longer traversable on the successor', () => withEnv(env(), async () => {
    const { parent, root } = lockedRoot();
    const id = `eacces-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    mkdirSync(join(root, 'notes'));
    writeFileSync(join(root, 'notes', 'alice-example.md'), '---\ntitle: Alice Example\ntype: note\n---\nA synthetic observation.\n');
    git(root, 'init', '-q', '-b', 'main'); git(root, 'add', '-A');
    git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'fixture');
    const ownerHost = randomUUID(), successorHost = randomUUID();
    await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)', [id, root, '{}']);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await claimWorktree(engine, id, root, ownerHost);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const prepared = await prepareWriterTransfer(engine, id, ownerHost);
    const successor = join(directory, `${id}-successor`);
    cpSync(root, successor, { recursive: true });
    lock(parent);
    await acceptWriterTransfer(engine, id, successor, prepared.owner_epoch, prepared.manifest.digest, successorHost);
    expect((await getWorktreeBinding(engine, id, successorHost))).toMatchObject({ owner_host_id: successorHost, local_path: successor });
    expect(registeredManagedRootRecords().map(record => record.root)).toContain(root);
  }), 120_000);
});
