/**
 * GBRA-130 A-3: one bad Google contact or calendar event never stops the
 * Contacts or Calendar sweep, never stops Gmail, and never pins the sync token.
 *
 * 1. Protects: a failing contact (`contact:<resourceName>`) or event
 *    (`event:<calendarId>:<eventId>`) is counted per item through the
 *    connector item holds; its siblings and the Gmail sweep land in the same
 *    run; the service's sync token stays put while the item still counts and
 *    commits once only held items remain; `gbrain sources retry-held`
 *    re-fetches a held item directly (people.get / events.get) with no
 *    upstream edit; a transient item failure is reported and retried, never
 *    held.
 * 2. Regression: a per-contact or per-event throw ending the whole service
 *    sweep (siblings after it lost, token never committed).
 * 3. Existing coverage holds Gmail threads and GitHub items only
 *    (connector-holds, fix-wave-4); the contacts/calendar tests stub one
 *    failure and pin that it propagates (#6324 cursor contract).
 * 4. No production seam: the bad states are upstream identity text carrying
 *    a NUL (a contact email, an event attendee: refused invalid_connector_text,
 *    content class) and a stale `.tmp` directory left at a page path
 *    (unmanaged, transient).
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { parseGoogleSourceConfig, readGoogleState, runGoogleSync } from '../../src/core/google/google-source.ts';
import { calendarRelPath, personSlugFromContact } from '../../src/core/google/google-render.ts';
import { readAllSourceHolds } from '../../src/core/connectors/item-holds-store.ts';
import { retryHeld } from '../../src/commands/sources-retry-held.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { sanitizeForJsonb } from '../../src/core/batch-rows.ts';
import { OperationError } from '../../src/core/ops/contract.ts';
import { slugifyPath } from '../../src/core/sync.ts';
import { json, options, sourceCheckpoint, withGoogleAccount } from '../helpers/connector-fixture.ts';
import { addThread, fakeGmail, gmailFetch, type FakeGmail } from '../helpers/connector-holds-fixture.ts';
import { withEnv } from '../helpers/with-env.ts';
import { expectItemFailure, expectOthersUnchanged, expectUnitNotAborted, managedBrain, pathologicalArms, runScopedErrors, snapshotItems } from './harness.ts';

const ACCOUNT = 'owner@example.invalid';
const CONFIG = { kind: 'google', g_account: ACCOUNT, g_services: 'contacts,calendar,gmail', g_access: 'env', g_token_env: 'CONNECTOR_TEST_TOKEN' };
const ENV = { CONNECTOR_TEST_TOKEN: 'synthetic-local-fixture' };
const DAY = 86_400_000;
const START = Math.floor(Date.now() / DAY) * DAY + 2 * DAY;
const EVENTS = '/calendar/v3/calendars/primary/events';

interface Person { resourceName: string; names: Array<{ displayName: string }>; emailAddresses: Array<{ value: string }>; organizations?: Array<{ name: string }> }
interface Ev { id: string; status: string; summary: string; description?: string; start: { dateTime: string }; end: { dateTime: string }; organizer: { email: string };
  attendees?: Array<{ email: string }> }
interface FakeGoogle { contacts: Map<string, Person>; events: Map<string, Ev>; contactDelta: string[]; eventDelta: string[]; tokens: { people: number; calendar: number };
  gets: string[]; gmail: FakeGmail }

const person = (resourceName: string, name: string, org?: string, email = `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@example.invalid`): Person =>
  ({ resourceName, names: [{ displayName: name }], emailAddresses: [{ value: email }], ...(org ? { organizations: [{ name: org }] } : {}) });
const event = (id: string, hour: number, summary: string, description = '', attendee?: string): Ev => ({ id, status: 'confirmed', summary, description,
  start: { dateTime: new Date(START + hour * 3_600_000).toISOString() }, end: { dateTime: new Date(START + (hour + 1) * 3_600_000).toISOString() },
  organizer: { email: ACCOUNT }, ...(attendee ? { attendees: [{ email: attendee }] } : {}) });
/** Content-class bad items: identity text (an email, an attendee) carrying a NUL; their keys stay clean. */
const badContact = () => person('people/c2', 'Bob Example', undefined, 'bob.example\u0000@example.invalid');
const badEvent = () => event('e2', 2, 'Standup example', '', 'guest\u0000@example.invalid');
const BAD_KEYS = ['contact:people/c2', 'event:primary:e2'];

