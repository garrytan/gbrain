/**
 * apple-contacts source kind against a synthetic GBrain Helper Contacts route (test/helpers/apple-contacts-stub.ts: a
 * local HTTP server on 127.0.0.1 and a local SOCKS5 proxy; no network, no Mac, synthetic contacts only).
 *
 * Covers: the first run reads the whole snapshot page by page and saves the change cursor; later runs read changes
 * only, saving the cursor after each page; 410 starts a snapshot; upserts are idempotent; op:delete soft-deletes and the
 * page can be restored; absence from a snapshot deletes only when the snapshot says full:true; the delete floor (more
 * than 20%, or an empty snapshot) writes nothing; the helper's refusals and a down helper stop the run with their codes
 * after bounded retries; the token file is refused when unsafe and the token never leaves the authorization header;
 * the socks5h proxy resolves the helper's host name; exact email/phone matching links one person, reviews two and
 * leaves none alone; the person-page block carries company, job title and groups only, is rewritten in place, removed
 * when the match goes, and never touches a byte outside it; and on a brain with a Git checkout no contact reaches it.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { BrainEngine } from '../src/core/engine.ts';
import type { SyncOpts } from '../src/commands/sync.ts';
import { connectTemplateBrain } from './helpers/brain-template.ts';
import { options } from './helpers/connector-fixture.ts';
import { withEnv } from './helpers/with-env.ts';
import { ContactsStub, Socks5Stub, STUB_TOKEN, type StubContact } from './helpers/apple-contacts-stub.ts';
import { runAppleContactsSync } from '../src/core/apple-contacts/apple-contacts-source.ts';
import { parseAppleContactsSourceConfig, parseSocksProxy } from '../src/core/apple-contacts/source-config.ts';
import { appleContactsHelper, readAppleContactsToken, APPLE_CONTACTS_RETRY_DELAYS_MS } from '../src/core/apple/contacts-client.ts';
import { personBlockMarkers } from '../src/core/apple-contacts/person-block.ts';
import { canonicalPhone } from '../src/core/phone-key.ts';
import { connectorDbCursorKey, readConnectorDbCursor } from '../src/core/connectors/db-cursor.ts';
import { connectorIdentity } from '../src/core/persistence/connector-identity.ts';
import { listEntityIdentities } from '../src/core/entity-identity.ts';
import { readSyncStatus } from '../src/core/persistence/sync-status.ts';
import { runDedupe } from '../src/commands/dedupe.ts';
import { addSource } from '../src/core/sources-ops.ts';
import { parseSourceLifecycleArgs } from '../src/commands/sources-lifecycle-args.ts';
import { isOwnerOnlySourceConfig } from '../src/core/access/owner-only.ts';
import { importFromContent } from '../src/core/import-file.ts';

const ALICE: StubContact = {
  given_name: 'Alice', family_name: 'Example', organization: 'Acme Example', job_title: 'Engineer',
  emails: [{ label: '_$!<Work>!$_', value: 'alice@example.invalid' }, { label: '_$!<Home>!$_', value: 'alice.home@example.invalid' }],
  phones: [{ label: '_$!<Mobile>!$_', value: '(555) 555-0100' }, { label: '_$!<Home>!$_', value: '555-555-0199' }],
  groups: ['Harbor Club'],
};
/** Values only the contact carries: none of them may ever reach a people/ page. */
const CONTACT_ONLY = ['alice.home@example.invalid', '5555550199', '555-0199'];
const PERSON_BODY = 'Alice runs the harbor project.\n\nMet at a conference in 2026.';
const contact = (n: number): StubContact => ({ given_name: `Person${n}`, family_name: 'Sample', emails: [{ label: null, value: `person${n}@example.invalid` }] });

