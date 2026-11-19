/**
 * GST-3022: on a personal, unmanaged brain whose default source is a Git checkout, an imessage source keeps its chat-day
 * pages as files under `.gbrain-owned/<id>/` in that checkout, one commit per run, written before the database rows.
 * Synthetic helper (test/helpers/imessage-helper-fixture.ts); no network, no Mac, no real messages.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
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
import { slugifyPath } from '../src/core/sync.ts';

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
const stateOf = async (id: string) => (await readConnectorDbCursor(engine, await cursorKey(id))).state as IMessageState;
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
