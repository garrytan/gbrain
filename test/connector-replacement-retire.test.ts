/**
 * #10579 / #10577: a connector page that moves (a renamed contact, a calendar event whose title or date changed) keeps
 * its old page until a different replacement page has actually landed. The replacement import can land nothing (its
 * render matches a page purge tombstone, or the import fails) or land on the old slug, and retiring the old page then
 * deleted the only stored copy. Google Contacts and Apple Contacts share the apply step (contact-page-apply.ts); the
 * Google Calendar sweep imports the moved event first and retires the old path after. Cancellation, contact deletion
 * and an ordinary move still retire the old page.
 * Real PGLite and Postgres (when DATABASE_URL is set), the real importers and purge, fake People / Calendar APIs and a
 * synthetic Apple Contacts helper on 127.0.0.1. No network.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { SyncOpts } from '../src/commands/sync.ts';
import { applyContactPage, type ContactPageIO } from '../src/core/contact-page-apply.ts';
import { planCalendarPage } from '../src/core/google/calendar-window.ts';
import { parseGoogleSourceConfig, readGoogleState, runGoogleSync } from '../src/core/google/google-source.ts';
import { sweepCalendar } from '../src/core/google/people-calendar-sweep.ts';
import * as sweepShared from '../src/core/google/sweep-shared.ts';
import type { GoogleSyncDeps, GoogleSyncSummary } from '../src/core/google/sweep-shared.ts';
import { CalendarClient } from '../src/core/google/google-clients.ts';
import { EnvAccessProvider } from '../src/core/google/access.ts';
import { calendarRelPath } from '../src/core/google/google-render.ts';
import type { CalendarEventData } from '../src/core/google/types.ts';
import { runAppleContactsSync } from '../src/core/apple-contacts/apple-contacts-source.ts';
import { parseAppleContactsSourceConfig } from '../src/core/apple-contacts/source-config.ts';
import { listEntityIdentities } from '../src/core/entity-identity.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { ManagedConnectorSync } from '../src/core/persistence/connector-sync.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { slugifyPath } from '../src/core/sync.ts';
import { _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';
import { ContactsStub, STUB_TOKEN, type StubContact } from './helpers/apple-contacts-stub.ts';
import { contact, createConnectorFixture, json, options, settleConnectorWrites, withGoogleAccount } from './helpers/connector-fixture.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const SOURCE = 'source-a';
const ACCOUNT = 'owner@example.invalid';
const ctx = (engine: BrainEngine, sourceId: string) => ({ engine, sourceId, config: { engine: engine.kind }, remote: false, dryRun: false,
  logger: { info() {}, warn() {}, error() {} } });
async function purge(engine: BrainEngine, sourceId: string, slug: string) {
  const snapshot = await engine.readPageSnapshot(slug, { sourceId });
  await submitPageMutation(ctx(engine, sourceId) as never, { operation: 'delete_page', params: { slug, purge: true, expected_revision: snapshot!.revision } });
  expect(await engine.getPage(slug, { sourceId })).toBeNull();
}
const live = async (engine: BrainEngine, sourceId: string) => (await engine.executeRaw<{ slug: string }>(
  'SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL ORDER BY slug', [sourceId])).map(r => r.slug);

/** An in-memory contacts directory behind the shared apply step; write() lands at slugifyPath(relPath) unless told otherwise. */
function directory(id: string) {
  const pages = new Map<string, string>();
  const removes: string[] = [];
  let applied = 0;
  let landing: (relPath: string) => string | null = relPath => relPath.replace(/\.md$/, '');
  const io: ContactPageIO = {
    existingPath: async () => [...pages].find(([, owner]) => owner === id)?.[0] ?? null,
    owner: async relPath => pages.get(relPath) ?? null,
    baseSlug: () => 'people/new-name',
    tombstoneSlugs: () => ['people/new-name'],
    render: () => ({ relPath: 'people/new-name.md', markdown: 'x' }),
    write: async relPath => { const slug = landing(relPath); if (slug === slugifyPath(relPath)) pages.set(relPath, id); return slug; },
    remove: async relPath => { removes.push(relPath); pages.delete(relPath); },
    skippedHandAuthored: () => {},
    applied: () => { applied++; },
  };
  return { pages, removes, io, applied: () => applied, land: (f: (relPath: string) => string | null) => { landing = f; } };
}

