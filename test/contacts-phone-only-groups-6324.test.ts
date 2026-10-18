/**
 * #6324: Google contacts carry phone numbers and contact groups; the contacts
 * cursor is bound to the field mask that minted it.
 *
 * Client: `CONTACT_PERSON_FIELDS` on every request (identical across pages),
 * E.164 phones, user groups without the system ones, a non-expiry 400 on a
 * syncToken request typed as `GoogleSyncTokenRejectedError`, and a bounded
 * `contactGroups` directory walk that says when it is incomplete.
 * Render: phone-only pages (nameless ones at `contact-<sha8>`), `phones:` and
 * `groups:` frontmatter, email-only pages unchanged.
 * Sweep: token and mask commit together after success only; a changed mask
 * forces one full list; expired or rejected tokens get one full-list attempt;
 * tokenless success never leaves a token the mask does not cover; the
 * tombstone of a nameless phone contact removes its page; the group directory
 * is read only when needed and degrades to the cache or raw ids.
 */
import { describe, expect, test } from 'bun:test';

import { CredentialError } from '../src/core/creds/errors.ts';
import { CONTACT_PERSON_FIELDS, GoogleSyncTokenRejectedError, PeopleClient } from '../src/core/google/google-clients.ts';
import { contactIdSlug, personSlugFromContact, renderPersonPage, sha8 } from '../src/core/google/google-render.ts';
import { sweepContacts } from '../src/core/google/people-calendar-sweep.ts';
import type { GoogleSyncDeps, GoogleSyncSummary } from '../src/core/google/sweep-shared.ts';
import type { ContactData, GoogleSourceState } from '../src/core/google/types.ts';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const tokens = { getAccessToken: async () => 'token', forceRefresh: async () => 'token' };

function fakePeople(handler: (u: URL, n: number) => Response | Promise<Response>) {
  const calls: URL[] = [];
  const people = new PeopleClient(tokens, async (url) => {
    const u = new URL(String(url));
    calls.push(u);
    return handler(u, calls.length);
  });
  return { people, calls };
}

function person(id: string, over: Record<string, unknown> = {}) {
  return { resourceName: `people/${id}`, ...over };
}

function contact(over: Partial<ContactData> = {}): ContactData {
  return { resourceName: 'people/c1', displayName: 'Bob Example', emails: [], phones: ['+15550100'], organization: null, title: null, groups: [], deleted: false, ...over };
}

const SYSTEM = [{ contactGroupMembership: { contactGroupResourceName: 'contactGroups/myContacts' } }, { contactGroupMembership: { contactGroupResourceName: 'contactGroups/starred' } }];
const USER_GROUP = { contactGroupMembership: { contactGroupResourceName: 'contactGroups/abc123' } };

// ── PeopleClient ─────────────────────────────────────────────────────────────

