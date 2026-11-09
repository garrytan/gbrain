/**
 * #8906: a full contacts re-list (expired syncToken, first sync, changed
 * mask) checkpoints its People pageToken after each page lands, so a run cut
 * short by its job deadline resumes at the next page instead of page 1. Runs
 * on a repo-less PGLite brain: the cursor lives in the source state the sweep
 * already writes, never in git.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { CONTACT_PERSON_FIELDS } from '../src/core/google/google-clients.ts';
import { googleStateFile, parseGoogleSourceConfig, readGoogleState, runGoogleSync } from '../src/core/google/google-source.ts';
import type { GoogleSourceState } from '../src/core/google/types.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

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
  await engine.setConfig('version', schemaVersion);
});

const PAGE_SIZE = 200;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** People connections in pages of 200: page n is asked for with pageToken p<n>; the last page mints ppl-new; a syncToken request is expired (410). */
function peopleApi(pages: number, o: { stale?: (pageToken: string) => Response; onList?: (pageToken: string | null) => void } = {}) {
  const served: string[] = [];
  const requests: Array<{ syncToken: string | null; pageToken: string | null }> = [];
  let calendarLists = 0;
  const fetchImpl: Fetch = async (url, init) => {
    const u = new URL(url);
    if (u.pathname.includes('/calendars/')) {
      calendarLists++;
      return json({ items: [], nextSyncToken: 'cal-1' });
    }
    if (!u.pathname.endsWith('/people/me/connections')) return json({ error: { message: 'unexpected fixture route' } }, 400);
    const syncToken = u.searchParams.get('syncToken');
    const pageToken = u.searchParams.get('pageToken');
    requests.push({ syncToken, pageToken });
    if (syncToken) return json({ error: { code: 410, message: 'Sync token is expired. Clear local cache and retry call without the sync token.' } }, 410);
    o.onList?.(pageToken);
    if (init?.signal?.aborted) throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
    const n = pageToken === null ? 1 : /^p\d+$/.test(pageToken) ? Number(pageToken.slice(1)) : NaN;
    if (!(n >= 1 && n <= pages)) return o.stale ? o.stale(pageToken!) : json({ error: { code: 400, message: 'unexpected page token' } }, 400);
    served.push('p' + n);
    const connections = Array.from({ length: PAGE_SIZE }, (_, i) => {
      const id = 'c' + String((n - 1) * PAGE_SIZE + i).padStart(5, '0');
      return { resourceName: 'people/' + id, etag: 'e-' + id, names: [{ displayName: 'Person ' + id + ' Example' }], emailAddresses: [{ value: id + '@example.invalid' }] };
    });
    return json(n < pages ? { connections, nextPageToken: 'p' + (n + 1) } : { connections, nextSyncToken: 'ppl-new' });
  };
  return { fetchImpl, served, requests, calendarLists: () => calendarLists };
}

async function googleSource(services = 'contacts') {
  const dir = mkdtempSync(join(tmpdir(), 'gsrc-relist-8906-'));
  const config = { kind: 'google', g_account: 'owner@example.invalid', g_services: services, g_history_days: 90, g_dir: dir, g_access: 'env', g_token_env: 'GBRAIN_TEST_8906_TOKEN' };
  await engine.executeRaw('INSERT INTO sources (id, name, local_path, config) VALUES ($1, $2, $3, $4::text::jsonb)', ['gsrc', 'google', dir, JSON.stringify(config)]);
  return { dir, cfg: parseGoogleSourceConfig(config, dir) };
}

function seedState(dir: string, state: Record<string, unknown>): void {
  writeFileSync(googleStateFile(dir), JSON.stringify({ ...readGoogleState(dir), ...state }));
}

const relistOf = (dir: string) => (readGoogleState(dir) as GoogleSourceState & { contacts_relist?: { page_token: string; person_fields: string } | null }).contacts_relist ?? null;

const personPages = async () => (await engine.executeRaw<{ n: number }>(
  "SELECT count(*)::int AS n FROM pages WHERE source_id = 'gsrc' AND deleted_at IS NULL AND frontmatter->>'google_contact_id' IS NOT NULL"))[0]!.n;

