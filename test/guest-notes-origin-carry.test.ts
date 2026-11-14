/**
 * Guest notes (GBRA-504) against the origin carry (GST-2689): before a deleted page's row goes, the purge labels
 * private every page that page alone kept private, through the label door.
 *
 * 1. Protects: the carry never labels a guest note, and the guest gate never refuses one of its writes, so no origin
 *    is parked for good. A guest page's frontmatter allowlist has none of the keys that tie a page to an origin, a
 *    guest write naming derived_from is refused, and the owner's purge of a private origin labels its owner-source
 *    dependent while every guest note keeps its revision. The owner's explicit and retention purges of a guest note
 *    remove it with no hold and no park. The one way a guest source held a page the carry would label was a source made
 *    a guest source while it held deleted pages, then restored; test/guests-cli.test.ts pins init refusing that.
 * 2. Fails when: a tie key joins the allowlist, a guest note changes during a carry, or a guest note's purge is held or parked.
 * 3. Real seams: legacy tokens on the guest source's writer list through MCP dispatch, local dispatch for the owner, on
 *    a repo-less PGLite brain.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { addMember, bindCredential } from '../src/core/access/members.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { changeGuestWriters, initGuestSource } from '../src/core/guests/sources.ts';
import { GUEST_FRONTMATTER_KEYS } from '../src/core/guests/admission.ts';
import { readDerivedOriginParks } from '../src/core/persistence/derived-origin-hold.ts';
import { purgeDeletedPagesCoordinated } from '../src/core/persistence/purge-deleted.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { readsUnscopedOnPurpose } from './helpers/reads-unscoped.ts';

const SRC = 'guests';
const PLAIN = 'source-a';
const OWNER = 'alice-example';
const META = { sender_label: 'Bob Example', group: 'team-a' };

let engine: PGLiteEngine;
let token = '';
const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
const parse = (text: string) => { try { return JSON.parse(text) as Record<string, unknown>; } catch { return {} as Record<string, unknown>; } };
const note = (extra: string[] = [], body = 'Bob says hello.') => ['---', 'type: note', 'title: A note from Bob', 'readable_by: [' + OWNER + ', bob-example]', 'guest_group: team-a',
  'guest_sender: Bob Example', 'saved_at: 2026-11-13T10:00:00Z', ...extra, '---', '# A note from Bob', '', body].join('\n');

async function guest(op: string, params: Record<string, unknown>) {
  const auth = await provider().verifyAccessToken(token) as unknown as AuthInfo;
  const out = await dispatchToolCall(engine, op, { ...params }, { remote: true, transport: 'http', auth, sourceId: SRC, takesHoldersAllowList: ['world'],
    onBehalfOf: { header: 'bob-example' }, guest: { requestMeta: { guest: META } } });
  const json = parse(out.content.map(c => c.text).join('\n'));
  return { isError: out.isError === true, code: (json.code ?? json.error) as string | undefined };
}
async function local(op: string, params: Record<string, unknown>, sourceId = SRC) {
  const out = await dispatchToolCall(engine, op, { ...params }, { remote: false, sourceId });
  return { isError: out.isError === true, json: parse(out.content.map(c => c.text).join('\n')) };
}
const snapshot = (slug: string, sourceId = SRC) => engine.readPageSnapshot(slug, { sourceId, includeDeleted: true });
const revisionOf = async (slug: string, sourceId = SRC) => (await snapshot(slug, sourceId))!.revision;
const rowCount = async (slug: string, sourceId = SRC) => (await engine.executeRaw<{ n: number }>(
  'SELECT count(*)::int AS n FROM pages WHERE source_id = $1 AND slug = $2', [sourceId, slug]))[0]!.n;
const slugOf = () => 'notes/guest-' + randomUUID().slice(0, 8);
async function savedGuestNote(): Promise<string> {
  const slug = slugOf();
  const saved = await guest('put_page', { slug, content: note([], `Bob says hello about ${slug}.`) });
  expect({ isError: saved.isError, code: saved.code }).toEqual({ isError: false, code: undefined });
  return slug;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const id of [OWNER, 'bob-example']) await addMember(engine, id);
  await setOwner(engine, OWNER);
  await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [PLAIN]);
  await initGuestSource(engine, SRC, []);
  const minted = await mintLegacyToken(engine, { name: 'broker-a', scopes: ['read', 'write'], takesHolders: ['world'], sourceGrant: [SRC] });
  token = minted.token;
  await bindCredential(engine, { kind: 'token', id: minted.id }, { mayActFor: ['member:bob-example', 'guest'] });
  await readsUnscopedOnPurpose(engine, minted.id);
  await changeGuestWriters(engine, SRC, { add: ['legacy_token:' + minted.id] });
}, 240_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); }, 60_000);

describe('the origin carry and guest notes (pglite, repo-less)', () => {
  test('a guest page can carry none of the keys that tie a page to an origin', async () => {
    expect(GUEST_FRONTMATTER_KEYS.filter(key => ['derived_from', 'source_slug', 'event', 'synthesized_by'].includes(key))).toEqual([]);
    const refused = await guest('put_page', { slug: slugOf(), content: note(['derived_from: notes/owner-origin.md']) });
    expect({ isError: refused.isError, code: refused.code }).toEqual({ isError: true, code: 'guest_frontmatter_refused' });
  }, 60_000);

  test("the owner's purge of a private origin labels its derived page and leaves every guest note unchanged", async () => {
    const kept = await savedGuestNote();
    const before = await revisionOf(kept);
    expect((await local('put_page', { slug: 'notes/owner-origin', content: '---\ntype: note\nvisibility: private\n---\n# Origin\n\nPrivate plan.' }, PLAIN)).isError).toBe(false);
    expect((await local('put_page', { slug: 'notes/owner-digest', content: '---\ntype: note\nderived_from: notes/owner-origin.md\n---\n# Digest\n\nA digest.' }, PLAIN)).isError).toBe(false);
    const purge = await local('delete_page', { slug: 'notes/owner-origin', purge: true, expected_revision: await revisionOf('notes/owner-origin', PLAIN) }, PLAIN);
    expect({ isError: purge.isError, status: purge.json.status, held: purge.json.purge_held }).toEqual({ isError: false, status: 'purged', held: undefined });
    expect((await snapshot('notes/owner-digest', PLAIN))!.page.frontmatter.visibility).toBe('private');
    expect(await revisionOf(kept)).toBe(before);
    expect(await readDerivedOriginParks(engine)).toEqual([]);
  }, 120_000);

  test("the owner's explicit purge of a guest note removes it with no hold and no park", async () => {
    const slug = await savedGuestNote();
    const purge = await local('delete_page', { slug, purge: true, expected_revision: await revisionOf(slug) });
    expect({ isError: purge.isError, status: purge.json.status, held: purge.json.purge_held }).toEqual({ isError: false, status: 'purged', held: undefined });
    expect(await rowCount(slug)).toBe(0);
    expect(await readDerivedOriginParks(engine)).toEqual([]);
  }, 120_000);

  test('the retention purge of an expired guest note removes it with no park', async () => {
    const slug = await savedGuestNote();
    expect((await local('delete_page', { slug, expected_revision: await revisionOf(slug) })).isError).toBe(false);
    await engine.executeRaw("UPDATE pages SET deleted_at = now() - interval '200 hours' WHERE source_id = $1 AND slug = $2", [SRC, slug]);
    const run = await purgeDeletedPagesCoordinated(engine, 72);
    expect({ purged: run.slugs.includes(slug), blocked: run.blocked.filter(b => b.slug === slug) }).toEqual({ purged: true, blocked: [] });
    expect(await rowCount(slug)).toBe(0);
    expect(await readDerivedOriginParks(engine)).toEqual([]);
  }, 120_000);
});
