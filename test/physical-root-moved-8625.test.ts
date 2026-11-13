/**
 * #8625: a managed checkout moved to a new path. Before, the `add` and `set-path` dry runs said OK while the real
 * runs refused with a generic identity error (`add`) or `source_checkout_missing` (`set-path`), and neither named the
 * exit that already works. Now both refuse with detail `physical_root_moved`, naming the recorded path, the worktree
 * and the exact commands (symlink then `set-path` for a bound worktree; move back then `add` for one whose source was
 * removed; restore or deactivate when the folder is not the same directory any more). Nothing changes ownership:
 * the existing verbs still verify everything, and a remote caller sees no path.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Action } from '../src/core/agent-output.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { PHYSICAL_ROOT_MARKER, physicalRootReservationPath } from '../src/core/persistence/physical-root-record.ts';
import { runManagedSourceLifecycle } from '../src/core/persistence/source-lifecycle.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { runSetPath } from '../src/commands/sources-set-path.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';

type Refusal = { code?: string; detail?: string; message?: string; suggestion?: string; docs?: string; fix?: Action };
const refusal = (promise: Promise<unknown>): Promise<Refusal | null> => promise.then(() => null, (error: Refusal) => error);
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

for (const kind of testBackends()) describe(`#8625 a moved managed checkout names its way back (${kind})`, () => {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'gbrain-moved-root-')));
  let engine: BrainEngine, close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
  }, 120_000);
  afterAll(async () => {
    await withEnv({ GBRAIN_HOME: directory }, () => disposePersistenceConsumer(engine));
    if (close) await close(); else await engine.disconnect();
    rmSync(directory, { recursive: true, force: true });
  });

  interface Fixture { home: string; base: string; root: string; source: string; worktreeId: string; members: string[] }
  /** Sources claimed before activation in one checkout at `<base>/<parent>/root` (a Git checkout unless `git: false`), then the brain activated. */
  async function fixture(opts: { git?: boolean; parent?: string; members?: string[] }, run: (f: Fixture) => Promise<void>): Promise<void> {
    const home = join(directory, randomUUID()), base = join(home, 'brains'), root = join(base, opts.parent ?? 'old', 'root');
    const tag = randomUUID().slice(0, 8), subs = opts.members ?? [''];
    for (const sub of subs) { mkdirSync(join(root, sub), { recursive: true }); writeFileSync(join(root, sub, 'alice-example.md'), '# Alice Example\n\nA note.\n'); }
    if (opts.git !== false) {
      git(root, 'init', '-q', '-b', 'main'); git(root, 'config', 'user.name', 'Example'); git(root, 'config', 'user.email', 'example@example.invalid');
      git(root, 'config', 'commit.gpgsign', 'false'); git(root, 'add', '-A'); git(root, 'commit', '-qm', 'init');
    }
    await withEnv({ GBRAIN_HOME: home, GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: undefined }, async () => {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      const ids = subs.map((_, i) => `moved-${tag}-${i}`);
      for (const [i, sub] of subs.entries()) {
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [ids[i], join(root, sub)]);
        await claimWorktree(engine, ids[i], join(root, sub));
      }
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      await registerLocalWriter(engine, 'cli');
      const worktreeId = (await getWorktreeBinding(engine, ids[0]))!.worktree_id;
      try { await run({ home, base, root, source: ids[0], worktreeId, members: ids }); }
      finally { await disposePersistenceConsumer(engine); }
    });
  }
  const add = (sourceId: string, path: string, dryRun = false) => runManagedSourceLifecycle(engine, { operation: 'add', sourceId, path, dryRun });
  const setPath = (sourceId: string, path: string, dryRun = false) => runManagedSourceLifecycle(engine, { operation: 'rebind', sourceId, path, dryRun });
  const remove = (sourceId: string) => runManagedSourceLifecycle(engine, { operation: 'remove', sourceId, confirmDestructive: true });
  const generation = async (id: string) => Number((await engine.executeRaw<{ g: string }>('SELECT topology_generation::text AS g FROM persistence_worktrees WHERE id=$1::uuid', [id]))[0].g);
  const hostPath = async (id: string) => (await engine.executeRaw<{ local_path: string }>('SELECT local_path FROM persistence_host_bindings WHERE worktree_id=$1::uuid', [id]))[0]?.local_path;
  const state = async () => ({
    changes: (await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM persistence_topology_changes'))[0].n,
    bindings: await engine.executeRaw('SELECT * FROM persistence_source_bindings ORDER BY source_id'),
    hosts: await engine.executeRaw('SELECT worktree_id,local_path,coordination_path FROM persistence_host_bindings ORDER BY worktree_id'),
    sources: await engine.executeRaw('SELECT id,local_path FROM sources ORDER BY id'),
  });
  /** Runs a refusal's fix chain as an operator would once the user agreed: plain commands as argv, gbrain steps through the lifecycle. */
  async function runFix(fix: Action | undefined): Promise<void> {
    for (let step = fix; step; step = step.then) {
      const argv = step.argv!;
      if (argv[0] !== 'gbrain') { execFileSync(argv[0], argv.slice(1)); continue; }
      const path = argv.includes('--path') ? argv[argv.indexOf('--path') + 1] : argv[4];
      if (argv[2] === 'add') await add(argv[3], path);
      else if (argv[2] === 'set-path') await setPath(argv[3], path);
      else throw new Error(`unexpected fix step: ${argv.join(' ')}`);
    }
  }
  const expectMoved = (error: Refusal | null, recorded: string, worktreeId: string) => {
    expect(error).toMatchObject({ code: 'recovery_required', detail: 'physical_root_moved' });
    expect(error!.message).toContain(recorded);
    expect(error!.message).toContain(worktreeId);
    expect(error!.suggestion).toContain('Never remove the ownership markers');
    expect(error!.fix).toMatchObject({ ask_user: true, actor: 'user' });
    expect(typeof error!.fix!.user_message).toBe('string');
    expect(error!.fix!.verify?.argv).toContain('--dry-run');
  };
  const expectGeneric = (error: Refusal | null) => {
    expect(error).toMatchObject({ code: 'recovery_required' });
    expect(error!.detail).toBeUndefined();
  };

  test('pin: remove then add at the same root keeps the worktree id, advances its topology and keeps Git history', () => fixture({}, async f => {
    const head = git(f.root, 'rev-parse', 'HEAD'), before = await generation(f.worktreeId);
    await remove(f.source);
    await add(`${f.source}-b`, f.root);
    expect((await getWorktreeBinding(engine, `${f.source}-b`))!.worktree_id).toBe(f.worktreeId);
    expect(await generation(f.worktreeId)).toBe(before + 2);
    expect(git(f.root, 'rev-parse', 'HEAD')).toBe(head);
  }), 120_000);

  for (const repo of [true, false]) test(`removed source, folder moved (${repo ? 'Git checkout' : 'repo-less directory'}): add and its dry run refuse physical_root_moved, write nothing, and the exit converges`, () => fixture({ git: repo }, async f => {
    const head = repo ? git(f.root, 'rev-parse', 'HEAD') : null, bytes = readFileSync(join(f.root, 'alice-example.md'), 'utf8');
    await remove(f.source);
    const moved = join(f.base, 'moved-root'), next = `${f.source}-b`;
    renameSync(f.root, moved);
    const stampBytes = readFileSync(join(moved, PHYSICAL_ROOT_MARKER), 'utf8'), reservationBytes = readFileSync(physicalRootReservationPath(f.root), 'utf8');
    const before = await state();
    const preview = await refusal(add(next, moved, true));
    expectMoved(preview, f.root, f.worktreeId);
    expect(preview!.suggestion).toContain(`mv '${moved}' '${f.root}'`);
    const real = await refusal(add(next, moved));
    expectMoved(real, f.root, f.worktreeId);
    expect(real!.fix).toEqual(preview!.fix);
    expect(readFileSync(join(moved, PHYSICAL_ROOT_MARKER), 'utf8')).toBe(stampBytes);
    expect(readFileSync(physicalRootReservationPath(f.root), 'utf8')).toBe(reservationBytes);
    expect(existsSync(physicalRootReservationPath(moved))).toBe(false);
    expect(await state()).toEqual(before);

    // The printed exit: move back and re-add at the recorded path, which reattaches the worktree; its verify then passes.
    await runFix(real!.fix);
    expect((await getWorktreeBinding(engine, next))!.worktree_id).toBe(f.worktreeId);
    await runManagedSourceLifecycle(engine, { operation: 'add', sourceId: next, path: f.root, dryRun: true });
    // Moving it to the new place again names the bound (symlink) exit, which keeps it too.
    renameSync(f.root, moved);
    const bound = await refusal(setPath(next, moved, true));
    expectMoved(bound, f.root, f.worktreeId);
    await runFix(bound!.fix);
    expect(existsSync(f.root)).toBe(false);
    expect(await getWorktreeBinding(engine, next)).toMatchObject({ worktree_id: f.worktreeId, local_path: moved });
    expect(readFileSync(join(moved, 'alice-example.md'), 'utf8')).toBe(bytes);
    if (head) expect(git(moved, 'rev-parse', 'HEAD')).toBe(head);
  }), 120_000);

  test('bound source, folder moved: set-path and its dry run refuse physical_root_moved; the symlink exit keeps the worktree', () => fixture({}, async f => {
    const moved = join(f.base, 'renamed');
    renameSync(f.root, moved);
    const reservationBytes = readFileSync(physicalRootReservationPath(f.root), 'utf8'), before = await state();
    const preview = await refusal(setPath(f.source, moved, true));
    expectMoved(preview, f.root, f.worktreeId);
    expect(preview!.suggestion).toContain(`ln -s '${moved}' '${f.root}'`);
    const real = await refusal(setPath(f.source, moved));
    expectMoved(real, f.root, f.worktreeId);
    expect(readFileSync(physicalRootReservationPath(f.root), 'utf8')).toBe(reservationBytes);
    expect(await state()).toEqual(before);
    await runFix(real!.fix);
    expect(existsSync(f.root)).toBe(false);
    expect(await getWorktreeBinding(engine, f.source)).toMatchObject({ worktree_id: f.worktreeId, local_path: moved });
    expect(existsSync(physicalRootReservationPath(f.root))).toBe(false);
    expect(existsSync(physicalRootReservationPath(moved))).toBe(true);
    await setPath(f.source, moved, true);
  }), 120_000);

  test('a bound checkout that is missing but not moved still refuses source_checkout_missing, in the dry run too', () => fixture({}, async f => {
    rmSync(f.root, { recursive: true, force: true });
    const other = join(f.base, 'elsewhere'); mkdirSync(other);
    for (const dryRun of [true, false]) {
      const error = await refusal(setPath(f.source, other, dryRun));
      expect(error).toMatchObject({ code: 'recovery_required', docs: 'docs/guides/write-refusals.md#source_checkout_missing' });
      expect(error!.message).toContain(`The canonical checkout ${f.root} of source '${f.source}' is missing`);
    }
  }), 120_000);

  for (const bound of [true, false]) test(`a renamed parent folder (${bound ? 'bound' : 'removed source'}) names the parent, and its exit converges`, () => fixture({ parent: 'parent-old' }, async f => {
    if (!bound) await remove(f.source);
    const from = join(f.base, 'parent-old'), to = join(f.base, 'parent-new'), moved = join(to, 'root'), sourceId = bound ? f.source : `${f.source}-b`;
    renameSync(from, to);
    const error = await refusal(bound ? setPath(sourceId, moved, true) : add(sourceId, moved, true));
    expectMoved(error, f.root, f.worktreeId);
    expect(error!.message).toContain(`'${from}'`);
    expect(error!.fix!.argv).toEqual(bound ? ['ln', '-s', to, from] : ['mv', to, from]);
    await runFix(error!.fix);
    expect(await getWorktreeBinding(engine, sourceId)).toMatchObject({ worktree_id: f.worktreeId, local_path: bound ? moved : f.root });
    expect(existsSync(from)).toBe(!bound);
  }), 120_000);

  for (const bound of [true, false]) test(`a parent moved under another folder with the same name (${bound ? 'bound' : 'removed source'}) names that parent, never the folders that held it`, () => fixture({ parent: join('left', 'group') }, async f => {
    if (!bound) await remove(f.source);
    const from = join(f.base, 'left', 'group'), to = join(f.base, 'right', 'group'), moved = join(to, 'root'), sourceId = bound ? f.source : `${f.source}-b`;
    mkdirSync(join(f.base, 'right'));
    renameSync(from, to);
    const error = await refusal(bound ? setPath(sourceId, moved, true) : add(sourceId, moved, true));
    expectMoved(error, f.root, f.worktreeId);
    expect(error!.message).toContain(`'${from}'`);
    expect(error!.fix!.argv).toEqual(bound ? ['ln', '-s', to, from] : ['mv', to, from]);
    await runFix(error!.fix);
    expect(await getWorktreeBinding(engine, sourceId)).toMatchObject({ worktree_id: f.worktreeId, local_path: bound ? moved : f.root });
    expect(existsSync(join(f.base, 'right'))).toBe(true);
  }), 120_000);

  test('a copy with a new inode whose original was deleted names restore or deactivate, never a move back', () => fixture({}, async f => {
    await remove(f.source);
    const copy = join(f.base, 'copied-root');
    cpSync(f.root, copy, { recursive: true, preserveTimestamps: true });
    rmSync(f.root, { recursive: true, force: true });
    for (const dryRun of [true, false]) {
      const error = await refusal(add(`${f.source}-b`, copy, dryRun));
      expect(error).toMatchObject({ code: 'recovery_required', detail: 'physical_root_moved' });
      expect(error!.message).toContain(f.root);
      expect(error!.suggestion).toContain('gbrain sources writer deactivate --dry-run');
      expect(error!.suggestion).not.toContain('mv ');
      expect(error!.fix!.argv).toEqual(['gbrain', 'sources', 'writer', 'deactivate', '--dry-run']);
    }
  }), 120_000);

  test('a worktree with two sources names a set-path for each, and both land at the new path', () => fixture({ members: ['notes', 'people'] }, async f => {
    const moved = join(f.base, 'renamed');
    renameSync(f.root, moved);
    const error = await refusal(setPath(f.source, join(moved, 'notes')));
    expectMoved(error, f.root, f.worktreeId);
    for (const id of f.members) expect(error!.message).toContain(id);
    await runFix(error!.fix);
    const paths = await engine.executeRaw<{ id: string; local_path: string }>('SELECT id,local_path FROM sources WHERE id=ANY($1::text[]) ORDER BY id', [f.members]);
    expect(paths).toEqual([{ id: f.members[0], local_path: join(moved, 'notes') }, { id: f.members[1], local_path: join(moved, 'people') }]);
    expect(await hostPath(f.worktreeId)).toBe(moved);
  }), 120_000);

  test('writer claim --dry-run refuses a moved checkout like the add does', () => fixture({}, async f => {
    await remove(f.source);
    const moved = join(f.base, 'moved-root'), id = `${f.source}-c`;
    renameSync(f.root, moved);
    await runManagedSourceLifecycle(engine, { operation: 'add', sourceId: id });
    expectMoved(await refusal(runPersistenceAdministration(engine, 'writer_claim', { source_id: id, path: moved, dry_run: true })), f.root, f.worktreeId);
  }), 120_000);

  test('lookalikes keep the generic refusal: another brain, another token, a copy, another host, no reservation', () => fixture({}, async f => {
    await remove(f.source);
    const moved = join(f.base, 'moved-root'), stamp = join(moved, PHYSICAL_ROOT_MARKER), reservation = physicalRootReservationPath(f.root);
    renameSync(f.root, moved);
    const original = { stamp: readFileSync(stamp, 'utf8'), reservation: readFileSync(reservation, 'utf8') };
    const put = (path: string, bytes: string) => { rmSync(path, { force: true }); writeFileSync(path, bytes, { mode: 0o600 }); };
    const patch = (path: string, fields: Record<string, unknown>) => put(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), ...fields }));
    const restore = () => { put(stamp, original.stamp); put(reservation, original.reservation); };
    const check = async () => { for (const dryRun of [true, false]) expectGeneric(await refusal(add(`${f.source}-b`, moved, dryRun))); };
    const brainId = randomUUID();
    patch(stamp, { brainId }); patch(reservation, { brainId }); await check(); restore();
    patch(stamp, { token: randomUUID() }); await check(); restore();
    mkdirSync(f.root); await check(); rmSync(f.root, { recursive: true });
    const [{ owner }] = await engine.executeRaw<{ owner: string }>('SELECT owner_host_id::text AS owner FROM persistence_worktrees WHERE id=$1::uuid', [f.worktreeId]);
    await engine.executeRaw('UPDATE persistence_worktrees SET owner_host_id=$2::uuid WHERE id=$1::uuid', [f.worktreeId, randomUUID()]); await check();
    await engine.executeRaw('UPDATE persistence_worktrees SET owner_host_id=$2::uuid WHERE id=$1::uuid', [f.worktreeId, owner]);
    unlinkSync(reservation); await check();
  }), 120_000);

  test('a stamp other users can read after the move refuses ownership_record_not_private', () => fixture({}, async f => {
    await remove(f.source);
    const moved = join(f.base, 'moved-root');
    renameSync(f.root, moved);
    chmodSync(join(moved, PHYSICAL_ROOT_MARKER), 0o644);
    for (const dryRun of [true, false]) expect(await refusal(add(`${f.source}-b`, moved, dryRun))).toMatchObject({ code: 'recovery_required', detail: 'ownership_record_not_private' });
  }), 120_000);

  test('repo-less classic brain: a moved folder is a plain set-path, unchanged', async () => {
    const home = join(directory, randomUUID()), root = join(home, 'notes'), moved = join(home, 'notes-moved'); mkdirSync(root, { recursive: true });
    const source = `classic-${randomUUID().slice(0, 8)}`;
    await withEnv({ GBRAIN_HOME: home, GBRAIN_SOURCE: undefined }, async () => {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [source, root]);
      renameSync(root, moved);
      await runSetPath(engine, [source, moved]);
      expect((await engine.executeRaw<{ local_path: string }>('SELECT local_path FROM sources WHERE id=$1', [source]))[0].local_path).toBe(moved);
    });
  }, 60_000);
});

