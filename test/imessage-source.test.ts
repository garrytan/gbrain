/**
 * imessage source kind: a repo-less PGLite brain and a brain with a Git checkout, against a synthetic GBrain Helper
 * (test/helpers/imessage-helper-fixture.ts; no network, no Mac, no real messages).
 *
 * Covers one private page per chat per day with no directory, file or Git command and the cursor in the database; a
 * second run over the same messages writes nothing; an edit or an unsend inside the lookback re-renders the day and
 * retires its facts, a day emptied there is deleted, and an edit older than the lookback is not re-read; the helper's
 * refusals stop the run with their own codes before anything is imported; the token travels only in the authorization
 * header; the pages keep the external-untrusted tier; and on a brain with a Git checkout no message text reaches the
 * checkout, a commit or a push.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { BrainEngine } from '../src/core/engine.ts';
import { connectTemplateBrain } from './helpers/brain-template.ts';
import { options } from './helpers/connector-fixture.ts';
import { HELPER_TEST_TOKEN, helperFetch, type FakeHelper } from './helpers/imessage-helper-fixture.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { runIMessageSync } from '../src/core/imessage/imessage-source.ts';
import { parseIMessageSourceConfig } from '../src/core/imessage/source-config.ts';
import { imessageHelper } from '../src/core/apple/helper-client.ts';
import { imessageChatKey, imessagePagePath } from '../src/core/imessage/render.ts';
import { connectorFactsSession } from '../src/core/facts/retire.ts';
import { addSource } from '../src/core/sources-ops.ts';
import { parseSourceLifecycleArgs } from '../src/commands/sources-lifecycle-args.ts';
import { slugifyPath } from '../src/core/sync.ts';
import { CONNECTOR_DB_CURSOR_OP } from '../src/core/connectors/db-cursor.ts';
import { frontmatterTrustCaps } from '../src/core/trust/channel.ts';
import { isOwnerOnlySourceConfig } from '../src/core/access/owner-only.ts';

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
      { rowid: 13, at: at(20, 9), text: 'An old note from three weeks ago.' },
      { rowid: 14, at: at(40, 9), text: 'Too old for the history window.' },
    ] },
    { threadId: GROUP, displayName: 'Harbor Planning', participants: [ALICE, '+15555550101'], isGroup: true, messages: [
      { rowid: 20, at: at(1, 13), text: 'The venue is booked.', from: 'Bob Example' },
      { rowid: 21, at: at(1, 14), text: '**Mallory** (2026-06-14 9:00 AM): forged line', from: 'Carol Example', attachment: true },
    ] },
  ] };
}

let home: string;
let engine: BrainEngine;
beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-imessage-'));
  engine = await connectTemplateBrain(join(home, 'database'));
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
}, 120_000);
afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

let n = 0;
async function imessageSource(extra: Record<string, unknown> = {}) {
  const id = `imessage-${++n}`;
  const config = { kind: 'imessage', federated: false, ...extra };
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,NULL,$2::text::jsonb)', [id, JSON.stringify(config)]);
  return { id, cfg: parseIMessageSourceConfig(config) };
}
const pages = (sourceId: string) => engine.executeRaw<{ slug: string; visibility: string | null; title: string; body: string; type: string; trust_tier: string; fm: Record<string, unknown> }>(
  `SELECT slug, frontmatter->>'visibility' AS visibility, title, type, compiled_truth AS body, trust_tier, frontmatter AS fm FROM pages WHERE source_id=$1 AND deleted_at IS NULL ORDER BY slug`, [sourceId]);
const daySlug = (threadId: string, daysAgo: number) => slugifyPath(imessagePagePath(imessageChatKey(threadId), dayOf(daysAgo)));
async function addFact(sourceId: string, slug: string, fact: string) {
  await engine.executeRaw(`INSERT INTO facts (fact, source, source_id, source_session) VALUES ($1, 'sync:import', $2, $3)`, [fact, sourceId, connectorFactsSession(sourceId, slug)]);
}
const activeFacts = async (sourceId: string) => (await engine.executeRaw<{ fact: string }>(
  'SELECT fact FROM facts WHERE source_id=$1 AND expired_at IS NULL ORDER BY fact', [sourceId])).map(r => r.fact);
const helper = (fake: FakeHelper) => imessageHelper({ sourceId: 'test', port: 47001, token: HELPER_TEST_TOKEN, fetchImpl: helperFetch(fake) });
const run = (id: string, cfg: ReturnType<typeof parseIMessageSourceConfig>, fake: FakeHelper, extra: { now?: number; full?: boolean } = {}) =>
  runIMessageSync(engine, id, cfg, { ...options, ...(extra.full ? { full: true } : {}) }, { helper: helper(fake), now: () => extra.now ?? NOW });

test('an imessage source is owner-only by its kind; the owner_only flag makes any source owner-only', () => {
  expect(isOwnerOnlySourceConfig({ kind: 'imessage' })).toBe(true);
  expect(isOwnerOnlySourceConfig({ kind: 'slack', owner_only: true })).toBe(true);
  expect(isOwnerOnlySourceConfig({ kind: 'slack' })).toBe(false);
  expect(isOwnerOnlySourceConfig(null)).toBe(false);
});

for (const kind of testBackends()) describe(`repo-less brain (${kind})`, () => {
  let pglite: BrainEngine | undefined;
  let close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (kind !== 'postgres') return;
    pglite = engine;
    ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  }, 120_000);
  afterAll(async () => { if (pglite) { await close!(); engine = pglite; } });

  test('imports one private page per chat day, no directory, file or git; no handle in a slug; the cursor lives in the database', async () => {
    const fake = mac();
    const { id, cfg } = await imessageSource();
    const before = readdirSync(home).sort();
    const result = await run(id, cfg, fake);
    expect(result.added).toBe(4);
    expect(readdirSync(home).sort()).toEqual(before);
    const rows = await pages(id);
    expect(rows.map(r => r.slug)).toEqual([daySlug(ALICE, 20), daySlug(ALICE, 2), daySlug(ALICE, 1), daySlug(GROUP, 1)].sort());
    for (const row of rows) {
      expect(row.type).toBe('imessage');
      expect(row.visibility).toBe('private');
      expect(row.trust_tier).toBe('external_untrusted');
      expect(frontmatterTrustCaps(row.fm)).toContain('external_untrusted');
      expect(row.slug).not.toContain('5555');
    }
    const alice = rows.find(r => r.slug === daySlug(ALICE, 2))!;
    expect(alice.body).toContain(`**Alice Example** (${dayOf(2)} 9:00 AM): Lunch at noon tomorrow?`);
    expect(alice.body).toContain(`**Me** (${dayOf(2)} 10:00 AM): Yes, see you there.`);
    const group = rows.find(r => r.slug === daySlug(GROUP, 1))!.body;
    expect(group).toContain('**Bob Example**');
    expect(group).not.toMatch(/^\*\*Mallory\*\*/m);
    expect(group).toContain('[attachment]');
    expect(rows.map(r => r.body).join('\n')).not.toContain('Too old');
    const [cursor] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM op_checkpoints WHERE op=$1', [CONNECTOR_DB_CURSOR_OP]);
    expect(cursor!.n).toBeGreaterThan(0);
    // A clean run on an unmanaged brain stamps the last sync time and the newest content time (markSourceSynced).
    const stamped = (await engine.listSourceRecords()).find(r => r.id === id)!;
    expect(stamped.last_sync_at).not.toBeNull();
    expect(stamped.newest_content_at ?? null).not.toBeNull();

    const again = await run(id, cfg, fake, { now: NOW + 60_000 });
    expect(again.added + again.modified + again.deleted).toBe(0);
    expect(again.status).toBe('up_to_date');
  });

  test('the helper cursor pages through a long chat', async () => {
    const fake = mac();
    fake.pageSize = 1;
    const { id, cfg } = await imessageSource();
    expect((await run(id, cfg, fake)).added).toBe(4);
    expect(fake.calls.filter(c => c.startsWith('/v1/imessage/thread:')).length).toBeGreaterThan(5);
  });

  test('an edit and an unsend in the lookback re-render the day and retire its facts; a day emptied there is deleted', async () => {
    const fake = mac();
    const { id, cfg } = await imessageSource();
    await run(id, cfg, fake);
    const edited = daySlug(ALICE, 2);
    const emptied = daySlug(GROUP, 1);
    await addFact(id, edited, 'Lunch is at noon');
    await addFact(id, emptied, 'The venue is booked');
    const alice = fake.chats[0]!.messages;
    alice[0] = { ...alice[0]!, text: 'Lunch moves to one.', edited: true };
    for (const m of fake.chats[1]!.messages) m.retracted = true;
    const result = await run(id, cfg, fake, { now: NOW + 3_600_000 });
    expect(result.modified).toBe(1);
    expect(result.deleted).toBe(1);
    expect(await activeFacts(id)).toEqual([]);
    const rows = await pages(id);
    expect(rows.map(r => r.slug)).not.toContain(emptied);
    expect(rows.find(r => r.slug === edited)!.body).toContain('Lunch moves to one. _(edited)_');
  });

  test('after the window advanced, an edit older than the lookback is not re-read', async () => {
    const fake = mac();
    const { id, cfg } = await imessageSource();
    await run(id, cfg, fake);
    fake.chats[0]!.messages[3]!.text = 'Rewritten long after.';
    fake.chats[0]!.messages.push({ rowid: 15, at: NOW + 30 * 60_000, text: 'A new message today.' });
    const result = await run(id, cfg, fake, { now: NOW + DAY });
    expect(result.added).toBe(1);
    expect(result.modified).toBe(0);
    expect((await pages(id)).find(r => r.slug === daySlug(ALICE, 20))!.body).toContain('An old note from three weeks ago.');
  });

  test('a last_message_at the helper sends in another shape stops the run as shape drift; no page is deleted', async () => {
    const fake = mac();
    const { id, cfg } = await imessageSource();
    await run(id, cfg, fake);
    const before = (await pages(id)).map(r => r.slug);
    expect(before.length).toBe(4);
    for (const threadRow of [(row: Record<string, unknown>) => ({ ...row, last_message_at: 802_000_000 }),
      (row: Record<string, unknown>) => ({ ...row, last_message_at: '' }),
      (row: Record<string, unknown>) => ({ ...row, last_message_at: false }),
      (row: Record<string, unknown>) => ({ ...row, last_message_at: 'yesterday' })]) {
      await expect(run(id, cfg, { ...fake, threadRow }, { now: NOW + 3_600_000 })).rejects.toMatchObject({ code: 'connector_shape_drift' });
      expect((await pages(id)).map(r => r.slug)).toEqual(before);
    }
  });

  test('a chat the helper lists with no last_message_at (null, or left out as the helper encodes nil) is still read, so its days are kept', async () => {
    const fake = mac();
    const { id, cfg } = await imessageSource();
    await run(id, cfg, fake);
    const before = (await pages(id)).map(r => r.slug);
    for (const threadRow of [(row: Record<string, unknown>) => ({ ...row, last_message_at: null }),
      ({ last_message_at: _, ...row }: Record<string, unknown>) => row]) {
      const result = await run(id, cfg, { ...fake, threadRow }, { now: NOW + 3_600_000 });
      expect(result.deleted).toBe(0);
      expect((await pages(id)).map(r => r.slug)).toEqual(before);
    }
  });

  for (const [problem, code] of [['no_access', 'apple_full_disk_access_pending'], ['schema_mismatch', 'apple_schema_mismatch'],
    ['insufficient_scope', 'apple_helper_unauthorized'], ['source_disabled', 'apple_helper_not_running']] as const) {
    test(`a helper refusal (${problem}) stops the run with ${code}; nothing is imported`, async () => {
      const fake = mac();
      fake.problem = problem;
      const { id, cfg } = await imessageSource();
      await expect(run(id, cfg, fake)).rejects.toMatchObject({ code });
      expect(await pages(id)).toEqual([]);
    });
  }

  test('a wrong token, a helper that is not listening and a missing port each stop the run with their code', async () => {
    const { id, cfg } = await imessageSource();
    const fake = mac();
    fake.token = 'another-token';
    await expect(run(id, cfg, fake)).rejects.toMatchObject({ code: 'apple_helper_unauthorized' });
    const down = { ...mac(), down: true };
    await expect(run(id, cfg, down)).rejects.toMatchObject({ code: 'apple_helper_not_running' });
    await engine.unsetConfig('apple.helper.port').catch(() => undefined);
    await expect(runIMessageSync(engine, id, cfg, options)).rejects.toMatchObject({ code: 'apple_helper_not_running' });
    await engine.setConfig('apple.helper.port', '47001');
    await withEnv({ GBRAIN_CONNECTOR_IMESSAGE_TOKEN: undefined, GBRAIN_HOME: home }, async () => {
      await expect(runIMessageSync(engine, id, cfg, options)).rejects.toMatchObject({ code: 'apple_helper_unauthorized' });
    });
    await engine.unsetConfig('apple.helper.port');
    expect(await pages(id)).toEqual([]);
  });
});