describe('the shared contact apply step retires the old page only after a different replacement landed', () => {
  test('a normal rename lands the new page and retires the old one', async () => {
    const d = directory('c1');
    d.pages.set('people/old-name.md', 'c1');
    expect(await applyContactPage('c1', false, d.io)).toBe(true);
    expect([...d.pages.keys()]).toEqual(['people/new-name.md']);
    expect(d.removes).toEqual(['people/old-name.md']);
    expect(d.applied()).toBe(1);
  });

  test('a replacement the import skipped (no page landed) keeps the old page and reports nothing applied', async () => {
    const d = directory('c1');
    d.pages.set('people/old-name.md', 'c1');
    d.land(() => null);
    expect(await applyContactPage('c1', false, d.io)).toBe(false);
    expect([...d.pages.keys()]).toEqual(['people/old-name.md']);
    expect(d.removes).toEqual([]);
    expect(d.applied()).toBe(0);
  });

  test('a replacement the import kept on the old slug is not retired', async () => {
    const d = directory('c1');
    d.pages.set('people/old-name.md', 'c1');
    d.land(() => 'people/old-name');
    expect(await applyContactPage('c1', false, d.io)).toBe(true);
    expect([...d.pages.keys()]).toEqual(['people/old-name.md']);
    expect(d.removes).toEqual([]);
  });

  test('a deleted contact still retires its page', async () => {
    const d = directory('c1');
    d.pages.set('people/old-name.md', 'c1');
    expect(await applyContactPage('c1', true, d.io)).toBe(true);
    expect(d.pages.size).toBe(0);
  });
});

test('planCalendarPage names the old path to retire after the write', () => {
  expect(planCalendarPage('inside', 'calendar/new.md', 'calendar/old.md', 'x')).toEqual({ kind: 'write', retireAfter: 'calendar/old.md' });
  expect(planCalendarPage('inside', 'calendar/new.md', 'calendar/new.md', 'x')).toEqual({ kind: 'write', retireAfter: null });
  expect(planCalendarPage('inside', null, 'calendar/old.md', 'x')).toEqual({ kind: 'remove', relPath: 'calendar/old.md' });
});