if (testBackends().includes('pglite')) describe('#8625 a remote page write never sees the moved checkout\'s paths (pglite, pre-activation)', () => {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'gbrain-moved-remote-')));
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
  afterAll(async () => { await withEnv({ GBRAIN_HOME: directory }, () => disposePersistenceConsumer(engine)); await engine.disconnect(); rmSync(directory, { recursive: true, force: true }); });

  test('remote put_page to a source whose folder holds a moved stamp refuses without a path or worktree id', async () => {
    const home = join(directory, 'home'), root = join(directory, 'brains', 'old-root'), moved = join(directory, 'brains', 'new-root');
    mkdirSync(root, { recursive: true });
    await withEnv({ GBRAIN_HOME: home, GBRAIN_SOURCE: undefined }, async () => {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.setConfig('sync.write_through', 'true');
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', ['source-a', root]);
      const worktreeId = (await claimWorktree(engine, 'source-a', root)).worktree_id;
      await engine.executeRaw("DELETE FROM persistence_source_bindings WHERE source_id='source-a'");
      await engine.executeRaw("DELETE FROM sources WHERE id='source-a'");
      renameSync(root, moved);
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', ['source-b', moved]);
      const result = await dispatchToolCall(engine, 'put_page', { slug: 'notes/alice-example', content: '---\ntype: note\ntitle: Alice Example\n---\n# Alice Example\n' },
        { remote: true, transport: 'stdio', sourceId: 'source-b', admissionOrigin: 'interactive' });
      expect(result.isError).toBe(true);
      const text = result.content[0]!.text;
      expect(JSON.parse(text)).toMatchObject({ code: 'recovery_required', detail: 'physical_root_moved' });
      for (const secret of [directory, root, moved, worktreeId]) expect(text).not.toContain(secret);
      expect(existsSync(join(moved, 'notes'))).toBe(false);
    });
  }, 120_000);
});

