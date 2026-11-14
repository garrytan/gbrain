/**
 * Guest notes, slice 4 (GBRA-504): the owner keeps a guest note as an owner page.
 *
 * Protects: promote_guest_note, run by the owner (the trusted local CLI, a credential bound to the owner, or one that
 * speaks only for the owner), writes a normal page in the target source through the owner's own write path, with
 * 'promoted_from: <guest source>:<slug>' and the guest note's readers, records the link in guest_promotions, and leaves
 * the guest page and its mark unchanged; the guest row then reads 'guest.promoted: true'. Promoting again to the same
 * page writes nothing. Everyone else (the broker, a member, the owner's credential speaking for a group, an enforced
 * member) is refused guest_promotion_owner_only before anything is written. The broker's remote delete of a promoted
 * guest page is refused guest_page_promoted; of an unpromoted one it still works. 'gbrain guests promote' runs the same
 * op. All on a repo-less PGLite brain; one case promotes into a source with a git repository.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { addGroup, addMember, bindCredential } from '../src/core/access/members.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { changeGuestWriters, initGuestSource } from '../src/core/guests/sources.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { runGuests } from '../src/commands/guests.ts';
import { runSources } from '../src/commands/sources.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { readsUnscopedOnPurpose } from './helpers/reads-unscoped.ts';
import { explicitReadBinding } from '../src/core/source-resolver.ts';

const SRC = 'guests';
const PLAIN = 'source-a';
const OWNER = 'alice-example';
const META = { sender_label: 'Bob Example', group: 'team-a' };

let engine: PGLiteEngine;
const tokens: Record<string, { id: string; token: string }> = {};
const tmpDirs: string[] = [];
const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
const verify = async (who: string) => await provider().verifyAccessToken(tokens[who]!.token) as unknown as AuthInfo;
const parse = (text: string) => { try { return JSON.parse(text) as any; } catch { return {}; } };
const slugOf = () => 'guests/note-' + randomUUID().slice(0, 8);

const guestPage = (body: string) => ['---', 'type: note', 'title: Offsite moved', 'readable_by: [' + OWNER + ', group:team-a]',
  'guest_group: team-a', 'guest_sender: Bob Example', 'saved_at: 2026-11-13T10:00:00Z', '---', '# Offsite moved', '', body].join('\n');

async function call(who: string, op: string, params: Record<string, unknown>, opts: { audience?: string; sourceId?: string; meta?: boolean } = {}) {
  const out = await dispatchToolCall(engine, op, { ...params }, {
    remote: true, transport: 'http', auth: await verify(who), sourceId: opts.sourceId ?? SRC, takesHoldersAllowList: ['world'],
    ...(opts.audience ? { onBehalfOf: { header: opts.audience } } : {}),
    ...(opts.meta ? { guest: { requestMeta: { guest: META } } } : {}),
  });
  const text = out.content.map(c => c.text).join('\n');
  const json = parse(text);
  return { isError: out.isError === true, text, json, code: (json.code ?? json.error) as string | undefined };
}
async function local(op: string, params: Record<string, unknown>, sourceId = PLAIN) {
  const out = await dispatchToolCall(engine, op, { ...params }, { remote: false, sourceId });
  const text = out.content.map(c => c.text).join('\n');
  const json = parse(text);
  return { isError: out.isError === true, text, json, code: (json.code ?? json.error) as string | undefined };
}
async function saveGuest(slug: string, body = 'The offsite moved to Friday, note ' + slug + '.') {
  const out = await call('broker', 'put_page', { slug, content: guestPage(body) }, { audience: 'group:team-a', meta: true });
  expect({ slug, isError: out.isError, text: out.isError ? out.text : '' }).toEqual({ slug, isError: false, text: '' });
}
async function guestState(slug: string) {
  const [row] = await engine.executeRaw<{ id: number; content_hash: string; updated_at: string; frontmatter: unknown; deleted: boolean; mark: unknown }>(
    'SELECT p.id, p.content_hash, p.updated_at::text AS updated_at, p.frontmatter, p.deleted_at IS NOT NULL AS deleted, to_jsonb(m) AS mark '
      + 'FROM pages p LEFT JOIN guest_marks m ON m.page_id = p.id WHERE p.source_id = $1 AND p.slug = $2', [SRC, slug]);
  return row ?? null;
}
const promotions = async (slug: string) => engine.executeRaw<{ target_source_id: string; target_slug: string; promoted_by_kind: string }>(
  'SELECT g.target_source_id, g.target_slug, g.promoted_by_kind FROM guest_promotions g JOIN pages p ON p.id = g.guest_page_id '
    + 'WHERE p.source_id = $1 AND p.slug = $2 ORDER BY g.id', [SRC, slug]);
const revisionOf = async (slug: string) => (await engine.readPageSnapshot(slug, { sourceId: SRC, includeDeleted: true }))!.revision;
const fm = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v) as Record<string, unknown>;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const id of [OWNER, 'bob-example', 'carol-example']) await addMember(engine, id);
  await addGroup(engine, 'team-a', ['bob-example']);
  await setOwner(engine, OWNER);
  await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [PLAIN]);
  await importFromContent(engine, 'notes/owner-page', '---\ntype: note\ntitle: Owner page\n---\n# Owner page\n\nMine.\n', { sourceId: PLAIN });
  await initGuestSource(engine, SRC, []);
  const mint = async (name: string, grant: string[], binding: { member?: string; mayActFor?: string[] }) => {
    const minted = await mintLegacyToken(engine, { name, scopes: ['read', 'write'], takesHolders: ['world'], sourceGrant: grant });
    tokens[name] = { id: minted.id, token: minted.token };
    await bindCredential(engine, { kind: 'token', id: minted.id }, binding);
    if (!binding.member) await readsUnscopedOnPurpose(engine, minted.id);
  };
  await mint('broker', [SRC], { mayActFor: ['member:bob-example', 'group:team-a'] });
  await mint('owner', [PLAIN, SRC], { member: OWNER, mayActFor: ['group:team-a', 'member:' + OWNER] });
  await mint('bob', [PLAIN, SRC], { member: 'bob-example' });
  await changeGuestWriters(engine, SRC, { add: ['legacy_token:' + tokens.broker!.id] });
}, 240_000);
afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
}, 60_000);

describe('promote_guest_note (pglite, repo-less)', () => {
  test('the local owner promotes: a normal owner page, a guest_promotions row, the guest page and mark unchanged', async () => {
    const slug = slugOf();
    await saveGuest(slug);
    const before = await guestState(slug);
    const out = await local('promote_guest_note', { slug, to: 'notes/offsite' });
    expect({ isError: out.isError, text: out.isError ? out.text : '' }).toEqual({ isError: false, text: '' });
    expect(out.json).toMatchObject({ status: 'promoted', guest: { source_id: SRC, slug }, page: { source_id: PLAIN, slug: 'notes/offsite' } });
    const page = await engine.getPage('notes/offsite', { sourceId: PLAIN });
    expect(page).not.toBeNull();
    expect(page!.compiled_truth).toContain('The offsite moved to Friday, note ' + slug);
    expect(fm(page!.frontmatter)).toMatchObject({ promoted_from: SRC + ':' + slug, readable_by: [OWNER, 'group:team-a'] });
    expect(fm(page!.frontmatter).guest_sender).toBeUndefined();
    const [tier] = await engine.executeRaw<{ trust_tier: string }>('SELECT trust_tier FROM pages WHERE source_id=$1 AND slug=$2', [PLAIN, 'notes/offsite']);
    expect(tier!.trust_tier).not.toBe('external_untrusted');
    expect(await promotions(slug)).toEqual([{ target_source_id: PLAIN, target_slug: 'notes/offsite', promoted_by_kind: 'local_cli' }]);
    expect(await guestState(slug)).toEqual(before);
    const read = await call('owner', 'get_page', { slug });
    expect({ origin: read.json.origin, promoted: read.json.guest?.promoted }).toEqual({ origin: 'guest', promoted: true });
    const again = await local('promote_guest_note', { slug, to: 'notes/offsite' });
    expect({ isError: again.isError, status: again.json.status }).toEqual({ isError: false, status: 'already_promoted' });
    expect((await promotions(slug)).length).toBe(1);
  }, 120_000);

  test('a credential bound to the owner promotes into its write source, and so do one speaking only for the owner and an owner-bound stdio server', async () => {
    const slug = slugOf();
    await saveGuest(slug);
    const out = await call('owner', 'promote_guest_note', { slug }, { sourceId: PLAIN });
    expect({ isError: out.isError, text: out.isError ? out.text : '' }).toEqual({ isError: false, text: '' });
    expect(out.json).toMatchObject({ status: 'promoted', page: { source_id: PLAIN, slug } });
    expect(await promotions(slug)).toEqual([{ target_source_id: PLAIN, target_slug: slug, promoted_by_kind: 'legacy_token' }]);
    const second = slugOf();
    await saveGuest(second);
    const self = await call('owner', 'promote_guest_note', { slug: second, to: 'notes/kept-' + second.slice(-8) }, { sourceId: PLAIN, audience: 'member:' + OWNER });
    expect({ isError: self.isError, text: self.isError ? self.text : '' }).toEqual({ isError: false, text: '' });
    const third = slugOf();
    await saveGuest(third);
    const stdio = await dispatchToolCall(engine, 'promote_guest_note', { slug: third, to: 'notes/kept-' + third.slice(-8) }, {
      remote: true, transport: 'stdio', stdioMember: OWNER, sourceId: PLAIN, localFederatedSourceIds: [PLAIN, SRC], takesHoldersAllowList: ['world'] });
    expect({ isError: stdio.isError === true, text: stdio.isError ? stdio.content[0]!.text : '' }).toEqual({ isError: false, text: '' });
    expect((await promotions(third))[0]?.promoted_by_kind).toBe('local_stdio');
  }, 120_000);

  test('a stdio connection bound to a source that cannot read the guest source cannot promote from it', async () => {
    const slug = slugOf();
    await saveGuest(slug);
    const isolated = 'source-isolated';
    await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ($1, $1, '{"federated": false}'::jsonb) ON CONFLICT (id) DO NOTHING`, [isolated]);
    const binding = await explicitReadBinding(engine, isolated, 'env');
    expect(binding?.sourceIds).toEqual([isolated]);
    const opts = { remote: true, transport: 'stdio' as const, stdioMember: OWNER, sourceId: isolated, explicitReadBinding: binding, takesHoldersAllowList: ['world'] };
    const read = parse((await dispatchToolCall(engine, 'get_page', { slug, source_id: SRC }, opts)).content[0]!.text);
    expect(read.code ?? read.error).toBeDefined();
    const out = await dispatchToolCall(engine, 'promote_guest_note', { slug, to: 'notes/bound-' + slug.slice(-8) }, opts);
    expect(out.isError).toBe(true);
    expect(await promotions(slug)).toEqual([]);
    expect(await engine.getPage('notes/bound-' + slug.slice(-8), { sourceId: isolated })).toBeNull();
  }, 120_000);

  test('a promotion whose link was lost is finished by promoting again, with no second write', async () => {
    const slug = slugOf();
    const target = 'notes/recover-' + slug.slice(-8);
    await saveGuest(slug);
    expect((await local('promote_guest_note', { slug, to: target })).isError).toBe(false);
    await engine.executeRaw('DELETE FROM guest_promotions WHERE target_source_id = $1 AND target_slug = $2', [PLAIN, target]);
    const before = (await engine.readPageSnapshot(target, { sourceId: PLAIN }))!.revision;
    const again = await local('promote_guest_note', { slug, to: target });
    expect({ isError: again.isError, text: again.isError ? again.text : '', status: again.json.status }).toEqual({ isError: false, text: '', status: 'promoted' });
    expect(await promotions(slug)).toEqual([{ target_source_id: PLAIN, target_slug: target, promoted_by_kind: 'local_cli' }]);
    expect((await engine.readPageSnapshot(target, { sourceId: PLAIN }))!.revision).toBe(before);
  }, 120_000);

  test('a target page that was not promoted from this note is not linked', async () => {
    const slug = slugOf();
    await saveGuest(slug);
    expect((await local('promote_guest_note', { slug, to: 'notes/owner-page' })).isError).toBe(true);
    expect(await promotions(slug)).toEqual([]);
  }, 120_000);

  test('everyone else is guest_promotion_owner_only and nothing is written', async () => {
    const slug = slugOf();
    await saveGuest(slug);
    const refusals = {
      broker: (await call('broker', 'promote_guest_note', { slug }, { audience: 'group:team-a' })).code,
      member: (await call('bob', 'promote_guest_note', { slug }, { sourceId: PLAIN })).code,
      owner_for_group: (await call('owner', 'promote_guest_note', { slug }, { sourceId: PLAIN, audience: 'group:team-a' })).code,
      enforced_member: parse((await dispatchToolCall(engine, 'promote_guest_note', { slug }, {
        remote: true, transport: 'stdio', stdioMember: OWNER, enforcedMember: true, sourceId: PLAIN, takesHoldersAllowList: ['world'] })).content[0]!.text).code,
    };
    expect(refusals).toEqual({ broker: 'guest_promotion_owner_only', member: 'guest_promotion_owner_only',
      owner_for_group: 'guest_promotion_owner_only', enforced_member: 'guest_promotion_owner_only' });
    const prior = process.env.GBRAIN_ENFORCED_MEMBER;
    process.env.GBRAIN_ENFORCED_MEMBER = OWNER;
    try { expect((await local('promote_guest_note', { slug })).code).toBe('guest_promotion_owner_only'); }
    finally { if (prior === undefined) delete process.env.GBRAIN_ENFORCED_MEMBER; else process.env.GBRAIN_ENFORCED_MEMBER = prior; }
    expect(await promotions(slug)).toEqual([]);
    expect(await engine.getPage(slug, { sourceId: PLAIN })).toBeNull();
  }, 120_000);

  test('a page that is not a live guest note, or a guest source as the target, is refused', async () => {
    expect((await local('promote_guest_note', { slug: 'notes/owner-page' })).code).toBe('page_not_found');
    const slug = slugOf();
    await saveGuest(slug);
    expect((await local('promote_guest_note', { slug, source_id: SRC })).code).toBe('invalid_params');
    expect(await promotions(slug)).toEqual([]);
  }, 60_000);

  test("the broker's delete of a promoted guest page is guest_page_promoted; of another guest page it still works", async () => {
    const kept = slugOf();
    const plain = slugOf();
    await saveGuest(kept);
    await saveGuest(plain);
    expect((await local('promote_guest_note', { slug: kept, to: 'notes/kept-' + kept.slice(-8) })).isError).toBe(false);
    const refused = await call('broker', 'delete_page', { slug: kept, expected_revision: await revisionOf(kept) }, { audience: 'group:team-a' });
    expect(refused.code).toBe('guest_page_promoted');
    expect((await guestState(kept))?.deleted).toBe(false);
    const deleted = await call('broker', 'delete_page', { slug: plain, expected_revision: await revisionOf(plain) }, { audience: 'group:team-a' });
    expect({ isError: deleted.isError, text: deleted.isError ? deleted.text : '' }).toEqual({ isError: false, text: '' });
    expect((await guestState(plain))?.deleted).toBe(true);
    const owner = await local('delete_page', { slug: kept, expected_revision: await revisionOf(kept) }, SRC);
    expect({ isError: owner.isError, text: owner.isError ? owner.text : '' }).toEqual({ isError: false, text: '' });
  }, 120_000);

  test('promotion into a source with a git repository writes the page file there', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-guest-promote-'));
    tmpDirs.push(dir);
    execSync('git init -q && git config user.email t@t && git config user.name t && echo seed > README.md && git add README.md && git commit -q -m seed', { cwd: dir });
    await runSources(engine, ['add', 'repo-a', '--path', dir, '--no-federated']);
    const slug = slugOf();
    await saveGuest(slug);
    const out = await local('promote_guest_note', { slug, to: 'notes/from-guest' }, 'repo-a');
    expect({ isError: out.isError, text: out.isError ? out.text : '' }).toEqual({ isError: false, text: '' });
    const file = join(dir, 'notes', 'from-guest.md');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('promoted_from: ' + SRC + ':' + slug);
  }, 120_000);
});

describe('gbrain guests promote', () => {
  let out: string[] = [];
  let spies: Array<{ mockRestore: () => void }> = [];
  afterEach(() => { for (const s of spies) s.mockRestore(); spies = []; out = []; });

  test('runs the same op as the trusted local CLI and prints the owner page', async () => {
    spies = [spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); })];
    const slug = slugOf();
    await saveGuest(slug);
    await runGuests(engine, ['promote', slug, '--to', 'notes/cli-kept', '--source', PLAIN]);
    expect(out.join('\n')).toContain(PLAIN + ':notes/cli-kept');
    expect(await promotions(slug)).toEqual([{ target_source_id: PLAIN, target_slug: 'notes/cli-kept', promoted_by_kind: 'local_cli' }]);
    expect(operationsByName.promote_guest_note?.mutating).toBe(true);
  }, 120_000);
});
