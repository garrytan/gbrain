/**
 * Slack channel source kind: repo-less and Git-recorded unmanaged brains.
 *
 * Synthetic Slack Web API fixtures only (test/helpers/slack-fixture.ts); no
 * network. Covers the repo-less default (record: database, no directory, no
 * file and no git command, the cursor in op_checkpoints), day pages rebuilt
 * whole with thread replies, the unchanged-day fingerprint, an edit or a
 * deletion upstream retiring the facts extracted from the page, private
 * channels, the account pin, the first-sync refusal for a channel the app
 * cannot read, a channel held later without stopping the others, the per-run
 * request cap, the rate limit recorded for the scheduler, a Git-recorded
 * brain (commit before the database row; private channels never committed; a
 * channel that became private leaving the checkout at HEAD), and a missing
 * checkout holding the day instead of writing it database-only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { BrainEngine } from '../src/core/engine.ts';
import { connectTemplateBrain } from './helpers/brain-template.ts';
import { options } from './helpers/connector-fixture.ts';
import { slackFetch, slackTs, type FakeSlack } from './helpers/slack-fixture.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { runSlackSync } from '../src/core/slack/slack-source.ts';
import { parseSlackSourceConfig } from '../src/core/slack/source-config.ts';
import { slackApi } from '../src/core/slack/client.ts';
import { slackPagePath } from '../src/core/slack/render.ts';
import { connectorFactsSession } from '../src/core/facts/retire.ts';
import { addSource } from '../src/core/sources-ops.ts';
import { slugifyPath } from '../src/core/sync.ts';
import { CONNECTOR_DB_CURSOR_OP } from '../src/core/connectors/db-cursor.ts';

const DAY = 86_400_000;
const NOW = Date.parse('2026-06-15T12:00:00Z');
const at = (daysAgo: number, hour: number) => Date.parse(new Date(NOW - daysAgo * DAY).toISOString().slice(0, 10) + `T${String(hour).padStart(2, '0')}:00:00Z`);
const dayOf = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString().slice(0, 10);
const USERS = { UALICE0001: { name: 'Alice Example' }, UBOB000001: { name: 'Bob Example' }, UCAROL0001: { name: 'Carol Example', deleted: true } };

const api = (fake: FakeSlack, extra: { maxRequests?: number; now?: () => number } = {}) => slackApi({ token: 'xoxb-synthetic-fixture', userAgent: 'gbrain-test',
  fetchImpl: slackFetch(fake), sleep: async () => {}, minDelayMs: 0, now: extra.now ?? (() => NOW), ...(extra.maxRequests !== undefined ? { maxRequests: extra.maxRequests } : {}) });

function workspace(teamId = 'TACME00001'): FakeSlack {
  return { teamId, users: { ...USERS }, calls: [], channels: [
    { id: 'CGENERAL01', name: 'general', messages: [
      { ts: slackTs(at(2, 9)), user: 'UALICE0001', text: 'Morning, <@UBOB000001>. The launch review is at noon.',
        replies: [{ ts: slackTs(at(2, 10)), user: 'UBOB000001', text: 'Thanks, I will bring the numbers.' }, { ts: slackTs(at(1, 8)), user: 'UCAROL0001', text: 'Late reply from the next day.' }] },
      { ts: slackTs(at(2, 15)), user: 'UBOB000001', text: 'Pricing stays monthly for now.' },
      { ts: slackTs(at(1, 11)), user: 'UALICE0001', text: 'Day two update.' },
      { ts: slackTs(at(30, 11)), user: 'UALICE0001', text: 'Too old for the history window.' },
    ] },
    { id: 'CPRIVATE01', name: 'leadership', isPrivate: true, messages: [{ ts: slackTs(at(1, 13)), user: 'UALICE0001', text: 'Private planning note.' }] },
  ] };
}

let home: string;
let engine: BrainEngine;
beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-slack-'));
  engine = await connectTemplateBrain(join(home, 'database'));
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
}, 120_000);
afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

let n = 0;
async function slackSource(fake: FakeSlack, extra: Record<string, unknown> = {}, dir: string | null = null) {
  const id = `slack-${++n}`;
  const config = { kind: 'slack', s_channels: fake.channels.map(c => c.id).join(','), s_record: dir ? 'git' : 'database', ...(dir ? { s_dir: dir } : {}), federated: false, ...extra };
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)', [id, dir, JSON.stringify(config)]);
  return { id, cfg: parseSlackSourceConfig(config, '') };
}
const pages = (sourceId: string) => engine.executeRaw<{ slug: string; visibility: string | null; title: string; body: string; type: string }>(
  `SELECT slug, frontmatter->>'visibility' AS visibility, title, type, compiled_truth AS body FROM pages WHERE source_id=$1 AND deleted_at IS NULL ORDER BY slug`, [sourceId]);
const daySlug = (channel: string, daysAgo: number) => slugifyPath(slackPagePath(channel, dayOf(daysAgo)));
async function addFact(sourceId: string, slug: string, fact: string) {
  await engine.executeRaw(`INSERT INTO facts (fact, source, source_id, source_session) VALUES ($1, 'sync:import', $2, $3)`, [fact, sourceId, connectorFactsSession(sourceId, slug)]);
}
const activeFacts = async (sourceId: string) => (await engine.executeRaw<{ fact: string }>(
  'SELECT fact FROM facts WHERE source_id=$1 AND expired_at IS NULL ORDER BY fact', [sourceId])).map(r => r.fact);
const run = (id: string, cfg: ReturnType<typeof parseSlackSourceConfig>, fake: FakeSlack, extra: { now?: number; maxRequests?: number; full?: boolean } = {}) =>
  runSlackSync(engine, id, cfg, { ...options, ...(extra.full ? { full: true } : {}) },
    { api: api(fake, { now: () => extra.now ?? NOW, ...(extra.maxRequests !== undefined ? { maxRequests: extra.maxRequests } : {}) }), now: () => extra.now ?? NOW });

const backends = testBackends();
for (const kind of backends) describe(`repo-less brain (record: database, ${kind})`, () => {
  let pglite: BrainEngine | undefined;
  let close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (kind !== 'postgres') return;
    pglite = engine;
    ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  }, 120_000);
  afterAll(async () => { if (pglite) { await close!(); engine = pglite; } });

  test('imports one page per channel day with thread replies, no directory, file or git; the cursor lives in the database', async () => {
    const fake = workspace();
    const { id, cfg } = await slackSource(fake);
    expect(cfg.record).toBe('database');
    const before = readdirSync(home).sort();
    const result = await run(id, cfg, fake);
    expect(result.added).toBe(3);
    expect(readdirSync(home).sort()).toEqual(before);
    const rows = await pages(id);
    expect(rows.map(r => r.slug)).toEqual([daySlug('CGENERAL01', 2), daySlug('CGENERAL01', 1), daySlug('CPRIVATE01', 1)].sort());
    const general = rows.find(r => r.slug === daySlug('CGENERAL01', 2))!;
    expect(general.type).toBe('slack');
    expect(general.visibility).toBeNull();
    expect(general.body).toContain(`**Alice Example** (${dayOf(2)} 9:00 AM): Morning, @Bob Example. The launch review is at noon.`);
    expect(general.body).toContain(`**Bob Example** (${dayOf(2)} 10:00 AM): ↳ Thanks, I will bring the numbers.`);
    expect(general.body).toContain(`**Carol Example (deactivated)** (${dayOf(1)} 8:00 AM): ↳ Late reply from the next day.`);
    expect(general.body).not.toContain('Too old');
    expect(rows.find(r => r.slug === daySlug('CPRIVATE01', 1))!.visibility).toBe('private');
    const [cursor] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM op_checkpoints WHERE op=$1', [CONNECTOR_DB_CURSOR_OP]);
    expect(cursor!.n).toBeGreaterThan(0);

    fake.calls.length = 0;
    const again = await run(id, cfg, fake, { now: NOW + 60_000 });
    expect(again.added + again.modified + again.deleted).toBe(0);
    expect(fake.calls.filter(c => c.startsWith('conversations.replies'))).toEqual([]);
  });

  test('an edit upstream rebuilds the day and retires its facts; a day emptied upstream is deleted and its facts retired', async () => {
    const fake = workspace();
    const { id, cfg } = await slackSource(fake);
    await run(id, cfg, fake);
    const edited = daySlug('CGENERAL01', 2);
    const emptied = daySlug('CGENERAL01', 1);
    await addFact(id, edited, 'Pricing stays monthly');
    await addFact(id, emptied, 'Day two had an update');
    const general = fake.channels[0]!;
    general.messages[1] = { ...general.messages[1]!, text: 'Pricing moves to annual plans.', edited: { ts: slackTs(NOW) } };
    general.messages.splice(2, 1);
    general.messages[0]!.replies!.splice(1, 1);
    const result = await run(id, cfg, fake, { now: NOW + 3_600_000 });
    expect(result.modified).toBe(1);
    expect(result.deleted).toBe(1);
    expect(await activeFacts(id)).toEqual([]);
    const rows = await pages(id);
    expect(rows.map(r => r.slug)).not.toContain(emptied);
    expect(rows.find(r => r.slug === edited)!.body).toContain('Pricing moves to annual plans. _(edited)_');
  });

  test('a token for another workspace is refused before anything is imported', async () => {
    const fake = workspace();
    const { id, cfg } = await slackSource(fake);
    await run(id, cfg, fake);
    const count = (await pages(id)).length;
    const other = workspace('TOTHER0001');
    other.channels[0]!.messages.push({ ts: slackTs(at(0, 9)), user: 'UALICE0001', text: 'From the other workspace.' });
    await expect(run(id, cfg, other, { now: NOW + 60_000 })).rejects.toMatchObject({ code: 'connector_account_changed' });
    expect(await pages(id)).toHaveLength(count);
  });

  test('the first sync refuses a channel the app was not invited to, with the fix; nothing is imported', async () => {
    const fake = workspace();
    fake.channels.push({ id: 'CNOTJOIN01', name: 'random', member: false, messages: [] });
    const { id, cfg } = await slackSource(fake);
    const error = await run(id, cfg, fake).catch(e => e);
    expect(error).toMatchObject({ code: 'connector_access_denied' });
    expect(String(error.suggestion)).toContain('/invite');
    expect(await pages(id)).toEqual([]);
  });

  test('a channel the app later loses is held while the other channels keep syncing', async () => {
    const fake = workspace();
    const { id, cfg } = await slackSource(fake);
    await run(id, cfg, fake);
    fake.channels[1]!.member = false;
    fake.channels[0]!.messages.push({ ts: slackTs(NOW - 3_600_000), user: 'UBOB000001', text: 'Fresh message after the kick.' });
    const result = await run(id, cfg, fake, { now: NOW + 60_000 });
    expect(result.status).toBe('partial');
    expect(result.added).toBe(1);
    expect((await pages(id)).map(r => r.slug)).toContain(daySlug('CGENERAL01', 0));
  });

  test('the per-run request cap stops the run partial; the next run finishes the same window', async () => {
    const fake = workspace();
    fake.pageSize = 1;
    const { id, cfg } = await slackSource(fake);
    const first = await run(id, cfg, fake, { maxRequests: 6 });
    expect(first.status).toBe('partial');
    const second = await run(id, cfg, fake, { now: NOW + 60_000 });
    expect(second.status).not.toBe('partial');
    expect((await pages(id)).length).toBe(3);
  });

  test('a rate limit stops the run with rate_limited and records when Slack resets', async () => {
    const fake = workspace();
    const { id, cfg } = await slackSource(fake);
    await run(id, cfg, fake);
    fake.rateLimited = true;
    await expect(run(id, cfg, fake)).rejects.toMatchObject({ code: 'rate_limited' });
    const [row] = await engine.executeRaw<{ keys: Array<{ retry_at: string }> }>(`SELECT completed_keys AS keys FROM op_checkpoints WHERE op='connector-rate-limit' AND fingerprint=$1`, [id]);
    expect(Date.parse(row!.keys[0]!.retry_at)).toBe(NOW + 600_000);
  });

  test('sources add --kind slack on a repo-less brain records to the database, keeps no directory and stores no token', async () => {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      await addSource(engine, { id: 'slack-added', slack: { channels: ['CGENERAL01'], record: 'auto', private: false } });
    });
    const [row] = await engine.executeRaw<{ local_path: string | null; config: Record<string, unknown> }>('SELECT local_path, config FROM sources WHERE id=$1', ['slack-added']);
    expect(row!.local_path).toBeNull();
    expect(row!.config).toMatchObject({ kind: 'slack', s_channels: 'CGENERAL01', s_record: 'database', federated: false });
    expect(JSON.stringify(row!.config)).not.toMatch(/token|xox/i);
  });
});

if (backends.includes('pglite')) describe('Git-recorded brain (record: git, unmanaged)', () => {
  const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });

  test('days are committed before their rows; a private channel is never committed; a channel that becomes private leaves HEAD', async () => {
    const repo = join(home, 'repo-brain');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@example.invalid');
    git(repo, 'config', 'user.name', 'Test Example');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
    const dir = join(repo, 'slack-source');
    await withEnv({ GBRAIN_HOME: home }, async () => {
      await addSource(engine, { id: 'slack-git', slack: { channels: ['CGENERAL01', 'CPRIVATE01'], record: 'auto', private: false, dir } });
    });
    const [src] = await engine.executeRaw<{ config: Record<string, unknown> }>('SELECT config FROM sources WHERE id=$1', ['slack-git']);
    const cfg = parseSlackSourceConfig(src!.config, '');
    expect(cfg.record).toBe('git');
    const fake = workspace();
    const result = await runSlackSync(engine, 'slack-git', cfg, options, { api: api(fake), now: () => NOW });
    expect(result.added).toBe(3);
    const tracked = () => git(repo, 'ls-files').stdout;
    expect(tracked()).toContain(`slack-source/${slackPagePath('CGENERAL01', dayOf(2))}`);
    expect(tracked()).not.toContain('CPRIVATE01');
    expect(existsSync(join(dir, slackPagePath('CPRIVATE01', dayOf(1))))).toBe(false);
    expect(git(repo, 'status', '--porcelain').stdout.trim()).toBe('');

    await addFact('slack-git', daySlug('CGENERAL01', 2), 'Launch review at noon');
    fake.channels[0]!.isPrivate = true;
    const converted = await runSlackSync(engine, 'slack-git', cfg, options, { api: api(fake), now: () => NOW + 60_000 });
    expect(converted.status).not.toBe('partial');
    expect(tracked()).not.toContain('CGENERAL01');
    expect(readdirSync(dir, { recursive: true }).filter(name => String(name).endsWith('.md'))).toEqual([]);
    expect((await pages('slack-git')).map(r => r.visibility)).toEqual(['private', 'private', 'private']);
    expect(await activeFacts('slack-git')).toEqual([]);
    expect(git(repo, 'status', '--porcelain').stdout.trim()).toBe('');
  });

  test('a missing checkout holds the day; nothing is written database-only', async () => {
    const dir = join(home, 'gone-checkout', 'slack');
    const fake = workspace();
    fake.channels.splice(1, 1);
    const { id, cfg } = await slackSource(fake, {}, dir);
    const result = await run(id, cfg, fake);
    expect(result.status).toBe('partial');
    expect(await pages(id)).toEqual([]);
    const [cursor] = await engine.executeRaw<{ keys: Array<{ state: { item_holds: { items: Record<string, { code: string }> } } }> }>(
      'SELECT completed_keys AS keys FROM op_checkpoints WHERE op=$1 AND completed_keys::text LIKE $2', [CONNECTOR_DB_CURSOR_OP, `%"CGENERAL01/${dayOf(2)}"%`]);
    expect(cursor!.keys[0]!.state.item_holds.items[`CGENERAL01/${dayOf(2)}`]!.code).toBe('connector_binding_missing');
  });
});
