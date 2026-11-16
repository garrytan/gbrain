/**
 * Guest notes, slice 4 (GBRA-504): a guest mark reaches only a caller whose own read policy admits the note.
 *
 * Protects: the stamp (guests/stamp.ts) decides per referenced page what get_page decides for that caller (source
 * grant, readable_by and folder rules, privacy labels; a soft-deleted note under the same rules). A reference the
 * caller cannot read gets no stamp at all, not even the unattributed form, so a stored object naming a guest note by
 * source_id and slug (a raw-data payload, a frontmatter value) or by page_id cannot read back its sender, group,
 * audience or date. The local CLI and an owner-bound credential still see every mark with its writer. Output
 * redaction runs after the stamp, so a key-like sender label is redacted for remote readers; only the writer of a mark
 * the stamp built passes it, never a `writer` field elsewhere or a stored look-alike.
 *
 * Real seams: legacy tokens bound by the member functions, MCP dispatch on a repo-less PGLite brain.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { addGroup, addMember, bindCredential, memberIdentity } from '../src/core/access/members.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { changeGuestWriters, initGuestSource } from '../src/core/guests/sources.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withCallerAccess } from '../src/core/search/private-visibility.ts';
import { exemptGuestWriter, withOutputRedaction } from '../src/core/search/output-redaction.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { readsUnscopedOnPurpose } from './helpers/reads-unscoped.ts';
import { stampGuestNotes } from '../src/core/guests/stamp.ts';

const SRC = 'guests';
const PLAIN = 'source-a';
const OWNER = 'alice-example';
const HOST = 'notes/owner-plan';
const GUEST = 'notes/guest-live';
const GONE = 'notes/guest-gone';
const KEYED = 'notes/guest-keyed';
const SENDER = 'Bob Example';
/** A key-shaped sender label admission accepts (built here so no scanner reads a literal key in this file). */
const KEY = 'sk-ant-' + 'supersecret-123456';

let engine: PGLiteEngine;
const tokens: Record<string, { id: string; token: string }> = {};
const ids: Record<string, number> = {};
let writer = '';
const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
const verify = async (who: string) => await provider().verifyAccessToken(tokens[who]!.token) as unknown as AuthInfo;

type Who = 'local' | 'owner' | 'bob' | 'carol' | 'dave';
async function call(who: Who, op: string, args: Record<string, unknown>, sourceId = PLAIN) {
  const opts = who === 'local'
    ? { remote: false, sourceId }
    : { remote: true, transport: 'http', auth: await verify(who), sourceId, takesHoldersAllowList: ['world'] };
  const out = await dispatchToolCall(engine, op, args, opts as never);
  return { isError: out.isError === true, text: out.content.map(c => c.text).join('\n') };
}
/** A trusted local read previewing a member's view (the CLI's --as): local output carries no quote fences. */
async function preview(member: string, op: string, args: Record<string, unknown>) {
  const { identity } = await memberIdentity(engine, member);
  const out = await withCallerAccess({ identity, applyRemoteReadPolicy: true, hidePrivate: true, privateReadableSources: [] },
    () => dispatchToolCall(engine, op, args, { remote: false, sourceId: PLAIN }));
  return { isError: out.isError === true, text: out.content.map(c => c.text).join('\n') };
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
/** Every guest object stamped anywhere in a JSON answer, with the slug or page_id of the item it sits on. */
function stamps(text: string): Array<{ at: string; guest: Record<string, unknown> }> {
  const out: Array<{ at: string; guest: Record<string, unknown> }> = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!isObj(v)) return;
    if (v.origin === 'guest' && isObj(v.guest)) out.push({ at: String(v.slug ?? v.page_id), guest: v.guest });
    for (const x of Object.values(v)) walk(x);
  };
  try { walk(JSON.parse(text)); } catch { /* not JSON */ }
  return out;
}