function fakeGoogle(): FakeGoogle {
  return { contacts: new Map(), events: new Map(), contactDelta: [], eventDelta: [], tokens: { people: 0, calendar: 0 }, gets: [], gmail: fakeGmail(ACCOUNT) };
}
const putContact = (fx: FakeGoogle, p: Person) => { fx.contacts.set(p.resourceName, p); fx.contactDelta.push(p.resourceName); };
const putEvent = (fx: FakeGoogle, ev: Ev) => { fx.events.set(ev.id, ev); fx.eventDelta.push(ev.id); };

function googleFetch(fx: FakeGoogle) {
  const gmail = gmailFetch(fx.gmail);
  return withGoogleAccount(async (url: string) => {
    const u = new URL(url);
    if (u.hostname === 'people.googleapis.com') {
      if (u.pathname === '/v1/people/me/connections') {
        const ids = u.searchParams.has('syncToken') ? fx.contactDelta : [...fx.contacts.keys()];
        return json({ connections: ids.map(id => fx.contacts.get(id) ?? { resourceName: id, metadata: { deleted: true } }), nextSyncToken: `ppl-${++fx.tokens.people}` });
      }
      const name = decodeURIComponent(u.pathname.slice('/v1/'.length));
      fx.gets.push(`contact:${name}`);
      const found = fx.contacts.get(name);
      return found ? json(found) : json({ error: { code: 404, message: 'Not Found' } }, 404);
    }
    if (u.hostname === 'www.googleapis.com' && u.pathname.startsWith(EVENTS)) {
      const rest = u.pathname.slice(EVENTS.length);
      if (!rest) {
        const ids = u.searchParams.has('syncToken') ? fx.eventDelta : [...fx.events.keys()];
        return json({ items: ids.map(id => fx.events.get(id) ?? { id, status: 'cancelled' }), nextSyncToken: `cal-${++fx.tokens.calendar}` });
      }
      const id = decodeURIComponent(rest.slice(1));
      fx.gets.push(`event:primary:${id}`);
      const found = fx.events.get(id);
      return found ? json(found) : json({ error: { code: 404, message: 'Not Found' } }, 404);
    }
    return gmail(url);
  }, ACCOUNT);
}

const contactSlug = (p: Person) => personSlugFromContact({ resourceName: p.resourceName, displayName: p.names[0]!.displayName, emails: [], phones: [],
  organization: null, title: null, groups: [], deleted: false })!;
const eventRelPath = (ev: Ev) => calendarRelPath({ id: ev.id, startIso: ev.start.dateTime, summary: ev.summary } as never);

interface GoogleSource { id: string; dir: string; managed: boolean; run: (fx: FakeGoogle, engine?: BrainEngine) => ReturnType<typeof runGoogleSync> }

/** A Google source on the brain: managed (the brain's coordinator writes its pages) or unmanaged (pages land under its directory). */
async function googleSource(engine: BrainEngine, root: string, managed: boolean): Promise<GoogleSource> {
  const id = `google-${Math.random().toString(16).slice(2, 10)}`;
  const dir = join(root, '..', id);
  mkdirSync(dir);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)', [id, dir, JSON.stringify(CONFIG)]);
  if (managed) await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const cfg = parseGoogleSourceConfig(CONFIG, dir);
  return { id, dir, managed, run: async (fx, using = engine) => {
    try { return await runGoogleSync(using, id, cfg, options, googleFetch(fx)); } finally { await disposePersistenceConsumer(engine); }
  } };
}

/** The contacts and calendar sync tokens the source's committed cursor carries. */
async function tokens(engine: BrainEngine, f: GoogleSource): Promise<{ contacts: string | null; calendar: string | null }> {
  const state = f.managed
    ? ((await sourceCheckpoint(engine, f.id)) as Array<{ completed_keys?: Array<{ state?: Record<string, unknown> }> }>)[0]?.completed_keys?.[0]?.state ?? {}
    : readGoogleState(f.dir) as unknown as Record<string, unknown>;
  return { contacts: (state.contacts_sync_token as string | null | undefined) ?? null, calendar: (state.calendar_sync_token as string | null | undefined) ?? null };
}

