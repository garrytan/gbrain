/**
 * GST-3216 PR 2: connector pages mark the owner's turns only from the provider's own signal: iMessage's is-from-me
 * flag (label "Me") and Gmail's SENT label, never a From line the sender sets. The owner label must be unique on the page,
 * and the source must be one person's (bound to one member, or the owner's on a brain no other person shares).
 * Meetings get no marker: a recorder's speaker label that matches the account owner does not prove who spoke.
 * Repo-less PGLite, plus Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { addMember } from '../src/core/access/members.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { bindMemberSource } from '../src/core/access/member-sources.ts';
import { connectorSpeakerOwnerStamp, readSpeakerOwners } from '../src/core/identity/speaker-owner.ts';
import { renderThreadPage } from '../src/core/google/google-render.ts';
import type { GmailMessageMeta } from '../src/core/google/types.ts';
import { renderMeetingPage } from '../src/core/meetings/render.ts';
import { runIMessageSync } from '../src/core/imessage/imessage-source.ts';
import { parseIMessageSourceConfig } from '../src/core/imessage/source-config.ts';
import { imessageHelper } from '../src/core/apple/helper-client.ts';
import { imessageChatKey, imessagePagePath } from '../src/core/imessage/render.ts';
import { slugifyPath } from '../src/core/sync.ts';
import { options } from './helpers/connector-fixture.ts';
import { HELPER_TEST_TOKEN, helperFetch, type FakeHelper } from './helpers/imessage-helper-fixture.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

setDefaultTimeout(60_000);

const ACCOUNT = 'owner@example.com';
const mail = (id: string, from: string, fromAddress: string, labelIds: string[] = ['INBOX']): GmailMessageMeta => ({
  id: `m${id}`.padEnd(12, '0'), threadId: 't1', from, fromAddress, to: [ACCOUNT], cc: [], subject: 'Plans', dateIso: `2026-04-0${id}T10:00:00.000Z`,
  internalDateMs: 0, labelIds, listUnsubscribe: false, bodyText: `message ${id}` } as GmailMessageMeta);
const marker = (messages: GmailMessageMeta[], member: string | null = null) => {
  const page = renderThreadPage({ threadId: 't1', account: ACCOUNT, messages }, { member })!;
  const line = page.markdown.split('\n').find(l => l.startsWith('speaker_owner: '));
  return line ? JSON.parse(line.slice('speaker_owner: '.length)) : undefined;
};

describe('Gmail thread pages', () => {
  test('the SENT messages are the owner\'s, under their From line', () => {
    expect(marker([mail('1', 'Bob Example <bob@example.com>', 'bob@example.com'), mail('2', 'Owner Example <owner@example.com>', ACCOUNT, ['SENT'])], 'alice-example'))
      .toEqual({ label: 'Owner Example <owner@example.com>', basis: 'gmail_sent', turns: 1, member: 'alice-example' });
  });

  test('an inbound message whose From line copies the owner\'s address is not an owner turn', () => {
    expect(marker([mail('1', 'Owner Example <owner@example.com>', ACCOUNT), mail('2', 'Bob Example <bob@example.com>', 'bob@example.com')])).toBeUndefined();
    expect(marker([mail('1', 'Owner Example <owner@example.com>', ACCOUNT, ['SENT']), mail('2', 'Owner Example <owner@example.com>', ACCOUNT)])).toBeUndefined();
  });

  test('two From lines for the owner, or another sender under the owner\'s From line: speaker-unknown', () => {
    expect(marker([mail('1', 'Owner Example <owner@example.com>', ACCOUNT, ['SENT']), mail('2', 'O. Example <owner@example.com>', ACCOUNT, ['SENT'])])).toBeUndefined();
    expect(marker([mail('1', 'Pat Example', ACCOUNT, ['SENT']), mail('2', 'Pat Example', 'pat@example.com')])).toBeUndefined();
  });

  test('no owner turn, or no stamp: no marker', () => {
    expect(marker([mail('1', 'Bob Example <bob@example.com>', 'bob@example.com')])).toBeUndefined();
    expect(renderThreadPage({ threadId: 't1', account: ACCOUNT, messages: [mail('1', 'Owner Example', ACCOUNT, ['SENT'])] })!.markdown).not.toContain('speaker_owner');
  });
});

test('a meeting page never carries a marker, even when a speaker label matches the account owner', () => {
  const page = renderMeetingPage({ id: 'meet-1', title: 'Weekly sync', startedAt: '2026-04-01T10:00:00.000Z', durationSec: 600, organizerEmail: ACCOUNT,
    attendees: [{ name: 'Owner Example', email: ACCOUNT }, { name: 'Bob Example', email: 'bob@example.com' }], url: null, summary: null, actionItems: [], keywords: [],
    transcript: [{ speaker: 'Owner Example', startSec: 0, text: 'hello' }, { speaker: 'Bob Example', startSec: 5, text: 'hi' }] } as never,
  { cfg: { provider: 'fireflies', privateOnly: false } as never, account: { email: ACCOUNT } as never });
  expect(page).not.toContain('speaker_owner');
});

const DAY = 86_400_000;
const NOW = Date.parse('2026-06-15T12:00:00Z');
const at = (daysAgo: number, hour: number) => Date.parse(new Date(NOW - daysAgo * DAY).toISOString().slice(0, 10) + `T${String(hour).padStart(2, '0')}:00:00Z`);
const dayOf = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString().slice(0, 10);
const ALICE = '+15555550100';
const GROUP = 'chat000000000000000001';
const daySlug = (threadId: string, daysAgo: number) => slugifyPath(imessagePagePath(imessageChatKey(threadId), dayOf(daysAgo)));
const mac = (): FakeHelper => ({ token: HELPER_TEST_TOKEN, calls: [], chats: [
  { threadId: ALICE, displayName: 'Alice Example', participants: [ALICE], messages: [
    { rowid: 10, at: at(2, 9), text: 'Lunch at noon tomorrow?' },
    { rowid: 11, at: at(2, 10), text: 'Yes, see you there.', fromMe: true },
    { rowid: 12, at: at(2, 11), text: 'Great.', fromMe: true },
    { rowid: 13, at: at(1, 8), text: 'Running ten minutes late.' },
  ] },
  { threadId: GROUP, displayName: 'Harbor Planning', participants: [ALICE, '+15555550101'], isGroup: true, messages: [
    { rowid: 20, at: at(1, 13), text: 'I will bring the maps.', from: 'Me' },
    { rowid: 21, at: at(1, 14), text: 'Thanks.', fromMe: true },
  ] },
] } as FakeHelper);

for (const backend of testBackends()) describe(`[${backend}] connector owner stamps and iMessage pages (repo-less)`, () => {
  let engine: BrainEngine;
  let close: () => Promise<void>;
  let home: string;
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gb-speaker-connectors-'));
    if (backend === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { const pg = new PGLiteEngine(); await pg.connect({ engine: 'pglite' } as never); await pg.initSchema(); engine = pg; close = () => pg.disconnect(); }
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  }, 120_000);
  afterAll(async () => { await close?.(); rmSync(home, { recursive: true, force: true }); }, 60_000);
  beforeEach(async () => {
    for (const sql of ['DELETE FROM access_member_sources', 'DELETE FROM access_members', 'DELETE FROM pages', 'DELETE FROM op_checkpoints',
      "DELETE FROM sources WHERE id <> 'default'", "DELETE FROM config WHERE key = 'access.owner_member'"]) await engine.executeRaw(sql);
  });
  const source = async (id: string, kind: string) => {
    await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,NULL,$2::text::jsonb)', [id, JSON.stringify({ kind, federated: false })]);
  };

  test('a source is one person\'s: its one bound member, or the owner on a brain no other person shares', async () => {
    await source('mail-a', 'google');
    expect(await connectorSpeakerOwnerStamp(engine, 'mail-a')).toEqual({ member: null });
    await addMember(engine, 'alice-example');
    await setOwner(engine, 'alice-example');
    expect(await connectorSpeakerOwnerStamp(engine, 'mail-a')).toEqual({ member: 'alice-example' });
    await addMember(engine, 'bob-example');
    expect(await connectorSpeakerOwnerStamp(engine, 'mail-a')).toBeNull();
    await bindMemberSource(engine, 'bob-example', 'mail-a');
    expect(await connectorSpeakerOwnerStamp(engine, 'mail-a')).toEqual({ member: 'bob-example' });
    await bindMemberSource(engine, 'alice-example', 'mail-a');
    expect(await connectorSpeakerOwnerStamp(engine, 'mail-a')).toBeNull();
  });

  test('an iMessage sync marks "Me" only where the owner wrote and no one else renders as Me', async () => {
    await source('texts', 'imessage');
    const cfg = parseIMessageSourceConfig({ kind: 'imessage', federated: false });
    const helper = imessageHelper({ sourceId: 'test', port: 47001, token: HELPER_TEST_TOKEN, fetchImpl: helperFetch(mac()) });
    await runIMessageSync(engine, 'texts', cfg, options, { helper, now: () => NOW });
    const reads = await readSpeakerOwners(engine, [daySlug(ALICE, 2), daySlug(ALICE, 1), daySlug(GROUP, 1)].map(slug => ({ source_id: 'texts', slug })));
    expect(reads.map(r => [r.slug, r.status, r.marker])).toEqual([
      [daySlug(ALICE, 2), 'trusted', { label: 'Me', basis: 'is_from_me', turns: 2 }],
      [daySlug(ALICE, 1), 'absent', null],
      [daySlug(GROUP, 1), 'absent', null],
    ]);
  });
});
