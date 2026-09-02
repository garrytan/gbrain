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
import { __setChatTransportForTests, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import {
  LOOPS_EXTRACT_ENQUEUE_CEILING,
  LOOPS_EXTRACT_MAX_PER_SWEEP,
} from '../src/core/google/loops-extract.ts';
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

    if (/\/calendars\/[^/]+\/events$/.test(u.pathname)) {
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
  extra: { cfg?: Record<string, unknown>; engine?: PGLiteEngine } = {},
) {
  const cfg = parseGoogleSourceConfig(
    { kind: 'google', g_account: 'a@example.com', g_services: services, g_history_days: 90, g_dir: dir, ...extra.cfg },
    dir,
  );
  return runGoogleSync(
    extra.engine ?? engine,
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

/** Seed N pending loops_extract jobs carrying the real payload shape for one source. */
async function seedWaitingLoopsJobs(
  sourceId: string,
  n: number,
  keyPrefix: string,
  status: 'waiting' | 'delayed' | 'active' = 'waiting',
): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO minion_jobs (name, queue, status, data, idempotency_key, delay_until)
     SELECT 'loops_extract', 'default', $4::text, jsonb_build_object('sourceId', $2::text), $3::text || '-' || i,
            CASE WHEN $4::text = 'delayed' THEN now() + interval '10 minutes' END
       FROM generate_series(1, $1) AS i`,
    [n, sourceId, keyPrefix, status],
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

  test('calendar: a 410 re-list stays on the SECONDARY calendar the source is bound to', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gsrc-cal410sec-'));
    const fx = emptyFx();
    const vault = makeVault();
    const secondary = 'family0123456789@group.calendar.google.com';
    fx.calendarEvents = [
      {
        id: 'evt00000000000002',
        status: 'confirmed',
        summary: 'Family dinner',
        start: { dateTime: new Date(daysAgoMs(1)).toISOString() },
        end: { dateTime: new Date(daysAgoMs(1) + 3_600_000).toISOString() },
        organizer: { email: 'a@example.com' },
        attendees: [{ email: 'a@example.com', self: true, responseStatus: 'accepted' }],
      },
    ];
    try {
      await insertGoogleSource(dir);
      await withHome(async () => {
        const cfg = { g_calendar_id: secondary };
        const res1 = await sweep(dir, fx, vault, {}, 'calendar', { cfg });
        expect(res1.added).toBe(1);
        expect(readGoogleState(dir).calendar_sync_token).toBe('cal-sync-w1');

        fx.calendarExpireSyncToken = true;
        const res2 = await sweep(dir, fx, vault, {}, 'calendar', { cfg });
        expect(res2.status).not.toBe('partial');
        expect(readGoogleState(dir).calendar_sync_token).toBe('cal-sync-w2');
        expect(fx.calendarWindowedLists).toBe(2);

        // Every calendar call — initial window, the 410'd syncToken attempt,
        // and the windowed re-list — addressed the secondary; none fell back
        // to primary.
        const calendarCalls = fx.calls.filter((c) => c.includes('/calendars/'));
        expect(calendarCalls.length).toBe(3);
        for (const c of calendarCalls) {
          expect(c).toContain(`/calendars/${encodeURIComponent(secondary)}/events`);
          expect(c).not.toContain('/calendars/primary/');
        }
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('calendar: the stored sync token is bound to its calendar id — re-pointing g_calendar_id discards it and re-lists windowed', async () => {
    // Ship-review fix: the persisted token was not bound to the calendar it
    // was minted for, so changing g_calendar_id paired the NEW calendar with
    // the OLD token (a foreign delta cursor) instead of a fresh window.
    const dir = mkdtempSync(join(tmpdir(), 'gsrc-calrebind-'));
    const fx = emptyFx();
    const vault = makeVault();
    const secondary = 'family0123456789@group.calendar.google.com';
    fx.calendarEvents = [
      {
        id: 'evt00000000000003',
        status: 'confirmed',
        summary: 'Family dinner',
        start: { dateTime: new Date(daysAgoMs(1)).toISOString() },
        end: { dateTime: new Date(daysAgoMs(1) + 3_600_000).toISOString() },
        organizer: { email: 'a@example.com' },
        attendees: [{ email: 'a@example.com', self: true, responseStatus: 'accepted' }],
      },
    ];
    try {
      await insertGoogleSource(dir);
      await withHome(async () => {
        // State minted against PRIMARY, then the source is re-pointed.
        writeFileSync(
          googleStateFile(dir),
          JSON.stringify({
            gmail_history_id: null,
            gmail_backfill_floor_ms: null,
            gmail_backfill_done: false,
            gmail_newest_ms: null,
            calendar_sync_token: 'cal-sync-stale-primary',
            calendar_id: 'primary',
            contacts_sync_token: null,
            last_full_at: null,
          }),
          'utf-8',
        );
        const { result: res, err } = await capturedStderr(() =>
          sweep(dir, fx, vault, {}, 'calendar', { cfg: { g_calendar_id: secondary } }),
        );
        expect(res.status).not.toBe('partial');
        expect(res.added).toBe(1);
        // Fresh window: no syncToken on the wire, exactly one windowed list.
        const calendarCalls = fx.calls.filter((c) => c.includes('/calendars/'));
        expect(calendarCalls.length).toBe(1);
        expect(calendarCalls[0]).not.toContain('syncToken=');
        expect(fx.calendarWindowedLists).toBe(1);
        // Token rebound to the calendar it now belongs to; the switch is logged.
        const state = readGoogleState(dir);
        expect(state.calendar_sync_token).toBe('cal-sync-w1');
        expect(state.calendar_id).toBe(secondary);
        expect(err).toContain('[google] calendar changed');
        expect(err).toContain(secondary);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("calendar: a legacy token with no calendar_id is primary's — primary keeps its delta, a secondary re-lists windowed", async () => {
    const legacyState = {
      gmail_history_id: null,
      gmail_backfill_floor_ms: null,
      gmail_backfill_done: false,
      gmail_newest_ms: null,
      calendar_sync_token: 'cal-sync-legacy',
      contacts_sync_token: null,
      last_full_at: null,
    };
    const dirA = mkdtempSync(join(tmpdir(), 'gsrc-callegacy-a-'));
    const dirB = mkdtempSync(join(tmpdir(), 'gsrc-callegacy-b-'));
    try {
      await withHome(async () => {
        // A: still primary → the legacy token is used as a delta cursor and
        // gets bound to primary on the way out.
        const fxA = emptyFx();
        await insertGoogleSource(dirA);
        writeFileSync(googleStateFile(dirA), JSON.stringify(legacyState), 'utf-8');
        await sweep(dirA, fxA, makeVault(), {}, 'calendar');
        expect(fxA.calendarWindowedLists).toBe(0);
        expect(fxA.calls.filter((c) => c.includes('/calendars/'))[0]).toContain('syncToken=cal-sync-legacy');
        const stateA = readGoogleState(dirA);
        expect(stateA.calendar_sync_token).toBe('cal-sync-delta');
        expect(stateA.calendar_id).toBe('primary');

        // B: re-pointed at a secondary → the primary token is discarded.
        const fxB = emptyFx();
        await engine.executeRaw(`DELETE FROM sources WHERE id = 'gsrc'`);
        await insertGoogleSource(dirB);
        writeFileSync(googleStateFile(dirB), JSON.stringify(legacyState), 'utf-8');
        const secondary = 'family0123456789@group.calendar.google.com';
        await sweep(dirB, fxB, makeVault(), {}, 'calendar', { cfg: { g_calendar_id: secondary } });
        expect(fxB.calendarWindowedLists).toBe(1);
        expect(fxB.calls.filter((c) => c.includes('/calendars/'))[0]).not.toContain('syncToken=');
        expect(readGoogleState(dirB).calendar_id).toBe(secondary);
      });
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
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

// ── loops_extract enqueue completeness ───────────────────────────────────────

describe('loops_extract enqueue completeness', () => {
  // The sweep only enqueues when a chat provider is available (a job the
  // handler can never run would complete as a no-work row and consume the
  // thread's revision slot). The gateway test seam makes chat "available" for
  // every test here; the dedicated test below clears it again.
  const chatStub = async () => {
    throw new Error('chat transport must not be called by the sweep');
  };
  beforeEach(() => __setChatTransportForTests(chatStub));
  afterAll(() => {
    // Shard hygiene (same as facts-extract-junk-filter.test.ts): a reset
    // gateway must not leak a dimensionless config into later files.
    __setChatTransportForTests(null);
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      env: { ...process.env },
    });
  });

  test('chat provider unavailable (keyless install / outage) → 0 jobs enqueued, one stderr line names the reason', async () => {
    // Ship-review fix: a job enqueued with no chat provider ran to
    // `llm_unavailable`, completed, and its revision-keyed idempotency row
    // blocked re-enqueue until the thread changed — every eligible thread
    // swept during the outage was silently never extracted. Gate at enqueue.
    const dir = mkdtempSync(join(tmpdir(), 'gsrc-nochat-'));
    const fx = emptyFx();
    const vault = makeVault();
    for (let i = 0; i < 2; i++) {
      const tid = `17ee88000000${(0x100 + i).toString(16)}`;
      fx.messages.push(
        gmsg(`18ff88000000${(0x200 + i).toString(16)}`, tid, hoursAgoMs(i + 1), {
          headers: { From: 'Peer Example <peer@example.com>', To: 'a@example.com', Subject: `Nochat topic ${i}` },
          body: `Nochat body ${i}.`,
        }),
      );
    }
    try {
      await insertGoogleSource(dir);
      resetGateway();
      __setChatTransportForTests(null); // no transport stub, no config → isAvailable('chat') === false
      await withHome(async () => {
        const { result: res, err } = await capturedStderr(() => sweep(dir, fx, vault));
        expect(res.added).toBe(2); // pages still import — only the LLM lane is skipped
        const jobs = await engine.executeRaw<{ n: string }>(
          `SELECT count(*)::text AS n FROM minion_jobs WHERE name = 'loops_extract'`,
        );
        expect(Number(jobs[0].n)).toBe(0);
        expect(err).toContain('loops_extract: chat provider unavailable');
        expect(err).toContain('2 eligible thread(s)');
        expect(err).not.toContain('loops_extract: enqueued');
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  test(`>${LOOPS_EXTRACT_MAX_PER_SWEEP} eligible threads → EVERY one is queued exactly once`, async () => {
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
        // The old cap kept only the newest 50 and logged the rest as
        // "deferring … (they re-candidate on next touch)". That was silent
        // loss: a thread only re-candidates when it CHANGES, so an untouched
        // overflow thread was never extracted at all.
        const jobs = await engine.executeRaw<{ data: unknown }>(
          `SELECT data FROM minion_jobs WHERE name = 'loops_extract'`,
        );
        expect(jobs).toHaveLength(total);
        expect(err).toContain(`loops_extract: enqueued ${total} eligible thread(s)`);
        const slugs = jobs
          .map((j) => (typeof j.data === 'string' ? JSON.parse(j.data) : j.data) as { slug: string })
          .map((p) => p.slug);
        // The previously-dropped tail is present, and so is the newest.
        for (const kept of ['recent-topic-50', 'recent-topic-51', 'recent-topic-52', 'recent-topic-0']) {
          expect(slugs.some((s) => s.includes(kept))).toBe(true);
        }
        // Every slug distinct — one job per thread, no duplicates.
        expect(new Set(slugs).size).toBe(total);
        // NOTE (item 1e): runGoogleSync writes NO heartbeat.jsonl rows — the
        // connect funnel is a commands-layer concern; see
        // test/google-connect-cmd.serial.test.ts for those assertions.
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  test('a repeated sweep re-touching unchanged threads adds no duplicate jobs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gsrc-dup-'));
    const fx = emptyFx();
    const vault = makeVault();
    const total = 5;
    const threadIds: string[] = [];
    for (let i = 0; i < total; i++) {
      const tid = `17ee11000000${(0x100 + i).toString(16)}`;
      threadIds.push(tid);
      fx.messages.push(
        gmsg(`18ff11000000${(0x200 + i).toString(16)}`, tid, hoursAgoMs(i + 1), {
          headers: { From: 'Peer Example <peer@example.com>', To: 'a@example.com', Subject: `Dup topic ${i}` },
          body: `Dup body ${i}.`,
        }),
      );
    }
    try {
      await insertGoogleSource(dir);
      await withHome(async () => {
        await capturedStderr(() => sweep(dir, fx, vault));
        const after1 = await engine.executeRaw<{ n: string }>(
          `SELECT count(*)::text AS n FROM minion_jobs WHERE name = 'loops_extract'`,
        );
        // Second sweep RE-TOUCHES every thread via the history delta with
        // unchanged content — the revision-keyed idempotency key is now the
        // ONLY dedupe in play (no maxWaiting), so it must hold on its own.
        fx.history.push([...threadIds]);
        fx.historyResponseId = '2000';
        await capturedStderr(() => sweep(dir, fx, vault));
        const after2 = await engine.executeRaw<{ n: string }>(
          `SELECT count(*)::text AS n FROM minion_jobs WHERE name = 'loops_extract'`,
        );
        expect(Number(after1[0].n)).toBe(total);
        expect(Number(after2[0].n)).toBe(total);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  test('a deep waiting backlog shrinks the sweep enqueue budget (defer, not stack)', async () => {
    // The maxWaiting removal left the per-sweep ceiling as the ONLY bound —
    // with a stalled worker, repeated pathological sweeps could stack another
    // 500 waiting jobs each. The sweep now counts already-waiting
    // loops_extract jobs and shrinks this sweep's budget by that depth;
    // overflow is a deferral (a deferred thread re-candidates on next touch).
    const dir = mkdtempSync(join(tmpdir(), 'gsrc-depth-'));
    const fx = emptyFx();
    const vault = makeVault();
    for (let i = 0; i < 2; i++) {
      const tid = `17ee33000000${(0x100 + i).toString(16)}`;
      fx.messages.push(
        gmsg(`18ff33000000${(0x200 + i).toString(16)}`, tid, hoursAgoMs(i + 1), {
          headers: { From: 'Peer Example <peer@example.com>', To: 'a@example.com', Subject: `Depth topic ${i}` },
          body: `Depth body ${i}.`,
        }),
      );
    }
    try {
      await insertGoogleSource(dir);
      // Seed a waiting backlog at the ceiling — the stalled-worker shape.
      // Real loops_extract payloads carry the enqueuing source's id.
      await seedWaitingLoopsJobs('gsrc', LOOPS_EXTRACT_ENQUEUE_CEILING, 'depthseed');
      await withHome(async () => {
        const { err } = await capturedStderr(() => sweep(dir, fx, vault));
        const after = await engine.executeRaw<{ n: string }>(
          `SELECT count(*)::text AS n FROM minion_jobs WHERE name = 'loops_extract' AND status = 'waiting'`,
        );
        // Budget exhausted by the backlog: NOTHING new stacks on top.
        expect(Number(after[0].n)).toBe(LOOPS_EXTRACT_ENQUEUE_CEILING);
        expect(err).toContain('deferring 2');
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  test('a DELAYED (retry-backoff) backlog counts against the budget too — a flapping provider cannot stack past the ceiling', async () => {
    // Ship-review fix: the depth probe counted status='waiting' only. During a
    // provider outage every claimed job fails and parks as 'delayed' (backoff),
    // so the probe read ~0 and each sweep stacked another ceiling's worth of
    // jobs on top of the backlog. Pending = waiting + delayed + active.
    const dir = mkdtempSync(join(tmpdir(), 'gsrc-delayed-'));
    const fx = emptyFx();
    const vault = makeVault();
    for (let i = 0; i < 2; i++) {
      const tid = `17ee77000000${(0x100 + i).toString(16)}`;
      fx.messages.push(
        gmsg(`18ff77000000${(0x200 + i).toString(16)}`, tid, hoursAgoMs(i + 1), {
          headers: { From: 'Peer Example <peer@example.com>', To: 'a@example.com', Subject: `Delayed topic ${i}` },
          body: `Delayed body ${i}.`,
        }),
      );
    }
    try {
      await insertGoogleSource(dir);
      await seedWaitingLoopsJobs('gsrc', LOOPS_EXTRACT_ENQUEUE_CEILING, 'delayedseed', 'delayed');
      await withHome(async () => {
        const { err } = await capturedStderr(() => sweep(dir, fx, vault));
        const fresh = await engine.executeRaw<{ n: string }>(
          `SELECT count(*)::text AS n FROM minion_jobs
            WHERE name = 'loops_extract' AND idempotency_key NOT LIKE 'delayedseed-%'`,
        );
        expect(Number(fresh[0].n)).toBe(0);
        expect(err).toContain('deferring 2');
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  test("another source's waiting backlog does NOT starve this source's budget (per-source depth)", async () => {
    // Pre-fix the probe counted EVERY waiting loops_extract job brain-wide,
    // so one Google account's stalled backlog drove every other source's
    // budget to 0 forever — nothing new was ever enqueued for them.
    const dir = mkdtempSync(join(tmpdir(), 'gsrc-otherdepth-'));
    const fx = emptyFx();
    const vault = makeVault();
    for (let i = 0; i < 2; i++) {
      const tid = `17ee44000000${(0x100 + i).toString(16)}`;
      fx.messages.push(
        gmsg(`18ff44000000${(0x200 + i).toString(16)}`, tid, hoursAgoMs(i + 1), {
          headers: { From: 'Peer Example <peer@example.com>', To: 'a@example.com', Subject: `Other depth topic ${i}` },
          body: `Other depth body ${i}.`,
        }),
      );
    }
    try {
      await insertGoogleSource(dir);
      await seedWaitingLoopsJobs('google-other-account', LOOPS_EXTRACT_ENQUEUE_CEILING, 'otherseed');
      await withHome(async () => {
        const { err } = await capturedStderr(() => sweep(dir, fx, vault));
        const mine = await engine.executeRaw<{ n: string }>(
          `SELECT count(*)::text AS n FROM minion_jobs
            WHERE name = 'loops_extract' AND status = 'waiting' AND data->>'sourceId' = 'gsrc'`,
        );
        expect(Number(mine[0].n)).toBe(2);
        expect(err).toContain('loops_extract: enqueued 2 eligible thread(s)');
        expect(err).not.toContain('deferring');
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  test('partial budget keeps the NEWEST thread and logs the deferral count', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gsrc-partial-'));
    const fx = emptyFx();
    const vault = makeVault();
    // Three threads, ages 1h/2h/3h — only ONE slot is left in the budget.
    for (let i = 0; i < 3; i++) {
      const tid = `17ee55000000${(0x100 + i).toString(16)}`;
      fx.messages.push(
        gmsg(`18ff55000000${(0x200 + i).toString(16)}`, tid, hoursAgoMs(i + 1), {
          headers: { From: 'Peer Example <peer@example.com>', To: 'a@example.com', Subject: `Partial topic ${i}` },
          body: `Partial body ${i}.`,
        }),
      );
    }
    try {
      await insertGoogleSource(dir);
      await seedWaitingLoopsJobs('gsrc', LOOPS_EXTRACT_ENQUEUE_CEILING - 1, 'partialseed');
      await withHome(async () => {
        const { err } = await capturedStderr(() => sweep(dir, fx, vault));
        expect(err).toContain('deferring 2');
        expect(err).toContain(`${LOOPS_EXTRACT_ENQUEUE_CEILING - 1} already pending`);
        const fresh = await engine.executeRaw<{ data: unknown }>(
          `SELECT data FROM minion_jobs
            WHERE name = 'loops_extract' AND idempotency_key NOT LIKE 'partialseed-%'`,
        );
        expect(fresh).toHaveLength(1);
        const payload = (typeof fresh[0].data === 'string' ? JSON.parse(fresh[0].data) : fresh[0].data) as { slug: string; sourceId: string };
        expect(payload.slug).toContain('partial-topic-0'); // the 1h-old thread, not 2h/3h
        expect(payload.sourceId).toBe('gsrc');
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  test('a failing waiting-depth probe fails OPEN — the sweep still enqueues', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gsrc-probefail-'));
    const fx = emptyFx();
    const vault = makeVault();
    const tid = '17ee66000000a100';
    fx.messages.push(
      gmsg('18ff66000000b200', tid, hoursAgoMs(1), {
        headers: { From: 'Peer Example <peer@example.com>', To: 'a@example.com', Subject: 'Probe topic' },
        body: 'Probe body.',
      }),
    );
    // Only the depth probe (`… AS n FROM minion_jobs …`) throws; queue.add and
    // every other query reach the real engine.
    const probeFailing = new Proxy(engine, {
      get(target, prop) {
        if (prop === 'executeRaw') {
          return (sql: string, params?: unknown[]) => {
            if (/AS n FROM minion_jobs/.test(sql)) throw new Error('probe unavailable');
            return target.executeRaw(sql, params);
          };
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as PGLiteEngine;
    try {
      await insertGoogleSource(dir);
      await withHome(async () => {
        const { err } = await capturedStderr(() => sweep(dir, fx, vault, {}, 'gmail', { engine: probeFailing }));
        expect(err).toContain('loops_extract: enqueued 1 eligible thread(s)');
        expect(err).not.toContain('enqueue failed');
        const jobs = await engine.executeRaw<{ n: string }>(
          `SELECT count(*)::text AS n FROM minion_jobs WHERE name = 'loops_extract' AND data->>'sourceId' = 'gsrc'`,
        );
        expect(Number(jobs[0].n)).toBe(1);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  test('bulk mail the owner never answered is filtered before the queue', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gsrc-elig-'));
    const fx = emptyFx();
    const vault = makeVault();
    fx.messages.push(
      gmsg('18ff220000000001', '17ee220000000001', hoursAgoMs(2), {
        headers: {
          From: 'Peer Example <peer@example.com>',
          To: 'a@example.com',
          Subject: 'Real question',
          'List-Unsubscribe': '<https://example.com/u>',
        },
        body: 'Newsletter body.',
      }),
    );
    fx.messages.push(
      gmsg('18ff220000000002', '17ee220000000002', hoursAgoMs(3), {
        headers: { From: 'Peer Example <peer@example.com>', To: 'a@example.com', Subject: 'Human topic' },
        body: 'A real message.',
      }),
    );
    try {
      await insertGoogleSource(dir);
      await withHome(async () => {
        const { err } = await capturedStderr(() => sweep(dir, fx, vault));
        const jobs = await engine.executeRaw<{ data: unknown }>(
          `SELECT data FROM minion_jobs WHERE name = 'loops_extract'`,
        );
        const slugs = jobs
          .map((j) => (typeof j.data === 'string' ? JSON.parse(j.data) : j.data) as { slug: string })
          .map((p) => p.slug);
        expect(slugs.some((s) => s.includes('human-topic'))).toBe(true);
        expect(slugs.some((s) => s.includes('real-question'))).toBe(false);
        // Auditable counts, no mail content: one filtered, one queued.
        expect(err).toContain('loops_extract eligibility:');
        expect(err).toContain('list_mail=1');
        expect(err).toContain('human_correspondence=1');
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