async function guestPut(slug: string, label: string) {
  const content = ['---', 'type: note', 'title: Guest ' + slug, 'readable_by: [' + OWNER + ', bob-example]', 'guest_group: team-a',
    'guest_sender: ' + JSON.stringify(label), 'saved_at: 2026-11-13T10:00:00Z', '---', '# Guest ' + slug, '', 'Bob says the offsite moved to Friday.'].join('\n');
  const put = await dispatchToolCall(engine, 'put_page', { slug, content }, { remote: true, transport: 'http', auth: await verify('broker'), sourceId: SRC,
    takesHoldersAllowList: ['world'], onBehalfOf: { header: 'bob-example' }, guest: { requestMeta: { guest: { sender_label: label, group: 'team-a' } } } });
  expect(put.isError).not.toBe(true);
  const [row] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id = $1 AND slug = $2', [SRC, slug]);
  ids[slug] = Number(row!.id);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const id of [OWNER, 'bob-example', 'carol-example', 'dave-example']) await addMember(engine, id);
  await addGroup(engine, 'team-a', ['bob-example']);
  await addGroup(engine, 'team-b', ['dave-example']);
  await setOwner(engine, OWNER);
  await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [PLAIN]);
  await importFromContent(engine, HOST, '---\ntype: note\ntitle: Owner plan\nref:\n  source_id: ' + SRC + '\n  slug: ' + GUEST + '\n---\n# Owner plan\n\nThe owner plans the harbor review.\n', { sourceId: PLAIN });
  await initGuestSource(engine, SRC, []);
  const mint = async (name: string, grant: string[], binding: { member?: string; mayActFor?: string[] }) => {
    const minted = await mintLegacyToken(engine, { name, scopes: ['read', 'write'], takesHolders: ['world'], sourceGrant: grant });
    tokens[name] = { id: minted.id, token: minted.token };
    await bindCredential(engine, { kind: 'token', id: minted.id }, binding);
    if (!binding.member) await readsUnscopedOnPurpose(engine, minted.id);
  };
  await mint('broker', [SRC], { mayActFor: ['member:bob-example'] });
  await mint('owner', [SRC, PLAIN], { member: OWNER });
  await mint('bob', [SRC], { member: 'bob-example' });
  await mint('carol', [PLAIN], { member: 'carol-example' });
  await mint('dave', [SRC, PLAIN], { member: 'dave-example' });
  await changeGuestWriters(engine, SRC, { add: ['legacy_token:' + tokens.broker!.id] });
  await guestPut(GUEST, SENDER);
  await guestPut(GONE, SENDER);
  await guestPut(KEYED, KEY);
  const [m] = await engine.executeRaw<{ writer_kind: string; writer_id: string }>('SELECT writer_kind, writer_id FROM guest_marks WHERE page_id = $1', [ids[GUEST]]);
  writer = m!.writer_kind + ':' + m!.writer_id;
  // A soft-deleted guest note. Guest pages refuse ordinary edits, so the fixture sets the tombstone with triggers off.
  await engine.transaction(async tx => {
    await tx.executeRaw('SET LOCAL session_replication_role = replica');
    await tx.executeRaw('UPDATE pages SET deleted_at = now() WHERE id = $1', [ids[GONE]]);
  });
  // A source-a-only credential stores an object naming the guest notes by source_id and slug and by page_id. The owner
  // plan's frontmatter names one too.
  const payload = { live: { source_id: SRC, slug: GUEST }, gone: { source_id: SRC, slug: GONE }, by_id: { page_id: ids[GUEST] } };
  expect((await call('carol', 'put_raw_data', { slug: HOST, source: 'probe', data: payload })).isError).toBe(false);
}, 240_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); }, 60_000);

