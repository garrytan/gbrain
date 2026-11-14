/**
 * Guest notes, slice 2 (GBRA-504): who may write a guest source, and what a guest write may say.
 *
 * Protects: a guest source takes page writes only from a credential on its writer list, through put_page, as a new
 * page (create-only), with the guest attribution channel (X-Gbrain-Guest header or request-level _meta.guest), a
 * frontmatter allowlist and readers of exactly the brain owner plus the call's one audience principal; the write is
 * capped at external_untrusted, gets a guest_marks row in the publication transaction, and produces no derived rows
 * (facts, takes, timeline, links). A writer-list change after admission refuses at publication. Local CLI writes,
 * an enforced member, remember, links and import refuse on a guest source, while local delete and restore still work.
 * Pages outside a guest source keep their behavior, and attribution sent to them is stored nowhere.
 *
 * Real seams: legacy tokens bound by the member CLI functions, dispatched through MCP dispatch on a repo-less PGLite
 * brain; the race case drives admission and publication through the persistence service directly.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { buildOperationContext, dispatchToolCall } from '../src/mcp/dispatch.ts';
import { addGroup, addMember, bindCredential } from '../src/core/access/members.ts';
import { clearOwner, setOwner } from '../src/core/access/owner.ts';
import { parseAudience } from '../src/core/access/audience.ts';
import { remoteCallerAccess } from '../src/core/access/caller.ts';
import { withCallerAccess } from '../src/core/search/private-visibility.ts';
import { changeGuestWriters, initGuestSource } from '../src/core/guests/sources.ts';
import { GUEST_HEADER, parseGuestAttribution } from '../src/core/guests/admission.ts';
import { preparePageAdmission } from '../src/core/persistence/page-mutations.ts';
import { admitWrite } from '../src/core/persistence/journal.ts';
import { disposePersistenceConsumer, waitForWrite } from '../src/core/persistence/service.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { runImport } from '../src/commands/import.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { readsUnscopedOnPurpose } from './helpers/reads-unscoped.ts';

const SRC = 'guests';
const PLAIN = 'source-a';
const OWNER = 'alice-example';
const META = { sender_label: 'Bob Example', group: 'team-a' };

let engine: PGLiteEngine;
const tokens: Record<string, { id: string; token: string }> = {};
const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
const verify = async (who: string) => await provider().verifyAccessToken(tokens[who]!.token) as unknown as AuthInfo;

interface GuestPage { readers?: string | null; sender?: string; group?: string; extra?: string[]; body?: string }
const guestPage = (o: GuestPage = {}) => ['---', 'type: note', 'title: A note from Bob',
  ...(o.readers === null ? [] : [`readable_by: ${o.readers ?? `[${OWNER}, bob-example]`}`]),
  `guest_group: ${o.group ?? 'team-a'}`, `guest_sender: ${o.sender ?? 'Bob Example'}`, 'saved_at: 2026-11-13T10:00:00Z',
  ...(o.extra ?? []), '---', '# A note from Bob', '',
  o.body ?? 'Bob met [Carol](people/carol-example) about the harbor ledger. See [[people/carol-example]].\n\n## Timeline\n\n- **2026-11-01** | Met Carol about the ledger'].join('\n');

type Channels = { audience?: string | null; header?: string; meta?: unknown; sourceId?: string };
const parse = (text: string) => { try { return JSON.parse(text) as Record<string, unknown>; } catch { return {} as Record<string, unknown>; } };
async function call(who: string, op: string, params: Record<string, unknown>, ch: Channels = {}) {
  const auth = await verify(who);
  const out = await dispatchToolCall(engine, op, { ...params }, {
    remote: true, transport: 'http', auth, sourceId: ch.sourceId ?? SRC, takesHoldersAllowList: ['world'],
    onBehalfOf: { header: ch.audience === null ? undefined : ch.audience ?? 'bob-example' },
    guest: { header: ch.header, requestMeta: ch.meta === undefined ? { guest: META } : ch.meta === null ? undefined : { guest: ch.meta } },
  });
  const text = out.content.map(c => c.text).join('\n');
  const json = parse(text);
  return { isError: out.isError === true, text, json, code: (json.code ?? json.error) as string | undefined };
}
async function local(op: string, params: Record<string, unknown>, sourceId = SRC) {
  const out = await dispatchToolCall(engine, op, { ...params }, { remote: false, sourceId });
  const text = out.content.map(c => c.text).join('\n');
  const json = parse(text);
  return { isError: out.isError === true, text, json, code: (json.code ?? json.error) as string | undefined };
}
const put = (who: string, slug: string, page: GuestPage = {}, ch: Channels = {}, extra: Record<string, unknown> = {}) =>
  call(who, 'put_page', { slug, content: guestPage(page), ...extra }, ch);
const revisionOf = async (slug: string) => (await engine.readPageSnapshot(slug, { sourceId: SRC, includeDeleted: true }))!.revision;
const codeOf = (fn: () => unknown) => { try { fn(); return null; } catch (e) { return (e as { code?: string }).code ?? String(e); } };
const slugOf = () => `notes/guest-${randomUUID().slice(0, 8)}`;
async function pageRow(slug: string, sourceId = SRC) {
  const [row] = await engine.executeRaw<{ id: number; tier: string; deleted: boolean }>(
    'SELECT id, trust_tier AS tier, deleted_at IS NOT NULL AS deleted FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]);
  return row ?? null;
}
async function markOf(slug: string) {
  const [row] = await engine.executeRaw<Record<string, unknown>>(
    `SELECT m.source_id, m.slug_at_write, m.audience_member, m.group_slug, m.sender_label, m.writer_kind, m.writer_id, m.request_id, m.saved_at IS NOT NULL AS saved
       FROM guest_marks m JOIN pages p ON p.id = m.page_id WHERE p.source_id=$1 AND p.slug=$2`, [SRC, slug]);
  return row ?? null;
}
async function derivedCounts(slug: string) {
  const [row] = await engine.executeRaw<{ links: number; timeline: number; facts: number; takes: number }>(
    `SELECT (SELECT count(*)::int FROM links l WHERE l.from_page_id = p.id OR l.to_page_id = p.id) AS links,
            (SELECT count(*)::int FROM timeline_entries t WHERE t.page_id = p.id) AS timeline,
            (SELECT count(*)::int FROM facts f WHERE f.source_id = p.source_id) AS facts,
            (SELECT count(*)::int FROM takes k WHERE k.page_id = p.id) AS takes
       FROM pages p WHERE p.source_id=$1 AND p.slug=$2`, [SRC, slug]);
  return row!;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const id of [OWNER, 'bob-example', 'carol-example']) await addMember(engine, id);
  await addGroup(engine, 'team-a', ['bob-example']);
  await addGroup(engine, 'team-b', ['carol-example']);
  await setOwner(engine, OWNER);
  await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [PLAIN]);
  await initGuestSource(engine, SRC, []);
  const mint = async (name: string, grant: string[]) => {
    const minted = await mintLegacyToken(engine, { name, scopes: ['read', 'write'], takesHolders: ['world'], sourceGrant: grant });
    tokens[name] = { id: minted.id, token: minted.token };
    await bindCredential(engine, { kind: 'token', id: minted.id }, { mayActFor: ['member:bob-example', 'member:carol-example', 'group:team-a', 'guest'] });
    await readsUnscopedOnPurpose(engine, minted.id);
  };
  await mint('broker', [SRC]);
  await mint('other', [SRC]);
  await mint('plain', [PLAIN]);
  await changeGuestWriters(engine, SRC, { add: [`legacy_token:${tokens.broker!.id}`] });
}, 240_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); }, 60_000);

describe('guest attribution channel', () => {
  test('header form is URL-encoded sender_label and group; meta form is _meta.guest', () => {
    expect(GUEST_HEADER).toBe('X-Gbrain-Guest');
    expect(parseGuestAttribution({ header: 'sender_label=Bob%20Example&group=team-a' })).toEqual(META);
    expect(parseGuestAttribution({ requestMeta: { guest: META } })).toEqual(META);
    expect(parseGuestAttribution({ header: 'sender_label=Bob%20Example&group=team-a', requestMeta: { guest: META } })).toEqual(META);
    expect(parseGuestAttribution({})).toBeNull();
  });

  test('a label or group outside the rules, or header and meta that disagree, is refused', () => {
    for (const label of ['', 'x'.repeat(65), 'Bob\u202eExample', 'Bob\u200bExample', 'Bob\nExample', 'Bob · Ex', 'Bob [x]', 'Bob <x>', 'Bob "x"'])
      expect({ label, code: codeOf(() => parseGuestAttribution({ requestMeta: { guest: { sender_label: label, group: 'team-a' } } })) }).toEqual({ label, code: 'guest_attribution_missing' });
    for (const group of ['Team-A', 'team a', '', 'x'.repeat(65)])
      expect({ group, code: codeOf(() => parseGuestAttribution({ requestMeta: { guest: { sender_label: 'Bob', group } } })) }).toEqual({ group, code: 'guest_attribution_missing' });
    expect(codeOf(() => parseGuestAttribution({ header: 'sender_label=Bob&group=team-a', requestMeta: { guest: META } }))).toBe('guest_attribution_missing');
    expect(codeOf(() => parseGuestAttribution({ requestMeta: { guest: 'Bob' } }))).toBe('guest_attribution_missing');
  });
});

describe('guest write admission (pglite, repo-less)', () => {
  test('a listed writer saves a new guest page: external_untrusted, a guest mark, no derived rows', async () => {
    const slug = slugOf();
    const out = await put('broker', slug);
    expect({ isError: out.isError, code: out.code }).toEqual({ isError: false, code: undefined });
    const row = await pageRow(slug);
    expect(row?.tier).toBe('external_untrusted');
    expect(await markOf(slug)).toEqual({ source_id: SRC, slug_at_write: slug, audience_member: 'member:bob-example', group_slug: 'team-a',
      sender_label: 'Bob Example', writer_kind: 'legacy_token', writer_id: tokens.broker!.id, request_id: expect.any(String), saved: true });
    expect(await derivedCounts(slug)).toEqual({ links: 0, timeline: 0, facts: 0, takes: 0 });
    const [intent] = await engine.executeRaw<{ note: unknown }>("SELECT intent->'guest_note' AS note FROM persistence_requests WHERE source_id=$1 AND slug=$2", [SRC, slug]);
    expect(intent?.note).toEqual(META);
  }, 60_000);

  test('the header channel works on its own', async () => {
    const slug = slugOf();
    const out = await put('broker', slug, {}, { header: 'sender_label=Bob%20Example&group=team-a', meta: null });
    expect({ isError: out.isError, code: out.code }).toEqual({ isError: false, code: undefined });
    expect((await markOf(slug))?.sender_label).toBe('Bob Example');
  }, 60_000);

  test('a group audience is stored as the group principal', async () => {
    const slug = slugOf();
    const out = await put('broker', slug, { readers: `[${OWNER}, group:team-a]` }, { audience: 'group:team-a' });
    expect({ isError: out.isError, code: out.code }).toEqual({ isError: false, code: undefined });
    expect((await markOf(slug))?.audience_member).toBe('group:team-a');
  }, 60_000);

  test('missing or bad attribution is guest_attribution_missing and writes nothing', async () => {
    for (const ch of [{ meta: null }, { meta: { sender_label: 'Bob\u202eExample', group: 'team-a' } }, { meta: { sender_label: 'Bob\u200b', group: 'team-a' } },
      { header: 'sender_label=Carol&group=team-a' }] as Channels[]) {
      const slug = slugOf();
      const out = await put('broker', slug, {}, ch);
      expect({ ch, code: out.code }).toEqual({ ch, code: 'guest_attribution_missing' });
      expect(await pageRow(slug)).toBeNull();
    }
  }, 60_000);

  test('a credential not on the writer list is source_writer_restricted', async () => {
    const slug = slugOf();
    const out = await put('other', slug);
    expect(out.code).toBe('source_writer_restricted');
    expect(out.text).not.toMatch(/writers --add|add (it|the credential) as a writer/i);
    expect(await pageRow(slug)).toBeNull();
  }, 60_000);

  test('local CLI writes, an enforced member, remember and import refuse on a guest source', async () => {
    const slug = slugOf();
    expect((await local('put_page', { slug, content: guestPage() })).code).toBe('source_writer_restricted');
    expect((await local('remember', { fact: 'Bob likes tea', provenance: 'test 2026-11-13' })).code).toBe('source_writer_restricted');
    const member = await dispatchToolCall(engine, 'put_page', { slug, content: guestPage() }, {
      remote: true, transport: 'stdio', stdioMember: 'bob-example', enforcedMember: true, sourceId: SRC, takesHoldersAllowList: ['world'] });
    expect(parse(member.content[0]!.text).code).toBe('source_writer_restricted');
    await expect(importFromContent(engine, slug, guestPage(), { sourceId: SRC })).rejects.toThrow(/source_writer_restricted/);
    const dir = mkdtempSync(join(tmpdir(), 'gb-guest-import-'));
    try {
      mkdirSync(join(dir, 'notes'));
      writeFileSync(join(dir, 'notes', 'a.md'), guestPage());
      await expect(runImport(engine, [dir, '--source', SRC, '--no-embed'])).rejects.toThrow(/source_writer_restricted/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
    expect(await pageRow(slug)).toBeNull();
    expect(await pageRow('notes/a')).toBeNull();
  }, 120_000);

  test('the local owner can still delete and restore a guest page; a remote non-writer cannot delete', async () => {
    const slug = slugOf();
    expect((await put('broker', slug)).isError).toBe(false);
    expect((await call('other', 'delete_page', { slug, expected_revision: await revisionOf(slug) })).code).toBe('source_writer_restricted');
    expect((await pageRow(slug))?.deleted).toBe(false);
    const del = await local('delete_page', { slug, expected_revision: await revisionOf(slug) });
    expect({ isError: del.isError, code: del.code }).toEqual({ isError: false, code: undefined });
    expect((await pageRow(slug))?.deleted).toBe(true);
    const restored = await local('restore_page', { slug, expected_revision: await revisionOf(slug) });
    expect({ isError: restored.isError, code: restored.code }).toEqual({ isError: false, code: undefined });
    const row = await pageRow(slug);
    expect(row?.deleted).toBe(false);
    expect((await engine.executeRaw('SELECT 1 FROM content_chunks WHERE page_id=$1', [row!.id])).length).toBeGreaterThan(0);
    expect(await markOf(slug)).not.toBeNull();
  }, 60_000);

  test('guest pages are create-only', async () => {
    const slug = slugOf();
    expect((await put('broker', slug)).isError).toBe(false);
    expect((await put('broker', slug, { body: 'Rewritten.' })).code).toBe('revision_required');
    expect((await put('broker', slug, { body: 'Rewritten.' }, {}, { force: true })).code).toBe('guest_page_immutable');
    expect((await put('broker', slug, { body: 'Rewritten.' }, {}, { expected_revision: await revisionOf(slug) })).code).toBe('guest_page_immutable');
    expect((await call('broker', 'edit_page', { slug, edits: [{ old_text: 'Bob met', new_text: 'Bob saw' }], expected_revision: await revisionOf(slug) })).code).toBe('guest_page_immutable');
    expect((await call('broker', 'add_timeline_entry', { slug, date: '2026-11-02', summary: 'Again' })).code).toBe('guest_page_immutable');
    expect((await call('broker', 'append_page', { slug, text: 'More.', request_id: randomUUID() })).code).toBe('guest_page_immutable');
    expect((await call('broker', 'add_link', { from: slug, to: slug })).code).toBe('guest_page_immutable');
    expect((await call('other', 'add_link', { from: slug, to: slug })).code).toBe('source_writer_restricted');
    expect((await call('broker', 'remember', { fact: 'Bob likes tea', provenance: 'test 2026-11-13' })).code).toBe('guest_page_immutable');
    const batch = await call('broker', 'put_pages', { pages: [{ slug: slugOf(), content: guestPage() }], request_id: randomUUID() });
    expect((batch.json.pages as Array<{ error?: { code?: string } }>)?.map(page => page.error?.code)).toEqual(['guest_page_immutable']);
    const del = await call('broker', 'delete_page', { slug, expected_revision: await revisionOf(slug) });
    expect({ isError: del.isError, code: del.code }).toEqual({ isError: false, code: undefined });
    expect((await put('broker', slug)).code).toBe('guest_page_immutable');
  }, 120_000);

  test('the frontmatter allowlist and the sender and group match', async () => {
    for (const [label, page] of [
      ['extra key', { extra: ['tags: [x]'] }], ['visibility', { extra: ['visibility: private'] }], ['trust key', { extra: ['trust_tier: owner'] }],
      ['sender mismatch', { sender: 'Carol Example' }], ['group mismatch', { group: 'team-b' }],
    ] as Array<[string, GuestPage]>) {
      const slug = slugOf();
      expect({ label, code: (await put('broker', slug, page)).code }).toEqual({ label, code: 'guest_frontmatter_refused' });
      expect(await pageRow(slug)).toBeNull();
    }
  }, 120_000);

  test('readers must be exactly the owner and the one audience principal', async () => {
    const refused: Array<[string, GuestPage, Channels]> = [
      ['owner dropped', { readers: '[bob-example]' }, {}],
      ['extra group', { readers: `[${OWNER}, bob-example, group:team-b]` }, {}],
      ['two-entry audience', { readers: `[${OWNER}, bob-example, carol-example]` }, { audience: 'bob-example, carol-example' }],
    ];
    for (const [label, page, ch] of refused) {
      const slug = slugOf();
      expect({ label, code: (await put('broker', slug, page, ch)).code }).toEqual({ label, code: 'guest_readers_invalid' });
      expect(await pageRow(slug)).toBeNull();
    }
    for (const [label, page, ch] of [['no readers', { readers: null }, {}], ['no audience', {}, { audience: null }]] as Array<[string, GuestPage, Channels]>) {
      const slug = slugOf();
      expect({ label, refused: ['guest_readers_invalid', 'readable_by_invalid'].includes(String((await put('broker', slug, page, ch)).code)) }).toEqual({ label, refused: true });
      expect(await pageRow(slug)).toBeNull();
    }
    await clearOwner(engine);
    try {
      const slug = slugOf();
      expect((await put('broker', slug)).code).toBe('guest_readers_invalid');
    } finally { await setOwner(engine, OWNER); }
  }, 120_000);

  test('the same request_id with different attribution is idempotency_conflict', async () => {
    const slug = slugOf();
    const requestId = randomUUID();
    expect((await call('broker', 'put_page', { slug, content: guestPage(), request_id: requestId })).isError).toBe(false);
    const replay = await call('broker', 'put_page', { slug, content: guestPage(), request_id: requestId }, { meta: { sender_label: 'Bob Example', group: 'team-b' } });
    expect(replay.code).toBe('idempotency_conflict');
  }, 60_000);

  test('attribution sent with a write outside a guest source is ignored and stored nowhere', async () => {
    const slug = slugOf();
    const out = await call('plain', 'put_page', { slug, content: '---\ntype: note\ntitle: Plain\n---\n# Plain\n\nPlain words.' }, { sourceId: PLAIN, audience: null });
    expect({ isError: out.isError, code: out.code }).toEqual({ isError: false, code: undefined });
    const [row] = await engine.executeRaw<{ note: unknown; tier: string }>(
      "SELECT r.intent->'guest_note' AS note, p.trust_tier AS tier FROM persistence_requests r JOIN pages p ON p.source_id=r.source_id AND p.slug=r.slug WHERE r.source_id=$1 AND r.slug=$2", [PLAIN, slug]);
    expect(row?.note ?? null).toBeNull();
    expect(row?.tier).not.toBe('external_untrusted');
    expect((await engine.executeRaw('SELECT 1 FROM guest_marks WHERE source_id=$1', [PLAIN])).length).toBe(0);
  }, 60_000);

  test('a writer removed between admission and publication refuses at publication', async () => {
    const slug = slugOf();
    const auth = await verify('broker');
    const params = { slug, content: guestPage(), request_id: randomUUID() };
    const ctx = buildOperationContext(engine, params, { remote: true, transport: 'http', auth, sourceId: SRC, takesHoldersAllowList: ['world'],
      guest: { requestMeta: { guest: META } } });
    const access = await remoteCallerAccess(engine, auth, undefined, 'http', parseAudience({ header: 'bob-example' }), undefined, false);
    const row = await withCallerAccess(access, async () => {
      const prepared = await preparePageAdmission(ctx, { operation: 'put_page', params });
      return admitWrite(engine, prepared.admission!);
    });
    const [stored] = await engine.executeRaw<{ note: unknown }>("SELECT intent->'guest_note' AS note FROM persistence_requests WHERE request_id=$1::uuid", [row.request_id]);
    expect(stored?.note).toEqual(META);
    const writer = `legacy_token:${tokens.broker!.id}`;
    await changeGuestWriters(engine, SRC, { remove: [writer] });
    try {
      const settled = await waitForWrite(engine, row, ctx.config, 10_000);
      expect({ state: settled.state, code: settled.error_code }).toEqual({ state: 'failed', code: 'source_writer_restricted' });
      expect(await pageRow(slug)).toBeNull();
    } finally { await changeGuestWriters(engine, SRC, { add: [writer] }); }
  }, 60_000);
});
