/**
 * BrainEngine parity: what happens to a guest note after it is saved, on every engine (formerly loss row 32m-4). A Rust brain keeps
 * the owner's promotions (rust/crates/gbrain-store/src/guest_promotions.rs) beside the guest marks, so the owner keeps a
 * guest note as an owner page, a remote writer deletes only its own unkept note, and a remote reader sees the guest
 * stamp, as on PGLite and Postgres.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the owner's promote_guest_note writes the owner page and the link once (a second call answers
 *    already_promoted) and every read of the note then says promoted. A remote delete of a guest note is refused for a
 *    note another writer saved (permission_denied) and for a note the owner kept (guest_page_promoted), and goes through
 *    for the writer's own unkept note. A remote reader the note names reads it with the guest stamp. Each answer is the
 *    same on every arm.
 *  - Regression: on Rust each of these ran raw SQL (promote.ts, refuseRemoteGuestDelete, readableGuestRefs) and refused
 *    with engine_capability_missing (raw_sql).
 *  - Why existing coverage misses it: test/guest-notes-*.test.ts run on PGLite and Postgres only; guest-note-save.test.ts
 *    stops at the save and a local read.
 *  - hidden: row-level security hides guest_sources from no role on an unmanaged brain, so `hidden` reads false on every
 *    arm and is compared; the Postgres scoped-role case is named loss 32m-5 (Rust has no roles).
 *  - Seam: the brokers' access tokens are verified by the OAuth provider in production; here every arm gets the same
 *    hand-built AuthInfo for each minted token, so the dispatcher, the admission and the publication run for real. The
 *    remote reader is the stdio server's bound member (stdioMember), as `gbrain serve --stdio-member` runs it.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { addGroup, addMember, bindCredential } from '../../src/core/access/members.ts';
import { setOwner } from '../../src/core/access/owner.ts';
import { initGuestSource } from '../../src/core/guests/sources.ts';
import { mintLegacyToken } from '../../src/core/token-mint.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const OWNER = 'alice-example';
const GUEST = 'bob-example';
const OTHER = 'carol-example';
const ACTS_FOR = [`member:${GUEST}`, 'group:team-a', 'guest'];

const content = (title: string) => ['---', 'type: note', `title: ${title}`, `readable_by: [${OWNER}, ${GUEST}]`, 'guest_group: team-a',
  'guest_sender: Bob Example', 'saved_at: 2026-11-13T10:00:00Z', '---', '# A note', '', `${title} body.`].join('\n');

/** The tool result's JSON, or `{ error }` with the error code and message when it is an error. */
function result(out: unknown): Record<string, unknown> {
  const r = out as { isError?: boolean; content?: Array<{ text?: string }> };
  const text = r.content?.[0]?.text ?? '';
  if (r.isError) {
    try { const e = JSON.parse(text) as { error?: string; code?: string; message?: string }; return { error: e.code ?? e.error ?? null, message: e.message ?? null }; } catch { return { error: text }; }
  }
  try { return JSON.parse(text.split('\n')[0]!) as Record<string, unknown>; } catch { return { text }; }
}

/** A minted token bound to act for the guest, as the access-token check would return it. */
async function brokerAuth(engine: BrainEngine, name: string) {
  const minted = await mintLegacyToken(engine, { name, scopes: ['read', 'write'], takesHolders: ['world'], sourceGrant: ['guests'] });
  await bindCredential(engine, { kind: 'token', id: minted.id }, { mayActFor: ACTS_FOR });
  return { id: minted.id, auth: { token: minted.token, clientId: name, clientName: name, principal: { kind: 'legacy_token', id: minted.id }, member: null,
    mayActFor: ACTS_FOR, readsUnscoped: true, scopes: ['read', 'write'], sourceId: 'guests', allowedSources: ['guests'], hasSourceGrant: true,
    takesHoldersAllowList: ['world'], attest: null } };
}

const remote = (auth: unknown) => ({ remote: true, transport: 'http', auth, sourceId: 'guests', takesHoldersAllowList: ['world'], onBehalfOf: { header: GUEST },
  guest: { requestMeta: { guest: { sender_label: 'Bob Example', group: 'team-a' } } } }) as never;

const save = (engine: BrainEngine, auth: unknown, slug: string, title: string) =>
  dispatchToolCall(engine, 'put_page', { slug, content: content(title) }, remote(auth)).then(result);
const promote = (engine: BrainEngine, slug: string) =>
  dispatchToolCall(engine, 'promote_guest_note', { slug, source_id: 'default' }, { remote: false, sourceId: 'default' } as never).then(result);
const localRead = (engine: BrainEngine, slug: string, sourceId: string) =>
  dispatchToolCall(engine, 'get_page', { slug }, { remote: false, sourceId } as never).then(result);

async function seed(engine: BrainEngine, backend: Parameters<typeof createSource>[1], writers: number) {
  for (const id of [OWNER, GUEST, OTHER]) await addMember(engine, id);
  await addGroup(engine, 'team-a', [GUEST]);
  await setOwner(engine, OWNER);
  await createSource(engine, backend, 'guests');
  const brokers = [];
  for (let i = 0; i < writers; i++) brokers.push(await brokerAuth(engine, `broker-${i}`));
  await initGuestSource(engine, 'guests', brokers.map(b => `legacy_token:${b.id}`));
  return brokers;
}