const held = async (engine: BrainEngine, id: string) => ((await readAllSourceHolds(engine, { sourceIds: [id] }))[0]?.held ?? [])
  .map(record => ({ key: record.key, code: record.code })).sort((a, b) => a.key.localeCompare(b.key));
const live = async (engine: BrainEngine, id: string, slug: string) => (await engine.executeRaw(
  'SELECT 1 FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [id, slug])).length === 1;

/** A clean first sweep: two contacts, two events, one Gmail thread; both sync tokens committed. */
async function seeded(engine: BrainEngine, root: string, managed: boolean) {
  const f = await googleSource(engine, root, managed);
  const fx = fakeGoogle();
  const [c1, c3] = [person('people/c1', 'Alice Example'), person('people/c3', 'Carol Example')];
  const [e1, e3] = [event('e1', 1, 'Planning example'), event('e3', 3, 'Review example')];
  for (const p of [c1, c3]) fx.contacts.set(p.resourceName, p);
  for (const ev of [e1, e3]) fx.events.set(ev.id, ev);
  addThread(fx.gmail, 'a1b2c3d4e5f60001', Date.now() - 3_600_000);
  expect((await f.run(fx)).status).not.toBe('partial');
  return { f, fx, c1, c3, e1, e3 };
}

const HELD_THEN_DELETED = ['contact:people/c1', 'event:primary:e1'];

/**
 * A materialized contact and event go bad upstream and are held with their old pages in place; then the provider deletes
 * both, and the delta that names the deletions (a contact tombstone, a cancelled event) passes while they are held.
 */
async function heldThenDeleted(engine: BrainEngine, root: string, managed: boolean) {
  const seed = await seeded(engine, root, managed);
  const { f, fx, c1, e1 } = seed;
  putContact(fx, person('people/c1', 'Alice Example', undefined, 'alice.example\u0000@example.invalid'));
  putEvent(fx, event('e1', 1, 'Planning example', '', 'guest\u0000@example.invalid'));
  for (let run = 0; run < 4; run++) await expectUnitNotAborted(() => f.run(fx));
  expect((await held(engine, f.id)).map(h => h.key)).toEqual(HELD_THEN_DELETED);
  fx.contacts.delete(c1.resourceName);
  fx.events.delete(e1.id);
  fx.contactDelta = [c1.resourceName];
  fx.eventDelta = [e1.id];
  expect((await expectUnitNotAborted(() => f.run(fx))).status).not.toBe('partial');
  fx.contactDelta = [];
  fx.eventDelta = [];
  expect((await held(engine, f.id)).map(h => h.key)).toEqual(HELD_THEN_DELETED);
  expect(await live(engine, f.id, slugifyPath(`${contactSlug(c1)}.md`))).toBe(true);
  expect(await live(engine, f.id, slugifyPath(eventRelPath(e1)))).toBe(true);
  return seed;
}

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`A-3 google contacts and calendar (${backend})`, () => {
    for (const managed of [false, true]) {
      const mode = managed ? 'managed' : 'unmanaged';
      test(`item (${mode}): a failing contact and a failing event are counted, then held; their siblings and Gmail land, and each sync token commits once only held items remain`,
        async () => withEnv(ENV, () => managedBrain(async ({ engine, root }) => {
          const { f, fx, c1, e1 } = await seeded(engine, root, managed);
          const seededTokens = await tokens(engine, f);
          const before = await snapshotItems(engine, f.id);
          // Upstream: one bad new item and one healthy edit per service (the bad one listed first), plus new mail.
          putContact(fx, badContact());
          putContact(fx, person('people/c1', 'Alice Example', 'Acme Example'));
          putEvent(fx, badEvent());
          putEvent(fx, event('e1', 1, 'Planning example', 'An agenda.'));
          addThread(fx.gmail, 'a1b2c3d4e5f60002', Date.now() - 600_000);
          fx.gmail.history = ['a1b2c3d4e5f60002'];
          fx.gmail.historyResponseId = '101';
          const runs = [];
          for (let run = 0; run < 3; run++) runs.push(await expectUnitNotAborted(() => f.run(fx)));
          expect(runs.map(r => r.status)).toEqual(['partial', 'partial', 'partial']);
          expect(await tokens(engine, f)).toEqual(seededTokens);
          expectOthersUnchanged(before, await snapshotItems(engine, f.id),
            { expectProgress: [slugifyPath(`${contactSlug(c1)}.md`), slugifyPath(eventRelPath(e1))], progressFields: ['content_hash'] });
          const mail = await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE source_id=$1 AND frontmatter->>'thread_id'=$2", [f.id, 'a1b2c3d4e5f60002']);
          expect(mail).toHaveLength(1);
          const holds = await held(engine, f.id);
          for (const key of BAD_KEYS) expectItemFailure(holds.find(h => h.key === key), { key, code: 'invalid_connector_text' });
          expect(holds).toHaveLength(2);
          // Only held items remain: the next run completes and both tokens move past them.
          const fourth = await expectUnitNotAborted(() => f.run(fx));
          expect(fourth.status).not.toBe('partial');
          expect(fourth.connectorHolds).toMatchObject({ held: 2, retry_command: `gbrain sources retry-held ${f.id}` });
          const moved = await tokens(engine, f);
          expect(moved.contacts).not.toBe(seededTokens.contacts);
          expect(moved.calendar).not.toBe(seededTokens.calendar);
        }, { databaseUrl })), 240_000);

      test(`recovery (${mode}): retry-held re-fetches the held contact and event directly with no upstream edit; a re-attempt that still fails stays held without pinning a token`,
        async () => withEnv(ENV, () => managedBrain(async ({ engine, root }) => {
          const { f, fx } = await seeded(engine, root, managed);
          putContact(fx, badContact());
          putEvent(fx, badEvent());
          for (let run = 0; run < 4; run++) await expectUnitNotAborted(() => f.run(fx));
          expect((await held(engine, f.id)).map(h => h.key)).toEqual(BAD_KEYS);
          const heldTokens = await tokens(engine, f);
          // Upstream is unchanged, so no delta lists the items again: only a direct fetch reaches them.
          fx.contactDelta = [];
          fx.eventDelta = [];
          expect((await retryHeld(engine, f.id)).scheduled).toBe(2);
          fx.gets.length = 0;
          const retried = await expectUnitNotAborted(() => f.run(fx));
          expect(fx.gets.sort()).toEqual(BAD_KEYS);
          expect(retried.status).not.toBe('partial');
          expect((await held(engine, f.id)).map(h => h.key)).toEqual(BAD_KEYS);
          // Consumed: the next run re-fetches nothing, and the tokens keep moving.
          fx.gets.length = 0;
          await f.run(fx);
          expect(fx.gets).toEqual([]);
          expect((await tokens(engine, f)).contacts).not.toBe(heldTokens.contacts);
          // The provider fixes the items; a direct re-fetch now lands them and clears the holds.
          fx.contacts.set('people/c2', person('people/c2', 'Bob Example'));
          fx.events.set('e2', event('e2', 2, 'Standup example', '', 'guest@example.invalid'));
          await retryHeld(engine, f.id);
          await expectUnitNotAborted(() => f.run(fx));
          expect(await held(engine, f.id)).toEqual([]);
          expect(await live(engine, f.id, slugifyPath(`${contactSlug(badContact())}.md`))).toBe(true);
          expect(await live(engine, f.id, slugifyPath(eventRelPath(badEvent())))).toBe(true);
        }, { databaseUrl })), 240_000);

      test(`deleted while held (${mode}): retry-held finds the held contact and event gone upstream and retires the pages they materialized before clearing the holds`,
        async () => withEnv(ENV, () => managedBrain(async ({ engine, root }) => {
          const { f, fx, c1, e1 } = await heldThenDeleted(engine, root, managed);
          const slugs = [slugifyPath(`${contactSlug(c1)}.md`), slugifyPath(eventRelPath(e1))];
          const before = await snapshotItems(engine, f.id);
          const heldTokens = await tokens(engine, f);
          expect((await retryHeld(engine, f.id)).scheduled).toBe(2);
          fx.gets.length = 0;
          const retried = await expectUnitNotAborted(() => f.run(fx));
          expect(fx.gets.sort()).toEqual(HELD_THEN_DELETED);
          expect(retried.status).not.toBe('partial');
          expect({ held: await held(engine, f.id), live: await Promise.all(slugs.map(slug => live(engine, f.id, slug))) }).toEqual({ held: [], live: [false, false] });
          if (!managed) expect([contactSlug(c1) + '.md', eventRelPath(e1)].map(rel => existsSync(join(f.dir, rel)))).toEqual([false, false]);
          expectOthersUnchanged(before, await snapshotItems(engine, f.id), { changed: slugs });
          const moved = await tokens(engine, f);
          expect([moved.contacts === heldTokens.contacts, moved.calendar === heldTokens.calendar]).toEqual([false, false]);
        }, { databaseUrl })), 240_000);
    }

    test('deleted while held, refused (unmanaged): a held item whose page deletion is refused keeps its hold with the refusal code and its page, and clears once the deletion lands',
      async () => withEnv(ENV, () => managedBrain(async ({ engine, root }) => {
        const { f, fx, c1, e1 } = await heldThenDeleted(engine, root, false);
        const slugs = [slugifyPath(`${contactSlug(c1)}.md`), slugifyPath(eventRelPath(e1))];
        const refusing = new Proxy(engine, { get(target_, key) {
          const value = (target_ as unknown as Record<string | symbol, unknown>)[key];
          if (key === 'deletePages') return async () => { throw new OperationError('page_identity_changed', 'refused by the probe', 'none'); };
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target_) : value;
        } });
        await retryHeld(engine, f.id);
        expect((await expectUnitNotAborted(() => f.run(fx, refusing))).status).not.toBe('partial');
        const holds = await held(engine, f.id);
        for (const key of HELD_THEN_DELETED) expectItemFailure(holds.find(h => h.key === key), { key, code: 'page_identity_changed' });
        expect(holds).toHaveLength(2);
        expect(await Promise.all(slugs.map(slug => live(engine, f.id, slug)))).toEqual([true, true]);
        await retryHeld(engine, f.id);
        await expectUnitNotAborted(() => f.run(fx));
        expect({ held: await held(engine, f.id), live: await Promise.all(slugs.map(slug => live(engine, f.id, slug))) }).toEqual({ held: [], live: [false, false] });
      }, { databaseUrl })), 240_000);

    test('transient (unmanaged): a stale .tmp directory fails one contact and one event; siblings and Gmail land, the tokens wait, nothing is held, and clearing it lands both',
      async () => withEnv(ENV, () => managedBrain(async ({ engine, root }) => {
        const { f, fx, c1, e1 } = await seeded(engine, root, false);
        const seededTokens = await tokens(engine, f);
        const before = await snapshotItems(engine, f.id);
        const bob = person('people/c2', 'Bob Example');
        const standup = event('e2', 2, 'Standup example');
        const obstructions = [join(f.dir, `${contactSlug(bob)}.md.tmp`), join(f.dir, `${eventRelPath(standup)}.tmp`)];
        for (const dir of obstructions) mkdirSync(dir, { recursive: true });
        putContact(fx, bob);
        putContact(fx, person('people/c1', 'Alice Example', 'Acme Example'));
        putEvent(fx, standup);
        putEvent(fx, event('e1', 1, 'Planning example', 'An agenda.'));
        addThread(fx.gmail, 'a1b2c3d4e5f60002', Date.now() - 600_000);
        fx.gmail.history = ['a1b2c3d4e5f60002'];
        fx.gmail.historyResponseId = '101';
        for (let run = 0; run < 3; run++) expect((await expectUnitNotAborted(() => f.run(fx))).status).toBe('partial');
        expectOthersUnchanged(before, await snapshotItems(engine, f.id),
          { expectProgress: [slugifyPath(`${contactSlug(c1)}.md`), slugifyPath(eventRelPath(e1))], progressFields: ['content_hash'] });
        expect(await engine.executeRaw("SELECT 1 FROM pages WHERE source_id=$1 AND frontmatter->>'thread_id'=$2", [f.id, 'a1b2c3d4e5f60002'])).toHaveLength(1);
        expect(await tokens(engine, f)).toEqual(seededTokens);
        expect(await held(engine, f.id)).toEqual([]);
        for (const dir of obstructions) rmSync(dir, { recursive: true });
        expect((await expectUnitNotAborted(() => f.run(fx))).status).not.toBe('partial');
        expect(await live(engine, f.id, slugifyPath(`${contactSlug(bob)}.md`))).toBe(true);
        expect(await live(engine, f.id, slugifyPath(eventRelPath(standup)))).toBe(true);
        expect((await tokens(engine, f)).contacts).not.toBe(seededTokens.contacts);
      }, { databaseUrl })), 240_000);

    const targets = [
      { title: 'run: a run-scoped failure inside a contact stops the sweep and records no hold', lookup: "frontmatter->>'google_contact_id' = $2", id: 'people/c3', token: 'contacts' as const,
        edit: (fx: FakeGoogle) => { putContact(fx, person('people/c1', 'Alice Example', 'Acme Example')); putContact(fx, person('people/c3', 'Carol Example', 'Acme Example')); },
        slug: (s: Awaited<ReturnType<typeof seeded>>) => slugifyPath(`${contactSlug(s.c3)}.md`) },
      { title: 'run: a run-scoped failure inside an event stops the sweep and records no hold', lookup: "frontmatter->>'event_id' = $2", id: 'e3', token: 'calendar' as const,
        edit: (fx: FakeGoogle) => { putEvent(fx, event('e1', 1, 'Planning example', 'An agenda.')); putEvent(fx, event('e3', 3, 'Review example', 'An agenda.')); },
        slug: (s: Awaited<ReturnType<typeof seeded>>) => slugifyPath(eventRelPath(s.e3)) },
    ];
    for (const target of targets) for (const injected of runScopedErrors()) {
      test(`${target.title} (${injected.name})`,
        async () => withEnv(ENV, () => managedBrain(async ({ engine, root }) => {
          const seed = await seeded(engine, root, true);
          const { f, fx } = seed;
          const seededTokens = await tokens(engine, f);
          const before = await snapshotItems(engine, f.id);
          target.edit(fx);
          const error = injected.error();
          const failing = new Proxy(engine, { get(target_, key) {
            const value = (target_ as unknown as Record<string | symbol, unknown>)[key];
            if (key === 'executeRaw') return async (sql: string, params?: unknown[]) => {
              if (sql.includes(target.lookup) && params?.[1] === target.id) throw error;
              return (value as (...a: unknown[]) => unknown).call(target_, sql, params);
            };
            return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target_) : value;
          } });
          for (let run = 0; run < 3; run++) {
            const outcome = await f.run(fx, failing).then(r => r.status, (e: unknown) => e);
            expect(outcome === error || outcome === 'partial').toBe(true);
          }
          expect(await held(engine, f.id)).toEqual([]);
          expect((await tokens(engine, f))[target.token]).toBe(seededTokens[target.token]);
          expect((await snapshotItems(engine, f.id)).get(target.slug(seed))).toEqual(before.get(target.slug(seed)));
        }, { databaseUrl })), 240_000);
    }

    test('breaker: when most contacts fail the same way at once the run is an outage and holds nothing', async () => withEnv(ENV, () => managedBrain(async ({ engine, root }) => {
      const { f, fx } = await seeded(engine, root, false);
      const seededTokens = await tokens(engine, f);
      for (let n = 4; n < 10; n++) putContact(fx, person(`people/c${n}`, `Person${String.fromCharCode(97 + n)} Example`, undefined, `p${n}\u0000@example.invalid`));
      for (let run = 0; run < 3; run++) expect((await expectUnitNotAborted(() => f.run(fx))).status).toBe('partial');
      expect(await held(engine, f.id)).toEqual([]);
      expect((await tokens(engine, f)).contacts).toBe(seededTokens.contacts);
    }, { databaseUrl })), 240_000);
  });
}