describe('guest marks reach only callers who can read the note', () => {
  test('(a) a credential without the guest source reads no mark through a stored raw-data payload', async () => {
    expect((await call('carol', 'get_page', { slug: GUEST, source_id: SRC })).isError).toBe(true);
    const raw = await call('carol', 'get_raw_data', { slug: HOST });
    expect(raw.text).toContain(GUEST);
    expect(stamps(raw.text)).toEqual([]);
    for (const leak of ['"origin":"guest"', '"guest":', SENDER, 'team-a', 'external_untrusted']) expect(raw.text).not.toContain(leak);
  });

  test('(b) a member of another group with the guest source in its grant, outside readable_by, reads no mark', async () => {
    expect((await call('dave', 'get_page', { slug: GUEST, source_id: SRC })).isError).toBe(true);
    const raw = await call('dave', 'get_raw_data', { slug: HOST });
    expect(raw.text).toContain(GUEST);
    expect(stamps(raw.text)).toEqual([]);
    for (const leak of ['"origin":"guest"', '"guest":', SENDER, 'team-a']) expect(raw.text).not.toContain(leak);
    // A frontmatter value naming the note, through a read that prints it unfenced: a local preview of that member's view.
    expect((await preview('dave-example', 'get_page', { slug: GUEST, source_id: SRC })).isError).toBe(true);
    const page = await preview('dave-example', 'get_page', { slug: HOST });
    expect(page.isError).toBe(false);
    expect(page.text).toContain(GUEST);
    expect(stamps(page.text)).toEqual([]);
    for (const leak of ['"origin":"guest"', SENDER, 'team-a']) expect(page.text).not.toContain(leak);
  });

  test('(c) a soft-deleted guest note is marked only for a caller whose read policy admits it', async () => {
    expect((await call('carol', 'get_page', { slug: GONE, source_id: SRC, include_deleted: true })).isError).toBe(true);
    expect((await call('dave', 'get_page', { slug: GONE, source_id: SRC, include_deleted: true })).isError).toBe(true);
    for (const who of ['carol', 'dave'] as const) {
      const raw = await call(who, 'get_raw_data', { slug: HOST });
      expect(raw.text).toContain(GONE);
      expect(stamps(raw.text).filter(s => s.at === GONE)).toEqual([]);
    }
    const owner = await call('owner', 'get_raw_data', { slug: HOST });
    expect(stamps(owner.text).filter(s => s.at === GONE).map(s => s.guest.sender)).toEqual([SENDER]);
  });

  test('(d) the local CLI and an owner-bound credential still see every mark with its writer', async () => {
    for (const who of ['local', 'owner'] as const) {
      const raw = await call(who, 'get_raw_data', { slug: HOST });
      const found = stamps(raw.text);
      expect(found.map(s => s.at).sort()).toEqual([GONE, GUEST, String(ids[GUEST])].sort());
      for (const s of found) expect(s.guest).toMatchObject({ sender: SENDER, group: 'team-a', audience_member: 'member:bob-example', writer });
    }
    expect(stamps((await call('local', 'get_page', { slug: HOST })).text).map(s => s.guest.writer)).toEqual([writer]);
    expect(stamps((await preview('bob-example', 'get_raw_data', { slug: HOST })).text).map(s => s.at).sort()).toEqual([GONE, GUEST, String(ids[GUEST])].sort());
  });

  test("(g) a result the stamp cannot copy refuses the read and leaves the handler's own object unmarked", async () => {
    const own = { source_id: SRC, slug: GUEST, title: 'held by the handler', render: () => 'not cloneable' };
    const outcome = await stampGuestNotes({ engine, remote: false, sourceId: SRC } as never, own).then(() => 'stamped', (e: Error) => e.message);
    expect({ refused: outcome.includes('could not copy'), origin: (own as Record<string, unknown>).origin, guest: (own as Record<string, unknown>).guest })
      .toEqual({ refused: true, origin: undefined, guest: undefined });
  });

  test('(e) output redaction runs after the stamp, so a key-like sender label is redacted for a remote reader', async () => {
    const listed = await call('bob', 'list_pages', {}, SRC);
    const keyed = stamps(listed.text).filter(s => s.at === KEYED);
    expect(keyed.length).toBe(1);
    expect(listed.text).not.toContain(KEY);
    expect(String(keyed[0]!.guest.sender)).toContain('<REDACTED:');
    const plain = stamps(listed.text).filter(s => s.at === GUEST);
    expect(plain.map(s => s.guest.sender)).toEqual([SENDER]);
  });

  test('(f) only the stamp-built guest.writer passes redaction; another writer field that looks like a secret does not', async () => {
    const owner = await call('owner', 'list_pages', {}, SRC);
    expect(stamps(owner.text).filter(s => s.at === GUEST).map(s => s.guest.writer)).toEqual([writer]);
    const handler = withOutputRedaction({ outputRedaction: 'retrieval', handler: async () => ({
      writer: KEY,
      owner_style: { writer },
      forged: { slug: 'notes/look-alike', origin: 'guest', guest: { sender: SENDER, writer: KEY } },
      stamped: { slug: GUEST, origin: 'guest', guest: exemptGuestWriter({ sender: KEY, writer }) },
    }) });
    const out = await handler({ engine, remote: true, sourceId: SRC } as never, {}) as Record<string, Record<string, Record<string, unknown>>>;
    expect(String(out.writer)).toContain('<REDACTED:');
    expect(String(out.owner_style!.writer)).toContain('<REDACTED:');
    expect(String(out.forged!.guest!.writer)).toContain('<REDACTED:');
    expect(out.stamped!.guest!.writer).toBe(writer);
    expect(String(out.stamped!.guest!.sender)).toContain('<REDACTED:');
  });
});