/** The parts of a guest stamp that do not carry a write time or a generated id. */
const stamp = (guest: unknown) => {
  if (!guest || typeof guest !== 'object') return null;
  const { saved_at: _s, writer, ...rest } = guest as Record<string, unknown>;
  return { ...rest, writer: typeof writer === 'string' ? writer.split(':')[0] : writer ?? null };
};

describe('guest notes after the save', () => {
  parityTest('the owner keeps a guest note as an owner page once, and every read then says promoted',
    { methods: ['hasGuestSourceRow', 'readGuestPromotionKept', 'linkGuestPromotion', 'readGuestMarks', 'getPage'] }, async (engine, backend) => {
      try {
        const [broker] = await seed(engine, backend, 1);
        expect(await save(engine, broker!.auth, 'notes/guest-a', 'A note from Bob')).toMatchObject({ status: 'created_or_updated' });
        const first = await promote(engine, 'notes/guest-a');
        expect(first.status).toBe('promoted');
        const again = await promote(engine, 'notes/guest-a');
        const note = await localRead(engine, 'notes/guest-a', 'guests');
        const kept = await localRead(engine, 'notes/guest-a', 'default');
        return {
          first: { status: first.status, guest: first.guest, page: first.page },
          again: { status: again.status, error: again.error ?? null },
          note: { origin: note.origin ?? null, guest: stamp(note.guest) },
          kept: { title: kept.title ?? null, type: kept.type ?? null, compiled_truth: kept.compiled_truth ?? null,
            promoted_from: (kept.frontmatter as Record<string, unknown> | undefined)?.promoted_from ?? null, origin: kept.origin ?? null },
        };
      } finally { await disposePersistenceConsumer(engine).catch(() => {}); }
    });

  parityTest('a remote writer deletes only its own guest note, and never one the owner kept',
    { methods: ['readGuestDeleteCheck', 'linkGuestPromotion', 'getPage'] }, async (engine, backend) => {
      try {
        const [mine, theirs] = await seed(engine, backend, 2);
        const saved = await save(engine, mine!.auth, 'notes/own', 'My note');
        await save(engine, mine!.auth, 'notes/kept', 'A kept note');
        expect((await promote(engine, 'notes/kept')).status).toBe('promoted');
        const check = async (slug: string) => {
          const row = await engine.readGuestDeleteCheck('guests', slug);
          return row ? { ...row, writer: row.writer?.split(':')[0] ?? null } : null;
        };
        const before = { own: await check('notes/own'), kept: await check('notes/kept'), missing: await check('notes/missing') };
        const del = (auth: unknown, slug: string) => dispatchToolCall(engine, 'delete_page', { slug, expected_revision: saved.revision }, remote(auth)).then(result);
        const notYours = await del(theirs!.auth, 'notes/own');
        const promoted = await del(mine!.auth, 'notes/kept');
        const own = await del(mine!.auth, 'notes/own');
        expect(notYours.error).toBe('permission_denied');
        expect(promoted.error).toBe('guest_page_promoted');
        const live = async (slug: string) => (await engine.getPage(slug, { sourceId: 'guests' })) !== null;
        return {
          before, notYours: notYours.error ?? null, promoted: promoted.error ?? null, own: own.error ?? own.status ?? null,
          ownLive: await live('notes/own'), keptLive: await live('notes/kept'),
        };
      } finally { await disposePersistenceConsumer(engine).catch(() => {}); }
    });

  parityTest('a remote reader the note names reads it with the guest stamp, and one it does not name reads nothing',
    { methods: ['readGuestRefPages', 'readGuestDeleteCheck', 'readGuestSourceRow'] }, async (engine, backend) => {
      try {
        const [broker] = await seed(engine, backend, 1);
        await save(engine, broker!.auth, 'notes/guest-a', 'A note from Bob');
        const read = (member: string) => dispatchToolCall(engine, 'get_page', { slug: 'notes/guest-a' },
          { remote: true, transport: 'stdio', sourceId: 'guests', stdioMember: member } as never).then(result);
        const named = await read(GUEST);
        const unnamed = await read(OTHER);
        expect(named.origin).toBe('guest');
        // Row-level security does not hide guest_sources from this role on any arm (an unmanaged brain).
        const hidden = { source: (await engine.readGuestSourceRow('guests')).hidden, page: (await engine.readGuestDeleteCheck('guests', 'notes/guest-a'))?.hidden ?? null };
        return {
          hidden,
          named: { title: typeof named.title === 'string' ? named.title.replace(/saved \d{4}-\d\d-\d\d/, 'saved <date>') : null, origin: named.origin ?? null, trust_tier: named.trust_tier ?? null, guest: stamp(named.guest), error: named.error ?? null },
          unnamed: { error: unnamed.error ?? null, title: unnamed.title ?? null },
        };
      } finally { await disposePersistenceConsumer(engine).catch(() => {}); }
    });
});
