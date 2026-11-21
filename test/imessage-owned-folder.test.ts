/**
 * GST-3022: on a personal, unmanaged brain whose default source is a Git checkout, an imessage source keeps its chat-day
 * pages as files under `.gbrain-owned/<id>/` in that checkout, one commit per run, written before the database rows.
 * Synthetic helper (test/helpers/imessage-helper-fixture.ts); no network, no Mac, no real messages.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { BrainEngine } from '../src/core/engine.ts';
import { connectTemplateBrain } from './helpers/brain-template.ts';
import { options } from './helpers/connector-fixture.ts';
import { HELPER_TEST_TOKEN, helperFetch, type FakeHelper } from './helpers/imessage-helper-fixture.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { runIMessageSync, type IMessageState } from '../src/core/imessage/imessage-source.ts';
import { parseIMessageSourceConfig } from '../src/core/imessage/source-config.ts';
import { imessageHelper } from '../src/core/apple/helper-client.ts';
import { imessageChatKey, imessagePagePath } from '../src/core/imessage/render.ts';
import { connectorDbCursorKey, readConnectorDbCursor, writeConnectorDbCursor } from '../src/core/connectors/db-cursor.ts';
import { connectorIdentity } from '../src/core/persistence/connector-identity.ts';
import { withEnv } from './helpers/with-env.ts';
import { readPagesIn, pagesInLine } from '../src/core/owned-folder/status.ts';
import { rebindOwnedSource } from '../src/commands/sources-rebind.ts';
import { removeSource } from '../src/core/sources-ops.ts';
import { purgeExpiredSources } from '../src/core/destructive-guard.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { resolveOwnedDestination } from '../src/core/owned-folder/destination.ts';
import { slugifyPath } from '../src/core/sync.ts';
import { redactUnpushed, spoolSealer, type RedactOutcome } from '../src/core/git/redact-unpushed.ts';
import { ownedStateKey, readOwnedState, writeOwnedState } from '../src/core/owned-folder/writer.ts';
import { syncLockId, tryAcquireDbLock } from '../src/core/db-lock.ts';

const DAY = 86_400_000;
const NOW = Date.parse('2026-06-15T12:00:00Z');
const at = (daysAgo: number, hour: number) => Date.parse(new Date(NOW - daysAgo * DAY).toISOString().slice(0, 10) + `T${String(hour).padStart(2, '0')}:00:00Z`);
const dayOf = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString().slice(0, 10);
const ALICE = '+15555550100';
const GROUP = 'chat000000000000000001';

function mac(): FakeHelper {
  return { token: HELPER_TEST_TOKEN, calls: [], chats: [
    { threadId: ALICE, displayName: 'Alice Example', participants: [ALICE], messages: [
      { rowid: 10, at: at(2, 9), text: 'Lunch at noon tomorrow?' },
      { rowid: 11, at: at(2, 10), text: 'Yes, see you there.', fromMe: true },
      { rowid: 12, at: at(1, 8), text: 'Running ten minutes late.' },
    ] },
    { threadId: GROUP, displayName: 'Harbor Planning', participants: [ALICE, '+15555550101'], isGroup: true, messages: [
      { rowid: 20, at: at(1, 13), text: 'The venue is booked.', from: 'Bob Example' },
    ] },
  ] };
}

setDefaultTimeout(60_000);

const git = (cwd: string, ...args: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8' });
const commits = (repo: string) => Number(git(repo, 'rev-list', '--count', 'HEAD').stdout.trim());

let home: string;
let engine: BrainEngine;
beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-owned-'));
  engine = await connectTemplateBrain(join(home, 'database'));
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
}, 120_000);
afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

let n = 0;
/** A fresh checkout as the default source, with a bare remote, and a fresh imessage source. */
async function setup() {
  const k = ++n;
  const repo = join(home, `repo-${k}`);
  const remote = join(home, `remote-${k}.git`);
  mkdirSync(repo, { recursive: true });
  git(home, 'init', '--bare', '-q', remote);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 't');
  git(repo, 'config', 'user.email', 't@example.invalid');
  git(repo, 'remote', 'add', 'origin', remote);
  writeFileSync(join(repo, 'README.md'), '# notes\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-q', '-m', 'init');
  await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [repo]);
  const id = `imessage-${k}`;
  const config = { kind: 'imessage', federated: false };
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,NULL,$2::text::jsonb)', [id, JSON.stringify(config)]);
  return { repo, remote, id, cfg: parseIMessageSourceConfig(config), folder: join(repo, '.gbrain-owned', id) };
}
const helper = (fake: FakeHelper) => imessageHelper({ sourceId: 'test', port: 47001, token: HELPER_TEST_TOKEN, fetchImpl: helperFetch(fake) });
const run = (id: string, cfg: ReturnType<typeof parseIMessageSourceConfig>, fake: FakeHelper, extra: { now?: number; full?: boolean } = {}) =>
  runIMessageSync(engine, id, cfg, { ...options, ...(extra.full ? { full: true } : {}) }, { helper: helper(fake), now: () => extra.now ?? NOW });
