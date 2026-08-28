/**
 * google-source reconcile + resilience sweeps — sibling of
 * test/google-source-materialize.test.ts (same real-PGLite + mutable
 * fake-Google + in-memory-vault harness), covering the paths that file does
 * not: `--full` reconcile deletes (incl. the >200 mass-delete guard and its
 * GBRAIN_ALLOW_MASS_RECONCILE escape hatch), the backfill floor freeze on a
 * mid-backfill failure, 404-vanished threads in both lanes, calendar +
 * contacts syncToken 410 recovery, and the loops_extract enqueue cap.
 *
 * NOTE on funnel/heartbeat rows (coverage item 1e): runGoogleSync writes NO
 * heartbeat.jsonl rows — the funnel (`appendGoogleHeartbeat`) belongs to the
 * COMMANDS layer (gbrain google connect), asserted in
 * test/google-connect-cmd.serial.test.ts. The sweep-side observable here is
 * the enqueue-cap drop log on stderr, asserted below.
 *
 * Synthetic data only: example.com addresses, hex message/thread ids.
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
import { LOOPS_EXTRACT_MAX_PER_SWEEP } from '../src/core/google/loops-extract.ts';
import {
  googleStateFile,
  parseGoogleSourceConfig,
  readGoogleState,
  runGoogleSync,
} from '../src/core/google/google-source.ts';

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
  // MinionQueue.ensureSchema gates on the 'version' config row (same re-seed
  // as the sibling materialize suite).
  await engine.setConfig('version', schemaVersion);
  __clearSuppressionCacheForTests();
});

// ── Time helpers (exact-second timestamps so backfill floors are stable) ────

const NOW_MS = Math.floor(Date.now() / 1000) * 1000;
const daysAgoMs = (n: number): number => NOW_MS - n * 86_400_000;
const hoursAgoMs = (n: number): number => NOW_MS - n * 3_600_000;

// ── Thread / message id constants (hex only) ────────────────────────────────

const T_A = '17aa00000000a001';
const T_B = '17aa00000000b002';
const T_V = '17aa00000000e005'; // the vanished (404) thread

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
  history: string[][];
  historyResponseId: string;
  failThreads: Set<string>;
  /** getThread → 404 for these ids (deleted between listing and fetch). */
  vanishedThreads: Set<string>;
  contacts: unknown[];
  contactsDelta: unknown[];
  contactsExpireSyncToken: boolean;
  calendarEvents: unknown[];
  calendarDelta: unknown[];
  calendarExpireSyncToken: boolean;
  /** Counters so each windowed/full re-list mints a DISTINCT sync token. */
  calendarWindowedLists: number;
  contactsFullLists: number;
  calls: string[];
  threadFetches: number;
}

function emptyFx(): FakeGoogle {
  return {
    profileHistoryId: '1000',
    messages: [],
    messagesPageSize: 100,
    history: [],
    historyResponseId: '1000',
    failThreads: new Set(),
    vanishedThreads: new Set(),
    contacts: [],
    contactsDelta: [],
    contactsExpireSyncToken: false,
    calendarEvents: [],
    calendarDelta: [],
    calendarExpireSyncToken: false,
    calendarWindowedLists: 0,
    contactsFullLists: 0,
    calls: [],
    threadFetches: 0,
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
      msgs.sort((a, b) => b.internalDateMs - a.internalDateMs); // newest first
      const start = Number(u.searchParams.get('pageToken') ?? '0');
      const page = msgs.slice(start, start + fx.messagesPageSize);
      const next = start + fx.messagesPageSize < msgs.length ? String(start + fx.messagesPageSize) : undefined;
      return json({
        messages: page.map((m) => ({ id: m.id, threadId: m.threadId })),
        ...(next ? { nextPageToken: next } : {}),
      });
    }

    if (u.pathname.endsWith('/users/me/history')) {
      return json({
        historyId: fx.historyResponseId,
        history: fx.history.map((tids) => ({ messages: tids.map((tid) => ({ threadId: tid })) })),
      });
    }

    const threadMatch = u.pathname.match(/\/users\/me\/threads\/([^/]+)$/);
    if (threadMatch) {
      const tid = threadMatch[1];
      fx.threadFetches++;
      if (fx.vanishedThreads.has(tid)) return json({ error: { code: 404, message: 'Not Found' } }, 404);
      if (fx.failThreads.has(tid)) return json({ error: { code: 500, message: 'backend error' } }, 500);
      const msgs = fx.messages
        .filter((m) => m.threadId === tid)
        .sort((a, b) => b.internalDateMs - a.internalDateMs);
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

    if (u.pathname.includes('/calendars/primary/events')) {
      if (u.searchParams.get('syncToken')) {
        if (fx.calendarExpireSyncToken) return json({ error: { code: 410, message: 'Sync token expired' } }, 410);
        return json({ items: fx.calendarDelta, nextSyncToken: 'cal-sync-delta' });
      }
      fx.calendarWindowedLists++;
      return json({ items: fx.calendarEvents, nextSyncToken: `cal-sync-w${fx.calendarWindowedLists}` });
    }

    if (u.pathname.includes('/people/me/connections')) {
      if (u.searchParams.get('syncToken')) {
        if (fx.contactsExpireSyncToken) return json({ error: { code: 410, message: 'Sync token expired' } }, 410);
        return json({ connections: fx.contactsDelta, nextSyncToken: 'ppl-sync-delta' });
      }
      fx.contactsFullLists++;
      return json({ connections: fx.contacts, nextSyncToken: `ppl-sync-w${fx.contactsFullLists}` });
    }

    return json({ error: { message: `unhandled ${u.pathname}` } }, 400);
  };
}