describe('PeopleClient (#6324)', () => {
  test('asks for phones and memberships; maps E.164 phones and user groups; drops system groups', async () => {
    const { people, calls } = fakePeople(() => json({
      connections: [person('c1', {
        names: [{ displayName: 'Bob Example' }],
        phoneNumbers: [{ value: '(555) 010-0', canonicalForm: '+15550100' }, { value: '+15550100' }, { value: ' 555 0101 ' }, { value: '' }],
        memberships: [...SYSTEM, USER_GROUP, USER_GROUP],
      })],
      nextSyncToken: 'ppl-1',
    }));
    const { contacts } = await people.listConnections({});
    expect(CONTACT_PERSON_FIELDS).toBe('names,emailAddresses,organizations,phoneNumbers,memberships');
    expect(calls[0].searchParams.get('personFields')).toBe(CONTACT_PERSON_FIELDS);
    expect(contacts[0].phones).toEqual(['+15550100', '555 0101']);
    expect(contacts[0].groups).toEqual([{ id: 'contactGroups/abc123', name: null }]);
  });

  test('every page of a list repeats the same parameters, the syncToken included', async () => {
    const { people, calls } = fakePeople((u) => u.searchParams.has('pageToken')
      ? json({ connections: [], nextSyncToken: 'ppl-2' })
      : json({ connections: [], nextPageToken: 'page-2' }));
    expect((await people.listConnections({ syncToken: 'ppl-1' })).nextSyncToken).toBe('ppl-2');
    expect(calls).toHaveLength(2);
    for (const key of ['personFields', 'pageSize', 'requestSyncToken', 'syncToken']) {
      expect(calls[1].searchParams.get(key)).toBe(calls[0].searchParams.get(key));
    }
    expect(calls[0].searchParams.get('syncToken')).toBe('ppl-1');
    expect(calls[1].searchParams.get('pageToken')).toBe('page-2');
  });

  test('a non-expiry 400 on a syncToken request is typed as rejected and stays a CredentialError; the same 400 on a full list is a plain upstream error', async () => {
    const { people } = fakePeople(() => json({ error: { code: 400, message: 'Request parameters do not match the sync token.' } }, 400));
    let withToken: unknown;
    await people.listConnections({ syncToken: 'old' }).catch((e) => { withToken = e; });
    expect(withToken).toBeInstanceOf(GoogleSyncTokenRejectedError);
    expect(withToken).toBeInstanceOf(CredentialError);
    expect((withToken as CredentialError).code).toBe('upstream');
    let full: unknown;
    await people.listConnections({ syncToken: null }).catch((e) => { full = e; });
    expect(full).toBeInstanceOf(CredentialError);
    expect(full).not.toBeInstanceOf(GoogleSyncTokenRejectedError);
  });

  test('listContactGroups walks pages, drops system groups, and reports an incomplete directory', async () => {
    const paged = fakePeople((u) => u.searchParams.has('pageToken')
      ? json({ contactGroups: [{ resourceName: 'contactGroups/def456', name: 'Portfolio', groupType: 'USER_CONTACT_GROUP' }] })
      : json({ contactGroups: [
        { resourceName: 'contactGroups/abc123', formattedName: 'Investors', groupType: 'USER_CONTACT_GROUP' },
        { resourceName: 'contactGroups/myContacts', name: 'myContacts', groupType: 'SYSTEM_CONTACT_GROUP' },
      ], nextPageToken: 'g2' }));
    expect(await paged.people.listContactGroups()).toEqual({ names: { 'contactGroups/abc123': 'Investors', 'contactGroups/def456': 'Portfolio' }, complete: true });
    expect(paged.calls).toHaveLength(2);
    expect(paged.calls[0].pathname).toBe('/v1/contactGroups');
    expect(paged.calls[0].searchParams.get('groupFields')).toBe('name,groupType');

    const endless = fakePeople((_u, n) => json({ contactGroups: [{ resourceName: `contactGroups/g${n}`, name: `Group ${n}` }], nextPageToken: `g${n + 1}` }));
    const result = await endless.people.listContactGroups();
    expect(result.complete).toBe(false);
    expect(endless.calls).toHaveLength(10);
    expect(Object.keys(result.names)).toHaveLength(10);
  });
});

// ── Render ───────────────────────────────────────────────────────────────────

describe('renderPersonPage (#6324)', () => {
  test('a named phone-only contact renders with phones: frontmatter and no phone alias', () => {
    const page = renderPersonPage(contact({ phones: ['+15550100', '+15550101'] }));
    expect(page?.relPath).toBe('people/bob-example.md');
    const md = page!.markdown;
    expect(md).toContain('title: "Bob Example"');
    expect(md).toContain('emails: []');
    expect(md).toContain('phones: \n  - "+15550100"\n  - "+15550101"');
    expect(md).toContain('aliases: \n  - "Bob Example"\n');
    expect(md.match(/^aliases: \n((?:  - .*\n)+)/m)![1]).not.toContain('+1555');
    expect(md).toContain('Contact: +15550100, +15550101. [Source: Google Contacts]');
  });

  test('a nameless phone-only contact lands at contact-<sha8> (id-keyed, never phone digits), disambiguation or not', () => {
    const c = contact({ displayName: null, resourceName: 'people/c9' });
    const slug = `people/contact-${sha8('people/c9')}`;
    expect(contactIdSlug('people/c9')).toBe(slug);
    expect(personSlugFromContact(c)).toBe(slug);
    expect(personSlugFromContact(c, true)).toBe(slug);
    expect(renderPersonPage(c)?.relPath).toBe(`${slug}.md`);
    expect(renderPersonPage(c)!.markdown).toContain('title: "+15550100"');
    expect(personSlugFromContact(contact({ displayName: null, phones: [] }))).toBeNull();
    expect(renderPersonPage(contact({ phones: [] }))).toBeNull();
  });

  test('email-only pages carry neither phones: nor groups:; group names render and an unresolved group keeps its id', () => {
    const emailOnly = renderPersonPage(contact({ emails: ['bob@example.com'], phones: [] }))!.markdown;
    expect(emailOnly).not.toContain('phones:');
    expect(emailOnly).not.toContain('groups:');
    expect(emailOnly).toContain('Contact: bob@example.com.');
    const grouped = renderPersonPage(contact({ groups: [{ id: 'contactGroups/abc123', name: 'Investors' }, { id: 'contactGroups/zzz', name: null }] }))!.markdown;
    expect(grouped).toContain('groups: \n  - "Investors"\n  - "contactGroups/zzz"\n---');
  });
});