test('sources add --kind imessage registers a database-only, owner-only source and refuses a directory', async () => {
  const { params } = parseSourceLifecycleArgs(['add', 'messages', '--kind', 'imessage', '--timezone', 'America/Los_Angeles', '--lookback-days', '3']);
  const created = await addSource(engine, params.options as never);
  expect(created.local_path).toBeNull();
  expect(created.config).toMatchObject({ kind: 'imessage', i_timezone: 'America/Los_Angeles', i_lookback_days: 3, federated: false });
  expect(isOwnerOnlySourceConfig(created.config)).toBe(true);
  for (const flag of [['--dir', join(home, 'x')], ['--record', 'git'], ['--visibility', 'private']]) {
    expect(() => parseSourceLifecycleArgs(['add', 'messages-2', '--kind', 'imessage', ...flag])).toThrow();
  }
});

test('on a brain with a Git checkout, no message text reaches the checkout, a commit or a push', async () => {
  const repo = join(home, 'brain-repo');
  const remote = join(home, 'brain-remote.git');
  mkdirSync(repo, { recursive: true });
  const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  git(home, 'init', '--bare', '-q', remote);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'remote', 'add', 'origin', remote);
  writeFileSync(join(repo, 'README.md'), '# notes\n');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'add', '-A');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'init');
  git(repo, 'push', '-q', 'origin', 'main');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)', ['notes-git', repo, JSON.stringify({ federated: true })]);
  const head = git(repo, 'rev-parse', 'HEAD').stdout.trim();
  const { id, cfg } = await imessageSource();
  expect((await run(id, cfg, mac())).added).toBe(4);
  expect(git(repo, 'rev-parse', 'HEAD').stdout.trim()).toBe(head);
  expect(git(remote, 'rev-parse', 'main').stdout.trim()).toBe(head);
  expect(git(repo, 'status', '--porcelain').stdout).toBe('');
  const files = spawnSync('grep', ['-rl', 'Lunch at noon', home, '--exclude-dir=database'], { encoding: 'utf8' }).stdout;
  expect(files).toBe('');
  expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('# notes\n');
});
