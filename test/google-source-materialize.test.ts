/**
 * google-source materialize — end-to-end sweeps on a real PGLite engine.
 *
 * Mirrors test/github-source-materialize.test.ts: one shared engine
 * (beforeAll + resetPgliteState), a mutable fake Google API behind
 * fetchImpl, temp managed dirs, and an in-memory credential vault passed
 * via runGoogleSync's vaultOverride (no token-refresh HTTP ever fires —
 * the vault entry carries a fresh access token).
 *
 * Synthetic data only: example.com addresses, hex message/thread ids.
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import type { SyncOpts } from '../src/commands/sync.ts';
import type {
  CredentialEntry,
  CredentialMeta,
  CredentialVault,
  ProviderClientRecord,
} from '../src/core/creds/vault.ts';
import type { FetchImpl } from '../src/core/google/google-clients.ts';
import { __clearSuppressionCacheForTests } from '../src/core/google/loop-detect.ts';
import { __setChatTransportForTests } from '../src/core/ai/gateway.ts';
import {
  googleStateFile,
  myAddressSet,
  parseGoogleSourceConfig,
  readGoogleState,
  runGoogleSync,
} from '../src/core/google/google-source.ts';
import { importFile } from '../src/core/import-file.ts';

let engine: PGLiteEngine;
let schemaVersion: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  schemaVersion = (await engine.getConfig('version')) ?? '7';
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  // resetPgliteState truncates config; MinionQueue.ensureSchema gates on the
  // 'version' row (same re-seed pattern as the other minion-using tests).
  await engine.setConfig('version', schemaVersion);
  __clearSuppressionCacheForTests();
});

// ── Time helpers (exact-second timestamps so backfill floors are stable) ────

const NOW_MS = Math.floor(Date.now() / 1000) * 1000;
const daysAgoMs = (n: number): number => NOW_MS - n * 86_400_000;
const hoursAgoMs = (n: number): number => NOW_MS - n * 3_600_000;

// ── Thread / message id constants (hex only — emailCitation validates) ──────

const T_A = '17aa00000000a001'; // conversational thread (search + SENT + delta)
const T_B = '17aa00000000b002'; // old unanswered inbound (open-loop source)
const T_N = '17aa00000000c003'; // noise thread (noreply@)
const T_C = '17aa00000000d004'; // appears later (history-expired fallback)

// ── Fake Google API behind fetchImpl ─────────────────────────────────────────

interface FakeMessage {
  id: string;
  threadId: string;
  internalDateMs: number;
  headers: Record<string, string>;
  labelIds: string[];
  body: string;
}

interface FakeGoogle {
  profileHistoryId: string;
  messages: FakeMessage[];
  messagesPageSize: number;
  /** Each entry is one history record's touched threadIds. */
  history: string[][];
  historyResponseId: string;
  historyExpired: boolean;
  failThreads: Set<string>;
  contacts: unknown[];
  contactsDelta: unknown[];
  calendarEvents: unknown[];
  calendarDelta: unknown[];
  calendarExpireSyncToken: boolean;
  calls: string[];
  threadFetches: number;
  tokenPosts: number;
  onThreadFetch?: () => void;
}

function emptyFx(): FakeGoogle {
  return {
    profileHistoryId: '1000',
    messages: [],
    messagesPageSize: 100,
    history: [],
    historyResponseId: '1000',
    historyExpired: false,
    failThreads: new Set(),
    contacts: [],
    contactsDelta: [],
    calendarEvents: [],
    calendarDelta: [],
    calendarExpireSyncToken: false,
    calls: [],
    threadFetches: 0,
    tokenPosts: 0,
  };
}

