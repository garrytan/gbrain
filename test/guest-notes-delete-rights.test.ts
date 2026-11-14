/**
 * Guest notes (GBRA-504): a guest writer deletes only what it wrote.
 *
 * Protects: a credential on a guest source's writer list may delete a guest note it saved, but not one another listed
 * writer saved (permission_denied, the page stays live), and not any page outside the guest source, through its own
 * context or by naming another source; the brain owner on the local CLI still deletes any guest note. Real seams:
 * legacy tokens granted only the guest source, dispatched through MCP dispatch on a repo-less PGLite brain.
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
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { readsUnscopedOnPurpose } from './helpers/reads-unscoped.ts';

const SRC = 'guests';
const PLAIN = 'source-a';
const OWNER = 'alice-example';
const META = { sender_label: 'Bob Example', group: 'team-a' };

let engine: PGLiteEngine;
const tokens: Record<string, { id: string; token: string }> = {};
const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
const parse = (text: string) => { try { return JSON.parse(text) as Record<string, unknown>; } catch { return {} as Record<string, unknown>; } };
const note = () => ['---', 'type: note', 'title: A note from Bob', 'readable_by: [' + OWNER + ', bob-example]', 'guest_group: team-a',
  'guest_sender: Bob Example', 'saved_at: 2026-11-13T10:00:00Z', '---', '# A note from Bob', '', 'Bob says hello.'].join('\n');

async function call(who: string, op: string, params: Record<string, unknown>, sourceId = SRC) {
  const auth = await provider().verifyAccessToken(tokens[who]!.token) as unknown as AuthInfo;
  const out = await dispatchToolCall(engine, op, { ...params }, { remote: true, transport: 'http', auth, sourceId, takesHoldersAllowList: ['world'],
    onBehalfOf: { header: 'bob-example' }, guest: { requestMeta: { guest: META } } });
  const json = parse(out.content.map(c => c.text).join('\n'));
  return { isError: out.isError === true, code: (json.code ?? json.error) as string | undefined };
}
async function local(op: string, params: Record<string, unknown>, sourceId = SRC) {
  const out = await dispatchToolCall(engine, op, { ...params }, { remote: false, sourceId });
  const json = parse(out.content.map(c => c.text).join('\n'));
  return { isError: out.isError === true, code: (json.code ?? json.error) as string | undefined };
}
const revisionOf = async (slug: string, sourceId = SRC) => (await engine.readPageSnapshot(slug, { sourceId, includeDeleted: true }))!.revision;
const deleted = async (slug: string, sourceId = SRC) => (await engine.executeRaw<{ d: boolean }>(
  'SELECT deleted_at IS NOT NULL AS d FROM pages WHERE source_id = $1 AND slug = $2', [sourceId, slug]))[0]?.d;
const slugOf = () => 'notes/guest-' + randomUUID().slice(0, 8);

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const id of [OWNER, 'bob-example']) await addMember(engine, id);
  await setOwner(engine, OWNER);
  await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [PLAIN]);
  await initGuestSource(engine, SRC, []);
  for (const name of ['broker-a', 'broker-b']) {
    const minted = await mintLegacyToken(engine, { name, scopes: ['read', 'write'], takesHolders: ['world'], sourceGrant: [SRC] });
    tokens[name] = { id: minted.id, token: minted.token };
    await bindCredential(engine, { kind: 'token', id: minted.id }, { mayActFor: ['member:bob-example', 'guest'] });
    await readsUnscopedOnPurpose(engine, minted.id);
    await changeGuestWriters(engine, SRC, { add: ['legacy_token:' + minted.id] });
  }
  const owned = await local('put_page', { slug: 'notes/owner-plan', content: '---\ntype: note\ntitle: Plan\n---\n# Plan\n\nThe owner plan.' }, PLAIN);
  expect(owned.isError).toBe(false);
}, 240_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); }, 60_000);

describe('guest writer delete rights (pglite, repo-less)', () => {
  test('a writer deletes its own guest note', async () => {
    const slug = slugOf();
    expect((await call('broker-a', 'put_page', { slug, content: note() })).isError).toBe(false);
    const del = await call('broker-a', 'delete_page', { slug, expected_revision: await revisionOf(slug) });
    expect({ isError: del.isError, code: del.code }).toEqual({ isError: false, code: undefined });
    expect(await deleted(slug)).toBe(true);
  }, 60_000);

  test("a writer cannot delete a guest note another writer saved; the owner still can", async () => {
    const slug = slugOf();
    expect((await call('broker-a', 'put_page', { slug, content: note() })).isError).toBe(false);
    const del = await call('broker-b', 'delete_page', { slug, expected_revision: await revisionOf(slug) });
    expect({ isError: del.isError, code: del.code }).toEqual({ isError: true, code: 'permission_denied' });
    expect(await deleted(slug)).toBe(false);
    const owner = await local('delete_page', { slug, expected_revision: await revisionOf(slug) });
    expect({ isError: owner.isError, code: owner.code }).toEqual({ isError: false, code: undefined });
    expect(await deleted(slug)).toBe(true);
  }, 60_000);

  test('a writer cannot delete a page outside the guest source', async () => {
    const viaContext = await call('broker-a', 'delete_page', { slug: 'notes/owner-plan', expected_revision: await revisionOf('notes/owner-plan', PLAIN) }, PLAIN);
    expect(viaContext.isError).toBe(true);
    const viaParam = await call('broker-a', 'delete_page', { slug: 'notes/owner-plan', source_id: PLAIN, expected_revision: await revisionOf('notes/owner-plan', PLAIN) });
    expect(viaParam.isError).toBe(true);
    expect(await deleted('notes/owner-plan', PLAIN)).toBe(false);
  }, 60_000);
});