// ── In-memory vault ──────────────────────────────────────────────────────────

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

async function sweep(
  dir: string,
  fx: FakeGoogle,
  vault: FakeVault,
  opts: Partial<SyncOpts> = {},
  services = 'gmail',
) {
  const cfg = parseGoogleSourceConfig(
    { kind: 'google', g_account: 'a@example.com', g_services: services, g_history_days: 90, g_dir: dir },
    dir,
  );
  return runGoogleSync(
    engine,
    'gsrc',
    cfg,
    { sourceId: 'gsrc', noEmbed: true, noExtract: true, ...opts },
    buildFetch(fx),
    vault,
  );
}

async function emailSlugs(): Promise<string[]> {
  const rows = await engine.executeRaw<{ slug: string }>(
    `SELECT slug FROM pages WHERE source_id = 'gsrc' AND deleted_at IS NULL AND slug LIKE 'emails/%' ORDER BY slug`,
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

async function withHome<T>(fn: () => Promise<T>): Promise<T> {
  return withEnv({ GBRAIN_HOME: mkdtempSync(join(tmpdir(), 'gbrain-home-')) }, fn);
}

/** Capture stderr for the duration of `fn` (progress + sweep logs land there). */
async function capturedStderr<T>(fn: () => Promise<T>): Promise<{ result: T; err: string }> {
  const errOrig = process.stderr.write.bind(process.stderr);
  const chunks: string[] = [];
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = await fn();
    return { result, err: chunks.join('') };
  } finally {
    process.stderr.write = errOrig;
  }
}

/** Pre-mark the gmail backfill as complete so a sweep goes straight to delta. */
function writeBackfilledState(dir: string): void {
  writeFileSync(
    googleStateFile(dir),
    JSON.stringify({
      gmail_history_id: '1000',
      gmail_backfill_floor_ms: null,
      gmail_backfill_done: true,
      gmail_newest_ms: daysAgoMs(1),
      calendar_sync_token: null,
      contacts_sync_token: null,
      last_full_at: null,
    }),
    'utf-8',
  );
}

// ── --full reconcile ─────────────────────────────────────────────────────────

describe('gmail --full reconcile', () => {
  test('a thread missing from the live listing loses its page + file; out-of-window pages survive', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gsrc-reconcile-'));
    const fx = emptyFx();
    const vault = makeVault();
    fx.messages.push(
      gmsg('18c2f4a9b3d21e01', T_A, daysAgoMs(2)),
      gmsg('18c2f4a9b3d21e03', T_B, daysAgoMs(3), {
        headers: { From: 'Dana Example <dana@example.com>', To: 'a@example.com', Subject: 'Contract question' },
        body: 'Could you confirm the contract terms?',
      }),
    );
    try {
      await insertGoogleSource(dir);
      await withHome(async () => {
        const res1 = await sweep(dir, fx, vault);
        expect(res1.added).toBe(2);
        const before = await emailSlugs();
        expect(before).toHaveLength(2);
        const bSlug = before.find((s) => s.includes('contract-question'))!;
        const aSlug = before.find((s) => s.includes('quarterly-zephyr-roadmap'))!;
        expect(existsSync(join(dir, `${bSlug}.md`))).toBe(true);

        // A page whose first_message_date PREDATES the enumeration window is
        // out of reconcile scope and must survive even though its thread id
        // is not in the live listing.
        await engine.putPage(
          'emails/2020/01/2020-01-05-ancient-thread-deadbeef',
          {
            type: 'email',
            title: 'Ancient thread',
            compiled_truth: 'A thread from before the window.',
            frontmatter: {
              thread_id: '17aa00000000ffff',
              first_message_date: new Date(daysAgoMs(100)).toISOString(),
            },
          },
          { sourceId: 'gsrc' },
        );

        // Thread B vanishes upstream (deleted/trash); the live window now
        // only lists thread A.
        fx.messages = fx.messages.filter((m) => m.threadId !== T_B);
        const res2 = await sweep(dir, fx, vault, { full: true });
        expect(res2.status).toBe('synced');
        expect(res2.deleted).toBe(1);

        const after = await emailSlugs();
        expect(after).toContain(aSlug);
        expect(after).toContain('emails/2020/01/2020-01-05-ancient-thread-deadbeef'); // survives
        expect(after).not.toContain(bSlug);
        expect(existsSync(join(dir, `${bSlug}.md`))).toBe(false); // file removed too
        expect(existsSync(join(dir, `${aSlug}.md`))).toBe(true);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('>200 stale threads: the mass-delete guard refuses; GBRAIN_ALLOW_MASS_RECONCILE=1 proceeds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gsrc-massguard-'));
    const fx = emptyFx(); // live listing is EMPTY → every seeded page is stale
    const vault = makeVault();
    try {
      await insertGoogleSource(dir);
      writeBackfilledState(dir); // skip the backfill; go straight to delta + reconcile
      // 201 email pages inside the window, thread ids the live listing lacks.
      for (let i = 0; i < 201; i++) {
        const tid = `17dd0000${i.toString(16).padStart(8, '0')}`;
        await engine.putPage(
          `emails/2026/bulk/thread-${String(i).padStart(3, '0')}`,
          {
            type: 'email',
            title: `Bulk thread ${i}`,
            compiled_truth: 'Bulk body.',
            frontmatter: {
              thread_id: tid,
              first_message_date: new Date(daysAgoMs(5)).toISOString(),
            },
          },
          { sourceId: 'gsrc' },
        );
      }
      await withHome(async () => {
        // Without the escape hatch: zero deletions + the guard log.
        const { result: res1, err } = await capturedStderr(() => sweep(dir, fx, vault, { full: true }));
        expect(res1.deleted).toBe(0);
        expect(err).toContain('mass-delete guard refused 201 deletes');
        expect(await emailSlugs()).toHaveLength(201);

        // With it: the deletions proceed.
        await withEnv({ GBRAIN_ALLOW_MASS_RECONCILE: '1' }, async () => {
          const res2 = await sweep(dir, fx, vault, { full: true });
          expect(res2.deleted).toBe(201);
        });
        expect(await emailSlugs()).toHaveLength(0);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Backfill floor freeze ────────────────────────────────────────────────────

describe('backfill floor freeze on failure', () => {
  test('a failed thread freezes the floor at the last good batch; the retry completes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gsrc-freeze-'));
    const fx = emptyFx();
    const vault = makeVault();
    // 26 single-message threads, days 40..65 ago: batch 1 = the 25 newest
    // (days 40..64), batch 2 = the day-65 thread alone (BACKFILL_BATCH=25).
    const tids: string[] = [];
    for (let i = 0; i < 26; i++) {
      const tid = `17cc00000000${(0xa00 + i).toString(16)}`;
      tids.push(tid);
      fx.messages.push(
        gmsg(`18dd00000000${(0xb00 + i).toString(16)}`, tid, daysAgoMs(40 + i), {
          headers: { From: 'Peer Example <peer@example.com>', To: 'a@example.com', Subject: `Archive topic ${i}` },
          body: `Archive body ${i}.`,
        }),
      );
    }
    const failedTid = tids[25]; // the day-65 thread — batch 2
    try {
      await insertGoogleSource(dir);
      await withHome(async () => {
        fx.failThreads.add(failedTid);
        const res1 = await sweep(dir, fx, vault);
        expect(res1.status).toBe('partial');
        expect(res1.failedFiles).toBe(1);
        expect(res1.added).toBe(25);

        let state = readGoogleState(dir);
        expect(state.gmail_backfill_done).toBe(false);
        // The floor froze at batch 1's oldest thread (day 64) — it did NOT
        // advance past the failed thread's batch. A floor below day 65 would
        // orphan the failed thread outside every future resume window.
        expect(state.gmail_backfill_floor_ms).toBe(daysAgoMs(64));
        expect(state.gmail_history_id).toBe('1000'); // delta anchor intact

        // Failure clears → the resume window (before:floor) retries the
        // failed thread and the backfill completes.
        fx.failThreads.clear();
        const res2 = await sweep(dir, fx, vault);
        expect(res2.status).toBe('synced');
        expect(res2.added).toBe(1); // just the previously-failed thread
        state = readGoogleState(dir);
        expect(state.gmail_backfill_done).toBe(true);
        expect(state.gmail_backfill_floor_ms).toBeNull();
        const slugs = await emailSlugs();
        expect(slugs).toHaveLength(26);
        expect(slugs.some((s) => s.includes('archive-topic-25'))).toBe(true); // the failed thread's page
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── 404-vanished threads ─────────────────────────────────────────────────────

describe('404-vanished threads', () => {
  test('delta lane: a 404 thread is skipped, the sync is NOT partial, and the cursor advances', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gsrc-vanish-delta-'));
    const fx = emptyFx();
    const vault = makeVault();
    fx.messages.push(gmsg('18c2f4a9b3d21e01', T_A, daysAgoMs(2)));
    try {
      await insertGoogleSource(dir);
      await withHome(async () => {
        await sweep(dir, fx, vault);
        expect(readGoogleState(dir).gmail_history_id).toBe('1000');

        // History flags a thread that was deleted before we could fetch it.
        fx.history = [[T_V]];
        fx.historyResponseId = '1010';
        fx.vanishedThreads.add(T_V);
        const res = await sweep(dir, fx, vault);
        expect(res.status).toBe('up_to_date'); // skipped ≠ partial
        expect(res.failedFiles).toBeUndefined();
        expect(readGoogleState(dir).gmail_history_id).toBe('1010'); // cursor advanced
        // No page ever materialized for the vanished thread.
        expect((await emailSlugs())).toHaveLength(1);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('backfill lane: a 404 thread is skipped and the backfill still completes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gsrc-vanish-backfill-'));
    const fx = emptyFx();
    const vault = makeVault();
    // One good thread (day 40) + one whose listing entry survives but whose
    // getThread 404s (day 41).
    fx.messages.push(
      gmsg('18c2f4a9b3d21f01', '17cc00000000f001', daysAgoMs(40), {
        headers: { From: 'Peer Example <peer@example.com>', To: 'a@example.com', Subject: 'Good archive thread' },
        body: 'Archive body.',
      }),
      gmsg('18c2f4a9b3d21f02', T_V, daysAgoMs(41), {
        headers: { From: 'Peer Example <peer@example.com>', To: 'a@example.com', Subject: 'Vanished archive thread' },
        body: 'Gone before fetch.',
      }),
    );
    fx.vanishedThreads.add(T_V);
    try {
      await insertGoogleSource(dir);
      await withHome(async () => {
        const res = await sweep(dir, fx, vault);
        expect(res.status).toBe('first_sync'); // NOT partial
        expect(res.added).toBe(1);
        expect(res.failedFiles).toBeUndefined();
        const state = readGoogleState(dir);
        expect(state.gmail_backfill_done).toBe(true);
        expect(state.gmail_backfill_floor_ms).toBeNull();
        const slugs = await emailSlugs();
        expect(slugs).toHaveLength(1);
        expect(slugs[0]).toContain('good-archive-thread');
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── syncToken 410 recovery (calendar + contacts) ─────────────────────────────

describe('syncToken 410 recovery', () => {
  test('calendar: an expired syncToken re-lists windowed and stores the fresh token', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gsrc-cal410-'));
    const fx = emptyFx();
    const vault = makeVault();
    fx.calendarEvents = [
      {
        id: 'evt00000000000001',
        status: 'confirmed',
        summary: 'Zephyr planning sync',
        start: { dateTime: new Date(daysAgoMs(1)).toISOString() },
        end: { dateTime: new Date(daysAgoMs(1) + 3_600_000).toISOString() },
        organizer: { email: 'a@example.com' },
        attendees: [{ email: 'a@example.com', self: true, responseStatus: 'accepted' }],
      },
    ];
    try {
      await insertGoogleSource(dir);
      await withHome(async () => {
        const res1 = await sweep(dir, fx, vault, {}, 'calendar');
        expect(res1.added).toBe(1);
        expect(readGoogleState(dir).calendar_sync_token).toBe('cal-sync-w1');

        // The stored token expires upstream: 410 → windowed re-list.
        fx.calendarExpireSyncToken = true;
        const res2 = await sweep(dir, fx, vault, {}, 'calendar');
        expect(res2.status).not.toBe('partial'); // recovery, not failure
        const state = readGoogleState(dir);
        expect(state.calendar_sync_token).toBe('cal-sync-w2'); // fresh token banked
        // The windowed re-list actually ran (second windowed call).
        expect(fx.calendarWindowedLists).toBe(2);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('contacts: an expired syncToken re-lists in full and stores the fresh token', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gsrc-ppl410-'));
    const fx = emptyFx();
    const vault = makeVault();
    fx.contacts = [
      {
        resourceName: 'people/c000000001',
        names: [{ displayName: 'Alice Example', metadata: { primary: true } }],
        emailAddresses: [{ value: 'alice@example.com' }],
      },
    ];
    try {
      await insertGoogleSource(dir);
      await withHome(async () => {
        const res1 = await sweep(dir, fx, vault, {}, 'contacts');
        expect(res1.added).toBe(1);
        expect(readGoogleState(dir).contacts_sync_token).toBe('ppl-sync-w1');

        fx.contactsExpireSyncToken = true;
        const res2 = await sweep(dir, fx, vault, {}, 'contacts');
        expect(res2.status).not.toBe('partial');
        expect(readGoogleState(dir).contacts_sync_token).toBe('ppl-sync-w2');
        expect(fx.contactsFullLists).toBe(2);
        // The re-listed contact page is still there (idempotent re-import).
        const people = await engine.executeRaw<{ slug: string }>(
          `SELECT slug FROM pages WHERE source_id = 'gsrc' AND deleted_at IS NULL AND slug = 'people/alice-example'`,
        );
        expect(people).toHaveLength(1);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── loops_extract enqueue cap ────────────────────────────────────────────────

describe('loops_extract enqueue cap', () => {
  test(`>${LOOPS_EXTRACT_MAX_PER_SWEEP} recent threads → exactly ${LOOPS_EXTRACT_MAX_PER_SWEEP} jobs + the drop log`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gsrc-cap-'));
    const fx = emptyFx();
    const vault = makeVault();
    const total = LOOPS_EXTRACT_MAX_PER_SWEEP + 3; // 53 recent threads
    for (let i = 0; i < total; i++) {
      const tid = `17ee00000000${(0x100 + i).toString(16)}`;
      fx.messages.push(
        gmsg(`18ff00000000${(0x200 + i).toString(16)}`, tid, hoursAgoMs(i + 1), {
          headers: { From: 'Peer Example <peer@example.com>', To: 'a@example.com', Subject: `Recent topic ${i}` },
          body: `Recent body ${i}.`,
        }),
      );
    }
    try {
      await insertGoogleSource(dir);
      await withHome(async () => {
        const { result: res, err } = await capturedStderr(() => sweep(dir, fx, vault));
        expect(res.added).toBe(total);
        // Exactly the cap, newest-first; the overflow defers (re-candidates
        // on next touch) with an honest drop log.
        const jobs = await engine.executeRaw<{ data: unknown }>(
          `SELECT data FROM minion_jobs WHERE name = 'loops_extract'`,
        );
        expect(jobs).toHaveLength(LOOPS_EXTRACT_MAX_PER_SWEEP);
        expect(err).toContain(
          `loops_extract cap: enqueuing ${LOOPS_EXTRACT_MAX_PER_SWEEP}, deferring ${total - LOOPS_EXTRACT_MAX_PER_SWEEP}`,
        );
        // Newest-first pick: the three OLDEST threads (topics 50..52, hours
        // 51..53 ago) are the deferred ones.
        const slugs = jobs
          .map((j) => (typeof j.data === 'string' ? JSON.parse(j.data) : j.data) as { slug: string })
          .map((p) => p.slug);
        for (const dropped of ['recent-topic-50', 'recent-topic-51', 'recent-topic-52']) {
          expect(slugs.some((s) => s.includes(dropped))).toBe(false);
        }
        expect(slugs.some((s) => s.includes('recent-topic-0'))).toBe(true);
        // NOTE (item 1e): runGoogleSync writes NO heartbeat.jsonl rows — the
        // connect funnel is a commands-layer concern; see
        // test/google-connect-cmd.serial.test.ts for those assertions.
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