const dayFile = (threadId: string, daysAgo: number) => imessagePagePath(imessageChatKey(threadId), dayOf(daysAgo));
async function cursorKey(id: string) {
  const [src] = await engine.executeRaw<{ incarnation: string; local_path: string | null; config: Record<string, unknown> }>('SELECT incarnation::text AS incarnation,local_path,config FROM sources WHERE id=$1', [id]);
  return connectorDbCursorKey(id, src!.incarnation, connectorIdentity('imessage', src!.config, src!.local_path));
}
const incarnationOf = async (id: string) => (await engine.executeRaw<{ i: string }>('SELECT incarnation::text AS i FROM sources WHERE id=$1', [id]))[0]!.i;
const stateOf = async (id: string) => ({ ...(await readConnectorDbCursor(engine, await cursorKey(id))).state,
  owned: await readOwnedState(engine, id, await incarnationOf(id), 'imessage') }) as IMessageState;
const pageCount = async (id: string) => (await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE source_id=$1 AND deleted_at IS NULL', [id]))[0]!.n;

for (const kind of testBackends()) describe(`owned folder (${kind})`, () => {
  let pglite: BrainEngine | undefined;
  let close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (kind !== 'postgres') return;
    pglite = engine;
    ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  }, 120_000);
  afterAll(async () => { if (pglite) { await close!(); engine = pglite; } });

  test('the first run commits every chat-day once, with OWNER.json and a README naming the destination, before the rows', async () => {
    const { repo, remote, id, cfg, folder } = await setup();
    const before = commits(repo);
    const result = await run(id, cfg, mac());
    expect(result.added).toBe(3);
    expect(commits(repo)).toBe(before + 1);
    expect(git(repo, 'log', '-1', '--format=%s').stdout.trim()).toBe(`imessage(${id}): import 3 chat-days into .gbrain-owned/${id} (${remote.replace(/\.git$/, '')})`);
    expect(readFileSync(join(folder, dayFile(ALICE, 2)), 'utf8')).toContain('Lunch at noon tomorrow?');
    expect(JSON.parse(readFileSync(join(folder, 'OWNER.json'), 'utf8')).source_id).toBe(id);
    expect(readFileSync(join(folder, 'README.md'), 'utf8')).toContain(remote.replace(/\.git$/, ''));
    expect(git(repo, 'status', '--porcelain').stdout).toBe('');
    const state = await stateOf(id);
    expect(state.record_status?.record).toBe('folder');
    expect(Object.keys(state.owned!.files)).toContain(dayFile(ALICE, 2));
    expect(state.owned!.last_batch).toBe(git(repo, 'rev-parse', 'HEAD').stdout.trim());
    expect(await pageCount(id)).toBe(3);
    const pending = (await readPagesIn(engine, [id])).get(id)!;
    expect(pending).toMatchObject({ record: 'folder', folder: `.gbrain-owned/${id}`, files: 3, days_held: 0, pushed: 'pending' });
    git(repo, 'push', '-q', '-u', 'origin', 'main');
    const pushed = (await readPagesIn(engine, [id])).get(id)!;
    expect(pushed.pushed).toBe('pushed');
    expect(pagesInLine(id, pushed)).toContain(`pages in .gbrain-owned/${id}/ (3 day file(s)), last commit `);
  });

  test('a quiet run commits nothing; an edit commits one; an emptied day removes its file in one commit', async () => {
    const { repo, id, cfg, folder } = await setup();
    const fake = mac();
    await run(id, cfg, fake);
    const c1 = commits(repo);
    await run(id, cfg, fake);
    expect(commits(repo)).toBe(c1);
    fake.chats[0]!.messages[2]!.text = 'Running twenty minutes late.';
    await run(id, cfg, fake, { now: NOW + 60_000 });
    expect(commits(repo)).toBe(c1 + 1);
    expect(git(repo, 'log', '-1', '--format=%s').stdout.trim()).toBe(`imessage(${id}): 1 chat-days updated, 0 removed`);
    expect(readFileSync(join(folder, dayFile(ALICE, 1)), 'utf8')).toContain('twenty minutes');
    fake.chats[0]!.messages.splice(2, 1);
    await run(id, cfg, fake, { now: NOW + 120_000 });
    expect(commits(repo)).toBe(c1 + 2);
    expect(existsSync(join(folder, dayFile(ALICE, 1)))).toBe(false);
    expect(await pageCount(id)).toBe(2);
  });

  test('a hand-edited day file is left alone and that day stays database-only, with a notice', async () => {
    const { repo, id, cfg, folder } = await setup();
    const fake = mac();
    await run(id, cfg, fake);
    const path = join(folder, dayFile(ALICE, 1));
    writeFileSync(path, 'my own notes\n');
    const c1 = commits(repo);
    fake.chats[0]!.messages[2]!.text = 'Running twenty minutes late.';
    await run(id, cfg, fake, { now: NOW + 60_000 });
    expect(readFileSync(path, 'utf8')).toBe('my own notes\n');
    expect(commits(repo)).toBe(c1);
    const state = await stateOf(id);
    expect(state.owned!.held![dayFile(ALICE, 1)]!.code).toBe('owned_folder_conflict');
    const [row] = await engine.executeRaw<{ body: string }>('SELECT compiled_truth AS body FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [id, slugifyPath(dayFile(ALICE, 1))]);
    expect(row!.body).toContain('twenty minutes');
  });

  test('a secret in a day under secrets.on_push refuse is held; the committed clean file is kept', async () => {
    const { repo, id, cfg, folder } = await setup();
    const fake = mac();
    await run(id, cfg, fake);
    const clean = readFileSync(join(folder, dayFile(ALICE, 1)), 'utf8');
    const c1 = commits(repo);
    fake.chats[0]!.messages[2]!.text = `key ${'AKIA'}${'ABCDEFGHIJKLMNOP'} here`;
    await withEnv({ GBRAIN_SECRETS_ON_PUSH: 'refuse' }, async () => {
      await run(id, cfg, fake, { now: NOW + 60_000 });
      expect(commits(repo)).toBe(c1);
      expect(readFileSync(join(folder, dayFile(ALICE, 1)), 'utf8')).toBe(clean);
      expect((await stateOf(id)).owned!.held![dayFile(ALICE, 1)]!.code).toBe('owned_day_secret_held');
      const [row] = await engine.executeRaw<{ body: string }>('SELECT compiled_truth AS body FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [id, slugifyPath(dayFile(ALICE, 1))]);
      expect(row!.body).toContain('key AKIA');
    });
    fake.chats[0]!.messages[2]!.text = 'Running twenty minutes late.';
    await run(id, cfg, fake, { now: NOW + 120_000 });
    expect(commits(repo)).toBe(c1 + 1);
    expect((await stateOf(id)).owned!.held ?? {}).toEqual({});
  });

  test('a changed push remote keeps the pages database-only until rebind', async () => {
    const { repo, id, cfg } = await setup();
    const fake = mac();
    await run(id, cfg, fake);
    git(repo, 'remote', 'set-url', 'origin', join(home, 'elsewhere.git'));
    const c1 = commits(repo);
    fake.chats[0]!.messages[2]!.text = 'Running twenty minutes late.';
    await run(id, cfg, fake, { now: NOW + 60_000 });
    expect(commits(repo)).toBe(c1);
    expect((await stateOf(id)).record_status).toMatchObject({ record: 'database', reason: 'remote_changed' });
    expect((await readPagesIn(engine, [id])).get(id)).toMatchObject({ record: 'database', reason: 'remote_changed', files: 3 });
    const preview = await rebindOwnedSource(engine, { sourceId: id, yes: false });
    expect(preview).toMatchObject({ applied: false, changed: true, current: [join(home, 'elsewhere')] });
    expect(commits(repo)).toBe(c1);
    await expect(rebindOwnedSource(engine, { sourceId: id, yes: true, expect: 'somewhere-else' })).rejects.toMatchObject({ code: 'preview_changed' });
    expect((await rebindOwnedSource(engine, { sourceId: id, yes: true, expect: preview.current.join(',') })).applied).toBe(true);
    expect(commits(repo)).toBe(c1);
    await run(id, cfg, fake, { now: NOW + 120_000, full: true });
    expect(commits(repo)).toBe(c1 + 1);
    expect((await stateOf(id)).record_status?.record).toBe('folder');
  });

  test('a run that committed and stopped before the import: the next run commits nothing and imports the committed days', async () => {
    const { repo, id, cfg } = await setup();
    const fake = mac();
    await run(id, cfg, fake);
    const c1 = commits(repo);
    const state = await stateOf(id);
    // The state the run saved right after its commit: the owned record, and the chats as they were before the run.
    await writeConnectorDbCursor(engine, await cursorKey(id), { ...state, chats: {} });
    await engine.executeRaw('DELETE FROM pages WHERE source_id=$1', [id]);
    const result = await run(id, cfg, fake);
    expect(result.added).toBe(3);
    expect(commits(repo)).toBe(c1);
    expect(git(repo, 'status', '--porcelain').stdout).toBe('');
  });

  test('with --full and no helper on this Mac, the pages are rebuilt from the folder, held days left out', async () => {
    const { repo, id, cfg, folder } = await setup();
    const fake = mac();
    await run(id, cfg, fake);
    writeFileSync(join(folder, dayFile(ALICE, 1)), 'my own notes\n');
    fake.chats[0]!.messages[2]!.text = 'Running twenty minutes late.';
    await run(id, cfg, fake, { now: NOW + 60_000 });
    await engine.executeRaw('DELETE FROM pages WHERE source_id=$1', [id]);
    const c1 = commits(repo);
    const down = imessageHelper({ sourceId: id, port: 47001, token: HELPER_TEST_TOKEN, fetchImpl: (async () => { throw new Error('connect ECONNREFUSED'); }) as unknown as typeof fetch });
    const result = await runIMessageSync(engine, id, cfg, { ...options, full: true }, { helper: down, now: () => NOW + 120_000 });
    expect(result.added).toBe(2);
    expect(commits(repo)).toBe(c1);
    expect(await pageCount(id)).toBe(2);
    await expect(runIMessageSync(engine, id, cfg, { ...options }, { helper: down, now: () => NOW + 180_000 })).rejects.toMatchObject({ code: 'apple_helper_not_running' });
  });

  test('a day the push redacted stays this writer\'s: a later message rewrites it, status follows the rebuilt commit and removal takes it', async () => {
    const { repo, id, cfg, folder } = await setup();
    const fake = mac();
    fake.chats[0]!.messages[2]!.text = `key ${'AKIA'}${'ABCDEFGHIJKLMNOP'} here`;
    await withEnv({ GBRAIN_SECRETS_ON_PUSH: undefined }, () => run(id, cfg, fake));
    const file = join(folder, dayFile(ALICE, 1));
    const outcome = await withEnv({ GBRAIN_HOME: join(home, `gbrain-home-${id}`), GBRAIN_SECRETS_ON_PUSH: undefined },
      async () => redactUnpushed(repo, { base: '', sealer: spoolSealer(repo, null) })) as RedactOutcome;
    expect(outcome.new_head).not.toBe(outcome.old_head);
    expect(readFileSync(file, 'utf8')).toContain('<REDACTED:');
    const rebuilt = git(repo, 'rev-parse', 'HEAD').stdout.trim();
    expect((await readPagesIn(engine, [id])).get(id)!.last_batch).toBe(rebuilt);
    const c1 = commits(repo);
    fake.chats[0]!.messages.push({ rowid: 13, at: at(1, 9), text: 'Parking on level two.' });
    await withEnv({ GBRAIN_SECRETS_ON_PUSH: undefined }, () => run(id, cfg, fake, { now: NOW + 60_000 }));
    expect(commits(repo)).toBe(c1 + 1);
    expect(readFileSync(file, 'utf8')).toContain('Parking on level two.');
    expect((await stateOf(id)).owned!.held ?? {}).toEqual({});
    const removed = await removeSource(engine, { id, yes: true });
    expect(removed.owned_files).toBe(3);
    expect(existsSync(file)).toBe(false);
  });

  test('a push redaction whose rebuild never became HEAD is not adopted: the day stays this writer\'s and status keeps the batch in HEAD', async () => {
    const { repo, id, cfg, folder } = await setup();
    const fake = mac();
    fake.chats[0]!.messages[2]!.text = `key ${'AKIA'}${'ABCDEFGHIJKLMNOP'} here`;
    await withEnv({ GBRAIN_SECRETS_ON_PUSH: undefined }, () => run(id, cfg, fake));
    const file = join(folder, dayFile(ALICE, 1));
    const outcome = await withEnv({ GBRAIN_HOME: join(home, `gbrain-home-${id}`), GBRAIN_SECRETS_ON_PUSH: undefined },
      async () => redactUnpushed(repo, { base: '', sealer: spoolSealer(repo, null) })) as RedactOutcome;
    expect(outcome.new_head).not.toBe(outcome.old_head);
    expect(git(repo, 'reset', '-q', '--hard', outcome.old_head!).status).toBe(0);
    expect(readFileSync(file, 'utf8')).not.toContain('<REDACTED:');
    expect((await readPagesIn(engine, [id])).get(id)!.last_batch).toBe(outcome.old_head);
    const c1 = commits(repo);
    fake.chats[0]!.messages.push({ rowid: 13, at: at(1, 9), text: 'Parking on level two.' });
    await withEnv({ GBRAIN_SECRETS_ON_PUSH: undefined }, () => run(id, cfg, fake, { now: NOW + 60_000 }));
    expect(commits(repo)).toBe(c1 + 1);
    expect(readFileSync(file, 'utf8')).toContain('Parking on level two.');
    expect((await stateOf(id)).owned!.held ?? {}).toEqual({});
  });

  test('a run stopped by a timeout keeps the chat windows it started with, so the next run imports what it never wrote', async () => {
    const { id, cfg, folder } = await setup();
    const fake = mac();
    fake.chats[0]!.messages.unshift({ rowid: 5, at: at(20, 9), text: 'Plans from three weeks ago.' });
    fake.chats[1]!.messages.unshift({ rowid: 15, at: at(20, 10), text: 'The first venue fell through.', from: 'Bob Example' });
    const h = helper(fake);
    let reads = 0;
    const stopping: typeof h = { ...h, messages: (thread, since, signal) => ++reads === 2
      ? Promise.reject(Object.assign(new Error('the sync timed out'), { name: 'AbortError' })) : h.messages(thread, since, signal) };
    let threw = false;
    try { await runIMessageSync(engine, id, cfg, options, { helper: stopping, now: () => NOW }); } catch { threw = true; }
    expect(threw).toBe(true);
    await run(id, cfg, fake, { now: NOW + 60_000 });
    expect(existsSync(join(folder, dayFile(ALICE, 20)))).toBe(true);
    expect(existsSync(join(folder, dayFile(GROUP, 20)))).toBe(true);
  });

  test('a day too large to render is held on its own; the chat\'s other days are written', async () => {
    const { id, cfg, folder } = await setup();
    const fake = mac();
    fake.chats[0]!.messages.unshift({ rowid: 5, at: at(3, 9), text: 'x'.repeat(2_200_000) });
    await run(id, cfg, fake);
    expect(existsSync(join(folder, dayFile(ALICE, 3)))).toBe(false);
    expect(existsSync(join(folder, dayFile(ALICE, 2)))).toBe(true);
    expect(existsSync(join(folder, dayFile(ALICE, 1)))).toBe(true);
  });

  test('removing a source while its sync holds the lock removes nothing and says so; once the lock is free it removes the files', async () => {
    const { id, cfg, folder } = await setup();
    await run(id, cfg, mac());
    const lock = await tryAcquireDbLock(engine, syncLockId(id));
    expect(lock).not.toBeNull();
    try {
      await expect(removeSource(engine, { id, yes: true })).rejects.toThrow(`A sync of source ${id} is running`);
      expect(existsSync(join(folder, dayFile(ALICE, 1)))).toBe(true);
    } finally {
      await lock!.release();
    }
    expect((await removeSource(engine, { id, yes: true })).owned_files).toBe(3);
    expect(existsSync(join(folder, dayFile(ALICE, 1)))).toBe(false);
  });

  test('removing a source during its first import, with nothing recorded yet, waits for the sync lock too', async () => {
    const { id } = await setup();
    const lock = await tryAcquireDbLock(engine, syncLockId(id));
    expect(lock).not.toBeNull();
    try {
      await expect(removeSource(engine, { id, yes: true })).rejects.toThrow(`A sync of source ${id} is running`);
      expect((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM sources WHERE id=$1', [id]))[0]!.n).toBe(1);
    } finally {
      await lock!.release();
    }
    await removeSource(engine, { id, yes: true });
    expect((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM sources WHERE id=$1', [id]))[0]!.n).toBe(0);
  });

  test('a push destination not proven private keeps the pages database-only, and rebind refuses it', async () => {
    const { repo, remote, id, cfg, folder } = await setup();
    const fake = mac();
    const unproven = 'https://github.invalid/acme-example/notes.git';
    git(repo, 'remote', 'set-url', 'origin', unproven);
    await run(id, cfg, fake);
    expect(existsSync(folder)).toBe(false);
    expect((await stateOf(id)).record_status).toMatchObject({ record: 'database', reason: 'not_private' });
    expect(await pageCount(id)).toBe(3);
    git(repo, 'remote', 'set-url', 'origin', remote);
    await run(id, cfg, fake, { now: NOW + 60_000, full: true });
    expect(existsSync(join(folder, dayFile(ALICE, 1)))).toBe(true);
    git(repo, 'remote', 'set-url', 'origin', unproven);
    await expect(rebindOwnedSource(engine, { sourceId: id, yes: true })).rejects.toThrow('not proven private');
    await run(id, cfg, fake, { now: NOW + 120_000 });
    expect((await stateOf(id)).record_status?.record).toBe('database');
  });

  test('changing the source\'s timezone keeps the record of its files, so removal still takes them', async () => {
    const { id, cfg, folder } = await setup();
    await run(id, cfg, mac());
    await engine.executeRaw(`UPDATE sources SET config = config || '{"i_timezone":"America/New_York"}'::jsonb WHERE id=$1`, [id]);
    expect((await removeSource(engine, { id, yes: true })).owned_files).toBe(3);
    expect(existsSync(join(folder, dayFile(ALICE, 1)))).toBe(false);
  });

  test('a run that committed an update and stopped before saving its record adopts the update instead of holding the day', async () => {
    const { repo, id, cfg } = await setup();
    const fake = mac();
    await run(id, cfg, fake);
    const before = await stateOf(id);
    fake.chats[0]!.messages.push({ rowid: 13, at: at(1, 9), text: 'Parking on level two.' });
    await run(id, cfg, fake, { now: NOW + 60_000 });
    const c1 = commits(repo);
    await writeConnectorDbCursor(engine, await cursorKey(id), { ...before, owned: undefined });
    await writeOwnedState(engine, id, 'imessage', before.owned!);
    await run(id, cfg, fake, { now: NOW + 120_000 });
    expect(commits(repo)).toBe(c1);
    expect((await stateOf(id)).owned!.held ?? {}).toEqual({});
  });

  test('a write that fails partway undoes the batch and the run goes to the database; the next run writes the folder', async () => {
    const { repo, id, cfg, folder } = await setup();
    const fake = mac();
    await run(id, cfg, fake);
    const CAROL = '+15555550102';
    fake.chats[0]!.messages.push({ rowid: 13, at: at(1, 9), text: 'Parking on level two.' });
    fake.chats.push({ threadId: CAROL, displayName: 'Carol Example', participants: [CAROL], messages: [{ rowid: 30, at: at(3, 7), text: 'New number, saving it.' }] });
    const blocker = join(folder, 'imessage', imessageChatKey(CAROL));
    writeFileSync(blocker, 'in the way\n');
    await run(id, cfg, fake, { now: NOW + 60_000 });
    expect((await stateOf(id)).record_status).toMatchObject({ record: 'database', reason: 'conflict' });
    expect(git(repo, 'status', '--porcelain', '--', '.gbrain-owned').stdout.trim()).toBe(`?? .gbrain-owned/${id}/imessage/${imessageChatKey(CAROL)}`);
    rmSync(blocker);
    const c1 = commits(repo);
    await run(id, cfg, fake, { now: NOW + 120_000 });
    expect(commits(repo)).toBe(c1 + 1);
    expect(readFileSync(join(folder, dayFile(ALICE, 1)), 'utf8')).toContain('Parking on level two.');
    expect(existsSync(join(folder, dayFile(CAROL, 3)))).toBe(true);
    expect((await stateOf(id)).owned!.held ?? {}).toEqual({});
  });

  test('the first write after a failed one is not blocked by the empty folders it left; the README names the remote gbrain pushes to', async () => {
    const { repo, remote, id, cfg, folder } = await setup();
    mkdirSync(join(folder, 'imessage', imessageChatKey(ALICE)), { recursive: true });
    git(home, 'init', '--bare', '-q', join(home, `fork-${id}.git`));
    git(repo, 'remote', 'add', 'fork', join(home, `fork-${id}.git`));
    git(repo, 'config', 'branch.main.pushRemote', 'fork');
    const before = commits(repo);
    await run(id, cfg, mac());
    expect(commits(repo)).toBe(before + 1);
    expect((await stateOf(id)).record_status?.record).toBe('folder');
    expect(readFileSync(join(folder, 'README.md'), 'utf8')).toContain(remote.replace(/\.git$/, ''));
    expect(readFileSync(join(folder, 'README.md'), 'utf8')).not.toContain('fork-');
  });

  test('removing the source removes its files in one commit and keeps a hand-edited one; --keep-storage leaves them', async () => {
    const { repo, id, cfg, folder } = await setup();
    await run(id, cfg, mac());
    writeFileSync(join(folder, dayFile(ALICE, 1)), 'my own notes\n');
    const c1 = commits(repo);
    const preview = await removeSource(engine, { id, dryRun: true });
    expect(preview.owned_files).toBe(3);
    expect(commits(repo)).toBe(c1);
    const removed = await removeSource(engine, { id, yes: true });
    expect(removed.owned_files).toBe(3);
    expect(commits(repo)).toBe(c1 + 1);
    expect(git(repo, 'log', '-1', '--format=%s').stdout.trim()).toBe(`imessage(${id}): remove the source's 3 chat-day file(s) from .gbrain-owned/${id}`);
    expect(existsSync(join(folder, dayFile(ALICE, 2)))).toBe(false);
    expect(existsSync(join(folder, 'OWNER.json'))).toBe(false);
    expect(readFileSync(join(folder, dayFile(ALICE, 1)), 'utf8')).toBe('my own notes\n');
    expect(await pageCount(id)).toBe(0);

    const kept = await setup();
    await run(kept.id, kept.cfg, mac());
    const c2 = commits(kept.repo);
    await removeSource(engine, { id: kept.id, yes: true, keepStorage: true });
    expect(commits(kept.repo)).toBe(c2);
    expect(existsSync(join(kept.folder, dayFile(ALICE, 2)))).toBe(true);
  });

  test('the expired-archive purge takes the files out the same way', async () => {
    const { repo, id, cfg, folder } = await setup();
    await run(id, cfg, mac());
    await engine.executeRaw("UPDATE sources SET archived=true, archived_at=now() - interval '5 days', archive_expires_at=now() - interval '1 day' WHERE id=$1", [id]);
    const c1 = commits(repo);
    const result = await purgeExpiredSources(engine);
    expect(result.purged).toContain(id);
    expect(commits(repo)).toBe(c1 + 1);
    expect(existsSync(folder)).toBe(false);
  });

  test('a page write into a source whose pages are files in its folder is refused and names the folder', async () => {
    const { repo, id, cfg } = await setup();
    await run(id, cfg, mac());
    const c1 = commits(repo);
    const slug = slugifyPath(dayFile(ALICE, 2));
    for (const [tool, args] of [['put_page', { slug, source_id: id, content: '# changed\n' }], ['delete_page', { slug, source_id: id, force: true }],
      ['add_timeline_entry', { slug, date: dayOf(2), summary: 'planted' }]] as const) {
      const out = await dispatchToolCall(engine, tool, args, { remote: false, sourceId: id });
      const text = out.content.map(c => c.text).join('\n');
      expect({ tool, refused: out.isError, code: text.match(/"code": "([a-z_]+)"/)?.[1] }).toEqual({ tool, refused: true, code: 'owned_folder_conflict' });
      expect(text).toContain(`.gbrain-owned/${id}/`);
    }
    expect(commits(repo)).toBe(c1);
    expect(await pageCount(id)).toBe(3);
  });

  test('a brain that starts serving several people writes nothing new to the folder and keeps the committed files', async () => {
    const { repo, id, cfg, folder } = await setup();
    const fake = mac();
    await run(id, cfg, fake);
    const c1 = commits(repo);
    await engine.setConfig('access.serves', 'several');
    try {
      fake.chats[0]!.messages[2]!.text = 'Running twenty minutes late.';
      await run(id, cfg, fake, { now: NOW + 60_000 });
      expect(commits(repo)).toBe(c1);
      expect(existsSync(join(folder, dayFile(ALICE, 1)))).toBe(true);
      expect((await stateOf(id)).record_status).toMatchObject({ record: 'database', reason: 'not_personal' });
    } finally {
      await engine.setConfig('access.serves', 'one');
    }
  });

  test('a checkout whose Git ignores the folder keeps the pages in the database only', async () => {
    const { repo, id, cfg, folder } = await setup();
    writeFileSync(join(repo, '.gitignore'), '.gbrain-owned/\n');
    const c1 = commits(repo);
    const result = await run(id, cfg, mac());
    expect(result.added).toBe(3);
    expect(commits(repo)).toBe(c1);
    expect(existsSync(folder)).toBe(false);
    expect((await stateOf(id)).record_status).toMatchObject({ record: 'database', reason: 'ignored' });
    const filtered = await setup();
    writeFileSync(join(filtered.repo, '.gitattributes'), '.gbrain-owned/*/imessage/** filter=example\n');
    expect(await resolveOwnedDestination(engine, filtered.id, null)).toMatchObject({ record: 'database', reason: 'ignored' });
  });

  test('a commit Git refuses keeps the sync going in the database; the next run writes the folder, also after a database-only spell', async () => {
    const { repo, id, cfg, folder } = await setup();
    const fake = mac();
    await run(id, cfg, fake);
    const file = join(folder, dayFile(ALICE, 1));
    mkdirSync(join(repo, '.git', 'rebase-merge'));
    const c1 = commits(repo);
    fake.chats[0]!.messages[2]!.text = 'Running twenty minutes late.';
    await run(id, cfg, fake, { now: NOW + 60_000 });
    expect(commits(repo)).toBe(c1);
    expect((await stateOf(id)).record_status).toMatchObject({ record: 'database', reason: 'git_error' });
    const [row] = await engine.executeRaw<{ body: string }>('SELECT compiled_truth AS body FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [id, slugifyPath(dayFile(ALICE, 1))]);
    expect(row!.body).toContain('twenty minutes');
    rmSync(join(repo, '.git', 'rebase-merge'), { recursive: true });
    await run(id, cfg, fake, { now: NOW + 120_000 });
    expect(commits(repo)).toBe(c1 + 1);
    expect(readFileSync(file, 'utf8')).toContain('twenty minutes');
    expect((await stateOf(id)).owned!.held ?? {}).toEqual({});

    await engine.setConfig('access.serves', 'several');
    try {
      fake.chats[0]!.messages[2]!.text = 'Running an hour late.';
      await run(id, cfg, fake, { now: NOW + 180_000 });
    } finally {
      await engine.setConfig('access.serves', 'one');
    }
    expect(Object.keys((await stateOf(id)).owned!.held!)).toEqual([dayFile(ALICE, 1)]);
    await run(id, cfg, fake, { now: NOW + 240_000 });
    expect(commits(repo)).toBe(c1 + 2);
    expect(readFileSync(file, 'utf8')).toContain('an hour late');
  });

  test('a run that committed and stopped before saving its record adopts its own files instead of holding them', async () => {
    const { repo, id, cfg, folder } = await setup();
    const fake = mac();
    await run(id, cfg, fake);
    const c1 = commits(repo);
    await writeConnectorDbCursor(engine, await cursorKey(id), {});
    await writeConnectorDbCursor(engine, ownedStateKey(id, await incarnationOf(id), 'imessage'), {});
    await run(id, cfg, fake, { now: NOW + 60_000 });
    expect(commits(repo)).toBe(c1);
    const state = await stateOf(id);
    expect(state.owned!.held ?? {}).toEqual({});
    expect(Object.keys(state.owned!.files).sort()).toEqual(['OWNER.json', 'README.md', dayFile(ALICE, 1), dayFile(ALICE, 2), dayFile(GROUP, 1)].sort());
    await removeSource(engine, { id, yes: true });
    expect(existsSync(folder)).toBe(false);
  });

  test('a managed brain resolves to database-only (D1: managed brains are the next PR)', async () => {
    const { id } = await setup();
    expect((await resolveOwnedDestination(engine, id, null)).record).toBe('folder');
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    try {
      expect(await resolveOwnedDestination(engine, id, null)).toMatchObject({ record: 'database', reason: 'managed' });
    } finally {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    }
  });

  test('a mass removal removes nothing and keeps the days', async () => {
    const { repo, id, cfg, folder } = await setup();
    const fake = mac();
    await run(id, cfg, fake);
    const c1 = commits(repo);
    for (const chat of fake.chats) chat.messages = [{ rowid: 99, at: at(0, 9), text: 'only today' }];
    await run(id, cfg, fake, { now: NOW + 60_000 });
    expect(existsSync(join(folder, dayFile(ALICE, 2)))).toBe(true);
    expect(existsSync(join(folder, dayFile(GROUP, 1)))).toBe(true);
    expect(commits(repo)).toBe(c1 + 1);
  });

  test('a folder reached through a symlink is never written; the run imports to the database only', async () => {
    const { repo, id, cfg } = await setup();
    const outside = join(home, `outside-${n}`);
    mkdirSync(outside);
    symlinkSync(outside, join(repo, '.gbrain-owned'));
    const c1 = commits(repo);
    const result = await run(id, cfg, mac());
    expect(result.added).toBe(3);
    expect(commits(repo)).toBe(c1);
    expect(spawnSync('ls', ['-A', outside], { encoding: 'utf8' }).stdout).toBe('');
    expect((await stateOf(id)).record_status).toMatchObject({ record: 'database', reason: 'conflict' });
  });
});
