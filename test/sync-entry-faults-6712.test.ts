/**
 * GBRA-133 (#6712 PR 4b lane F): one odd file never stops a managed source. Each case commits one odd input beside a
 * healthy file, syncs, then commits another healthy file and syncs again.
 *
 * Protects (each red at ed7e8e017, where the source stopped on every rerun and `last_commit` froze):
 * - S-39/S-44/S-53: a NUL byte in a Markdown file (and a UTF-16 save with a byte order mark) failed the admission insert
 *   with 22P05 (`storage_error`); it is held `content_null_bytes` naming the file and line, and with `sync.holds=fail`
 *   the run stops with that typed code instead of `storage_error`.
 * - S-33: a committed file whose Git blob is gone imports from identical working-tree bytes, and is held
 *   `git_object_missing` when the working tree differs.
 * - S-22: an imported file that became a directory (`notes/fd.md/x.md`) stopped the source with
 *   `page_identity_changed`; its page is deleted and the new file imports.
 * - S-63: an unexpected throw while freezing one entry is held `page_write_failed` (origin `freeze`) and re-tested by
 *   the next sync, which imports the file once the fault is gone; a deliberate refusal still stops the run, and a run where
 *   most freezes throw is systemic and stops without holding (guards).
 * - S-64: on Postgres, where bulk groups are on, the same throw in a group follower is held on the follower's own path,
 *   and with `sync.holds=fail` the run stops naming the follower (the group head's path before).
 * - S-60: a `storage_error` that two syncs in a row record on one file with the same message stayed `connection` / `retry`
 *   with `next` = rerun the same sync forever; it is now `page` class and `needs_human`, naming the file. A message that
 *   changes between runs stays a rerun, and the count survives a resumed cursor's repeated observation.
 * - S-61: a pass that stopped in discovery (path `<discovery>`) or on one entry left no cursor and an `open` pass row, so
 *   doctor `managed_sync_blocked` (`readBlockedManagedSyncs`) said nothing was blocked; it lists the stop until a sync succeeds.
 * - S-69: a non-Error rejection (`undefined`) while a pass batches a level's entries was replaced by a TypeError about
 *   `.code`; it now reaches the caller and the failure record as itself (red with the `sync:batch_entries` seam alone).
 * - S-7: a committed file whose name is not valid UTF-8 (a Latin-1 byte) was held `page_write_failed` with a Git error (and
 *   stopped the source before this lane); it is held `path_not_utf8` naming the rename, which clears the hold.
 * - Rename storm: a folder of more than 20 pages moved with git mv tripped the mass-delete valve, which withheld the
 *   old paths' deletes in the first round, so each new path imported as a new page beside its old one ("shares
 *   content_hash ... Indexing both") and the pages lost their ids; each is now a move that keeps its page.
 * The deliberate-refusal, systemic, changing-message and mass-delete guards pass before and after.
 *
 * PGLite here; Postgres through test/e2e/sync-entry-faults-6712-postgres.test.ts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { opError } from '../src/core/ops/contract.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { resolveBulkSettings } from '../src/core/persistence/sync-group.ts';
import { recordManagedSyncFailure } from '../src/core/persistence/sync-failures.ts';
import { readGitSourceHolds } from '../src/core/persistence/sync-holds.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { readSyncStatus } from '../src/core/persistence/sync-status.ts';
import { readBlockedManagedSyncs } from '../src/core/persistence/sync-blocked.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { persistencePostgresTemplate } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const note = (title: string) => `---\ntype: concept\ntitle: ${title}\n---\n\nThe body of ${title}.\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  writeFileSync(join(root, 'notes/seed.md'), note('notes/seed')); writeFileSync(join(root, 'notes/fd.md'), note('notes/fd'));
  commit(root, 'seed');
};
const live = async (engine: BrainEngine) => (await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE source_id='default' AND deleted_at IS NULL ORDER BY slug")).map(row => row.slug);
const holds = async (engine: BrainEngine) => ((await readGitSourceHolds(engine, { sourceIds: ['default'] }))[0]?.holds ?? []);
const atHead = async (engine: BrainEngine, root: string) => (await engine.executeRaw<{ c: string | null }>("SELECT last_commit AS c FROM sources WHERE id='default'"))[0]!.c === git(root, 'rev-parse', 'HEAD');
const dropBlob = (root: string, path: string) => { const oid = git(root, 'rev-parse', `HEAD:${path}`); rmSync(join(root, '.git/objects', oid.slice(0, 2), oid.slice(2))); return oid; };
/** The odd commit beside a healthy file, the sync, then a later healthy commit and its sync: the source keeps moving. */
async function oddThenHealthy(engine: BrainEngine, root: string, odd: () => void, committed: () => void = () => {}, beforeNext: () => void = () => {}) {
  expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
  writeFileSync(join(root, 'notes/ok.md'), note('notes/ok'));
  odd(); commit(root, 'odd'); committed();
  const first = await performManagedSync(engine, OPTS);
  expect(await atHead(engine, root)).toBe(true);
  beforeNext();
  writeFileSync(join(root, 'notes/ok2.md'), note('notes/ok2')); commit(root, 'ok2');
  const second = await performManagedSync(engine, OPTS);
  expect(second.status).toBe('synced');
  expect(await atHead(engine, root)).toBe(true);
  return first;
}
afterEach(() => installFaultHook(undefined));