function b64url(s: string): string {
  return Buffer.from(s, 'utf-8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function buildFetch(fx: FakeGoogle): FetchImpl {
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  return async (url: string): Promise<Response> => {
    const u = new URL(url);
    fx.calls.push(u.pathname + (u.search ? u.search : ''));

    if (u.hostname === 'oauth2.googleapis.com') {
      fx.tokenPosts++;
      return json({ access_token: 't2', expires_in: 3600 });
    }

    if (u.pathname.endsWith('/users/me/profile')) {
      return json({ emailAddress: 'a@example.com', historyId: fx.profileHistoryId });
    }

    if (u.pathname.endsWith('/users/me/messages')) {
      const q = u.searchParams.get('q') ?? '';
      const after = /after:(\d+)/.exec(q);
      const before = /before:(\d+)/.exec(q);
      let msgs = [...fx.messages];
      if (after) msgs = msgs.filter((m) => Math.floor(m.internalDateMs / 1000) >= Number(after[1]));
      if (before) msgs = msgs.filter((m) => Math.floor(m.internalDateMs / 1000) < Number(before[1]));
      msgs.sort((a, b) => b.internalDateMs - a.internalDateMs); // newest first, like Gmail
      const start = Number(u.searchParams.get('pageToken') ?? '0');
      const page = msgs.slice(start, start + fx.messagesPageSize);
      const next = start + fx.messagesPageSize < msgs.length ? String(start + fx.messagesPageSize) : undefined;
      return json({
        messages: page.map((m) => ({ id: m.id, threadId: m.threadId })),
        ...(next ? { nextPageToken: next } : {}),
      });
    }

    if (u.pathname.endsWith('/users/me/history')) {
      if (fx.historyExpired) return json({ error: { code: 404, message: 'Start history id is too old' } }, 404);
      return json({
        historyId: fx.historyResponseId,
        history: fx.history.map((tids) => ({ messages: tids.map((tid) => ({ threadId: tid })) })),
      });
    }

    const threadMatch = u.pathname.match(/\/users\/me\/threads\/([^/]+)$/);
    if (threadMatch) {
      const tid = threadMatch[1];
      fx.threadFetches++;
      fx.onThreadFetch?.();
      if (fx.failThreads.has(tid)) return json({ error: { code: 500, message: 'backend error' } }, 500);
      const msgs = fx.messages
        .filter((m) => m.threadId === tid)
        .sort((a, b) => b.internalDateMs - a.internalDateMs); // served newest-first
      return json({
        id: tid,
        messages: msgs.map((m) => ({
          id: m.id,
          threadId: tid,
          labelIds: m.labelIds,
          internalDate: String(m.internalDateMs),
          payload: {
            mimeType: 'multipart/alternative',
            headers: Object.entries(m.headers).map(([name, value]) => ({ name, value })),
            parts: [{ mimeType: 'text/plain', body: { data: b64url(m.body) } }],
          },
        })),
      });
    }

    // Any calendar id — the real API serves /calendars/<id>/events for every
    // calendar the account can read, not just 'primary'.
    if (/\/calendars\/[^/]+\/events/.test(u.pathname)) {
      if (u.searchParams.get('syncToken')) {
        if (fx.calendarExpireSyncToken) return json({ error: { code: 410, message: 'Sync token expired' } }, 410);
        return json({ items: fx.calendarDelta, nextSyncToken: 'cal-sync-2' });
      }
      return json({ items: fx.calendarEvents, nextSyncToken: 'cal-sync-1' });
    }

    if (u.pathname.includes('/people/me/connections')) {
      if (u.searchParams.get('syncToken')) {
        return json({ connections: fx.contactsDelta, nextSyncToken: 'ppl-sync-2' });
      }
      return json({ connections: fx.contacts, nextSyncToken: 'ppl-sync-1' });
    }

    return json({ error: { message: `unhandled ${u.pathname}` } }, 400);
  };
}

// ── In-memory vault (runGoogleSync's vaultOverride — no ~/.gbrain reads) ────

class FakeVault implements CredentialVault {
  entries = new Map<string, CredentialEntry>();
  clients = new Map<string, ProviderClientRecord>();
  async get(id: string): Promise<CredentialEntry | null> {
    return this.entries.get(id) ?? null;
  }
  async put(entry: CredentialEntry): Promise<void> {
    this.entries.set(entry.id, entry);
  }
  async list(): Promise<CredentialMeta[]> {
    return [];
  }
  async delete(id: string): Promise<boolean> {
    return this.entries.delete(id);
  }
  async getClient(provider: string): Promise<ProviderClientRecord | null> {
    return this.clients.get(provider) ?? null;
  }
  async putClient(rec: ProviderClientRecord): Promise<void> {
    this.clients.set(rec.provider, rec);
  }
  async deleteClient(provider: string): Promise<boolean> {
    return this.clients.delete(provider);
  }
}

const CLIENT_ID = '123-abc.apps.googleusercontent.com';

function makeVault(): FakeVault {
  const v = new FakeVault();
  v.entries.set('google:a@example.com', {
    id: 'google:a@example.com',
    provider: 'google',
    kind: 'oauth2',
    client_ref: 'byo',
    secret: {
      access_token: 't',
      refresh_token: 'r',
      expiry: new Date(Date.now() + 3_600_000).toISOString(),
    },
    meta: {
      account: 'a@example.com',
      sendas_aliases: ['alias@example.com'],
      connected_at: new Date().toISOString(),
      client_id: CLIENT_ID,
    },
  });
  v.clients.set('google', {
    provider: 'google',
    client_id: CLIENT_ID,
    client_secret: 'GOCSPX-test-secret-0000',
    created_at: new Date().toISOString(),
  });
  return v;
}

// ── Shared setup helpers ─────────────────────────────────────────────────────

async function insertGoogleSource(dir: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config) VALUES ($1, $2, $3, $4::text::jsonb)`,
    [
      'gsrc',
      'google',
      dir,
      JSON.stringify({
        kind: 'google',
        g_account: 'a@example.com',
        g_services: 'gmail,calendar,contacts',
        g_history_days: 90,
        g_dir: dir,
      }),
    ],
  );
}

function cfgFor(dir: string, services = 'gmail,calendar,contacts') {
  return parseGoogleSourceConfig(
    { kind: 'google', g_account: 'a@example.com', g_services: services, g_history_days: 90, g_dir: dir },
    dir,
  );
}

async function sweep(
  dir: string,
  fx: FakeGoogle,
  vault: FakeVault,
  opts: Partial<SyncOpts> = {},
  services = 'gmail,calendar,contacts',
) {
  return runGoogleSync(
    engine,
    'gsrc',
    cfgFor(dir, services),
    { sourceId: 'gsrc', noEmbed: true, noExtract: true, ...opts },
    buildFetch(fx),
    vault,
  );
}

async function slugsWhere(where: string): Promise<string[]> {
  const rows = await engine.executeRaw<{ slug: string }>(
    `SELECT slug FROM pages WHERE source_id = 'gsrc' AND deleted_at IS NULL AND ${where} ORDER BY slug`,
  );
  return rows.map((r) => r.slug);
}

function gmsg(id: string, threadId: string, ms: number, over: Partial<FakeMessage> = {}): FakeMessage {
  return {
    id,
    threadId,
    internalDateMs: ms,
    headers: { From: 'Charlie Example <charlie@example.com>', To: 'a@example.com', Subject: 'Quarterly zephyr roadmap' },
    labelIds: [],
    body: 'Sharing the zephyr roadmap draft for review.',
    ...over,
  };
}

/** Threads A (2 msgs, one SENT), B (old unanswered inbound), N (noise). */
function gmailFixture(fx: FakeGoogle): void {
  fx.messages.push(
    gmsg('18c2f4a9b3d21e01', T_A, daysAgoMs(2)),
    gmsg('18c2f4a9b3d21e02', T_A, daysAgoMs(2) + 3_600_000, {
      headers: { From: 'A Example <a@example.com>', To: 'charlie@example.com', Subject: 'Re: Quarterly zephyr roadmap' },
      labelIds: ['SENT'],
      body: 'Looks good, shipping it this week.',
    }),
    gmsg('18c2f4a9b3d21e03', T_B, daysAgoMs(3), {
      headers: { From: 'Dana Example <dana@example.com>', To: 'a@example.com', Subject: 'Contract question' },
      body: 'Could you confirm the contract terms?',
    }),
    gmsg('18c2f4a9b3d21e04', T_N, daysAgoMs(1), {
      headers: { From: 'Notifier <noreply@example.com>', To: 'a@example.com', Subject: 'Automated notification' },
      body: 'This is an automated message.',
    }),
  );
}

function contactsFixture(fx: FakeGoogle): void {
  fx.contacts = [
    {
      resourceName: 'people/c000000001',
      names: [{ displayName: 'Alice Example', metadata: { primary: true } }],
      emailAddresses: [{ value: 'alice@example.com' }],
      organizations: [{ name: 'Acme Example', title: 'Engineer', metadata: { primary: true } }],
    },
    {
      resourceName: 'people/c000000002',
      names: [{ displayName: 'Dana Example' }],
      emailAddresses: [{ value: 'dana@example.com' }],
    },
  ];
}

function calendarFixture(fx: FakeGoogle): void {
  fx.calendarEvents = [
    {
      id: 'evt00000000000001',
      status: 'confirmed',
      summary: 'Zephyr planning sync',
      description: 'Review the zephyr roadmap.',
      start: { dateTime: new Date(daysAgoMs(1)).toISOString() },
      end: { dateTime: new Date(daysAgoMs(1) + 3_600_000).toISOString() },
      organizer: { email: 'a@example.com' },
      attendees: [
        { email: 'a@example.com', self: true, responseStatus: 'accepted' },
        { email: 'charlie@example.com', displayName: 'Charlie Example', responseStatus: 'accepted' },
      ],
      htmlLink: 'https://calendar.google.com/calendar/event?eid=evt1',
    },
    {
      id: 'evt00000000000002',
      status: 'cancelled',
      summary: 'Dropped sync',
      start: { dateTime: new Date(daysAgoMs(2)).toISOString() },
      end: { dateTime: new Date(daysAgoMs(2) + 1_800_000).toISOString() },
    },
  ];
}

async function withHome<T>(fn: () => Promise<T>): Promise<T> {
  return withEnv({ GBRAIN_HOME: mkdtempSync(join(tmpdir(), 'gbrain-home-')) }, fn);
}

// ── Pure config/state units (google-source exports) ─────────────────────────

describe('google-source config + state units', () => {
  test('parseGoogleSourceConfig normalizes account, services, historyDays, dir', () => {
    const cfg = parseGoogleSourceConfig(
      { kind: 'google', g_account: ' A@Example.com ', g_services: 'Gmail, bogus , CALENDAR', g_history_days: 30.7, g_dir: '/tmp/gdir' },
      '/tmp/fallback',
    );
    expect(cfg.account).toBe('a@example.com');
    expect(cfg.services).toEqual(['gmail', 'calendar']);
    expect(cfg.historyDays).toBe(30);
    expect(cfg.dir).toBe('/tmp/gdir');
  });

  test('parseGoogleSourceConfig defaults: all services, 90 days, fallback dir', () => {
    const cfg = parseGoogleSourceConfig({ kind: 'google' }, '/tmp/fallback');
    expect(cfg.account).toBe('');
    expect(cfg.services).toEqual(['gmail', 'calendar', 'contacts']);
    expect(cfg.historyDays).toBe(90);
    expect(cfg.dir).toBe('/tmp/fallback');
  });

  test('parseGoogleSourceConfig: all-invalid services fall back to all; historyDays clamps', () => {
    const cfg = parseGoogleSourceConfig({ kind: 'google', g_services: 'bogus', g_history_days: 99999 }, '/tmp/x');
    expect(cfg.services).toEqual(['gmail', 'calendar', 'contacts']);
    expect(cfg.historyDays).toBe(3650);
    expect(parseGoogleSourceConfig({ kind: 'google', g_history_days: -5 }, '/tmp/x').historyDays).toBe(90);
  });

  test('googleStateFile + readGoogleState: missing file → empty state; partial file merges', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gsrc-state-'));
    try {
      expect(googleStateFile(dir)).toBe(join(dir, '.google-source.json'));
      const empty = readGoogleState(dir);
      expect(empty.gmail_history_id).toBeNull();
      expect(empty.gmail_backfill_done).toBe(false);
      writeFileSync(googleStateFile(dir), JSON.stringify({ gmail_history_id: '42' }), 'utf-8');
      const partial = readGoogleState(dir);
      expect(partial.gmail_history_id).toBe('42');
      expect(partial.gmail_backfill_done).toBe(false);
      expect(partial.calendar_sync_token).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('myAddressSet includes the account and sendAs aliases, lowercased', () => {
    const vault = makeVault();
    const entry = vault.entries.get('google:a@example.com')!;
    const set = myAddressSet({ ...entry, meta: { ...entry.meta, account: 'A@Example.com', sendas_aliases: ['Alias@Example.com'] } });
    expect(set.has('a@example.com')).toBe(true);
    expect(set.has('alias@example.com')).toBe(true);
    expect(set.size).toBe(2);
  });
});

// ── End-to-end sweeps ────────────────────────────────────────────────────────

describe('google-source materialize', () => {
  test('first sweep materializes contacts, calendar, and gmail; state + search projection land', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gsrc-first-'));
    const fx = emptyFx();
    gmailFixture(fx);
    contactsFixture(fx);
    calendarFixture(fx);
    fx.messagesPageSize = 3; // force messages.list pagination during backfill
    const vault = makeVault();
    try {
      await insertGoogleSource(dir);
      await withHome(async () => {
        const res = await sweep(dir, fx, vault);
        expect(res.status).toBe('first_sync');
        // 2 person pages + 1 meeting + 2 threads (noise thread excluded).
        expect(res.added).toBe(5);
        expect(res.deleted).toBe(0);
        expect(res.chunksCreated).toBeGreaterThan(0);
        expect(fx.tokenPosts).toBe(0); // fresh vault token — no refresh HTTP

        // Contacts → person pages with aliases projected into page_aliases.
        expect(await slugsWhere(`slug LIKE 'people/%'`)).toEqual(['people/alice-example', 'people/dana-example']);
        const aliasRows = await engine.executeRaw<{ alias_norm: string }>(
          `SELECT alias_norm FROM page_aliases WHERE source_id = 'gsrc' AND slug = 'people/alice-example' ORDER BY alias_norm`,
        );
        const norms = aliasRows.map((r) => r.alias_norm);
        expect(norms).toContain('alice@example.com');
        expect(norms).toContain('alice example');

        // Calendar → meeting page; cancelled event never materializes.
        const meetings = await slugsWhere(`slug LIKE 'calendar/%'`);
        expect(meetings.length).toBe(1);
        expect(meetings[0]).toContain('zephyr-planning-sync');
        const meetingMd = readFileSync(join(dir, `${meetings[0]}.md`), 'utf-8');
        expect(meetingMd).toContain('type: meeting');
        expect(meetingMd).toContain('- "charlie@example.com"');

        // Gmail → thread pages with correct frontmatter; noise thread → no page.
        const emails = await slugsWhere(`slug LIKE 'emails/%'`);
        expect(emails.length).toBe(2);
        expect(emails.some((s) => s.includes('automated-notification'))).toBe(false);
        const aSlug = emails.find((s) => s.includes('quarterly-zephyr-roadmap'))!;
        expect(aSlug).toBeDefined();
        const aMd = readFileSync(join(dir, `${aSlug}.md`), 'utf-8');
        expect(aMd).toContain('type: email');
        expect(aMd).toContain(`thread_id: "${T_A}"`);
        expect(aMd).toContain('message_id: "18c2f4a9b3d21e02"'); // latest message
        expect(aMd).toContain('account: "a@example.com"');
        expect(aMd).toContain('## → A Example <a@example.com>'); // SENT marker
        expect(aMd).toContain('https://mail.google.com/mail/u/?authuser=a%40example.com#inbox/18c2f4a9b3d21e01');

        // State file: history anchored, backfill done, service cursors banked.
        const state = readGoogleState(dir);
        expect(state.gmail_history_id).toBe('1000');
        expect(state.gmail_backfill_done).toBe(true);
        expect(state.gmail_backfill_floor_ms).toBeNull();
        expect(state.gmail_newest_ms).toBe(daysAgoMs(1)); // noise thread is newest seen
        expect(state.calendar_sync_token).toBe('cal-sync-1');
        expect(state.contacts_sync_token).toBe('ppl-sync-1');

        // SearchResult projection: subject word → message_id + thread_id.
        const results = await engine.searchKeyword('zephyr', { sourceId: 'gsrc' });
        const emailHit = results.find((r) => r.slug.startsWith('emails/'));
        expect(emailHit).toBeDefined();
        expect(emailHit!.message_id).toBe('18c2f4a9b3d21e02');
        expect(emailHit!.thread_id).toBe(T_A);

        // Sources row touched.
        const row = await engine.executeRaw<{ last_sync_at: string | null }>(
          `SELECT last_sync_at FROM sources WHERE id = 'gsrc'`,
        );
        expect(row[0].last_sync_at).not.toBeNull();
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('delta sweep re-imports only the replied thread and advances the cursor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gsrc-delta-'));
    const fx = emptyFx();
    gmailFixture(fx);
    const vault = makeVault();
    try {
      await insertGoogleSource(dir);
      await withHome(async () => {
        await sweep(dir, fx, vault, {}, 'gmail');
        expect(readGoogleState(dir).gmail_history_id).toBe('1000');

        // A reply lands on thread A; history flags only that thread.
        fx.messages.push(
          gmsg('18c2f4a9b3d21e05', T_A, hoursAgoMs(1), {
            headers: { From: 'Charlie Example <charlie@example.com>', To: 'a@example.com', Subject: 'Re: Quarterly zephyr roadmap' },
            body: 'One more question about rollout timing?',
          }),
        );
        fx.history = [[T_A]];
        fx.historyResponseId = '1010';
        const fetchesBefore = fx.threadFetches;

        const res = await sweep(dir, fx, vault, {}, 'gmail');
        expect(res.status).toBe('synced');
        expect(res.modified).toBe(1);
        expect(res.added).toBe(0);
        expect(fx.threadFetches - fetchesBefore).toBe(1); // only thread A re-fetched

        const state = readGoogleState(dir);
        expect(state.gmail_history_id).toBe('1010'); // cursor advanced
        expect(state.gmail_newest_ms).toBe(hoursAgoMs(1));

        const aSlug = (await slugsWhere(`slug LIKE 'emails/%'`)).find((s) => s.includes('quarterly-zephyr-roadmap'))!;
        const aMd = readFileSync(join(dir, `${aSlug}.md`), 'utf-8');
        expect(aMd).toContain('One more question about rollout timing?');
        expect(aMd).toContain('message_id: "18c2f4a9b3d21e05"'); // latest id moved
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('history 404 falls back to a bookmark window and re-anchors a fresh historyId', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gsrc-expired-'));
    const fx = emptyFx();
    gmailFixture(fx);
    const vault = makeVault();
    try {
      await insertGoogleSource(dir);
      await withHome(async () => {
        await sweep(dir, fx, vault, {}, 'gmail');

        // Cursor expires upstream; a brand-new thread arrived meanwhile.
        fx.historyExpired = true;
        fx.profileHistoryId = '2000';
        fx.messages.push(
          gmsg('18c2f4a9b3d21e06', T_C, hoursAgoMs(1), {
            headers: { From: 'Erin Example <erin@example.com>', To: 'a@example.com', Subject: 'Fresh zephyr kickoff' },
            body: 'Kicking off the fresh thread here.',
          }),
        );
        const callsBefore = fx.calls.length;
        const res = await sweep(dir, fx, vault, {}, 'gmail');
        expect(res.status).toBe('synced'); // sync still succeeds
        expect(res.added).toBe(1); // the new thread landed via messages.list fallback
        // Fallback used messages.list + getProfile (re-anchor), not history.
        const newCalls = fx.calls.slice(callsBefore);
        expect(newCalls.some((c) => c.includes('/users/me/messages?'))).toBe(true);
        expect(newCalls.some((c) => c.endsWith('/users/me/profile'))).toBe(true);
        // H6 anchor ordering: getProfile fires BEFORE listMessageIds. A
        // message arriving between the two calls is then either in the
        // listing (post-anchor arrival) or replayed by history.list from the
        // anchor; anchoring AFTER the listing would drop it forever.
        const profileIdx = newCalls.findIndex((c) => c.endsWith('/users/me/profile'));
        const messagesIdx = newCalls.findIndex((c) => c.includes('/users/me/messages?'));
        expect(profileIdx).toBeGreaterThanOrEqual(0);
        expect(messagesIdx).toBeGreaterThanOrEqual(0);
        expect(profileIdx).toBeLessThan(messagesIdx);

        const state = readGoogleState(dir);
        expect(state.gmail_history_id).toBe('2000'); // fresh anchor
        expect(state.gmail_backfill_done).toBe(true);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a failed thread fetch yields partial and does NOT advance the history cursor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gsrc-fail-'));
    const fx = emptyFx();
    gmailFixture(fx);
    const vault = makeVault();
    try {
      await insertGoogleSource(dir);
      await withHome(async () => {
        await sweep(dir, fx, vault, {}, 'gmail');

        fx.history = [[T_A]];
        fx.historyResponseId = '1010';
        fx.failThreads.add(T_A);
        const res = await sweep(dir, fx, vault, {}, 'gmail');
        expect(res.status).toBe('partial');
        expect(res.failedFiles).toBe(1);
        expect(readGoogleState(dir).gmail_history_id).toBe('1000'); // NOT advanced

        // Failure clears; the same window re-lists and the cursor advances.
        fx.failThreads.clear();
        const retry = await sweep(dir, fx, vault, {}, 'gmail');
        expect(retry.status).toBe('up_to_date'); // unchanged content re-import skips
        expect(readGoogleState(dir).gmail_history_id).toBe('1010');
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('aborted backfill persists a resume floor; the next run completes it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gsrc-floor-'));
    const fx = emptyFx();
    const vault = makeVault();
    // Six single-message threads, days 40..45 ago (outside the extract window).
    const tids = ['17aa00000000f001', '17aa00000000f002', '17aa00000000f003', '17aa00000000f004', '17aa00000000f005', '17aa00000000f006'];
    for (let i = 0; i < 6; i++) {
      fx.messages.push(
        gmsg(`18c2f4a9b3d21f0${i + 1}`, tids[i], daysAgoMs(40 + i), {
          headers: { From: 'Peer Example <peer@example.com>', To: 'a@example.com', Subject: `Archive topic ${i}` },
          body: `Archive body ${i}.`,
        }),
      );
    }
    try {
      await insertGoogleSource(dir);
      await withHome(async () => {
        // Abort after the 2nd thread fetch (mid first batch).
        const controller = new AbortController();
        fx.onThreadFetch = () => {
          if (fx.threadFetches >= 2) controller.abort();
        };
        const res1 = await sweep(dir, fx, vault, { signal: controller.signal }, 'gmail');
        expect(res1.status).toBe('partial');
        expect(res1.added).toBe(2);

        let state = readGoogleState(dir);
        expect(state.gmail_backfill_done).toBe(false);
        expect(state.gmail_backfill_floor_ms).toBe(daysAgoMs(41)); // oldest fully-attempted thread
        expect(state.gmail_history_id).toBe('1000'); // delta anchor captured BEFORE backfill

        // Resume without the abort: only the remaining window is listed.
        fx.onThreadFetch = undefined;
        const res2 = await sweep(dir, fx, vault, {}, 'gmail');
        expect(res2.added).toBe(4); // the four threads below the floor
        state = readGoogleState(dir);
        expect(state.gmail_backfill_done).toBe(true);
        expect(state.gmail_backfill_floor_ms).toBeNull();
        expect((await slugsWhere(`slug LIKE 'emails/%'`)).length).toBe(6);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('contacts: deleted contact removes its page; hand-authored person pages are never rewritten', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gsrc-contacts-'));
    const fx = emptyFx();
    const vault = makeVault();
    fx.contacts = [
      {
        resourceName: 'people/c000000001',
        names: [{ displayName: 'Alice Example', metadata: { primary: true } }],
        emailAddresses: [{ value: 'alice@example.com' }],
      },
      {
        resourceName: 'people/c000000003',
        names: [{ displayName: 'Bob Example', metadata: { primary: true } }],
        emailAddresses: [{ value: 'bob@example.com' }],
      },
    ];
    try {
      await insertGoogleSource(dir);
      await withHome(async () => {
        // Hand-authored page at the exact path the Bob contact would take —
        // no google_contact_id marker, so the connector must not touch it.
        const bobPath = join(dir, 'people/bob-example.md');
        mkdirSync(dirname(bobPath), { recursive: true });
        const handAuthored = [
          '---',
          'type: person',
          'title: "Bob Example"',
          'aliases:',
          '  - "bob@example.com"',
          '---',
          '',
          '# Bob Example',
          '',
          'Hand-written notes that must survive the connector.',
          '',
        ].join('\n');
        writeFileSync(bobPath, handAuthored, 'utf-8');
        const imported = await importFile(engine, bobPath, 'people/bob-example.md', { sourceId: 'gsrc', noEmbed: true });
        expect(imported.status).toBe('imported');

        const res1 = await sweep(dir, fx, vault, {}, 'contacts');
        expect(res1.added).toBe(1); // Alice only — Bob skipped as hand-authored
        expect(readFileSync(bobPath, 'utf-8')).toBe(handAuthored); // body preserved
        expect(existsSync(join(dir, 'people/alice-example.md'))).toBe(true);
        const alicePage = readFileSync(join(dir, 'people/alice-example.md'), 'utf-8');
        expect(alicePage).toContain('google_contact_id: "people/c000000001"');

        // Delta: Alice is deleted upstream.
        fx.contactsDelta = [
          {
            resourceName: 'people/c000000001',
            names: [{ displayName: 'Alice Example' }],
            emailAddresses: [{ value: 'alice@example.com' }],
            metadata: { deleted: true },
          },
        ];
        const res2 = await sweep(dir, fx, vault, {}, 'contacts');
        expect(res2.deleted).toBe(1);
        expect(existsSync(join(dir, 'people/alice-example.md'))).toBe(false);
        expect(await slugsWhere(`slug = 'people/alice-example'`)).toEqual([]);
        // The hand-authored page survives both sweeps untouched.
        expect(readFileSync(bobPath, 'utf-8')).toBe(handAuthored);
        expect(await slugsWhere(`slug = 'people/bob-example'`)).toEqual(['people/bob-example']);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('poison ledger: failed runs never stamp last_sync_at and increment the ledger; the 4th run skips the poisoned thread; --full retries it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gsrc-poison-'));
    const fx = emptyFx();
    gmailFixture(fx);
    const vault = makeVault();
    const seededSyncAt = '2026-01-01T00:00:00.000Z';
    const lastSyncAt = async (): Promise<string | null> => {
      const rows = await engine.executeRaw<{ last_sync_at: Date | string | null }>(
        `SELECT last_sync_at FROM sources WHERE id = 'gsrc'`,
      );
      const v = rows[0].last_sync_at;
      return v === null ? null : new Date(v).toISOString();
    };
    try {
      await insertGoogleSource(dir);
      await engine.executeRaw(
        `UPDATE sources SET last_sync_at = $1::timestamptz WHERE id = 'gsrc'`,
        [seededSyncAt],
      );
      await withHome(async () => {
        // (a) Thread B persistently 500s: every run is partial, the ledger
        // increments ACROSS runs, and last_sync_at is never stamped — a
        // wedged sweep must read stale to the staleness gate, not fresh.
        fx.failThreads.add(T_B);
        for (let run = 1; run <= 3; run++) {
          const res = await sweep(dir, fx, vault, {}, 'gmail');
          expect(res.status).toBe('partial');
          expect(res.failedFiles).toBe(1);
          const state = readGoogleState(dir);
          expect(state.gmail_fail_counts?.[T_B]).toBe(run);
          expect(state.gmail_backfill_done).toBe(false);
          expect(await lastSyncAt()).toBe(seededSyncAt); // NOT updated
        }

        // (b) Run 4: three recorded failures = poisoned. The thread is
        // SKIPPED (never even fetched), the backfill completes around it,
        // and last_sync_at finally stamps.
        const callsBefore = fx.calls.length;
        const res4 = await sweep(dir, fx, vault, {}, 'gmail');
        expect(res4.failedFiles).toBeUndefined();
        const run4Calls = fx.calls.slice(callsBefore);
        expect(run4Calls.some((c) => c.includes(`/threads/${T_B}`))).toBe(false);
        const state4 = readGoogleState(dir);
        expect(state4.gmail_backfill_done).toBe(true);
        expect(state4.gmail_backfill_floor_ms).toBeNull();
        expect(state4.gmail_fail_counts?.[T_B]).toBe(3); // skip is not forgiveness
        expect(await lastSyncAt()).not.toBe(seededSyncAt); // stamped at last
        // The poisoned thread never materialized.
        const slugs4 = await slugsWhere(`slug LIKE 'emails/%'`);
        expect(slugs4.some((s) => s.includes('contract-question'))).toBe(false);
        expect(slugs4.some((s) => s.includes('quarterly-zephyr-roadmap'))).toBe(true);

        // (c) --full resets the ledger, so the (now healthy) thread is
        // retried instead of being skipped forever.
        fx.failThreads.clear();
        fx.history = [[T_B]];
        fx.historyResponseId = '1010';
        const res5 = await sweep(dir, fx, vault, { full: true }, 'gmail');
        expect(res5.status).toBe('synced');
        expect(res5.added).toBe(1);
        const state5 = readGoogleState(dir);
        expect(state5.gmail_fail_counts ?? {}).toEqual({}); // reset + success
        const slugs5 = await slugsWhere(`slug LIKE 'emails/%'`);
        expect(slugs5.some((s) => s.includes('contract-question'))).toBe(true);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('contacts: bare tombstone deletes by google_contact_id; a rename moves the page; an unknown tombstone is a no-op', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gsrc-contacts-tomb-'));
    const fx = emptyFx();
    const vault = makeVault();
    contactsFixture(fx); // alice (c000000001) + dana (c000000002)
    try {
      await insertGoogleSource(dir);
      await withHome(async () => {
        const res1 = await sweep(dir, fx, vault, {}, 'contacts');
        expect(res1.added).toBe(2);
        expect(existsSync(join(dir, 'people/alice-example.md'))).toBe(true);
        expect(existsSync(join(dir, 'people/dana-example.md'))).toBe(true);

        // (a) Deletion tombstone carrying ONLY resourceName + deleted — no
        // names, no emails, so slug derivation yields nothing. The page must
        // still die via the google_contact_id-keyed DB lookup.
        fx.contactsDelta = [{ resourceName: 'people/c000000002', metadata: { deleted: true } }];
        const res2 = await sweep(dir, fx, vault, {}, 'contacts');
        expect(res2.deleted).toBe(1);
        expect(existsSync(join(dir, 'people/dana-example.md'))).toBe(false); // file removed
        expect(await slugsWhere(`slug = 'people/dana-example'`)).toEqual([]); // live row gone
        // Honest current behavior: deletePageByRelPath routes through
        // engine.deletePages, which HARD-deletes the row (DELETE FROM pages),
        // so nothing remains — deleted or otherwise.
        const gone = await engine.executeRaw<{ n: number | string }>(
          `SELECT count(*) AS n FROM pages
           WHERE source_id = 'gsrc' AND slug = 'people/dana-example'`,
        );
        expect(Number(gone[0].n)).toBe(0);

        // (b) Rename: same resourceName, new displayName → the new slug
        // imports AND the old page is deleted instead of stranding.
        fx.contactsDelta = [
          {
            resourceName: 'people/c000000001',
            names: [{ displayName: 'Alicia Example', metadata: { primary: true } }],
            emailAddresses: [{ value: 'alice@example.com' }],
          },
        ];
        const res3 = await sweep(dir, fx, vault, {}, 'contacts');
        expect(res3.added).toBe(1);
        expect(res3.deleted).toBe(1);
        expect(existsSync(join(dir, 'people/alicia-example.md'))).toBe(true);
        expect(existsSync(join(dir, 'people/alice-example.md'))).toBe(false);
        expect(await slugsWhere(`slug LIKE 'people/%'`)).toEqual(['people/alicia-example']);
        const md = readFileSync(join(dir, 'people/alicia-example.md'), 'utf-8');
        expect(md).toContain('google_contact_id: "people/c000000001"');
        expect(md).toContain('title: "Alicia Example"');

        // (c) Tombstone for a never-imported contact: a clean no-op.
        fx.contactsDelta = [{ resourceName: 'people/c999999999', metadata: { deleted: true } }];
        const res4 = await sweep(dir, fx, vault, {}, 'contacts');
        expect(res4.status).toBe('up_to_date');
        expect(res4.deleted).toBe(0);
        expect(await slugsWhere(`slug LIKE 'people/%'`)).toEqual(['people/alicia-example']);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('open_loops: an old unanswered inbound opens a loop; the reply closes it as reply_detected', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gsrc-loops-'));
    const fx = emptyFx();
    const vault = makeVault();
    fx.messages.push(
      gmsg('18c2f4a9b3d21e03', T_B, daysAgoMs(3), {
        headers: { From: 'Dana Example <dana@example.com>', To: 'a@example.com', Subject: 'Contract question' },
        body: 'Could you confirm the contract terms?',
      }),
    );
    try {
      await insertGoogleSource(dir);
      await withHome(async () => {
        await sweep(dir, fx, vault, {}, 'gmail');
        const open = await engine.executeRaw<{ loop_type: string; status: string; counterparty_email: string; thread_id: string }>(
          `SELECT loop_type, status, counterparty_email, thread_id FROM open_loops WHERE source_id = 'gsrc'`,
        );
        expect(open.length).toBe(1);
        expect(open[0].loop_type).toBe('unanswered_inbound');
        expect(open[0].status).toBe('open');
        expect(open[0].counterparty_email).toBe('dana@example.com');
        expect(open[0].thread_id).toBe(T_B);

        // My reply lands in the delta sweep → the loop auto-closes.
        fx.messages.push(
          gmsg('18c2f4a9b3d21e07', T_B, hoursAgoMs(2), {
            headers: { From: 'A Example <a@example.com>', To: 'dana@example.com', Subject: 'Re: Contract question' },
            labelIds: ['SENT'],
            body: 'Confirmed, terms attached.',
          }),
        );
        fx.history = [[T_B]];
        fx.historyResponseId = '1010';
        await sweep(dir, fx, vault, {}, 'gmail');

        const after = await engine.executeRaw<{ status: string; closed_by: string | null }>(
          `SELECT status, closed_by FROM open_loops WHERE source_id = 'gsrc' AND loop_type = 'unanswered_inbound'`,
        );
        expect(after.length).toBe(1);
        expect(after[0].status).toBe('done');
        expect(after[0].closed_by).toBe('reply_detected');
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('command-mode access: sweep succeeds with NO vault entry; threads import and loop detection runs on the account-only identity', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gsrc-cmdaccess-'));
    const fx = emptyFx();
    gmailFixture(fx);
    try {
      await insertGoogleSource(dir);
      await withHome(async () => {
        // g_access/g_token_command map through parseGoogleSourceConfig.
        const cfg = parseGoogleSourceConfig(
          {
            kind: 'google',
            g_account: 'a@example.com',
            g_services: 'gmail',
            g_history_days: 90,
            g_dir: dir,
            g_access: 'command',
            g_token_command: 'echo fixture-token',
          },
          dir,
        );
        expect(cfg.access).toBe('command');
        expect(cfg.tokenCommand).toBe('echo fixture-token');

        // Every API call carries the command-minted bearer; NO vault is
        // passed (vaultOverride undefined) and no refresh POST ever fires —
        // the command IS the refresher.
        const inner = buildFetch(fx);
        const authHeaders: string[] = [];
        const spyFetch: FetchImpl = async (url, init) => {
          const h = (init?.headers ?? {}) as Record<string, string>;
          const auth = h.authorization ?? h.Authorization;
          if (auth) authHeaders.push(auth);
          return inner(url, init);
        };
        const res = await runGoogleSync(
          engine,
          'gsrc',
          cfg,
          { sourceId: 'gsrc', noEmbed: true, noExtract: true },
          spyFetch,
        );
        expect(res.status).toBe('first_sync');
        expect(fx.tokenPosts).toBe(0);
        expect(authHeaders.length).toBeGreaterThan(0);
        for (const a of authHeaders) expect(a).toBe('Bearer fixture-token');

        // Threads imported (noise excluded), same as vault mode.
        const emails = await slugsWhere(`slug LIKE 'emails/%'`);
        expect(emails.length).toBe(2);

        // Loop detection ran with myAddresses = account-only (the fake API
        // serves no sendAs endpoint; fetchSendAsAliases degrades to []):
        // T_A's SENT reply from a@example.com still reads as mine, so only
        // T_B's 3-day-old inbound opens a loop.
        const loops = await engine.executeRaw<{ loop_type: string; status: string; counterparty_email: string }>(
          `SELECT loop_type, status, counterparty_email FROM open_loops WHERE source_id = 'gsrc'`,
        );
        expect(loops.length).toBe(1);
        expect(loops[0].loop_type).toBe('unanswered_inbound');
        expect(loops[0].status).toBe('open');
        expect(loops[0].counterparty_email).toBe('dana@example.com');

        // gmail sweep succeeded → the trust-critical freshness stamp landed.
        const row = await engine.executeRaw<{ last_sync_at: unknown }>(
          `SELECT last_sync_at FROM sources WHERE id = 'gsrc'`,
        );
        expect(row[0].last_sync_at).not.toBeNull();
        expect(readGoogleState(dir).gmail_backfill_done).toBe(true);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('env-mode access: sweep succeeds when the var is set; unset var → partial with access_env_missing on stderr and NO freshness stamp', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gsrc-envaccess-'));
    const fx = emptyFx();
    gmailFixture(fx);
    const ENV_KEY = 'GBRAIN_TEST_GSYNC_ACCESS_TOKEN';
    const cfg = () =>
      parseGoogleSourceConfig(
        {
          kind: 'google',
          g_account: 'a@example.com',
          g_services: 'gmail',
          g_history_days: 90,
          g_dir: dir,
          g_access: 'env',
          g_token_env: ENV_KEY,
        },
        dir,
      );
    const stderrCaptured = async (fn: () => Promise<void>): Promise<string> => {
      const orig = process.stderr.write.bind(process.stderr);
      const chunks: string[] = [];
      process.stderr.write = ((chunk: string | Uint8Array): boolean => {
        chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
        return true;
      }) as typeof process.stderr.write;
      try {
        await fn();
      } finally {
        process.stderr.write = orig;
      }
      return chunks.join('');
    };
    try {
      await insertGoogleSource(dir);
      await withHome(async () => {
        expect(cfg().access).toBe('env');
        expect(cfg().tokenEnv).toBe(ENV_KEY);

        // (a) Unset var: the sweep FAILS honestly. Current behavior (pinned):
        // the CredentialError surfaces per-service inside runGoogleSync (the
        // same catch that handles scope_missing/upstream credential errors) —
        // status 'partial', toHuman() on stderr, nothing imported, and the
        // staleness-gate stamp is withheld.
        await withEnv({ [ENV_KEY]: undefined }, async () => {
          let res: Awaited<ReturnType<typeof runGoogleSync>> | undefined;
          const err = await stderrCaptured(async () => {
            res = await runGoogleSync(
              engine,
              'gsrc',
              cfg(),
              { sourceId: 'gsrc', noEmbed: true, noExtract: true },
              buildFetch(fx),
            );
          });
          expect(res!.status).toBe('partial');
          expect(res!.added).toBe(0);
          expect(err).toContain('token environment variable is empty');
          expect(err).toContain(`$${ENV_KEY}`);
          const row = await engine.executeRaw<{ last_sync_at: unknown }>(
            `SELECT last_sync_at FROM sources WHERE id = 'gsrc'`,
          );
          expect(row[0].last_sync_at).toBeNull(); // stale gate stays honest
          expect((await slugsWhere(`slug LIKE 'emails/%'`)).length).toBe(0);
        });

        // (b) Var set: the same source syncs end-to-end, no vault involved.
        await withEnv({ [ENV_KEY]: 'env-token-abc123' }, async () => {
          const res = await runGoogleSync(
            engine,
            'gsrc',
            cfg(),
            { sourceId: 'gsrc', noEmbed: true, noExtract: true },
            buildFetch(fx),
          );
          expect(res.status).toBe('first_sync');
          expect(fx.tokenPosts).toBe(0);
          expect((await slugsWhere(`slug LIKE 'emails/%'`)).length).toBe(2);
          const row = await engine.executeRaw<{ last_sync_at: unknown }>(
            `SELECT last_sync_at FROM sources WHERE id = 'gsrc'`,
          );
          expect(row[0].last_sync_at).not.toBeNull();
        });
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('loops_extract enqueue: recent threads get idempotency-keyed jobs; unchanged re-sweeps add no duplicates', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gsrc-extract-'));
    const fx = emptyFx();
    const vault = makeVault();
    fx.messages.push(
      gmsg('18c2f4a9b3d21e01', T_A, daysAgoMs(2)),
      gmsg('18c2f4a9b3d21e02', T_A, daysAgoMs(2) + 3_600_000, {
        headers: { From: 'A Example <a@example.com>', To: 'charlie@example.com', Subject: 'Re: Quarterly zephyr roadmap' },
        labelIds: ['SENT'],
        body: 'Looks good, shipping it this week.',
      }),
    );
    // The sweep enqueues only while a chat provider is available (a job the
    // handler cannot run would burn the thread's revision slot); the gateway
    // test seam makes chat "available" without a key or network.
    __setChatTransportForTests(async () => {
      throw new Error('chat transport must not be called by the sweep');
    });
    try {
      await insertGoogleSource(dir);
      await withHome(async () => {
        await sweep(dir, fx, vault, {}, 'gmail');
        const jobs1 = await engine.executeRaw<{ id: number; idempotency_key: string | null }>(
          `SELECT id, idempotency_key FROM minion_jobs WHERE name = 'loops_extract'`,
        );
        expect(jobs1.length).toBe(1);
        // Key folds the SOURCE first (red-team: the same account registered
        // twice must not coalesce source B's job onto source A's).
        expect(jobs1[0].idempotency_key).toMatch(/^loops:[^:]+:emails\//);

        // History touches the thread again with NO content change: the
        // page-revision-keyed idempotency key dedupes the enqueue.
        fx.history = [[T_A]];
        fx.historyResponseId = '1011';
        await sweep(dir, fx, vault, {}, 'gmail');
        const jobs2 = await engine.executeRaw<{ id: number }>(
          `SELECT id FROM minion_jobs WHERE name = 'loops_extract'`,
        );
        expect(jobs2.length).toBe(1);
        expect(jobs2[0].id).toBe(jobs1[0].id);
      });
    } finally {
      __setChatTransportForTests(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Secondary calendars (one calendar per source) ────────────────────────────

describe('google-source secondary calendar', () => {
  test('a source with g_calendar_id sweeps THAT calendar, URL-encoded, and materializes its events', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gsrc-cal2-'));
    const fx = emptyFx();
    const vault = makeVault();
    calendarFixture(fx);
    const calId = 'family0123456789@group.calendar.google.com';
    try {
      await insertGoogleSource(dir);
      await withHome(async () => {
        const cfg = parseGoogleSourceConfig(
          {
            kind: 'google',
            g_account: 'a@example.com',
            g_services: 'calendar',
            g_history_days: 90,
            g_dir: dir,
            g_calendar_id: calId,
          },
          dir,
        );
        const res = await runGoogleSync(
          engine,
          'gsrc',
          cfg,
          { sourceId: 'gsrc', noEmbed: true, noExtract: true },
          buildFetch(fx),
          vault,
        );
        expect(res.status).toBe('first_sync');
        // The sweep hit the SECONDARY calendar's path (percent-encoded '@'),
        // never the hardcoded primary.
        const calCalls = fx.calls.filter((c) => c.includes('/calendars/'));
        expect(calCalls.length).toBeGreaterThan(0);
        for (const c of calCalls) {
          expect(c).toContain('/calendars/family0123456789%40group.calendar.google.com/events');
        }
        // Its events materialized through the normal pipeline.
        expect((await slugsWhere(`slug LIKE 'calendar/%zephyr%'`)).length).toBe(1);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