let home: string;
let engine: BrainEngine;
let stub: ContactsStub;
let tokenFile: string;
beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-apple-contacts-'));
  engine = await connectTemplateBrain(join(home, 'database'));
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  tokenFile = join(home, 'contacts-token.json');
  writeFileSync(tokenFile, JSON.stringify({ accessToken: STUB_TOKEN }), { mode: 0o600 });
  chmodSync(tokenFile, 0o600);
}, 120_000);
afterAll(async () => { stub?.stop(); await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

let n = 0;
async function contactsSource(store: ContactsStub, extra: Record<string, unknown> = {}) {
  const id = `apple-contacts-${++n}`;
  const config = { kind: 'apple-contacts', ac_helper_host: '127.0.0.1', ac_helper_port: store.port, ac_token_file: tokenFile, owner_only: true, federated: false, ...extra };
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,NULL,$2::text::jsonb)', [id, JSON.stringify(config)]);
  return { id, cfg: parseAppleContactsSourceConfig(config) };
}
const freshStub = () => { stub?.stop(); stub = new ContactsStub().start(); return stub; };
const quiet = { log: () => {} };
const run = (id: string, cfg: ReturnType<typeof parseAppleContactsSourceConfig>, opts: Partial<SyncOpts> = {}, deps: Record<string, unknown> = {}) =>
  runAppleContactsSync(engine, id, cfg, { ...options, ...opts } as SyncOpts, { ...quiet, ...deps });
const contactPages = (sourceId: string) => engine.executeRaw<{ slug: string; id: string; body: string; fm: Record<string, unknown>; visibility: string | null; deleted: boolean }>(
  `SELECT slug, frontmatter->>'apple_contact_id' AS id, compiled_truth AS body, frontmatter AS fm, frontmatter->>'visibility' AS visibility, deleted_at IS NOT NULL AS deleted
   FROM pages WHERE source_id=$1 ORDER BY slug`, [sourceId]);
const live = async (sourceId: string) => (await contactPages(sourceId)).filter(p => !p.deleted);
async function savedCursor(sourceId: string): Promise<string | null> {
  const [s] = await engine.executeRaw<{ incarnation: string; local_path: string | null; config: Record<string, unknown> }>('SELECT incarnation::text AS incarnation,local_path,config FROM sources WHERE id=$1', [sourceId]);
  const key = connectorDbCursorKey(sourceId, s!.incarnation, connectorIdentity('apple-contacts', s!.config, s!.local_path));
  return ((await readConnectorDbCursor(engine, key)).state?.cursor as string | null | undefined) ?? null;
}
const personPage = (slug: string, frontmatter: Record<string, unknown>, sourceId = 'default', body = PERSON_BODY) =>
  engine.putPage(slug, { type: 'person', title: 'Alice Example', compiled_truth: body, timeline: '', frontmatter } as never, { sourceId } as never);
const bodyOf = async (slug: string, sourceId = 'default') =>
  (await engine.executeRaw<{ b: string }>('SELECT compiled_truth AS b FROM pages WHERE slug=$1 AND source_id=$2', [slug, sourceId]))[0]!.b;
const frontmatterOf = async (slug: string, sourceId = 'default') =>
  (await engine.executeRaw<{ fm: Record<string, unknown> }>('SELECT frontmatter AS fm FROM pages WHERE slug=$1 AND source_id=$2', [slug, sourceId]))[0]!.fm;
const versions = async (slug: string, sourceId = 'default') => (await engine.executeRaw<{ n: number }>(
  'SELECT count(*)::int AS n FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.slug=$1 AND p.source_id=$2', [slug, sourceId]))[0]!.n;
const outsideBlock = (body: string, sourceId: string) => {
  const m = personBlockMarkers(sourceId);
  const at = body.indexOf(m.begin);
  if (at < 0) return body;
  return body.slice(0, at).replace(/\n$/, '') + body.slice(body.indexOf(m.end) + m.end.length).replace(/^\n/, '');
};
async function deletePeople() { await engine.executeRaw(`DELETE FROM pages WHERE slug LIKE 'people/%'`); }

describe('phone keys', () => {
  test('a number is one canonical E.164-like key however it is written; ambiguous shapes are refused', () => {
    for (const raw of ['(555) 555-0100', '555-555-0100', '555.555.0100', '+1 555 555 0100', '1-555-555-0100', '001 555 555 0100', '011 1 555 555 0100', '555 555 0100 ext. 12', '555-555-0100 x12', '555-555-0100;123', '555-555-0100,,9']) {
      expect(canonicalPhone(raw)).toBe('+15555550100');
    }
    expect(canonicalPhone('+44 20 7946 0958')).toBe('+442079460958');
    expect(canonicalPhone('020 7946 0958', '44')).toBe('+442079460958');
    for (const bad of ['555-0100', '12345', 'call me', 'tel 555-555-0100', '+0 555 555 0100', '2 555 555 0100', '555 555 01OO', '']) expect(canonicalPhone(bad)).toBeNull();
  });
});

describe('config', () => {
  test('the proxy must be socks5h://host:port with no credentials; a stored bad proxy refuses instead of going direct', async () => {
    expect(parseSocksProxy('socks5h://127.0.0.1:1080')).toMatchObject({ host: '127.0.0.1', port: 1080 });
    expect(parseSocksProxy('socks5h://proxy.example.invalid:1055/')).toMatchObject({ url: 'socks5h://proxy.example.invalid:1055' });
    for (const bad of ['socks5h://user:pw@127.0.0.1:1080', 'socks5://127.0.0.1:1080', 'http://127.0.0.1:1080', 'socks5h://127.0.0.1', 'socks5h://127.0.0.1:99999']) {
      expect(parseSocksProxy(bad)).toBeNull();
    }
    const cfg = parseAppleContactsSourceConfig({ ac_helper_host: '127.0.0.1', ac_proxy: 'socks5h://user:pw@127.0.0.1:1080', ac_token_file: tokenFile });
    expect(() => appleContactsHelper({ sourceId: 'x', cfg, token: STUB_TOKEN })).toThrow(expect.objectContaining({ code: 'apple_contacts_config' }));
    expect(() => appleContactsHelper({ sourceId: 'x', cfg: { ...cfg, proxy: undefined, helperHost: '' }, token: STUB_TOKEN })).toThrow(expect.objectContaining({ code: 'apple_contacts_config' }));
  });

  test('sources add --kind apple-contacts registers an owner-only, database-record source pulled every 15 minutes', async () => {
    const { params } = parseSourceLifecycleArgs(['add', 'contacts-mac', '--kind', 'apple-contacts', '--helper-host', 'helper.example.invalid',
      '--proxy', 'socks5h://127.0.0.1:1055', '--token-file', tokenFile]);
    const created = await addSource(engine, params.options as never);
    expect(created.local_path).toBeNull();
    expect(created.config).toMatchObject({ kind: 'apple-contacts', ac_helper_host: 'helper.example.invalid', ac_proxy: 'socks5h://127.0.0.1:1055',
      ac_token_file: tokenFile, ac_record: 'database', owner_only: true, federated: true });
    expect(parseAppleContactsSourceConfig(created.config)).toMatchObject({ helperPort: 8792, contactsDir: 'contacts/apple', syncIntervalMin: 15, record: 'database', dir: null });
    expect(isOwnerOnlySourceConfig(created.config)).toBe(true);
    expect(JSON.stringify(created.config)).not.toContain(STUB_TOKEN);
    expect(() => parseSourceLifecycleArgs(['add', 'contacts-2', '--kind', 'apple-contacts', '--helper-host', '127.0.0.1', '--token-env', 'X'])).toThrow();
    expect(() => parseSourceLifecycleArgs(['add', 'contacts-3', '--kind', 'apple-contacts', '--helper-host', '127.0.0.1', '--proxy', 'socks5h://u:p@h:1', '--token-file', tokenFile])).toThrow();
  });
});

describe('token file', () => {
  test('a token file readable by others, a symlink or a relative path is refused, and the token never shows in the error', () => {
    const loose = join(home, 'loose.json');
    writeFileSync(loose, JSON.stringify({ accessToken: STUB_TOKEN }));
    chmodSync(loose, 0o644);
    const link = join(home, 'link.json');
    symlinkSync(tokenFile, link);
    for (const path of [loose, link, 'contacts-token.json', join(home, 'missing.json')]) {
      let error: unknown;
      try { readAppleContactsToken('src', path); } catch (e) { error = e; }
      expect(error).toMatchObject({ code: 'apple_contacts_token_file' });
      expect(JSON.stringify({ m: (error as Error).message, s: (error as { suggestion?: string }).suggestion })).not.toContain(STUB_TOKEN);
    }
    const bad = join(home, 'bad.json');
    writeFileSync(bad, STUB_TOKEN, { mode: 0o600 });
    chmodSync(bad, 0o600);
    expect(() => readAppleContactsToken('src', bad)).toThrow(expect.objectContaining({ code: 'apple_contacts_token_file' }));
    try { readAppleContactsToken('src', bad); } catch (e) { expect((e as Error).message).not.toContain(STUB_TOKEN); }
    expect(readAppleContactsToken('src', tokenFile)).toBe(STUB_TOKEN);
  });
});

describe('sync (repo-less brain)', () => {
  test('the first run reads the snapshot page by page, writes owner-only pages and saves the change cursor; a rerun writes nothing', async () => {
    const s = freshStub();
    s.pageSize = 2;
    for (let i = 1; i <= 5; i++) s.upsert(`c${i}`, contact(i));
    s.upsert('c-alice', ALICE);
    const { id, cfg } = await contactsSource(s);
    const result = await run(id, cfg);
    expect(result.added).toBe(6);
    expect(s.requests.filter(r => r.path.startsWith('/v1/contacts/changes')).length).toBe(3);
    const rows = await live(id);
    expect(rows.map(r => r.id).sort()).toEqual(['c-alice', 'c1', 'c2', 'c3', 'c4', 'c5']);
    for (const row of rows) { expect(row.slug.startsWith('contacts/apple/')).toBe(true); expect(row.visibility).toBe('private'); }
    const alice = rows.find(r => r.id === 'c-alice')!;
    expect(alice.fm).toMatchObject({ company: 'Acme Example', role: 'Engineer', visibility: 'private', apple_contact_id: 'c-alice' });
    expect(await engine.getTags(alice.slug, { sourceId: id } as never)).toEqual(['Harbor Club']);
    expect(alice.body).toContain('mobile');
    expect(await savedCursor(id)).toBe(`seq:${s.seq}`);

    s.requests = [];
    const again = await run(id, cfg);
    expect(again.status).toBe('up_to_date');
    expect(again.added + again.modified + again.deleted).toBe(0);
    expect(s.requests.map(r => r.path)).toEqual([`/v1/contacts/changes?cursor=seq%3A${s.seq}&limit=200`]);
    for (const r of s.requests) expect(r.authorization).toBe(`Bearer ${STUB_TOKEN}`);
  });

  test('changes are applied page by page with the cursor saved after each; a failure keeps the last applied cursor', async () => {
    const s = freshStub();
    s.upsert('c1', contact(1));
    const { id, cfg } = await contactsSource(s);
    await run(id, cfg);
    const start = s.seq;
    s.pageSize = 1;
    s.upsert('c2', contact(2));
    s.upsert('c3', contact(3));
    s.queue = [null, { status: 500, body: { code: 'internal' } }];
    await expect(run(id, cfg)).rejects.toMatchObject({ code: 'apple_contacts_helper_error' });
    expect(await savedCursor(id)).toBe(`seq:${start + 1}`);
    expect((await live(id)).map(r => r.id).sort()).toEqual(['c1', 'c2']);
    const resumed = await run(id, cfg);
    expect(resumed.added).toBe(1);
    expect(await savedCursor(id)).toBe(`seq:${s.seq}`);
  });

  test('an upsert rewrites the page once; op:delete soft-deletes it and it can be restored', async () => {
    const s = freshStub();
    for (let i = 1; i <= 5; i++) s.upsert('c' + i, contact(i));
    const { id, cfg } = await contactsSource(s);
    await run(id, cfg);
    s.upsert('c1', { ...contact(1), job_title: 'Captain' });
    expect((await run(id, cfg)).modified).toBe(1);
    expect((await live(id)).find(r => r.id === 'c1')!.fm).toMatchObject({ role: 'Captain' });
    s.upsert('c1', { ...contact(1), job_title: 'Captain' });
    expect((await run(id, cfg)).status).toBe('up_to_date');
    s.remove('c2');
    expect((await run(id, cfg)).deleted).toBe(1);
    const gone = (await contactPages(id)).find(r => r.id === 'c2')!;
    expect(gone.deleted).toBe(true);
    expect(await engine.restorePage(gone.slug, { sourceId: id })).toBe(true);
    expect((await live(id)).map(r => r.id).sort()).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
  });

  test('410 cursor_expired reads a full snapshot; absence deletes only when the snapshot says full:true', async () => {
    const s = freshStub();
    for (let i = 1; i <= 6; i++) s.upsert(`c${i}`, contact(i));
    const { id, cfg } = await contactsSource(s);
    await run(id, cfg);
    s.contacts.delete('c6');
    s.expire();
    s.full = false;
    const lines: string[] = [];
    const partial = await run(id, cfg, {}, { log: (l: string) => lines.push(l) });
    expect(lines.join('\n')).toContain('410 cursor_expired');
    expect(partial.deleted).toBe(0);
    expect((await live(id)).length).toBe(6);
    s.full = true;
    const complete = await run(id, cfg, { full: true });
    expect(complete.deleted).toBe(1);
    expect((await live(id)).map(r => r.id)).not.toContain('c6');
    expect(await savedCursor(id)).toBe(`seq:${s.seq}`);
  });

  test('the delete floor: a snapshot deleting more than 20%, or an empty one, writes nothing and keeps the cursor', async () => {
    const s = freshStub();
    for (let i = 1; i <= 10; i++) s.upsert(`c${i}`, contact(i));
    const { id, cfg } = await contactsSource(s);
    await run(id, cfg);
    const cursor = await savedCursor(id);
    for (const i of [1, 2, 3]) s.contacts.delete(`c${i}`);
    s.upsert('c4', { ...contact(4), job_title: 'Changed' });
    await expect(run(id, cfg, { full: true })).rejects.toMatchObject({ code: 'apple_contacts_delete_floor' });
    expect((await live(id)).length).toBe(10);
    expect((await live(id)).find(r => r.id === 'c4')!.fm.role).toBeUndefined();
    expect(await savedCursor(id)).toBe(cursor);

    const all = new Map(s.contacts);
    s.contacts.clear();
    await withEnv({ GBRAIN_ALLOW_MASS_RECONCILE: '1' }, async () => {
      await expect(run(id, cfg, { full: true })).rejects.toMatchObject({ code: 'apple_contacts_delete_floor' });
    });
    expect((await live(id)).length).toBe(10);
    s.contacts = all;
    await withEnv({ GBRAIN_ALLOW_MASS_RECONCILE: '1' }, async () => {
      expect((await run(id, cfg, { full: true })).deleted).toBe(3);
    });
    expect((await live(id)).length).toBe(7);
  });

  test('incremental deletions pass the floor together at the end of the run: more than 20% is held and a contact that comes back cancels it', async () => {
    const s = freshStub();
    for (let i = 1; i <= 10; i++) s.upsert('c' + i, contact(i));
    const { id, cfg } = await contactsSource(s);
    await run(id, cfg);
    for (const i of [1, 2, 3]) s.remove('c' + i);
    s.upsert('c4', { ...contact(4), job_title: 'Changed' });
    await expect(run(id, cfg)).rejects.toMatchObject({ code: 'apple_contacts_delete_floor' });
    expect((await live(id)).length).toBe(10);
    expect((await live(id)).find(r => r.id === 'c4')!.fm.role).toBe('Changed');
    expect(await savedCursor(id)).toBe('seq:' + s.seq);
    const held = await readSyncStatus(engine, id);
    expect(held.held_deletes).toMatchObject({ code: 'apple_contacts_delete_floor', contacts: 3, owned: 10, needs_human: true });
    expect(held.needs_human).toBe(true);
    await expect(run(id, cfg)).rejects.toMatchObject({ code: 'apple_contacts_delete_floor' });
    expect((await live(id)).length).toBe(10);
    s.upsert('c1', contact(1));
    const settled = await run(id, cfg);
    expect(settled.deleted).toBe(2);
    expect((await live(id)).map(r => r.id).sort()).toEqual(['c1', 'c10', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9']);
    expect((await readSyncStatus(engine, id)).held_deletes).toBeUndefined();
  });

  test('an incremental run deleting every contact is held, even with GBRAIN_ALLOW_MASS_RECONCILE=1', async () => {
    const s = freshStub();
    for (let i = 1; i <= 5; i++) s.upsert('c' + i, contact(i));
    const { id, cfg } = await contactsSource(s);
    await run(id, cfg);
    for (let i = 1; i <= 5; i++) s.remove('c' + i);
    await expect(run(id, cfg)).rejects.toMatchObject({ code: 'apple_contacts_delete_floor' });
    await withEnv({ GBRAIN_ALLOW_MASS_RECONCILE: '1' }, async () => {
      await expect(run(id, cfg)).rejects.toMatchObject({ code: 'apple_contacts_delete_floor' });
    });
    expect((await live(id)).length).toBe(5);
    expect((await readSyncStatus(engine, id)).held_deletes).toMatchObject({ contacts: 5, owned: 5 });
  });

  test('an incremental run under the floor applies its deletions; a held run applies with GBRAIN_ALLOW_MASS_RECONCILE=1', async () => {
    const s = freshStub();
    for (let i = 1; i <= 10; i++) s.upsert('c' + i, contact(i));
    const { id, cfg } = await contactsSource(s);
    await run(id, cfg);
    s.remove('c1');
    expect((await run(id, cfg)).deleted).toBe(1);
    expect((await contactPages(id)).find(r => r.id === 'c1')!.deleted).toBe(true);
    for (const i of [2, 3, 4]) s.remove('c' + i);
    await expect(run(id, cfg)).rejects.toMatchObject({ code: 'apple_contacts_delete_floor' });
    expect((await live(id)).length).toBe(9);
    await withEnv({ GBRAIN_ALLOW_MASS_RECONCILE: '1' }, async () => {
      expect((await run(id, cfg)).deleted).toBe(3);
    });
    expect((await live(id)).length).toBe(6);
    expect((await readSyncStatus(engine, id)).held_deletes).toBeUndefined();
  });

  test('a full re-read after 410 settles held deletions under the full-read floor', async () => {
    const s = freshStub();
    for (let i = 1; i <= 10; i++) s.upsert('c' + i, contact(i));
    const { id, cfg } = await contactsSource(s);
    await run(id, cfg);
    for (const i of [1, 2, 3]) s.remove('c' + i);
    await expect(run(id, cfg)).rejects.toMatchObject({ code: 'apple_contacts_delete_floor' });
    s.upsert('c1', contact(1));
    s.upsert('c2', contact(2));
    s.expire();
    expect((await run(id, cfg)).deleted).toBe(1);
    expect((await live(id)).map(r => r.id)).not.toContain('c3');
    expect((await live(id)).length).toBe(9);
    expect((await readSyncStatus(engine, id)).held_deletes).toBeUndefined();
  });

  test('refusals stop the run with their own codes before anything is written; the token never shows', async () => {
    const s = freshStub();
    s.upsert('c1', contact(1));
    for (const [answer, code] of [
      [{ status: 403, body: { code: 'contacts_not_allowed' } }, 'apple_contacts_not_allowed'],
      [{ status: 403, body: { code: 'source_disabled' } }, 'apple_contacts_disabled'],
      [{ status: 401, body: { code: 'unauthorized' } }, 'apple_contacts_unauthorized'],
      [{ status: 403, body: { code: 'insufficient_scope' } }, 'apple_contacts_unauthorized'],
      [{ status: 400, body: { code: 'bad_param' } }, 'apple_contacts_helper_error'],
      [{ status: 200, body: { items: [], meta: { next_cursor: 'x', more: false, full: true } } }, 'connector_shape_drift'],
    ] as const) {
      const { id, cfg } = await contactsSource(s);
      s.queue = [answer];
      let error: unknown;
      try { await run(id, cfg); } catch (e) { error = e; }
      expect(error).toMatchObject({ code });
      expect(JSON.stringify({ m: (error as Error).message, s: (error as { suggestion?: string }).suggestion })).not.toContain(STUB_TOKEN);
      expect(await contactPages(id)).toEqual([]);
      expect(await savedCursor(id)).toBeNull();
    }
    for (const r of s.requests) { expect(r.path).not.toContain(STUB_TOKEN); expect(r.authorization).toBe(`Bearer ${STUB_TOKEN}`); }
  });

  test('empty strings are absent values; a cursor the helper calls bad_param starts a full read', async () => {
    const s = freshStub();
    const { id, cfg } = await contactsSource(s);
    s.queue = [{ status: 200, body: { data: [{ op: 'upsert', id: 'c1', contact: { given_name: 'Dana', family_name: '', nickname: '', organization: '', job_title: '',
      emails: [{ label: '', value: 'dana@example.invalid' }], phones: [{ label: '', value: '' }], groups: [] } }], meta: { next_cursor: 'seq:9', more: false, full: true } } }];
    expect((await run(id, cfg)).added).toBe(1);
    const [page] = await live(id);
    expect(page!.fm).toMatchObject({ emails: ['dana@example.invalid'] });
    expect(page!.fm).not.toHaveProperty('company');
    expect(page!.fm).not.toHaveProperty('phones');
    expect(page!.body).not.toContain('()');
    expect(await savedCursor(id)).toBe('seq:9');
    s.upsert('c1', { given_name: 'Dana', emails: [{ label: '', value: 'dana@example.invalid' }] });
    s.queue = [{ status: 400, body: { code: 'bad_param' } }];
    const lines: string[] = [];
    await run(id, cfg, {}, { log: (l: string) => lines.push(l) });
    expect(lines.join('\n')).toContain('full snapshot');
    expect(await savedCursor(id)).toBe(`seq:${s.seq}`);
  });

  test('503s and a helper that is not listening retry 1 s, 4 s and 15 s, then stop with apple_contacts_unreachable', async () => {
    const s = freshStub();
    s.upsert('c1', contact(1));
    const { id, cfg } = await contactsSource(s);
    const waits: number[] = [];
    const helper = (c = cfg) => appleContactsHelper({ sourceId: id, cfg: c, token: STUB_TOKEN, sleep: async (ms: number) => { waits.push(ms); } });
    s.queue = [{ status: 503 }, { status: 503 }, { status: 503 }, { status: 503 }];
    await expect(run(id, cfg, {}, { helper: helper() })).rejects.toMatchObject({ code: 'apple_contacts_unreachable' });
    expect(waits).toEqual([...APPLE_CONTACTS_RETRY_DELAYS_MS]);
    expect(waits).toEqual([1000, 4000, 15000]);
    expect(await contactPages(id)).toEqual([]);

    waits.length = 0;
    s.queue = [{ status: 503 }, { status: 503 }];
    expect((await run(id, cfg, {}, { helper: helper() })).added).toBe(1);
    expect(waits).toEqual([1000, 4000]);

    const down = new ContactsStub().start();
    const closed = down.port;
    down.stop();
    waits.length = 0;
    await expect(run(id, cfg, { full: true }, { helper: helper({ ...cfg, helperPort: closed }) })).rejects.toMatchObject({ code: 'apple_contacts_unreachable' });
    expect(waits).toEqual([1000, 4000, 15000]);
  });

  test('through a socks5h proxy the proxy resolves the helper host name, and the run imports the same pages', async () => {
    const s = freshStub();
    s.upsert('c1', contact(1));
    const proxy = await new Socks5Stub().start();
    try {
      proxy.names.set('helper.example.invalid', '127.0.0.1');
      const { id, cfg } = await contactsSource(s, { ac_helper_host: 'helper.example.invalid', ac_proxy: `socks5h://127.0.0.1:${proxy.port}` });
      expect((await run(id, cfg)).added).toBe(1);
      expect(proxy.asked).toEqual([{ host: 'helper.example.invalid', port: s.port }]);
      expect(s.requests.at(-1)!.authorization).toBe(`Bearer ${STUB_TOKEN}`);
    } finally { await proxy.stop(); }
  });
});

describe('identity and the person-page block (repo-less brain)', () => {
  test('one exact match links the contact and writes company, job title and groups only; reruns write nothing; a change rewrites only the block', async () => {
    await deletePeople();
    await personPage('people/alice-example', { email: 'alice@example.invalid' });
    const original = await bodyOf('people/alice-example');
    const s = freshStub();
    s.upsert('c-alice', ALICE);
    for (let i = 1; i <= 4; i++) s.upsert('c' + i, contact(i));
    const { id, cfg } = await contactsSource(s);
    const fmBefore = await frontmatterOf('people/alice-example');
    await run(id, cfg);
    const page = (await live(id)).find(r => r.id === 'c-alice')!;
    const group = (await listEntityIdentities(engine, { slug: page.slug, slugSourceId: id })).find(m => m.slug === page.slug)!;
    expect(group.established_by).toBe('apple-contacts');
    expect((await listEntityIdentities(engine, { entityId: group.entity_id })).map(m => m.slug).sort()).toEqual([page.slug, 'people/alice-example'].sort());

    const body = await bodyOf('people/alice-example');
    const m = personBlockMarkers(id);
    expect(body.startsWith(original)).toBe(true);
    const interior = body.slice(body.indexOf(m.begin) + m.begin.length, body.indexOf(m.end));
    expect(interior).toContain('- Company: Acme Example');
    expect(interior).toContain('- Job title: Engineer');
    expect(interior).toContain('- Contacts groups: Harbor Club');
    for (const value of ['alice@example.invalid', ...CONTACT_ONLY, '5555550100', 'Alice', 'c-alice']) expect(interior).not.toContain(value);
    expect(outsideBlock(body, id)).toBe(original);
    // The edit door marks an automated edit as agent-written; that marker is the one change outside the block.
    expect(await frontmatterOf('people/alice-example')).toEqual({ ...fmBefore, trust_tier: 'agent_written' });

    const v = await versions('people/alice-example');
    s.upsert('c-alice', ALICE);
    await run(id, cfg);
    await run(id, cfg, { full: true });
    expect(await versions('people/alice-example')).toBe(v);
    expect(await bodyOf('people/alice-example')).toBe(body);

    s.upsert('c-alice', { ...ALICE, job_title: 'Harbor Master' });
    await run(id, cfg);
    const changed = await bodyOf('people/alice-example');
    expect(changed).toContain('- Job title: Harbor Master');
    expect(changed).not.toContain('- Job title: Engineer');
    expect(outsideBlock(changed, id)).toBe(original);

    s.remove('c-alice');
    await run(id, cfg);
    expect(await bodyOf('people/alice-example')).toBe(original);
    expect((await listEntityIdentities(engine, { slug: 'people/alice-example', slugSourceId: 'default' })).length).toBe(0);
  });

  test('a phone match links too; losing the match removes the link and the block, curated text outside it stays byte-identical', async () => {
    await deletePeople();
    const curated = 'Alice runs the harbor project.\n\n## Notes\n- Prefers mornings.';
    await personPage('people/alice-example', { phones: ['+1 555-555-0100'] }, 'default', curated);
    const original = await bodyOf('people/alice-example');
    const s = freshStub();
    s.upsert('c-alice', { ...ALICE, emails: [] });
    const { id, cfg } = await contactsSource(s);
    await run(id, cfg);
    expect(await bodyOf('people/alice-example')).toContain('- Company: Acme Example');
    // Curated edits land outside the block, then the contact stops matching.
    await engine.executeRaw('UPDATE pages SET compiled_truth = $1 || compiled_truth WHERE slug=$2', ['Intro line.\n\n', 'people/alice-example']);
    const edited = 'Intro line.\n\n' + original;
    s.upsert('c-alice', { ...ALICE, emails: [], phones: [{ label: null, value: '555-555-0142' }] });
    await run(id, cfg);
    expect(await bodyOf('people/alice-example')).toBe(edited);
    expect((await listEntityIdentities(engine, { slug: (await live(id))[0]!.slug, slugSourceId: id })).length).toBe(0);
  });

  test('no match links nothing; two people with the key are an identity review in sync status until the owner rejects them', async () => {
    await deletePeople();
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES('people-b','people-b') ON CONFLICT DO NOTHING");
    const s = freshStub();
    s.upsert('c-alice', ALICE);
    s.upsert('c-none', { given_name: 'Nobody', family_name: 'Sample', emails: [{ label: null, value: 'nobody@example.invalid' }] });
    // A Google contacts copy of the same person is a connector page, never a candidate.
    await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES('google-copy','google-copy','{\"kind\":\"google\"}'::jsonb) ON CONFLICT DO NOTHING");
    await personPage('contacts/alice-example', { email: 'alice@example.invalid' }, 'google-copy');
    await personPage('people/alice-example', { email: 'alice@example.invalid' });
    await personPage('people/alice-example', { email: 'alice@example.invalid' }, 'people-b');
    const original = await bodyOf('people/alice-example');
    const { id, cfg } = await contactsSource(s);
    await run(id, cfg);
    for (const row of await live(id)) expect((await listEntityIdentities(engine, { slug: row.slug, slugSourceId: id })).length).toBe(0);
    expect(await bodyOf('people/alice-example')).toBe(original);
    expect(await bodyOf('people/alice-example', 'people-b')).toBe(original);
    const status = await readSyncStatus(engine, id);
    expect(status.needs_human).toBe(true);
    expect(status.identity_reviews!.length).toBe(1);
    expect(JSON.stringify(status.identity_reviews)).toContain('people-b');
    expect(JSON.stringify(status.identity_reviews)).not.toContain('google-copy');

    const lines: string[] = [];
    const spy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
    try {
      await runDedupe(engine, ['--preview', '--json']);
      const groups = JSON.parse(lines.join('\n')).groups as Array<{ id: string; members: Array<{ source_id: string; slug: string }> }>;
      const group = groups.find(g => g.members.some(m => m.source_id === 'people-b'))!;
      lines.length = 0;
      await runDedupe(engine, ['reject', group.id]);
    } finally { spy.mockRestore(); }
    await run(id, cfg);
    const after = await readSyncStatus(engine, id);
    expect(after.identity_reviews?.every(r => (r as { decided?: string }).decided === 'different') ?? true).toBe(true);
    expect(after.needs_human ?? false).toBe(false);
    expect(await bodyOf('people/alice-example')).toBe(original);
  });

  test('an incomplete snapshot and the delete floor never remove a block', async () => {
    await deletePeople();
    await personPage('people/alice-example', { email: 'alice@example.invalid' });
    const original = await bodyOf('people/alice-example');
    const s = freshStub();
    s.upsert('c-alice', ALICE);
    for (let i = 1; i <= 4; i++) s.upsert(`c${i}`, contact(i));
    const { id, cfg } = await contactsSource(s);
    await run(id, cfg);
    const withBlock = await bodyOf('people/alice-example');
    expect(withBlock).not.toBe(original);

    // The match goes away in a snapshot that does not say full:true: the block waits.
    s.full = false;
    s.upsert('c-alice', { ...ALICE, emails: [{ label: null, value: 'alice.new@example.invalid' }], phones: [] });
    await run(id, cfg, { full: true });
    expect(await bodyOf('people/alice-example')).toBe(withBlock);
    s.full = true;
    await run(id, cfg);
    expect(await bodyOf('people/alice-example')).toBe(original);

    // Back again, then a mass deletion the floor refuses: the block stays.
    s.upsert('c-alice', ALICE);
    await run(id, cfg);
    expect(await bodyOf('people/alice-example')).toBe(withBlock);
    s.contacts.delete('c-alice'); s.contacts.delete('c1');
    await expect(run(id, cfg, { full: true })).rejects.toMatchObject({ code: 'apple_contacts_delete_floor' });
    expect(await bodyOf('people/alice-example')).toBe(withBlock);
  });

  test('no people/ page ever carries a phone or an email the contact alone holds', async () => {
    const rows = await engine.executeRaw<{ slug: string; body: string; fm: unknown }>(`SELECT slug, compiled_truth AS body, frontmatter AS fm FROM pages WHERE slug LIKE 'people/%'`);
    const versionsText = await engine.executeRaw<{ t: string }>(`SELECT v.compiled_truth || ' ' || v.frontmatter::text AS t FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.slug LIKE 'people/%'`);
    const text = rows.map(r => r.body + JSON.stringify(r.fm)).join('\n') + versionsText.map(v => v.t).join('\n');
    for (const value of CONTACT_ONLY) expect(text.replace(/\D/g, '').includes('5555550199') || text.includes(value)).toBe(false);
  });
});

test('on a brain with a Git checkout, no contact reaches the checkout or a commit; the person page in Git gets only its block', async () => {
  await deletePeople();
  const repo = join(home, 'brain-repo');
  const remote = join(home, 'brain-remote.git');
  mkdirSync(join(repo, 'people'), { recursive: true });
  const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  const who = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid'];
  git(home, 'init', '--bare', '-q', remote);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'remote', 'add', 'origin', remote);
  const file = '---\ntype: person\ntitle: Alice Example\nemail: alice@example.invalid\n---\n\n' + PERSON_BODY + '\n';
  writeFileSync(join(repo, 'people', 'alice-example.md'), file);
  git(repo, ...who, 'add', '-A');
  git(repo, ...who, 'commit', '-q', '-m', 'init');
  git(repo, 'push', '-q', 'origin', 'main');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)', ['notes-git', repo, JSON.stringify({ federated: true })]);
  await importFromContent(engine, 'people/alice-example', file, { sourceId: 'notes-git', sourcePath: 'people/alice-example.md', sourceRoot: repo, noEmbed: true });
  const s = freshStub();
  s.upsert('c-alice', ALICE);
  const contactsDir = join(home, 'contacts-checkout');
  mkdirSync(contactsDir);
  git(contactsDir, 'init', '-q', '-b', 'main');
  const { id, cfg } = await contactsSource(s, { ac_record: 'git', ac_dir: contactsDir });
  await run(id, cfg);
  const text = readFileSync(join(repo, 'people', 'alice-example.md'), 'utf8');
  const m = personBlockMarkers(id);
  expect(text).toContain(m.begin);
  expect(text).toContain('- Company: Acme Example');
  // Outside the block only the door's agent-written marker is added to the frontmatter.
  expect(text.replace(/\n?<!-- gbrain:apple-contacts[\s\S]*:end -->/, '')).toBe(file.replace('email: alice@example.invalid\n', 'email: alice@example.invalid\ntrust_tier: agent_written\n'));
  // The door's write-through leaves the person page file for the brain's own commit path; nothing else changed.
  expect(git(repo, 'status', '--porcelain', '--untracked-files=all').stdout).toBe(' M people/alice-example.md\n');
  expect(git(repo, 'rev-parse', 'HEAD').stdout).toBe(git(remote, 'rev-parse', 'main').stdout);
  const tracked = git(repo, 'ls-files').stdout;
  expect(tracked).not.toContain('contacts/apple');
  expect(git(contactsDir, 'status', '--porcelain', '--untracked-files=all').stdout).toBe('');
  expect(git(contactsDir, 'rev-list', '--all').stdout).toBe('');
  const grep = spawnSync('grep', ['-rl', '-e', 'alice.home@example.invalid', '-e', '555-0199', repo, remote], { encoding: 'utf8' }).stdout;
  expect(grep).toBe('');
  expect(git(repo, 'log', '-p', '--all').stdout).not.toContain('alice.home@example.invalid');
});