for (const backend of testBackends()) describe(`[${backend}] GBRA-133: one odd file never stops a managed source`, () => {
  const databaseUrl = backend === 'postgres' ? process.env.DATABASE_URL : undefined;
  let template: Awaited<ReturnType<typeof persistencePostgresTemplate>> | undefined;
  beforeAll(async () => { if (databaseUrl) template = await persistencePostgresTemplate(databaseUrl); }, 120_000);
  afterAll(async () => { await template?.dispose(); });
  const brain = (run: Parameters<typeof managedBrain>[0]) => managedBrain(run, { ...(template ? { open: template.clone } : {}), setup });

  test('S-39: a NUL byte in a Markdown file is held content_null_bytes naming the file and line; the rest syncs', () => brain(async ({ engine, root }) => {
    const first = await oddThenHealthy(engine, root, () => writeFileSync(join(root, 'notes/odd.md'), '---\ntitle: odd\n---\nfirst line\nbody\u0000here\n'));
    expect(first.held?.map(hold => [hold.path, hold.code])).toEqual([['notes/odd.md', 'content_null_bytes']]);
    const [hold] = await holds(engine);
    expect(hold).toMatchObject({ path: 'notes/odd.md', code: 'content_null_bytes', meta: { line: 5 } });
    expect(hold!.message).toContain('notes/odd.md holds a NUL byte (U+0000) on line 5');
    expect(await live(engine)).toEqual(['notes/fd', 'notes/ok', 'notes/ok2', 'notes/seed']);
  }), 240_000);

  test('S-53: a UTF-16 save with a byte order mark is held content_null_bytes and told to save as UTF-8', () => brain(async ({ engine, root }) => {
    const first = await oddThenHealthy(engine, root, () => writeFileSync(join(root, 'notes/odd.md'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(note('notes/odd'), 'utf16le')])));
    expect(first.held?.map(hold => [hold.path, hold.code])).toEqual([['notes/odd.md', 'content_null_bytes']]);
    expect((await holds(engine))[0]!.message).toContain('UTF-16');
    expect(await live(engine)).toEqual(['notes/fd', 'notes/ok', 'notes/ok2', 'notes/seed']);
  }), 240_000);

  test('S-39 with sync.holds=fail: the run stops with the typed content_null_bytes refusal, never storage_error', () => brain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await engine.setConfig('sync.holds', 'fail');
    writeFileSync(join(root, 'notes/odd.md'), 'body\u0000here\n'); commit(root, 'odd');
    await expect(performManagedSync(engine, OPTS)).rejects.toMatchObject({ code: 'content_null_bytes' });
  }), 240_000);

  test('S-33: a lost committed blob imports from identical working-tree bytes', () => brain(async ({ engine, root }) => {
    // Whether Git can build the next commit's tree while the index names the lost object depends on index stat timing
    // (racy-git), so the object is restored explicitly after the sync under test, before the next commit.
    const first = await oddThenHealthy(engine, root, () => writeFileSync(join(root, 'notes/odd.md'), note('notes/odd')), () => dropBlob(root, 'notes/odd.md'),
      () => git(root, 'hash-object', '-w', '--', 'notes/odd.md'));
    expect(first.held ?? []).toEqual([]);
    expect(await live(engine)).toEqual(['notes/fd', 'notes/odd', 'notes/ok', 'notes/ok2', 'notes/seed']);
  }), 240_000);

  test('S-33: a lost committed blob whose working-tree copy differs is held git_object_missing; the rest syncs', () => brain(async ({ engine, root }) => {
    // Git itself cannot build a later tree while the index names the lost object, so the rerun (not a new commit) shows the source is not stopped.
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    writeFileSync(join(root, 'notes/ok.md'), note('notes/ok')); writeFileSync(join(root, 'notes/odd.md'), note('notes/odd')); commit(root, 'odd');
    const oid = dropBlob(root, 'notes/odd.md');
    writeFileSync(join(root, 'notes/odd.md'), note('notes/odd edited'));
    git(root, 'update-index', '--assume-unchanged', 'notes/odd.md');
    const first = await performManagedSync(engine, OPTS);
    expect(first.held?.map(hold => [hold.path, hold.code])).toEqual([['notes/odd.md', 'git_object_missing']]);
    expect(await atHead(engine, root)).toBe(true);
    expect((await performManagedSync(engine, OPTS)).status).not.toBe('blocked_by_failures');
    const [hold] = await holds(engine);
    expect(hold).toMatchObject({ code: 'git_object_missing', meta: { blob_oid: oid } });
    expect(hold!.message).toContain('git fsck');
    expect(await live(engine)).toEqual(['notes/fd', 'notes/ok', 'notes/seed']);
  }), 240_000);

  test('S-22: an imported file that became a directory deletes its page and imports the new file', () => brain(async ({ engine, root }) => {
    const first = await oddThenHealthy(engine, root, () => { rmSync(join(root, 'notes/fd.md')); mkdirSync(join(root, 'notes/fd.md')); writeFileSync(join(root, 'notes/fd.md/x.md'), note('notes/x')); });
    expect(first.held ?? []).toEqual([]);
    expect(await live(engine)).toEqual(['notes/fd.md/x', 'notes/ok', 'notes/ok2', 'notes/seed']);
  }), 240_000);

  test('S-63/S-64: an unexpected throw while freezing one file is held page_write_failed on that file; the next sync re-tests and imports it', () => brain(async ({ engine, root }) => {
    let failing = true;
    installFaultHook((point, detail) => { if (failing && point === 'sync:after_freeze' && detail.path === 'notes/b.md') throw new TypeError('synthetic freeze fault'); });
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    for (const name of ['a', 'b', 'c', 'd']) writeFileSync(join(root, `notes/${name}.md`), note(`notes/${name}`));
    commit(root, 'four');
    // The CLI's bulk settings: on for Postgres (b is the first group's follower), off for PGLite.
    const bulk = { ...OPTS, bulk: await resolveBulkSettings(engine, undefined) };
    const first = await performManagedSync(engine, bulk);
    expect(first.held?.map(hold => [hold.path, hold.code])).toEqual([['notes/b.md', 'page_write_failed']]);
    expect(await atHead(engine, root)).toBe(true);
    const [hold] = await holds(engine);
    expect(hold!.meta.write_failure).toMatchObject({ origin: 'freeze', error_class: 'TypeError', request_id: null });
    expect(hold!.message).toContain('synthetic freeze fault');
    expect(await live(engine)).toEqual(['notes/a', 'notes/c', 'notes/d', 'notes/fd', 'notes/seed']);
    failing = false;
    writeFileSync(join(root, 'notes/e.md'), note('notes/e')); commit(root, 'e');
    expect((await performManagedSync(engine, bulk)).status).toBe('synced');
    expect(await live(engine)).toEqual(['notes/a', 'notes/b', 'notes/c', 'notes/d', 'notes/e', 'notes/fd', 'notes/seed']);
    expect(await holds(engine)).toEqual([]);
  }), 240_000);

  test('S-64 with sync.holds=fail: a group follower\'s throw stops the run naming the follower, not the group head', () => brain(async ({ engine, root }) => {
    installFaultHook((point, detail) => { if (point === 'sync:after_freeze' && detail.path === 'notes/b.md') throw new TypeError('synthetic follower fault'); });
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await engine.setConfig('sync.holds', 'fail');
    for (const name of ['a', 'b', 'c', 'd']) writeFileSync(join(root, `notes/${name}.md`), note(`notes/${name}`));
    commit(root, 'four');
    const failure = await performManagedSync(engine, { ...OPTS, bulk: await resolveBulkSettings(engine, undefined) }).then(() => null, (error: Error) => error.message);
    expect(failure).toContain('path=notes/b.md');
    expect(failure).toContain('synthetic follower fault');
  }), 240_000);

  test('S-63 guard: a deliberate refusal thrown while freezing still stops the run and holds nothing', () => brain(async ({ engine, root }) => {
    installFaultHook((point, detail) => { if (point === 'sync:after_freeze' && detail.path === 'notes/b.md') throw opError('plan_stale', 'synthetic deliberate refusal', 'none'); });
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    writeFileSync(join(root, 'notes/b.md'), note('notes/b')); commit(root, 'b');
    await expect(performManagedSync(engine, OPTS)).rejects.toMatchObject({ code: 'plan_stale' });
    expect(await holds(engine)).toEqual([]);
  }), 240_000);

  test('S-63 guard: when most freezes of a run throw, the run is systemic and stops without holding every file', () => brain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    installFaultHook(point => { if (point === 'sync:after_freeze') throw new TypeError('synthetic systemic fault'); });
    for (let i = 0; i < 8; i++) writeFileSync(join(root, `notes/n${i}.md`), note(`notes/n${i}`));
    commit(root, 'eight');
    await expect(performManagedSync(engine, OPTS)).rejects.toThrow('synthetic systemic fault');
    expect((await holds(engine)).length).toBeLessThan(8);
  }), 240_000);
  test('S-60: a storage_error two syncs in a row record on one file with the same message names a person instead of rerunning', () => brain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    writeFileSync(join(root, 'notes/odd.md'), note('notes/odd')); commit(root, 'odd');
    installFaultHook(point => { if (point === 'sync:mid_checkpoint') throw new Error('synthetic deterministic fault'); });
    await expect(performManagedSync(engine, OPTS)).rejects.toThrow('synthetic deterministic fault');
    const once = await readSyncStatus(engine, 'default');
    expect(once.last_error).toMatchObject({ code: 'storage_error', path: 'notes/odd.md', class: 'connection', safe_actions: ['retry'], needs_human: false });
    expect(once.next?.argv?.slice(0, 2)).toEqual(['gbrain', 'sync']);
    await expect(performManagedSync(engine, OPTS)).rejects.toThrow('synthetic deterministic fault');
    const twice = await readSyncStatus(engine, 'default');
    expect(twice.last_error).toMatchObject({ code: 'storage_error', path: 'notes/odd.md', repeats: 2, class: 'page', safe_actions: ['none'], needs_human: true });
    expect(twice.last_error!.human_reason).toContain('notes/odd.md stopped the last 2 syncs with the same storage_error');
    expect([twice.state, twice.reason]).toEqual(['blocked', 'needs_human']);
    expect(twice.next?.argv?.slice(0, 2)).not.toEqual(['gbrain', 'sync']);
    expect(twice.next?.user_message).toContain('notes/odd.md');
    installFaultHook(undefined);
    expect((await performManagedSync(engine, OPTS)).status).toBe('synced');
    expect(await atHead(engine, root)).toBe(true);
    expect((await readSyncStatus(engine, 'default')).last_error).toBeNull();
  }), 240_000);

  test('S-60 guard: a storage_error whose message changes between runs stays a rerun', () => brain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    writeFileSync(join(root, 'notes/odd.md'), note('notes/odd')); commit(root, 'odd');
    let run = 0;
    installFaultHook(point => { if (point === 'sync:mid_checkpoint') throw new Error(`synthetic fault number ${run}`); });
    for (run = 1; run <= 3; run++) await expect(performManagedSync(engine, OPTS)).rejects.toThrow(`synthetic fault number ${run}`);
    expect((await readSyncStatus(engine, 'default')).last_error).toMatchObject({ code: 'storage_error', attempts: 3, class: 'connection', safe_actions: ['retry'], needs_human: false });
  }), 240_000);

  test('S-60: a resumed run recording the same observation counts a new run; one invocation recording it twice does not', () => brain(async ({ engine }) => {
    const base = { source_id: 'default', source_incarnation: '00000000-0000-4000-8000-000000000000', path: 'notes/odd.md', code: 'storage_error', message: 'synthetic',
      request_id: null, run_id: 'run-1', target: 'a'.repeat(40), cursor_key: 'lanef-s60-key', phase: 'freeze' as const, state: 'failed', observation_id: 'run-1:0:freeze:storage_error' };
    expect((await recordManagedSyncFailure(engine, { ...base, invocation: 'one' })).failure.repeats).toBe(1);
    expect((await recordManagedSyncFailure(engine, { ...base, invocation: 'one' })).failure.repeats).toBe(1);
    expect((await recordManagedSyncFailure(engine, { ...base, invocation: 'two' })).failure.repeats).toBe(2);
    expect((await recordManagedSyncFailure(engine, { ...base, invocation: 'three', observation_id: 'run-2:0:freeze:storage_error' })).failure).toMatchObject({ repeats: 3, attempts: 2 });
    expect((await recordManagedSyncFailure(engine, { ...base, invocation: 'four', observation_id: 'run-3:0:freeze:storage_error', path: 'notes/other.md' })).failure).toMatchObject({ repeats: 1, attempts: 3 });
  }), 240_000);
  for (const [stop, point, path] of [['discovery', 'sync:level_read', '<discovery>'], ['entry', 'sync:mid_checkpoint', 'notes/odd.md']] as const) {
    test(`S-61: doctor managed_sync_blocked lists a pass's ${stop} stop until a sync succeeds`, () => brain(async ({ engine, root }) => {
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      writeFileSync(join(root, 'notes/odd.md'), note('notes/odd')); commit(root, 'odd');
      installFaultHook(at => { if (at === point) throw new Error('synthetic stop'); });
      await expect(performManagedSync(engine, OPTS)).rejects.toThrow(`path=${path} code=storage_error: synthetic stop`);
      expect(await readBlockedManagedSyncs(engine, ['default'])).toEqual([expect.objectContaining({ source_id: 'default', code: 'storage_error' })]);
      installFaultHook(undefined);
      expect((await performManagedSync(engine, OPTS)).status).toBe('synced');
      expect(await readBlockedManagedSyncs(engine, ['default'])).toEqual([]);
    }), 240_000);
  }
  test('S-69: a non-Error rejection while a pass batches its entries reaches the caller as itself, not as a TypeError about .code', () => brain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    writeFileSync(join(root, 'notes/odd.md'), note('notes/odd')); commit(root, 'odd');
    installFaultHook(point => { if (point === 'sync:batch_entries') throw undefined; });
    expect(await performManagedSync(engine, OPTS).then(() => 'resolved', (error: unknown) => error)).toBeUndefined();
    expect((await readSyncStatus(engine, 'default')).last_error).toMatchObject({ code: 'storage_error', path: '<discovery>', message: 'undefined' });
  }), 240_000);
  const latin1 = (root: string) => Buffer.concat([Buffer.from(join(root, 'notes/caf')), Buffer.from([0xe9]), Buffer.from('.md')]);
  test('S-7: a committed file whose name is not valid UTF-8 is held path_not_utf8 naming the rename; the rename imports it', () => brain(async ({ engine, root }) => {
    const first = await oddThenHealthy(engine, root, () => writeFileSync(latin1(root), note('notes/cafe')));
    expect(first.held?.map(hold => [hold.path, hold.code])).toEqual([['notes/caf\uFFFD.md', 'path_not_utf8']]);
    const [hold] = await holds(engine);
    expect(hold!.message).toContain('Rename it to a UTF-8 name');
    expect(await live(engine)).toEqual(['notes/fd', 'notes/ok', 'notes/ok2', 'notes/seed']);
    renameSync(latin1(root), join(root, 'notes/cafe.md')); commit(root, 'rename');
    expect((await performManagedSync(engine, OPTS)).status).toBe('synced');
    expect(await holds(engine)).toEqual([]);
    expect(await live(engine)).toEqual(['notes/cafe', 'notes/fd', 'notes/ok', 'notes/ok2', 'notes/seed']);
  }), 240_000);

  test('S-7 with sync.holds=fail: the run stops with the typed path_not_utf8 refusal', () => brain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await engine.setConfig('sync.holds', 'fail');
    writeFileSync(latin1(root), note('notes/cafe')); commit(root, 'odd');
    await expect(performManagedSync(engine, OPTS)).rejects.toMatchObject({ code: 'path_not_utf8' });
  }), 240_000);
  const ids = async (engine: BrainEngine, prefix: string) => (await engine.executeRaw<{ id: number | string; slug: string }>(
    "SELECT id, slug FROM pages WHERE source_id='default' AND deleted_at IS NULL AND slug LIKE $1 ORDER BY slug", [`${prefix}/%`])).map(row => [Number(row.id), row.slug.slice(prefix.length + 1)]);
  const folder = (root: string, name: string, n: number, body = (i: number) => `# Note ${i}\n\nSynthetic body number ${i}.\n`) => {
    mkdirSync(join(root, name), { recursive: true });
    for (let i = 0; i < n; i++) writeFileSync(join(root, `${name}/n${i}.md`), body(i));
  };
  test('rename storm: a folder of 30 pages moved with git mv keeps every page and indexes nothing twice', () => brain(async ({ engine, root }) => {
    folder(root, 'bulk', 30); commit(root, 'bulk');
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    const before = await ids(engine, 'bulk');
    git(root, 'mv', 'bulk', 'moved'); commit(root, 'mv');
    const warned: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: never[]) => { warned.push(String(chunk)); return write(chunk, ...rest); }) as typeof process.stderr.write;
    const moved = await performManagedSync(engine, OPTS).finally(() => { process.stderr.write = write; });
    expect(moved).toMatchObject({ status: 'synced', renamed: 30, added: 0, deleted: 0 });
    expect(warned.filter(line => line.includes('shares content_hash'))).toEqual([]);
    expect(await ids(engine, 'moved')).toEqual(before);
    expect(await ids(engine, 'bulk')).toEqual([]);
    expect(await atHead(engine, root)).toBe(true);
  }), 240_000);

  test('rename storm guard: 30 pages deleted with nothing arriving is still a withheld mass delete', () => brain(async ({ engine, root }) => {
    folder(root, 'bulk', 30); commit(root, 'bulk');
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    git(root, 'rm', '-rq', 'bulk'); commit(root, 'rm');
    await performManagedSync(engine, OPTS);
    expect((await ids(engine, 'bulk')).length).toBe(30);
    const convergence = (await readSyncStatus(engine, 'default')).convergence;
    expect(convergence && 'deletes_withheld' in convergence ? convergence.deletes_withheld?.count : null).toBe(30);
  }), 240_000);

  test('rename storm guard: 30 pages deleted while 30 different files arrive are deletes and adds, never renames', () => brain(async ({ engine, root }) => {
    folder(root, 'bulk', 30); commit(root, 'bulk');
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    git(root, 'rm', '-rq', 'bulk'); folder(root, 'other', 30, i => `# Other ${i}\n\nA different synthetic body ${i}.\n`); commit(root, 'swap');
    expect(await performManagedSync(engine, OPTS)).toMatchObject({ renamed: 0, added: 30 });
    expect((await ids(engine, 'other')).length).toBe(30);
  }), 240_000);
});