async function withGoogleBrain(databaseUrl: string | undefined, run: (engine: BrainEngine, root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-replacement-'));
  try {
    await withEnv({ GBRAIN_HOME: root, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, CONNECTOR_TEST_TOKEN: 'synthetic-local-fixture' }, async () => {
      _resetWriteThroughCacheForTest();
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await run(engine, root);
      } finally { await close(); }
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

const CONTACTS = { kind: 'google', g_account: ACCOUNT, g_services: 'contacts', g_access: 'env', g_token_env: 'CONNECTOR_TEST_TOKEN' };
const CALENDAR = { ...CONTACTS, g_services: 'calendar' };

for (const backend of testBackends()) describe(`[${backend}] a moved Google page keeps its only copy until the replacement lands`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test('contacts: a rename into purged content keeps the live page; an ordinary rename still retires it', async () => withGoogleBrain(databaseUrl, async (engine, root) => {
    const dir = join(root, 'google');
    await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)', [SOURCE, dir, JSON.stringify(CONTACTS)]);
    let name = 'Alice Example';
    const fetch = withGoogleAccount(async (url: string) => {
      if (new URL(url).pathname === '/v1/people/me/connections') return json({ connections: [contact('c1', name)], nextSyncToken: 'token-1' });
      throw new Error(`Unexpected Google fixture route: ${url}`);
    }, ACCOUNT);
    const cfg = parseGoogleSourceConfig(CONTACTS, dir);
    const sync = async () => expect((await runGoogleSync(engine, SOURCE, cfg, { ...options, sourceId: SOURCE }, fetch)).failedFiles ?? 0).toBe(0);
    await sync();
    await purge(engine, SOURCE, 'people/alice-example');
    rmSync(join(dir, 'people/alice-example.md'), { force: true });

    name = 'Bob Example';
    await sync();
    expect(await live(engine, SOURCE)).toEqual(['people/bob-example']);

    name = 'Alice Example';
    await sync();
    expect(await live(engine, SOURCE)).toEqual(['people/bob-example']);
    expect(existsSync(join(dir, 'people/bob-example.md'))).toBe(true);

    name = 'Carol Example';
    await sync();
    expect(await live(engine, SOURCE)).toEqual(['people/carol-example']);
    expect(existsSync(join(dir, 'people/bob-example.md'))).toBe(false);
  }), 180_000);

  test('calendar: a failed, purged or same-slug replacement keeps the event; a retry, a move and a cancellation still retire it', async () => withGoogleBrain(databaseUrl, async (engine, root) => {
    const dir = join(root, 'google');
    mkdirSync(dir, { recursive: true });
    await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)', [SOURCE, dir, JSON.stringify(CALENDAR)]);
    const start = new Date(Date.now() + 86_400_000).toISOString();
    const end = new Date(Date.parse(start) + 3_600_000).toISOString();
    let title = 'Original meeting';
    let status = 'confirmed';
    const pathFor = (summary: string) => calendarRelPath({ id: 'event12345', startIso: start, summary } as CalendarEventData);
    const client = new CalendarClient(new EnvAccessProvider('CONNECTOR_TEST_TOKEN'), async () => json({
      items: [{ id: 'event12345', status, summary: title, start: { dateTime: start }, end: { dateTime: end },
        organizer: { email: ACCOUNT }, attendees: [{ email: ACCOUNT, self: true, responseStatus: 'accepted' }] }],
      nextSyncToken: 'next-token',
    }));
    const deps = { engine, sourceId: SOURCE, cfg: parseGoogleSourceConfig(CALENDAR, dir), managed: null, opts: {}, log() {}, tick() {} } as unknown as GoogleSyncDeps;
    const summary = { status: 'synced', added: 0, modified: 0, deleted: 0, chunksCreated: 0, embedded: 0, pagesAffected: [], threadsSeen: 0,
      attachmentInspection: {}, extractEligibility: {}, loopsWithheld: {}, failedFiles: 0 } as GoogleSyncSummary;
    const state = readGoogleState(dir);
    const sweep = () => sweepCalendar(deps, client, state, undefined, summary, new Set());
    const only = async (relPath: string) => {
      expect(await live(engine, SOURCE)).toEqual([slugifyPath(relPath)]);
      expect(existsSync(join(dir, relPath))).toBe(true);
    };

    title = 'Purged meeting';
    await sweep();
    await purge(engine, SOURCE, slugifyPath(pathFor('Purged meeting')));
    rmSync(join(dir, pathFor('Purged meeting')), { force: true });
    title = 'Original meeting';
    await sweep();
    await only(pathFor('Original meeting'));

    // The replacement matches a purge tombstone: the import is skipped and the original stays.
    title = 'Purged meeting';
    await sweep();
    await only(pathFor('Original meeting'));

    // The replacement import fails: the original stays, and the retry completes the move.
    title = 'Renamed meeting';
    const blocked = join(dir, `${pathFor('Renamed meeting')}.tmp`);
    mkdirSync(blocked, { recursive: true });
    await expect(sweep()).rejects.toThrow('Stale temporary path');
    await only(pathFor('Original meeting'));
    rmSync(blocked, { recursive: true });
    await sweep();
    await only(pathFor('Renamed meeting'));
    expect(existsSync(join(dir, pathFor('Original meeting')))).toBe(false);

    // The import lands the moved event on the slug it already had: that page is not retired.
    title = 'Kept meeting';
    const kept = slugifyPath(pathFor('Renamed meeting'));
    const spy = spyOn(sweepShared, 'importRendered').mockResolvedValue(kept);
    try { await sweep(); } finally { spy.mockRestore(); }
    await only(pathFor('Renamed meeting'));

    // An ordinary move, then a cancellation, still retire the page.
    title = 'Moved meeting';
    await sweep();
    await only(pathFor('Moved meeting'));
    expect(existsSync(join(dir, pathFor('Renamed meeting')))).toBe(false);
    status = 'cancelled';
    await sweep();
    expect(await live(engine, SOURCE)).toEqual([]);
    expect(existsSync(join(dir, pathFor('Moved meeting')))).toBe(false);
  }), 180_000);
});

describe('apple contacts on a managed brain: a rename into purged content keeps the live page and its identity link', () => {
  const fixture = createConnectorFixture();
  beforeAll(fixture.setup, 120_000);
  afterAll(fixture.teardown);

  test('the skipped replacement retires nothing and leaves the identity decision as it was; an ordinary rename still moves it', async () => withEnv(fixture.env, async () => {
    const stub = new ContactsStub().start();
    try {
      const tokenFile = join(fixture.home, 'contacts-token.json');
      writeFileSync(tokenFile, JSON.stringify({ accessToken: STUB_TOKEN }), { mode: 0o600 });
      chmodSync(tokenFile, 0o600);
      const config = { kind: 'apple-contacts', ac_helper_host: '127.0.0.1', ac_helper_port: stub.port, ac_token_file: tokenFile, owner_only: true, federated: false };
      const person = (given: string): StubContact => ({ given_name: given, family_name: 'Example', emails: [{ label: null, value: 'dana@example.invalid' }] });
      for (const engine of fixture.engines) {
        const f = await fixture.source(engine, config);
        const cfg = parseAppleContactsSourceConfig(config);
        const run = async () => {
          await runAppleContactsSync(engine, f.id, cfg, options as SyncOpts, { log() {} });
          await settleConnectorWrites(engine, f.id).catch(() => {});
          await disposePersistenceConsumer(engine);
        };
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.putPage('people/dana-example', { type: 'person', title: 'Dana Example', compiled_truth: 'Dana runs the harbor project.', timeline: '',
          frontmatter: { email: 'dana@example.invalid' } } as never, { sourceId: 'default' } as never);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        const linked = async (slug: string) => (await listEntityIdentities(engine, { slug, slugSourceId: f.id })).find(m => m.slug === slug)?.established_by ?? null;

        stub.upsert('c1', person('Alice'));
        await run();
        const [purged] = await live(engine, f.id);
        expect(purged).toBeDefined();
        await purge(engine, f.id, purged!);
        await settleConnectorWrites(engine, f.id).catch(() => {});
        await disposePersistenceConsumer(engine);

        stub.upsert('c1', person('Bob'));
        await run();
        const [renamed] = await live(engine, f.id);
        expect(renamed).not.toBe(purged);
        expect(await linked(renamed!)).toBe('apple-contacts');

        stub.upsert('c1', person('Alice'));
        await run();
        expect(await live(engine, f.id)).toEqual([renamed!]);
        expect(await linked(renamed!)).toBe('apple-contacts');

        stub.upsert('c1', person('Carol'));
        await run();
        const [moved] = await live(engine, f.id);
        expect(moved).not.toBe(renamed);
        expect(await live(engine, f.id)).toEqual([moved!]);
        expect(await linked(moved!)).toBe('apple-contacts');
      }
    } finally { stub.stop(); }
  }), 180_000);
});

describe('google contacts on a managed brain: a replacement still pending when the sweep moves on is not taken as landed', () => {
  const fixture = createConnectorFixture();
  beforeAll(fixture.setup, 120_000);
  afterAll(fixture.teardown);

  test('a pending rename the pages guard refuses at publication keeps the old page', async () => withEnv(fixture.env, async () => {
    for (const engine of fixture.engines) {
      const f = await fixture.source(engine, CONTACTS);
      const cfg = parseGoogleSourceConfig(CONTACTS, f.dir);
      let name = 'Alice Example';
      const fetch = withGoogleAccount(async (url: string) => {
        const u = new URL(url);
        if (u.pathname.endsWith('/people/me/connections')) return json({ connections: [contact('c1', name)], nextSyncToken: 'token-1' });
        if (u.pathname.endsWith('/contactGroups')) return json({ contactGroups: [] });
        throw new Error(`Unexpected Google fixture route: ${url}`);
      }, ACCOUNT);
      const run = async () => {
        await runGoogleSync(engine, f.id, cfg, options, fetch).catch(() => {});
        await settleConnectorWrites(engine, f.id).catch(() => {});
        await disposePersistenceConsumer(engine);
      };
      await run();
      await purge(engine, f.id, 'people/alice-example');
      await settleConnectorWrites(engine, f.id).catch(() => {});
      await disposePersistenceConsumer(engine);
      name = 'Bob Example';
      await run();
      expect(await live(engine, f.id)).toEqual(['people/bob-example']);

      // The session's purge screen misses the render, so the write is admitted, outlives the item's wait and is refused
      // by the pages guard only at publication.
      name = 'Alice Example';
      const screen = spyOn(ManagedConnectorSync.prototype as unknown as { carriesPurgedPage: () => Promise<boolean> }, 'carriesPurgedPage').mockResolvedValue(false);
      const quiet = spyOn(process.stderr, 'write').mockImplementation(() => true);
      let stalled = false;
      installFaultHook(async (point) => { if (point === 'consumer:preparing' && !stalled) { stalled = true; await new Promise(r => setTimeout(r, 6_500)); } });
      try { await run(); } finally { installFaultHook(undefined); quiet.mockRestore(); screen.mockRestore(); }
      expect(await live(engine, f.id)).toEqual(['people/bob-example']);
    }
  }), 180_000);
});