// ── Sweep ────────────────────────────────────────────────────────────────────

interface StoredPage { slug: string; source_path: string; contact_id: string | null; markdown: string }

function harness(state: Partial<GoogleSourceState> = {}, opts: { idLookup?: boolean; onImport?: (relPath: string) => void } = {}) {
  const pages = new Map<string, StoredPage>();
  const log: string[] = [];
  const controller = new AbortController();
  const managed = {
    async page(slug: string) {
      const p = pages.get(slug);
      return p ? { frontmatter: p.contact_id ? { google_contact_id: p.contact_id } : {} } : null;
    },
    async importMarkdown(source_path: string, markdown: string) {
      opts.onImport?.(source_path);
      const slug = source_path.replace(/\.md$/, '');
      const created = !pages.has(slug);
      pages.set(slug, { slug, source_path, contact_id: markdown.match(/^google_contact_id: "([^"]+)"/m)?.[1] ?? null, markdown });
      return { slug, chunks: 0, status: 'imported' as const, created };
    },
    async delete(slug: string) { return pages.delete(slug); },
  };
  const engine = {
    async executeRaw(sql: string, params: unknown[]) {
      if (sql.includes("frontmatter->>'google_contact_id'")) {
        if (opts.idLookup === false) return [];
        return [...pages.values()].filter((p) => p.contact_id === params[1]).map((p) => ({ source_path: p.source_path }));
      }
      if (sql.includes('source_path = $2')) return [...pages.values()].filter((p) => p.source_path === params[1]).map((p) => ({ slug: p.slug }));
      return [];
    },
  };
  const full: GoogleSourceState = { gmail_history_id: null, gmail_backfill_floor_ms: null, gmail_backfill_done: false, gmail_newest_ms: null,
    calendar_sync_token: null, contacts_sync_token: null, last_full_at: null, ...state };
  const summary: GoogleSyncSummary = { status: 'synced', added: 0, modified: 0, deleted: 0, chunksCreated: 0, embedded: 0, pagesAffected: [], threadsSeen: 0,
    attachmentInspection: {}, extractEligibility: {}, loopsWithheld: {}, failedFiles: 0 };
  const run = (people: PeopleClient, syncOpts: { full?: boolean } = {}) => {
    const deps = { managed, engine, sourceId: 'g', cfg: { dir: '/nonexistent/google', contactsDir: 'people', account: 'owner@example.invalid' },
      opts: { ...syncOpts, signal: controller.signal }, entry: { meta: {} }, log: (m: string) => log.push(m), tick: () => {}, exclusion: {}, extractCandidates: [], processedThreads: new Set() };
    return sweepContacts(deps as unknown as GoogleSyncDeps, people, full, undefined, summary, new Set());
  };
  return { pages, log, state: full, summary, controller, run, seed(page: StoredPage) { pages.set(page.slug, page); } };
}

const BOB = person('c1', { names: [{ displayName: 'Bob Example' }], phoneNumbers: [{ canonicalForm: '+15550100' }], memberships: [USER_GROUP] });
const NAMELESS = person('c9', { phoneNumbers: [{ canonicalForm: '+15550199' }] });

/** A People fake: full lists return `all`, syncToken lists return `delta` (or an error), the directory names one group. */
function peopleFake(all: unknown[], o: { delta?: unknown[] | ((u: URL) => Response); token?: string | null; groups?: (u: URL) => Response } = {}) {
  return fakePeople((u) => {
    if (u.pathname === '/v1/contactGroups') return o.groups ? o.groups(u) : json({ contactGroups: [{ resourceName: 'contactGroups/abc123', name: 'Investors' }] });
    if (u.searchParams.has('syncToken')) {
      if (typeof o.delta === 'function') return o.delta(u);
      return json({ connections: o.delta ?? [], nextSyncToken: o.token === undefined ? 'ppl-delta' : o.token });
    }
    return json(o.token === undefined ? { connections: all, nextSyncToken: 'ppl-1' } : o.token === null ? { connections: all } : { connections: all, nextSyncToken: o.token });
  });
}

describe('sweepContacts cursor contract (#6324)', () => {
  test('a legacy token (no recorded mask) is not reused: one full list, then token and mask commit together and the next sweep is incremental', async () => {
    const h = harness({ contacts_sync_token: 'legacy-token' });
    const { people, calls } = peopleFake([BOB]);
    await h.run(people);
    const listCalls = () => calls.filter((u) => u.pathname.endsWith('/connections'));
    expect(listCalls()).toHaveLength(1);
    expect(listCalls()[0].searchParams.has('syncToken')).toBe(false);
    expect(h.log).toContain('[google] contacts field mask changed; full re-list');
    expect(h.state.contacts_sync_token).toBe('ppl-1');
    expect(h.state.contacts_person_fields).toBe(CONTACT_PERSON_FIELDS);
    expect(h.pages.get('people/bob-example')!.markdown).toContain('groups: \n  - "Investors"');
    await h.run(people);
    expect(listCalls()[1].searchParams.get('syncToken')).toBe('ppl-1');
    expect(h.state.contacts_sync_token).toBe('ppl-delta');
  });

  test('an abort mid-sweep and an import failure both commit neither token nor mask', async () => {
    const aborted = harness({ contacts_sync_token: 'legacy-token' }, { onImport: () => aborted.controller.abort() });
    await aborted.run(peopleFake([BOB, NAMELESS]).people);
    expect(aborted.pages.size).toBe(1);
    expect(aborted.state.contacts_sync_token).toBe('legacy-token');
    expect(aborted.state.contacts_person_fields).toBeUndefined();

    const failing = harness({ contacts_sync_token: 'legacy-token' }, { onImport: () => { throw new Error('fixture import outage'); } });
    await expect(failing.run(peopleFake([BOB]).people)).rejects.toThrow('fixture import outage');
    expect(failing.state.contacts_sync_token).toBe('legacy-token');
    expect(failing.state.contacts_person_fields).toBeUndefined();
  });

  test('an expired token re-lists once and commits the replacement', async () => {
    const h = harness({ contacts_sync_token: 'stale', contacts_person_fields: CONTACT_PERSON_FIELDS });
    const { people, calls } = peopleFake([BOB], { delta: () => json({ error: { code: 400, message: 'Sync token is expired.' } }, 400) });
    await h.run(people);
    expect(calls.filter((u) => u.pathname.endsWith('/connections')).map((u) => u.searchParams.get('syncToken'))).toEqual(['stale', null]);
    expect(h.log).toContain('[google] contacts syncToken expired; full re-list');
    expect(h.state.contacts_sync_token).toBe('ppl-1');
  });

  test('an unrelated 400 on a syncToken request gets exactly one full-list attempt; a second failure propagates and blesses nothing', async () => {
    const recovered = harness({ contacts_sync_token: 'mismatch', contacts_person_fields: CONTACT_PERSON_FIELDS });
    const once = peopleFake([BOB], { delta: () => json({ error: { code: 400, message: 'Request parameters do not match the sync token.' } }, 400) });
    await recovered.run(once.people);
    expect(once.calls.filter((u) => u.pathname.endsWith('/connections'))).toHaveLength(2);
    expect(recovered.log).toContain('[google] contacts syncToken rejected (HTTP 400); one full re-list');
    expect(recovered.state.contacts_sync_token).toBe('ppl-1');

    const wedged = harness({ contacts_sync_token: 'mismatch', contacts_person_fields: CONTACT_PERSON_FIELDS });
    const always = fakePeople(() => json({ error: { code: 400, message: 'Invalid personFields' } }, 400));
    await expect(wedged.run(always.people)).rejects.toBeInstanceOf(CredentialError);
    expect(always.calls.map((u) => u.searchParams.get('syncToken'))).toEqual(['mismatch', null]);
    expect(wedged.state.contacts_sync_token).toBeNull();
    expect(wedged.pages.size).toBe(0);
  });

  test('tokenless success: a changed mask leaves no cursor so the next sweep lists fully again; an unchanged mask keeps the token it had', async () => {
    const changed = harness({ contacts_sync_token: 'legacy-token' });
    const silent = peopleFake([BOB], { token: null });
    await changed.run(silent.people);
    expect(changed.state.contacts_sync_token).toBeNull();
    expect(changed.state.contacts_person_fields).toBe(CONTACT_PERSON_FIELDS);
    await changed.run(silent.people);
    expect(silent.calls.filter((u) => u.pathname.endsWith('/connections')).every((u) => !u.searchParams.has('syncToken'))).toBe(true);

    const same = harness({ contacts_sync_token: 'ppl-1', contacts_person_fields: CONTACT_PERSON_FIELDS });
    await same.run(peopleFake([BOB], { token: null }).people, { full: true });
    expect(same.state.contacts_sync_token).toBe('ppl-1');
  });

  test('a nameless phone contact lands at contact-<sha8>; its bare tombstone removes that page even when the id lookup misses', async () => {
    const h = harness({}, { idLookup: false });
    const slug = contactIdSlug('people/c9');
    await h.run(peopleFake([NAMELESS]).people);
    expect([...h.pages.keys()]).toEqual([slug]);
    expect(h.pages.get(slug)!.markdown).toContain('phones: \n  - "+15550199"');
    await h.run(peopleFake([], { delta: [person('c9', { metadata: { deleted: true } })] }).people);
    expect(h.pages.size).toBe(0);
    expect(h.summary.deleted).toBe(1);
  });

  test('slug collision: a phone-only contact whose base slug another contact owns gets the disambiguated slug', async () => {
    const h = harness();
    h.seed({ slug: 'people/bob-example', source_path: 'people/bob-example.md', contact_id: 'people/other', markdown: '' });
    await h.run(peopleFake([BOB]).people);
    expect([...h.pages.keys()].sort()).toEqual(['people/bob-example', `people/bob-example-${sha8('people/c1')}`]);
    expect(h.pages.get('people/bob-example')!.contact_id).toBe('people/other');
  });

  test('group cache: the directory is read only when a listed contact has a user group; an unreadable directory falls back to the cache; an incomplete read says so and keeps raw ids', async () => {
    const plain = peopleFake([person('c2', { names: [{ displayName: 'Dana Example' }], emailAddresses: [{ value: 'dana@example.com' }], memberships: SYSTEM })]);
    await harness().run(plain.people);
    expect(plain.calls.some((u) => u.pathname === '/v1/contactGroups')).toBe(false);

    const cached = harness({ contact_groups: { 'contactGroups/abc123': 'Cached Investors' } });
    await cached.run(peopleFake([BOB], { groups: () => json({ error: { code: 400, message: 'fixture directory outage' } }, 400) }).people);
    expect(cached.pages.get('people/bob-example')!.markdown).toContain('groups: \n  - "Cached Investors"');
    expect(cached.log.some((l) => l.startsWith('[google] contact groups unavailable'))).toBe(true);
    expect(cached.state.contact_groups).toEqual({ 'contactGroups/abc123': 'Cached Investors' });

    const partial = harness({ contact_groups: { 'contactGroups/old': 'Old Group' } });
    const bobTwoGroups = person('c1', { names: [{ displayName: 'Bob Example' }], phoneNumbers: [{ canonicalForm: '+15550100' }],
      memberships: [USER_GROUP, { contactGroupMembership: { contactGroupResourceName: 'contactGroups/zzz' } }] });
    await partial.run(peopleFake([bobTwoGroups], { groups: (u) => json({ contactGroups: [{ resourceName: 'contactGroups/abc123', name: 'Investors' }], nextPageToken: `${u.searchParams.get('pageToken') ?? 'g'}1` }) }).people);
    expect(partial.pages.get('people/bob-example')!.markdown).toContain('groups: \n  - "Investors"\n  - "contactGroups/zzz"');
    expect(partial.log.some((l) => l.startsWith('[google] contact groups directory exceeds the bounded read'))).toBe(true);
    expect(partial.state.contact_groups).toEqual({ 'contactGroups/old': 'Old Group', 'contactGroups/abc123': 'Investors' });
  });
});