if (testBackends().includes('pglite')) describe('#8625 a remote page write never sees the moved checkout\'s paths (pglite, activated brain)', () => {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'gbrain-moved-remote-active-')));
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
  afterAll(async () => { await engine.disconnect(); rmSync(directory, { recursive: true, force: true }); });

  test('remote put_page to an unbound source above a moved bound checkout refuses without a path or worktree id', async () => {
    const home = join(directory, 'home'), parent = join(directory, 'brains', 'a'), root = join(parent, 'brain'), aside = join(directory, 'brains', 'aside');
    mkdirSync(root, { recursive: true }); writeFileSync(join(root, 'alice-example.md'), '# Alice Example\n\nA note.\n');
    await withEnv({ GBRAIN_HOME: home, GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: undefined }, async () => {
      try {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', ['source-a', root]);
        const worktreeId = (await claimWorktree(engine, 'source-a', root)).worktree_id;
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', ['source-b', parent]);
        await engine.setConfig('sync.write_through', 'true');
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        await registerLocalWriter(engine, 'cli');
        renameSync(root, aside); rmSync(parent, { recursive: true }); renameSync(aside, parent);
        const result = await dispatchToolCall(engine, 'put_page', { slug: 'notes/alice-example', content: '---\ntype: note\ntitle: Alice Example\n---\n# Alice Example\n' },
          { remote: true, transport: 'stdio', sourceId: 'source-b', admissionOrigin: 'interactive' });
        expect(result.isError).toBe(true);
        const text = result.content[0]!.text;
        expect(JSON.parse(text)).toMatchObject({ code: 'recovery_required' });
        for (const secret of [directory, root, parent, worktreeId]) expect(text).not.toContain(secret);
        expect(existsSync(join(parent, 'notes'))).toBe(false);
      } finally { await disposePersistenceConsumer(engine); }
    });
  }, 120_000);
});
