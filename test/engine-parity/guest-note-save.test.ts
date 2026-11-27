/**
 * BrainEngine parity: a guest note saved over remote MCP on every engine (loss row 32m-4). A Rust brain keeps the guest
 * marks (rust/crates/gbrain-store/src/guest_marks.rs) and serves the publication's guest-source recheck, so a listed
 * writer's put_page with guest attribution publishes the page and its mark, and every read stamps the page as a guest
 * note.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a credential listed on the guest source's writers saves a guest note for a member it may act for; the
 *    page, its trust tier (capped at the source's ceiling) and its guest stamp (origin `guest`, sender, group, audience,
 *    promoted false) read back the same on every arm. A credential not on the writers is refused with
 *    source_writer_restricted and writes nothing.
 *  - Regression: on Rust the publication's recheck (assertGuestWriterAtPublication) and the mark write were raw SQL, so a
 *    listed writer's guest note was refused at publication (engine_capability_missing, raw_sql) and nothing was saved.
 *  - Why existing coverage misses it: test/guest-notes-*.test.ts run on PGLite and Postgres only; guest-sources.test.ts
 *    sets gbrain.guest_note by hand and writes no mark.
 *  - Not covered here, named in row 32m-4: promotion, the remote guest delete check and a remote reader's guest stamp
 *    still run raw SQL and refuse typed on Rust.
 *  - Seam: the access token is verified by the OAuth provider on the SQL engines in production; here every arm gets
 *    the same hand-built AuthInfo for the minted token (the provider's read is raw SQL on Rust), so the dispatcher, the
 *    admission and the publication run for real.
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
const ACTS_FOR = [`member:${GUEST}`, 'group:team-a', 'guest'];

const content = (title: string) => ['---', 'type: note', `title: ${title}`, `readable_by: [${OWNER}, ${GUEST}]`, 'guest_group: team-a',
  'guest_sender: Bob Example', 'saved_at: 2026-11-13T10:00:00Z', '---', '# A note', '', 'Bob wrote this.'].join('\n');

/** The tool result's JSON, or its text when it is an error. */
function result(out: unknown): unknown {
  const r = out as { isError?: boolean; content?: Array<{ text?: string }> };
  const text = r.content?.[0]?.text ?? '';
  if (r.isError) return { error: text };
  try { return JSON.parse(text); } catch { return { text }; }
}

/** A minted token bound to act for the guest, as the access-token check would return it for `sourceId`. */
async function brokerAuth(engine: BrainEngine, name: string) {
  const minted = await mintLegacyToken(engine, { name, scopes: ['read', 'write'], takesHolders: ['world'], sourceGrant: ['guests'] });
  await bindCredential(engine, { kind: 'token', id: minted.id }, { mayActFor: ACTS_FOR });
  return { id: minted.id, auth: { token: minted.token, clientId: name, clientName: name, principal: { kind: 'legacy_token', id: minted.id }, member: null,
    mayActFor: ACTS_FOR, readsUnscoped: true, scopes: ['read', 'write'], sourceId: 'guests', allowedSources: ['guests'], hasSourceGrant: true,
    takesHoldersAllowList: ['world'], attest: null } };
}

const saveAs = (engine: BrainEngine, auth: unknown, slug: string, title: string) => dispatchToolCall(engine, 'put_page', { slug, content: content(title) }, {
  remote: true, transport: 'http', auth, sourceId: 'guests', takesHoldersAllowList: ['world'],
  onBehalfOf: { header: GUEST }, guest: { requestMeta: { guest: { sender_label: 'Bob Example', group: 'team-a' } } } } as never);

async function seed(engine: BrainEngine, backend: Parameters<typeof createSource>[1]) {
  for (const id of [OWNER, GUEST]) await addMember(engine, id);
  await addGroup(engine, 'team-a', [GUEST]);
  await setOwner(engine, OWNER);
  await createSource(engine, backend, 'guests');
}

describe('guest note save', () => {
  parityTest('a listed writer saves a guest note and every read stamps it as one',
    { methods: ['claimGuestNotePublication', 'insertGuestMark', 'readGuestMarks', 'putPage', 'getPage', 'readPageTrustRows'] }, async (engine, backend) => {
      try {
        await seed(engine, backend);
        const broker = await brokerAuth(engine, 'broker');
        await initGuestSource(engine, 'guests', [`legacy_token:${broker.id}`]);
        const put = result(await saveAs(engine, broker.auth, 'notes/guest-a', 'A note from Bob')) as Record<string, unknown>;
        expect(put).toMatchObject({ status: 'created_or_updated' });
        const read = result(await dispatchToolCall(engine, 'get_page', { slug: 'notes/guest-a' }, { remote: false, sourceId: 'guests' } as never)) as Record<string, unknown>;
        const page = (await engine.getPage('notes/guest-a', { sourceId: 'guests' }))!;
        const [trust] = await engine.readPageTrustRows({ keys: [{ source_id: 'guests', slug: 'notes/guest-a' }] });
        const [mark] = await engine.readGuestMarks([Number(page.id)]);
        const guest = read.guest as Record<string, unknown> | undefined;
        expect(mark).toBeDefined();
        expect(read.origin).toBe('guest');
        return {
          put: { noop: put.noop, slug: put.slug, status: put.status, source_id: put.source_id },
          read: { title: read.title, compiled_truth: read.compiled_truth, origin: read.origin ?? null,
            guest: guest ? { ...guest, saved_at: typeof guest.saved_at === 'string', writer: guest.writer === `legacy_token:${broker.id}` ? 'the broker' : guest.writer } : null },
          tier: trust?.trust_tier ?? null,
          mark: mark ? { sender_label: mark.sender_label, group_slug: mark.group_slug, audience_member: mark.audience_member, writer_kind: mark.writer_kind,
            writer_is_broker: mark.writer_id === broker.id, promoted: mark.promoted, saved_at: !Number.isNaN(new Date(mark.saved_at).getTime()) } : null,
        };
      } finally { await disposePersistenceConsumer(engine).catch(() => {}); }
    });

  parityTest('a writer not on the guest source is refused and saves nothing',
    { methods: ['getPage'] }, async (engine, backend) => {
      try {
        await seed(engine, backend);
        const listed = await brokerAuth(engine, 'broker');
        const outsider = await brokerAuth(engine, 'outsider');
        await initGuestSource(engine, 'guests', [`legacy_token:${listed.id}`]);
        const put = result(await saveAs(engine, outsider.auth, 'notes/guest-b', 'Not listed')) as Record<string, unknown>;
        const text = JSON.stringify(put);
        expect(text).toContain('source_writer_restricted');
        return { refused: text.includes('source_writer_restricted'), saved: (await engine.getPage('notes/guest-b', { sourceId: 'guests' })) !== null };
      } finally { await disposePersistenceConsumer(engine).catch(() => {}); }
    });
});