const sync = (cfg: ReturnType<typeof parseGoogleSourceConfig>, fetchImpl: Fetch, signal?: AbortSignal) =>
  withEnv({ GBRAIN_HOME: mkdtempSync(join(tmpdir(), 'gbrain-home-8906-')), GBRAIN_TEST_8906_TOKEN: 'synthetic-fixture-token' }, () =>
    runGoogleSync(engine, 'gsrc', cfg, { sourceId: 'gsrc', noEmbed: true, noExtract: true, noSchemaPack: true, ...(signal ? { signal } : {}) }, fetchImpl));

describe('contacts full re-list checkpoints (#8906)', () => {
  test('expired token, 2,000 contacts, a deadline after 3 pages: each run resumes at its next page and the list completes with every page applied once', async () => {
    const { dir, cfg } = await googleSource();
    try {
      seedState(dir, { contacts_sync_token: 'stale-token', contacts_person_fields: CONTACT_PERSON_FIELDS });
      let controller = new AbortController();
      let listedThisRun = 0;
      const onDiskAtDeadline: Array<string | null> = [];
      const api = peopleApi(10, {
        onList: () => {
          // The job deadline fires as the run asks for its 4th page; what is on disk then is what a killed job leaves.
          if (++listedThisRun !== 4) return;
          controller.abort();
          onDiskAtDeadline.push(relistOf(dir)?.page_token ?? null);
        },
      });
      const firstPageTokens: Array<string | null> = [];
      for (let run = 0; run < 6 && readGoogleState(dir).contacts_sync_token !== 'ppl-new'; run++) {
        controller = new AbortController();
        listedThisRun = 0;
        const before = api.requests.length;
        await sync(cfg, api.fetchImpl, controller.signal);
        firstPageTokens.push(api.requests.slice(before).find((r) => r.syncToken === null)?.pageToken ?? null);
      }
      expect(firstPageTokens).toEqual([null, 'p4', 'p7', 'p10']);
      expect(onDiskAtDeadline).toEqual(['p4', 'p7', 'p10']);
      expect(api.served).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p10']);
      const state = readGoogleState(dir);
      expect(state.contacts_sync_token).toBe('ppl-new');
      expect(state.contacts_person_fields).toBe(CONTACT_PERSON_FIELDS);
      expect(relistOf(dir)).toBeNull();
      expect(await personPages()).toBe(2_000);
      const after = api.requests.length;
      await sync(cfg, api.fetchImpl);
      expect(api.requests[after]).toEqual({ syncToken: 'ppl-new', pageToken: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);

  test('a saved page token Google no longer honors (400 or 410) restarts the re-list from page 1 once; a failing restart propagates without looping', async () => {
    for (const status of [400, 410]) {
      await resetPgliteState(engine);
      await engine.setConfig('version', schemaVersion);
      const { dir, cfg } = await googleSource();
      try {
        seedState(dir, { contacts_sync_token: null, contacts_person_fields: CONTACT_PERSON_FIELDS, contacts_relist: { page_token: 'gone-page', person_fields: CONTACT_PERSON_FIELDS } });
        const api = peopleApi(3, { stale: () => json({ error: { code: status, message: 'Page token is invalid.' } }, status) });
        expect((await sync(cfg, api.fetchImpl)).status).not.toBe('partial');
        expect(api.requests.map((r) => r.pageToken)).toEqual(['gone-page', null, 'p2', 'p3']);
        expect(readGoogleState(dir).contacts_sync_token).toBe('ppl-new');
        expect(relistOf(dir)).toBeNull();
        expect(await personPages()).toBe(600);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    await resetPgliteState(engine);
    await engine.setConfig('version', schemaVersion);
    const { dir, cfg } = await googleSource();
    try {
      seedState(dir, { contacts_sync_token: null, contacts_person_fields: CONTACT_PERSON_FIELDS, contacts_relist: { page_token: 'gone-page', person_fields: CONTACT_PERSON_FIELDS } });
      const requests: Array<string | null> = [];
      const wedged: Fetch = async (url) => {
        const u = new URL(url);
        if (u.pathname.endsWith('/people/me/connections')) requests.push(u.searchParams.get('pageToken'));
        return json({ error: { code: 400, message: 'Page token is invalid.' } }, 400);
      };
      expect((await sync(cfg, wedged)).status).toBe('partial');
      expect(requests).toEqual(['gone-page', null]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  test('a paginated HTTP 400 that does not name the page token propagates: no restart from page 1', async () => {
    const { dir, cfg } = await googleSource();
    try {
      seedState(dir, { contacts_sync_token: null, contacts_person_fields: CONTACT_PERSON_FIELDS, contacts_relist: { page_token: 'gone-page', person_fields: CONTACT_PERSON_FIELDS } });
      const api = peopleApi(3, { stale: () => json({ error: { code: 400, message: 'Invalid personFields mask path: "unknownField".' } }, 400) });
      expect((await sync(cfg, api.fetchImpl)).status).toBe('partial');
      expect(api.requests.map((r) => r.pageToken)).toEqual(['gone-page']);
      expect(relistOf(dir)?.page_token).toBe('gone-page');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test('a page token saved under another field mask is not resumed: the re-list starts at page 1', async () => {
    const { dir, cfg } = await googleSource();
    try {
      seedState(dir, { contacts_sync_token: null, contacts_person_fields: 'names', contacts_relist: { page_token: 'p2', person_fields: 'names' } });
      const api = peopleApi(2);
      await sync(cfg, api.fetchImpl);
      expect(api.requests.map((r) => r.pageToken)).toEqual([null, 'p2']);
      expect(readGoogleState(dir).contacts_person_fields).toBe(CONTACT_PERSON_FIELDS);
      expect(relistOf(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("a re-list longer than one run's page budget stops at the budget and the calendar sweep still runs; the next sync finishes it", async () => {
    const { dir, cfg } = await googleSource('contacts,calendar');
    try {
      const api = peopleApi(12);
      expect((await sync(cfg, api.fetchImpl)).status).not.toBe('partial');
      expect(api.served).toHaveLength(10);
      expect(api.calendarLists()).toBeGreaterThan(0);
      expect(relistOf(dir)?.page_token).toBe('p11');
      expect(readGoogleState(dir).contacts_sync_token).toBeNull();
      await sync(cfg, api.fetchImpl);
      expect(api.served).toEqual(Array.from({ length: 12 }, (_, i) => 'p' + (i + 1)));
      expect(readGoogleState(dir).contacts_sync_token).toBe('ppl-new');
      expect(await personPages()).toBe(2_400);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);
test('a contact that keeps failing transiently keeps the page budget: the cursor moves past it, the finished list saves no sync token, and the next pass retries it', async () => {
    const { dir, cfg } = await googleSource();
    await engine.executeRaw(`CREATE FUNCTION relist_fail_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.title = 'Person c00200 Example' THEN RAISE EXCEPTION 'injected transient contact failure'; END IF; RETURN NEW; END $$`);
    await engine.executeRaw('CREATE TRIGGER relist_fail BEFORE INSERT ON pages FOR EACH ROW EXECUTE FUNCTION relist_fail_fn()');
    try {
      const api = peopleApi(11);
      expect((await sync(cfg, api.fetchImpl)).status).toBe('partial');
      expect(api.served).toEqual(Array.from({ length: 10 }, (_, i) => 'p' + (i + 1)));
      expect(relistOf(dir)).toEqual({ page_token: 'p11', person_fields: CONTACT_PERSON_FIELDS, blocked: true });
      await sync(cfg, api.fetchImpl);
      expect(api.served.slice(10)).toEqual(['p11']);
      expect(await personPages()).toBe(2_199);
      expect(readGoogleState(dir).contacts_sync_token).toBeNull();
      expect(relistOf(dir)).toBeNull();
      await engine.executeRaw('DROP TRIGGER relist_fail ON pages');
      await sync(cfg, api.fetchImpl);
      expect(api.requests.at(-10)).toEqual({ syncToken: null, pageToken: null });
      expect(await personPages()).toBe(2_200);
      expect(relistOf(dir)).toEqual({ page_token: 'p11', person_fields: CONTACT_PERSON_FIELDS });
    } finally {
      for (const sql of ['DROP TRIGGER IF EXISTS relist_fail ON pages', 'DROP FUNCTION IF EXISTS relist_fail_fn()']) await engine.executeRaw(sql);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);
test('a --full re-list that passes a failing contact drops its old sync token, so the next sync re-lists and retries the contact', async () => {
    const { dir, cfg } = await googleSource();
    await engine.executeRaw(`CREATE FUNCTION relist_fail_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.title = 'Person c00200 Example' THEN RAISE EXCEPTION 'injected transient contact failure'; END IF; RETURN NEW; END $$`);
    await engine.executeRaw('CREATE TRIGGER relist_fail BEFORE INSERT ON pages FOR EACH ROW EXECUTE FUNCTION relist_fail_fn()');
    try {
      seedState(dir, { contacts_sync_token: 'ppl-old', contacts_person_fields: CONTACT_PERSON_FIELDS });
      const api = peopleApi(11);
      await withEnv({ GBRAIN_HOME: mkdtempSync(join(tmpdir(), 'gbrain-home-8906-')), GBRAIN_TEST_8906_TOKEN: 'synthetic-fixture-token' }, () =>
        runGoogleSync(engine, 'gsrc', cfg, { sourceId: 'gsrc', full: true, noEmbed: true, noExtract: true, noSchemaPack: true }, api.fetchImpl));
      expect(api.served).toEqual(Array.from({ length: 11 }, (_, i) => 'p' + (i + 1)));
      expect(await personPages()).toBe(2_199);
      expect(readGoogleState(dir).contacts_sync_token).toBeNull();
      expect(relistOf(dir)).toBeNull();
      await engine.executeRaw('DROP TRIGGER relist_fail ON pages');
      const before = api.requests.length;
      await sync(cfg, api.fetchImpl);
      expect(api.requests[before]).toEqual({ syncToken: null, pageToken: null });
      expect(await personPages()).toBe(2_200);
    } finally {
      for (const sql of ['DROP TRIGGER IF EXISTS relist_fail ON pages', 'DROP FUNCTION IF EXISTS relist_fail_fn()']) await engine.executeRaw(sql);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);
test('--full ignores a saved re-list checkpoint and the page budget: it lists from page 1 to the end before recording last_full_at', async () => {
    const { dir, cfg } = await googleSource();
    try {
      seedState(dir, { contacts_sync_token: null, contacts_person_fields: CONTACT_PERSON_FIELDS, contacts_relist: { page_token: 'p3', person_fields: CONTACT_PERSON_FIELDS } });
      const api = peopleApi(11);
      await withEnv({ GBRAIN_HOME: mkdtempSync(join(tmpdir(), 'gbrain-home-8906-')), GBRAIN_TEST_8906_TOKEN: 'synthetic-fixture-token' }, () =>
        runGoogleSync(engine, 'gsrc', cfg, { sourceId: 'gsrc', full: true, noEmbed: true, noExtract: true, noSchemaPack: true }, api.fetchImpl));
      expect(api.served).toEqual(Array.from({ length: 11 }, (_, i) => 'p' + (i + 1)));
      const state = readGoogleState(dir);
      expect(state.contacts_sync_token).toBe('ppl-new');
      expect(relistOf(dir)).toBeNull();
      expect(state.last_full_at).toBeTruthy();
      expect(await personPages()).toBe(2_200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);
test('--full drops a saved re-list checkpoint even when it stops before writing its own, so the next sync starts at page 1', async () => {
    const { dir, cfg } = await googleSource();
    try {
      seedState(dir, { contacts_sync_token: null, contacts_person_fields: CONTACT_PERSON_FIELDS, contacts_relist: { page_token: 'p3', person_fields: CONTACT_PERSON_FIELDS } });
      const controller = new AbortController();
      const api = peopleApi(4, { onList: () => controller.abort() });
      await withEnv({ GBRAIN_HOME: mkdtempSync(join(tmpdir(), 'gbrain-home-8906-')), GBRAIN_TEST_8906_TOKEN: 'synthetic-fixture-token' }, () =>
        runGoogleSync(engine, 'gsrc', cfg, { sourceId: 'gsrc', full: true, noEmbed: true, noExtract: true, noSchemaPack: true, signal: controller.signal }, api.fetchImpl)).catch(() => {});
      expect(api.requests.map((r) => r.pageToken)).toEqual([null]);
      expect(relistOf(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
