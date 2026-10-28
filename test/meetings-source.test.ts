/**
 * Meetings source kind (Fireflies first): repo-less and Git-recorded brains.
 *
 * Synthetic Fireflies GraphQL fixtures only; no network. Covers the repo-less
 * default (record: database, no directory, no file and no git command, the
 * connector cursor in op_checkpoints), a Git-recorded unmanaged brain (the
 * commit lands before the database row; a missing checkout holds the item,
 * never writes it database-only), edits and deletions upstream retiring the
 * facts extracted from the page, deferral of meetings still processing, the
 * account pin, and the provider's rate limit recorded for the scheduler.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { BrainEngine } from '../src/core/engine.ts';
import { connectTemplateBrain } from './helpers/brain-template.ts';
import { json, options } from './helpers/connector-fixture.ts';
import { withEnv } from './helpers/with-env.ts';
import { runMeetingsSync } from '../src/core/meetings/meetings-source.ts';
import { parseMeetingsSourceConfig } from '../src/core/meetings/source-config.ts';
import { firefliesProvider } from '../src/core/meetings/providers/fireflies.ts';
import { meetingPagePath } from '../src/core/meetings/render.ts';
import { connectorFactsSession } from '../src/core/facts/retire.ts';
import { addSource } from '../src/core/sources-ops.ts';
import { slugifyPath } from '../src/core/sync.ts';
import { CONNECTOR_DB_CURSOR_OP } from '../src/core/connectors/db-cursor.ts';

const DAY = 86_400_000;
const NOW = Date.parse('2026-06-15T12:00:00Z');
const OWNER = 'owner@example.invalid';

interface FakeMeeting { id: string; title: string; date: number; summary?: string | null; attendees?: string[]; organizer?: string }
interface Fake { userId: string; email: string; meetings: FakeMeeting[]; rateLimited?: boolean; calls: string[] }

function fireflies(fake: Fake) {
  return async (_url: string, init: RequestInit) => {
    const { query, variables } = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
    if (fake.rateLimited) return json({ errors: [{ message: 'Too many requests', extensions: { code: 'too_many_requests', metadata: { retryAfter: 600 } } }] });
    if (query.includes('GbrainUser')) { fake.calls.push('user'); return json({ data: { user: { user_id: fake.userId, email: fake.email, name: 'Owner Example' } } }); }
    if (query.includes('GbrainTranscripts')) {
      fake.calls.push('list');
      const from = Date.parse(String(variables.fromDate)); const to = Date.parse(String(variables.toDate));
      const hits = fake.meetings.filter(m => m.date >= from && m.date < to).sort((a, b) => b.date - a.date);
      const skip = Number(variables.skip ?? 0); const limit = Number(variables.limit ?? 50);
      return json({ data: { transcripts: hits.slice(skip, skip + limit).map(m => ({ id: m.id, title: m.title, date: m.date })) } });
    }
    fake.calls.push(`get:${variables.id}`);
    const m = fake.meetings.find(x => x.id === variables.id);
    if (!m) return json({ data: { transcript: null }, errors: [{ message: 'Transcript not found', extensions: { code: 'object_not_found' } }] });
    const attendees = m.attendees ?? [OWNER, 'alice@example.invalid'];
    return json({ data: { transcript: {
      id: m.id, title: m.title, date: m.date, duration: 30, transcript_url: `https://app.fireflies.example/view/${m.id}`,
      organizer_email: m.organizer ?? attendees[0], participants: attendees,
      meeting_attendees: attendees.map(email => ({ email, displayName: email.split('@')[0] })),
      summary: m.summary === null ? null : { overview: m.summary ?? `Summary of ${m.title}.`, action_items: '- Send the follow-up', keywords: ['planning'] },
    } } });
  };
}

const provider = (fake: Fake, now = () => NOW) => firefliesProvider({ token: 'synthetic-fixture-key', userAgent: 'gbrain-test', now,
  fetchImpl: fireflies(fake), sleep: async () => {} });

let home: string;
let engine: BrainEngine;
beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-meetings-'));
  engine = await connectTemplateBrain(join(home, 'database'));
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
}, 120_000);
afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

let n = 0;
async function meetingsSource(extra: Record<string, unknown> = {}, dir: string | null = null) {
  const id = `meet-${++n}`;
  const config = { kind: 'meetings', m_provider: 'fireflies', m_record: dir ? 'git' : 'database', ...(dir ? { m_dir: dir } : {}), federated: false, ...extra };
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)', [id, dir, JSON.stringify(config)]);
  return { id, cfg: parseMeetingsSourceConfig(config, '') };
}
const pages = (sourceId: string) => engine.executeRaw<{ slug: string; visibility: string | null; title: string; body: string }>(
  `SELECT slug, frontmatter->>'visibility' AS visibility, title, compiled_truth AS body FROM pages WHERE source_id=$1 AND deleted_at IS NULL ORDER BY slug`, [sourceId]);
const meetingSlug = (m: FakeMeeting) => slugifyPath(meetingPagePath({ id: m.id, title: m.title, startedAt: new Date(m.date).toISOString() }));
async function addFact(sourceId: string, slug: string, fact: string) {
  await engine.executeRaw(`INSERT INTO facts (fact, source, source_id, source_session) VALUES ($1, 'sync:import', $2, $3)`, [fact, sourceId, connectorFactsSession(sourceId, slug)]);
}
const activeFacts = async (sourceId: string) => (await engine.executeRaw<{ fact: string }>(
  'SELECT fact FROM facts WHERE source_id=$1 AND expired_at IS NULL ORDER BY fact', [sourceId])).map(r => r.fact);

describe('repo-less brain (record: database)', () => {
  test('imports meetings with no directory, no file and no git; the cursor lives in the database', async () => {
    const fake: Fake = { userId: 'u-1', email: OWNER, calls: [], meetings: [
      { id: 'mtg-aaa111', title: 'Weekly planning', date: NOW - 2 * DAY },
      { id: 'mtg-bbb222', title: 'Board prep', date: NOW - 5 * DAY, attendees: ['alice@example.invalid', 'bob@example.invalid'] },
      { id: 'mtg-old000', title: 'Too old', date: NOW - 40 * DAY },
    ] };
    const { id, cfg } = await meetingsSource();
    expect(cfg.record).toBe('database');
    expect(cfg.dir).toBeNull();
    const before = readdirSync(home).sort();
    const result = await runMeetingsSync(engine, id, cfg, options, { provider: provider(fake), now: () => NOW });
    expect(result.added).toBe(2);
    expect(readdirSync(home).sort()).toEqual(before);
    const rows = await pages(id);
    expect(rows.map(r => r.slug)).toEqual([meetingSlug(fake.meetings[0]!), meetingSlug(fake.meetings[1]!)].sort());
    const byTitle = Object.fromEntries(rows.map(r => [r.title, r]));
    expect(byTitle['Weekly planning']!.visibility).toBeNull();
    expect(byTitle['Board prep']!.visibility).toBe('private');
    expect(byTitle['Weekly planning']!.body).toContain('Summary of Weekly planning.');
    const [cursor] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM op_checkpoints WHERE op=$1', [CONNECTOR_DB_CURSOR_OP]);
    expect(cursor!.n).toBeGreaterThan(0);

    const again = await runMeetingsSync(engine, id, cfg, options, { provider: provider(fake), now: () => NOW + 60_000 });
    expect(again.added + again.modified + again.deleted).toBe(0);
  });

  test('an edit upstream updates the page and retires its facts; a deletion removes the page and retires its facts', async () => {
    const fake: Fake = { userId: 'u-2', email: OWNER, calls: [], meetings: [
      { id: 'mtg-ccc333', title: 'Pricing review', date: NOW - 1 * DAY },
      { id: 'mtg-ddd444', title: 'Hiring sync', date: NOW - 1 * DAY + 3_600_000 },
    ] };
    const { id, cfg } = await meetingsSource();
    await runMeetingsSync(engine, id, cfg, options, { provider: provider(fake), now: () => NOW });
    const [edited, deleted] = fake.meetings.map(meetingSlug) as [string, string];
    await addFact(id, edited, 'Pricing moves to annual plans');
    await addFact(id, deleted, 'Two engineers start in July');
    expect(await activeFacts(id)).toHaveLength(2);

    fake.meetings[0]!.summary = 'Pricing stays monthly after review.';
    fake.meetings.splice(1, 1);
    const result = await runMeetingsSync(engine, id, cfg, options, { provider: provider(fake), now: () => NOW + 3_600_000 });
    expect(result.modified).toBe(1);
    expect(result.deleted).toBe(1);
    expect(await activeFacts(id)).toEqual([]);
    const rows = await pages(id);
    expect(rows.map(r => r.slug)).toEqual([edited]);
    expect(rows[0]!.body).toContain('Pricing stays monthly after review.');
  });

  test('a meeting still processing is deferred, then published once its summary arrives', async () => {
    const fake: Fake = { userId: 'u-3', email: OWNER, calls: [], meetings: [{ id: 'mtg-eee555', title: 'Fresh call', date: NOW - 3_600_000, summary: null }] };
    const { id, cfg } = await meetingsSource();
    const first = await runMeetingsSync(engine, id, cfg, options, { provider: provider(fake), now: () => NOW });
    expect(first.added).toBe(0);
    expect(await pages(id)).toEqual([]);
    fake.meetings[0]!.summary = 'The summary arrived.';
    const second = await runMeetingsSync(engine, id, cfg, options, { provider: provider(fake), now: () => NOW + 600_000 });
    expect(second.added).toBe(1);
    expect((await pages(id))[0]!.body).toContain('The summary arrived.');
  });

  test('a key for another account is refused before anything is imported', async () => {
    const fake: Fake = { userId: 'u-4', email: OWNER, calls: [], meetings: [{ id: 'mtg-fff666', title: 'First', date: NOW - DAY }] };
    const { id, cfg } = await meetingsSource();
    await runMeetingsSync(engine, id, cfg, options, { provider: provider(fake), now: () => NOW });
    const other: Fake = { userId: 'u-other', email: 'other@example.invalid', calls: [], meetings: [{ id: 'mtg-ggg777', title: 'Other', date: NOW - DAY }] };
    await expect(runMeetingsSync(engine, id, cfg, options, { provider: provider(other), now: () => NOW + 60_000 })).rejects.toMatchObject({ code: 'connector_account_changed' });
    expect((await pages(id)).map(r => r.title)).toEqual(['First']);
  });

  test('a rate limit stops the run with rate_limited and records when the provider resets', async () => {
    const fake: Fake = { userId: 'u-5', email: OWNER, calls: [], meetings: [] };
    const { id, cfg } = await meetingsSource();
    await runMeetingsSync(engine, id, cfg, options, { provider: provider(fake), now: () => NOW });
    fake.rateLimited = true;
    await expect(runMeetingsSync(engine, id, cfg, options, { provider: provider(fake), now: () => NOW })).rejects.toMatchObject({ code: 'rate_limited' });
    const [row] = await engine.executeRaw<{ keys: Array<{ retry_at: string }> }>(`SELECT completed_keys AS keys FROM op_checkpoints WHERE op='connector-rate-limit' AND fingerprint=$1`, [id]);
    expect(Date.parse(row!.keys[0]!.retry_at)).toBe(NOW + 600_000);
  });

  test('sources add --kind meetings on a repo-less brain records to the database and keeps no directory', async () => {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      await addSource(engine, { id: 'meet-added', meetings: { provider: 'fireflies', record: 'auto', transcript: 'none', private: false } });
    });
    const [row] = await engine.executeRaw<{ local_path: string | null; config: Record<string, unknown> }>('SELECT local_path, config FROM sources WHERE id=$1', ['meet-added']);
    expect(row!.local_path).toBeNull();
    expect(row!.config).toMatchObject({ kind: 'meetings', m_provider: 'fireflies', m_record: 'database', federated: false });
    expect(JSON.stringify(row!.config)).not.toMatch(/token|key/i);
  });
});

describe('Git-recorded brain (record: git, unmanaged)', () => {
  const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });

  test('each page is committed to the checkout before its database row', async () => {
    const repo = join(home, 'repo-brain');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@example.invalid');
    git(repo, 'config', 'user.name', 'Test Example');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
    const dir = join(repo, 'meetings-source');
    await withEnv({ GBRAIN_HOME: home }, async () => {
      await addSource(engine, { id: 'meet-git', meetings: { provider: 'fireflies', record: 'auto', transcript: 'none', private: false, dir } });
    });
    const [src] = await engine.executeRaw<{ config: Record<string, unknown> }>('SELECT config FROM sources WHERE id=$1', ['meet-git']);
    const cfg = parseMeetingsSourceConfig(src!.config, '');
    expect(cfg.record).toBe('git');
    const fake: Fake = { userId: 'u-6', email: OWNER, calls: [], meetings: [
      { id: 'mtg-hhh888', title: 'Roadmap review', date: NOW - DAY },
      { id: 'mtg-iii999', title: 'Not attended', date: NOW - DAY, attendees: ['alice@example.invalid'] },
    ] };
    const result = await runMeetingsSync(engine, 'meet-git', cfg, options, { provider: provider(fake), now: () => NOW });
    expect(result.added).toBe(2);
    const committed = git(repo, 'log', '--name-only', '--format=%s').stdout;
    const publicPath = meetingPagePath({ id: 'mtg-hhh888', title: 'Roadmap review', startedAt: new Date(NOW - DAY).toISOString() });
    const privatePath = meetingPagePath({ id: 'mtg-iii999', title: 'Not attended', startedAt: new Date(NOW - DAY).toISOString() });
    expect(committed).toContain(`meetings-source/${publicPath}`);
    expect(committed).not.toContain(privatePath);
    expect(existsSync(join(dir, privatePath))).toBe(false);
    expect((await pages('meet-git')).map(r => r.visibility).sort()).toEqual([null, 'private'].sort());
    expect(git(repo, 'status', '--porcelain').stdout.trim()).toBe('');
  });

  test('a missing checkout holds the meeting; nothing is written database-only', async () => {
    const dir = join(home, 'gone-checkout', 'meetings');
    const { id, cfg } = await meetingsSource({}, dir);
    const fake: Fake = { userId: 'u-7', email: OWNER, calls: [], meetings: [{ id: 'mtg-jjj000', title: 'Held meeting', date: NOW - DAY }] };
    const result = await runMeetingsSync(engine, id, cfg, options, { provider: provider(fake), now: () => NOW });
    expect(result.status).toBe('partial');
    expect(await pages(id)).toEqual([]);
    const [cursor] = await engine.executeRaw<{ keys: Array<{ state: { item_holds: { items: Record<string, { code: string }> } } }> }>(
      'SELECT completed_keys AS keys FROM op_checkpoints WHERE op=$1 AND completed_keys::text LIKE $2', [CONNECTOR_DB_CURSOR_OP, '%mtg-jjj000%']);
    expect(cursor!.keys[0]!.state.item_holds.items['mtg-jjj000']!.code).toBe('connector_binding_missing');
  });
});
