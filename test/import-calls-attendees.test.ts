/**
 * GST-2904 (GBRA-592, decisions K to O): `gbrain import --calls` keeps each call to the brain owner plus the teammates its
 * header names, on a brain that serves two or more people, and imports open as before whenever an owner caller could
 * lose it (calls_not_scoped).
 *
 * Authoring gate:
 *  1. Protects: a teammate who was not on a call gets not_found and no search hit for it, while the attendees, the owner's
 *     local CLI and every owner caller kind (bound token, bound OAuth client, bound stdio, attested owner, owner-alone
 *     audience) read it; a one-person brain imports byte-identical pages; matching is exact and fails closed.
 *  2. Fails on: a call readable by a non-attendee, any owner caller losing a call, a guessed or name-fallback match, a
 *     call scoped while an unbound reader could be the owner's, readers dropped by a later local write.
 *  3. Real seams: runCallImport on a repo-less brain (PGLite, and Postgres through test/e2e), tokens and clients verified
 *     by the serve --http verifier, reads through MCP dispatch with remote: true. Placeholder names only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runCallImport } from '../src/commands/import-calls.ts';
import { callReadersFor, parseCallAttendees } from '../src/core/meetings/attendees.ts';
import { callScopeGate, type UnboundStdio } from '../src/core/access/call-scope.ts';
import { _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { clearOwner, setOwner } from '../src/core/access/owner.ts';
import { bindCredential, type MemberRecord } from '../src/core/access/members.ts';
import { linkMember } from '../src/core/access/actor.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { readsUnscopedOnPurpose } from './helpers/reads-unscoped.ts';
import { withEnv } from './helpers/with-env.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer, startPersistenceConsumer } from '../src/core/persistence/service.ts';

const SRC = 'company';
const OWNER = 'owner-example';
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const temp = (prefix: string): string => { const d = realpathSync(mkdtempSync(join(tmpdir(), prefix))); roots.push(d); return d; };
const NO_STDIO = (): UnboundStdio[] => [];

/** The audit's four call shapes, plus a call with no list, in placeholder names. */
const CALLS: Record<string, string> = {
  '2026-11-12 hiring debrief.md': '# Hiring debrief\nDate: 2026-11-12\nAttendees: owner, carol-example\n\ncarol-example: strong on systems design.\nowner: The band is canaryhiringband 210k to 240k base.\n',
  '2026-11-11 pricing review.txt': 'Pricing review\nDate: 2026-11-11\nAttendees: Alice Example, bob-example\n\nbob-example: canarypricing annual billing.\n',
  '2026-11-10 weekly eng sync.md': '**Participants:** bob-example; Carol <carol@acme-example.test>\n\nbob-example: canaryengsync deploy on Tuesday.\n',
  '2026-11-09 acme renewal.md': 'Acme renewal\nAttendees: alice-example, dave-example (acme-example procurement)\n\nalice-example: canaryrenewal renew at the same price.\n',
  '2026-11-08 standup.txt': 'Standup\nalice-example: canarystandup shipping today.\nAttendees: bob-example\n',
};
const SLUG = {
  debrief: 'company/calls/2026-11-12-hiring-debrief',
  pricing: 'company/calls/2026-11-11-pricing-review',
  eng: 'company/calls/2026-11-10-weekly-eng-sync',
  renewal: 'company/calls/2026-11-09-acme-renewal',
  standup: 'company/calls/2026-11-08-standup',
};

function writeCalls(dir: string, names = Object.keys(CALLS)): void {
  for (const name of names) writeFileSync(join(dir, name), CALLS[name]!);
}

async function importJson(engine: BrainEngine, dir: string, extra: string[] = [], unboundStdio = NO_STDIO): Promise<any> {
  _resetCliExitVerdictForTests();
  const chunks: string[] = [];
  const spy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { chunks.push(a.map(String).join(' ')); });
  try { await runCallImport(engine, dir, ['--calls', '--prefix', 'company/calls', ...extra], { sourceId: SRC, json: true, unboundStdio }); } finally { spy.mockRestore(); }
  __resetPrivateVisibilityCacheForTests();
  return JSON.parse(chunks.join(''));
}

const member = (id: string, extra: Partial<MemberRecord> = {}): MemberRecord => ({ id, display_name: null, email: null, status: 'enabled', kind: 'person', labelled_only: false, groups: [], created_at: null, ...extra });

describe('call header and exact matching', () => {
  test('only the header counts: a frontmatter key, an Attendees or Participants line before the first turn or blank line', () => {
    expect(parseCallAttendees(CALLS['2026-11-12 hiring debrief.md']!)?.map(a => a.entry)).toEqual(['owner', 'carol-example']);
    expect(parseCallAttendees(CALLS['2026-11-10 weekly eng sync.md']!)).toEqual([{ entry: 'bob-example' }, { entry: 'Carol <carol@acme-example.test>', email: 'carol@acme-example.test' }]);
    expect(parseCallAttendees('---\nattendees: [alice-example, bob-example]\n---\nhi\n')?.map(a => a.entry)).toEqual(['alice-example', 'bob-example']);
    expect(parseCallAttendees('---\nattendees: ["Smith, Alice", \'bob-example\']\n---\nhi\n')?.map(a => a.entry)).toEqual(['Smith, Alice', 'bob-example']);
    expect(callReadersFor(parseCallAttendees('---\nattendees: ["Smith, Alice"]\n---\nhi\n'), OWNER, [member(OWNER), member('smith'), member('alice', { display_name: 'Alice' })]))
      .toEqual({ readers: [OWNER], matched_by: {}, unmatched: ['Smith, Alice'], no_list: false });
    expect(parseCallAttendees('---\nattendees:\n  - alice-example\n  - "bob@acme-example.test"\n---\nhi\n')).toEqual([{ entry: 'alice-example' }, { entry: 'bob@acme-example.test', email: 'bob@acme-example.test' }]);
    expect(parseCallAttendees(CALLS['2026-11-08 standup.txt']!)).toBeNull();
    expect(parseCallAttendees('Weekly\n\nalice-example: hello\nAttendees: bob-example\n')).toBeNull();
    expect(parseCallAttendees('no header at all\n')).toBeNull();
  });

  test('an email entry matches by email only; then id, then a display name held by exactly one enabled person', () => {
    const members = [member(OWNER), member('alice-example', { display_name: 'Alice Example', email: 'alice@acme-example.test' }), member('bob-example', { display_name: 'Sam Example' }),
      member('carol-example', { display_name: 'Sam Example', email: 'carol@acme-example.test' }), member('dave-example', { status: 'disabled' }), member('room-example', { kind: 'audience', display_name: 'Room Example' })];
    const r = callReadersFor(parseCallAttendees('Attendees: owner, ALICE EXAMPLE, bob-example, Sam Example, carol-example <x@other-example.test>, dave-example, Room Example, Erin <alice@acme-example.test>\n\nx: y'), OWNER, members);
    expect(r).toEqual({ readers: [OWNER, 'alice-example', 'bob-example'], matched_by: { 'alice-example': 'name', 'bob-example': 'id' },
      unmatched: ['Sam Example', 'carol-example <x@other-example.test>', 'dave-example', 'Room Example'], no_list: false });
    expect(callReadersFor(null, OWNER, members)).toEqual({ readers: [OWNER], matched_by: {}, unmatched: [], no_list: true });
  });
});

for (const kind of testBackends()) {
  describe(`call import keeps calls to their attendees (${kind}, repo-less)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const tokens: Record<string, string> = {};
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    let calls: string;

    async function remote(who: string, op: string, params: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<string> {
      const auth = await provider().verifyAccessToken(tokens[who]!) as unknown as AuthInfo;
      const out = await dispatchToolCall(engine, op, params, { remote: true, transport: 'http', auth, sourceId: SRC, takesHoldersAllowList: ['world'], ...extra });
      return out.content.map(c => c.text).join('\n');
    }
    const stdio = async (op: string, params: Record<string, unknown>, stdioMember?: string) =>
      (await dispatchToolCall(engine, op, params, { remote: true, transport: 'stdio', sourceId: SRC, ...(stdioMember ? { stdioMember } : {}) })).content.map(c => c.text).join('\n');
    const local = async (slug: string) => (await dispatchToolCall(engine, 'get_page', { slug }, { remote: false, sourceId: SRC })).content.map(c => c.text).join('\n');
    const reads = async (who: string, slug: string, canary: string) => (await remote(who, 'get_page', { slug })).includes(canary);

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      __resetPrivateVisibilityCacheForTests();
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
      for (const [id, name, email, kindOf] of [[OWNER, 'Owner Example', null, 'person'], ['alice-example', 'Alice Example', 'alice@acme-example.test', 'person'], ['bob-example', null, null, 'person'],
        ['carol-example', 'Carol Example', 'carol@acme-example.test', 'person'], ['room-example', null, null, 'audience']] as const) {
        await engine.executeRaw('INSERT INTO access_members (id, display_name, email, kind) VALUES ($1, $2, $3, $4)', [id, name, email, kindOf]);
      }
      const mint = async (name: string, bind: { member?: string; mayActFor?: string[] } | 'unscoped' | null) => {
        const minted = await mintLegacyToken(engine, { name, scopes: ['read'], takesHolders: ['world'], sourceGrant: [SRC] });
        tokens[name] = minted.token;
        if (bind === 'unscoped') await readsUnscopedOnPurpose(engine, minted.id);
        else if (bind) await bindCredential(engine, { kind: 'token', id: minted.id }, bind);
        return minted.id;
      };
      await mint('owner', { member: OWNER });
      await mint('alice', { member: 'alice-example' });
      await mint('bob', { member: 'bob-example' });
      await mint('carol', { member: 'carol-example' });
      await mint('owner-audience', { mayActFor: [`member:${OWNER}`] });
      const client = await provider().registerClientManual('owner-client', ['client_credentials'], 'read', [], SRC);
      await bindCredential(engine, { kind: 'client', id: client.clientId }, { member: OWNER });
      tokens['owner-client'] = (await provider().exchangeClientCredentials(client.clientId, client.clientSecret ?? '')).access_token;
      const qm = await provider().registerClientManual('qm-example', ['client_credentials'], 'read', [], SRC);
      await bindCredential(engine, { kind: 'client', id: qm.clientId }, { attestActor: 'qm', attestOps: ['get_page'] });
      tokens.qm = (await provider().exchangeClientCredentials(qm.clientId, qm.clientSecret ?? '')).access_token;
      await linkMember(engine, OWNER, 'qm', 'U0OWNEREXAMPLE');
      await setOwner(engine, OWNER);
      calls = temp('gbrain-calls-attendees-');
      writeCalls(calls);
    }, 240_000);
    afterAll(async () => { await close?.(); }, 60_000);

    test('the four calls and a call with no list get the owner plus matched attendees, with every unmatched name listed', async () => {
      const doc = await importJson(engine, calls);
      expect(doc).toMatchObject({ imported: 5, errors: 0, readers: { scoped: 4, owner_only: 1, not_scoped: 0 } });
      expect(doc.notices).toBeUndefined();
      const bySlug = Object.fromEntries(doc.pages.map((p: any) => [p.slug, p]));
      expect(bySlug[SLUG.debrief]).toMatchObject({ scoped: true, readers: [OWNER, 'carol-example'], readers_from: 'computed', matched_by: { 'carol-example': 'id' }, unmatched: [] });
      expect(bySlug[SLUG.pricing]).toMatchObject({ readers: [OWNER, 'alice-example', 'bob-example'], matched_by: { 'alice-example': 'name', 'bob-example': 'id' } });
      expect(bySlug[SLUG.eng]).toMatchObject({ readers: [OWNER, 'bob-example', 'carol-example'], matched_by: { 'carol-example': 'email' }, unmatched: [] });
      expect(bySlug[SLUG.renewal]).toMatchObject({ readers: [OWNER, 'alice-example'], unmatched: ['dave-example (acme-example procurement)'] });
      expect(bySlug[SLUG.standup]).toMatchObject({ scoped: true, readers: [OWNER], unmatched: [] });
    }, 120_000);

    test('a teammate who was not on the call is told it does not exist and finds nothing; the attendees and the owner read it', async () => {
      expect(await reads('alice', SLUG.debrief, 'canaryhiringband')).toBe(false);
      expect(await remote('alice', 'search', { query: 'canaryhiringband', match: 'keyword', limit: 20 })).not.toContain('canaryhiringband');
      expect(await reads('bob', SLUG.debrief, 'canaryhiringband')).toBe(false);
      expect(await reads('carol', SLUG.debrief, 'canaryhiringband')).toBe(true);
      expect(await reads('alice', SLUG.pricing, 'canarypricing')).toBe(true);
      expect(await reads('carol', SLUG.renewal, 'canaryrenewal')).toBe(false);
      expect(await reads('bob', SLUG.standup, 'canarystandup')).toBe(false);
      expect(await local(SLUG.debrief)).toContain('canaryhiringband');
    }, 120_000);

    test('every owner caller kind still reads every call: token, OAuth client, stdio, attested owner, owner-alone audience', async () => {
      for (const [slug, canary] of [[SLUG.debrief, 'canaryhiringband'], [SLUG.standup, 'canarystandup'], [SLUG.renewal, 'canaryrenewal']] as const) {
        expect({ slug, token: await reads('owner', slug, canary), client: await reads('owner-client', slug, canary),
          stdio: (await stdio('get_page', { slug }, OWNER)).includes(canary),
          attested: (await remote('qm', 'get_page', { slug }, { actor: { header: 'U0OWNEREXAMPLE' } })).includes(canary),
          audience: (await remote('owner-audience', 'get_page', { slug }, { onBehalfOf: { header: OWNER } })).includes(canary),
          local: (await local(slug)).includes(canary) })
          .toEqual({ slug, token: true, client: true, stdio: true, attested: true, audience: true, local: true });
      }
    }, 240_000);

    test('a link out of a scoped call is hidden from a teammate who was not on it, and shown to an attendee and the owner', async () => {
      const dir = temp('gbrain-calls-links-');
      writeFileSync(join(dir, '2026-11-07 offer review.md'), 'Offer review\nAttendees: carol-example\n\ncarol-example: canaryoffer see [[people/dave-example]] for the reference check.\n');
      await dispatchToolCall(engine, 'put_page', { slug: 'people/dave-example', content: '---\ntype: person\ntitle: Dave Example\n---\n# Dave Example\n' }, { remote: false, sourceId: SRC });
      const doc = await importJson(engine, dir);
      expect(doc.pages[0]).toMatchObject({ scoped: true, readers: [OWNER, 'carol-example'] });
      const backlinks = async (who: string) => (await remote(who, 'get_backlinks', { slug: 'people/dave-example' })).includes('company/calls/2026-11-07-offer-review');
      const [links] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM links l JOIN pages p ON p.id = l.from_page_id WHERE p.slug = 'company/calls/2026-11-07-offer-review'");
      expect(Number(links!.n)).toBeGreaterThan(0);
      expect({ alice: await backlinks('alice'), carol: await backlinks('carol'), owner: await backlinks('owner') }).toEqual({ alice: false, carol: true, owner: true });
      await engine.executeRaw("DELETE FROM pages WHERE source_id = $1 AND slug = 'company/calls/2026-11-07-offer-review'", [SRC]);
    }, 120_000);

    test('a rerun reports the stored readers and writes nothing; a later local write without readers keeps them', async () => {
      const again = await importJson(engine, calls);
      expect(again).toMatchObject({ imported: 0, unchanged: 5 });
      expect(again.pages.find((p: any) => p.slug === SLUG.debrief)).toMatchObject({ status: 'unchanged', scoped: true, readers: [OWNER, 'carol-example'], readers_from: 'stored' });
      const [guard] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM page_label_guards g JOIN pages p ON p.id = g.page_id WHERE p.source_id = $1 AND starts_with(p.slug, $2)', [SRC, 'company/calls/']);
      expect(Number(guard!.n)).toBe(5);
      const stored = JSON.parse(await local(SLUG.debrief)) as { compiled_truth: string; revision: string };
      const body = ['---', 'title: "hiring debrief"', 'type: meeting', 'date: 2026-11-12', 'facts_backstop: false', '---', stored.compiled_truth, 'owner: one more note.', ''].join('\n');
      const write = await dispatchToolCall(engine, 'put_page', { slug: SLUG.debrief, content: body, expected_revision: stored.revision }, { remote: false, sourceId: SRC });
      expect({ isError: write.isError === true, text: write.isError ? write.content.map(c => c.text).join('') : '' }).toEqual({ isError: false, text: '' });
      const [row] = await engine.executeRaw<{ frontmatter: Record<string, unknown>; compiled_truth: string }>('SELECT frontmatter, compiled_truth FROM pages WHERE source_id = $1 AND slug = $2', [SRC, SLUG.debrief]);
      expect(row!.frontmatter.readable_by).toEqual([OWNER, 'carol-example']);
      __resetPrivateVisibilityCacheForTests();
      expect(await reads('alice', SLUG.debrief, 'canaryhiringband')).toBe(false);
      expect(await reads('carol', SLUG.debrief, 'canaryhiringband')).toBe(true);
      expect(await reads('owner', SLUG.debrief, 'canaryhiringband')).toBe(true);
    }, 120_000);
  });

  describe(`the owner check keeps calls open, as before (${kind}, repo-less)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const tokens: Record<string, string> = {};
    const ids: Record<string, string> = {};
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    let n = 0;
    let one: PGLiteEngine;
    const fresh = () => { const d = temp('gbrain-calls-gate-'); writeCalls(d, ['2026-11-12 hiring debrief.md']); return d; };
    const prefixOf = () => `company/calls`;
    async function importOnce(extra: string[] = [], unboundStdio = NO_STDIO): Promise<any> {
      n++;
      await engine.executeRaw("DELETE FROM pages WHERE source_id = $1 AND starts_with(slug, 'company/calls/')", [SRC]);
      return importJson(engine, fresh(), extra, unboundStdio);
    }
    async function remote(who: string, slug: string): Promise<string> {
      const auth = await provider().verifyAccessToken(tokens[who]!) as unknown as AuthInfo;
      const out = await dispatchToolCall(engine, 'get_page', { slug }, { remote: true, transport: 'http', auth, sourceId: SRC, takesHoldersAllowList: ['world'] });
      return out.content.map(c => c.text).join('\n');
    }
    const setServesSince = (iso: string) => engine.executeRaw("INSERT INTO config (key, value) VALUES ('access.serves_since', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [iso]);

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
      for (const id of [OWNER, 'alice-example', 'carol-example']) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', [id]);
      for (const name of ['legacy-bot', 'alice']) {
        const minted = await mintLegacyToken(engine, { name, scopes: ['read'], takesHolders: ['world'], sourceGrant: [SRC] });
        tokens[name] = minted.token; ids[name] = minted.id;
      }
      await bindCredential(engine, { kind: 'token', id: ids.alice! }, { member: 'alice-example' });
      await setOwner(engine, OWNER);
      one = new PGLiteEngine();
      await one.connect({ engine: 'pglite' } as never); await one.initSchema();
    }, 240_000);
    afterAll(async () => { await one?.disconnect(); await close?.(); }, 60_000);
    beforeEach(async () => {
      await engine.executeRaw("DELETE FROM config WHERE key IN ('access.requester_scope_enforce', 'mcp.stdio_member')");
      await engine.executeRaw('UPDATE access_tokens SET reads_unscoped = NULL WHERE id::text = $1', [ids['legacy-bot']]);
      await setServesSince('2000-01-01T00:00:00Z');
      await setOwner(engine, OWNER);
      __resetPrivateVisibilityCacheForTests();
    });

    const open = (doc: any, reason: string) => {
      expect(doc.pages[0]).toMatchObject({ status: 'imported', scoped: false, reason, readers: null });
      expect(doc.readers).toEqual({ scoped: 0, owner_only: 0, not_scoped: 1 });
      expect(doc.notices?.[0]).toMatchObject({ code: 'calls_not_scoped', kind: 'safety', fix: { next: 'tell_user_to_run' } });
    };

    test('baseline: a refused unbound token reads nothing today, so it does not block scoping', async () => {
      const doc = await importOnce();
      expect(doc.pages[0]).toMatchObject({ scoped: true, readers: [OWNER, 'carol-example'] });
      expect(doc.notices).toBeUndefined();
      expect(await remote('legacy-bot', SLUG.debrief)).toContain('requester_scope_required');
    }, 120_000);

    test('an unbound token in grace keeps the import open, names its bind command, and still reads the call', async () => {
      await setServesSince(new Date(Date.now() + 3600_000).toISOString());
      const doc = await importOnce();
      open(doc, 'unbound_readers');
      expect(doc.notices[0].fix.command).toContain('gbrain auth rescope --token legacy-bot --member owner-example');
      expect(doc.notices[0].why).toContain('token legacy-bot (grace)');
      __resetPrivateVisibilityCacheForTests();
      expect(await remote('legacy-bot', SLUG.debrief)).toContain('canaryhiringband');
    }, 120_000);

    test('a token that reads unscoped on purpose keeps the import open and still reads the call', async () => {
      await readsUnscopedOnPurpose(engine, ids['legacy-bot']!);
      open(await importOnce(), 'unbound_readers');
      __resetPrivateVisibilityCacheForTests();
      expect(await remote('legacy-bot', SLUG.debrief)).toContain('canaryhiringband');
    }, 120_000);

    test('a host that does not enforce binding (hosted) keeps the import open and the unbound token still reads', async () => {
      await engine.executeRaw("INSERT INTO config (key, value) VALUES ('access.requester_scope_enforce', 'false') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value");
      open(await importOnce(), 'unbound_readers');
      __resetPrivateVisibilityCacheForTests();
      expect(await remote('legacy-bot', SLUG.debrief)).toContain('canaryhiringband');
    }, 120_000);

    test('an unbound stdio connection in grace keeps the import open and still reads; bound by config it does not block', async () => {
      await setServesSince(new Date(Date.now() - 3600_000).toISOString());
      const unbound = (): UnboundStdio[] => [{ harness: 'claude-code', name: 'gbrain', argv: ['gbrain', 'setup', 'claude-code'] }];
      const doc = await importOnce([], unbound);
      open(doc, 'stdio_unbound');
      expect(doc.notices[0].fix.command).toBe('gbrain setup claude-code --stdio-member owner-example');
      __resetPrivateVisibilityCacheForTests();
      expect((await dispatchToolCall(engine, 'get_page', { slug: SLUG.debrief }, { remote: true, transport: 'stdio', sourceId: SRC })).content.map(c => c.text).join('\n')).toContain('canaryhiringband');
      await engine.executeRaw("INSERT INTO config (key, value) VALUES ('mcp.stdio_member', $1)", [OWNER]);
      expect((await importOnce([], unbound)).pages[0]).toMatchObject({ scoped: true });
      await setServesSince('2000-01-01T00:00:00Z');
      await engine.executeRaw("DELETE FROM config WHERE key = 'mcp.stdio_member'");
      expect((await importOnce([], unbound)).pages[0]).toMatchObject({ scoped: true });
    }, 120_000);

    test('no owner, or an owner who is not enabled, keeps the import open with the owner command', async () => {
      await clearOwner(engine);
      const unset = await importOnce();
      open(unset, 'owner_unset');
      expect(unset.notices[0].fix.command).toBe("gbrain access owner set '<MEMBER>'");
      await setOwner(engine, OWNER);
      await engine.executeRaw('UPDATE access_members SET disabled_at = now() WHERE id = $1', [OWNER]);
      const inactive = await importOnce();
      open(inactive, 'owner_inactive');
      expect(inactive.notices[0].fix.command).toBe('gbrain access member enable owner-example');
      await engine.executeRaw('UPDATE access_members SET disabled_at = NULL WHERE id = $1', [OWNER]);
    }, 120_000);

    test('--readers source imports open as today with no notice; any other value refuses', async () => {
      const doc = await importOnce(['--readers', 'source']);
      expect(doc.pages[0]).toMatchObject({ scoped: false, reason: 'readers_source', readers: null });
      expect(doc.notices).toBeUndefined();
      expect(await remote('alice', SLUG.debrief)).toContain('canaryhiringband');
      await expect(importOnce(['--readers', 'everyone'])).rejects.toMatchObject({ code: 'invalid_params' });
    }, 120_000);

    test('a one-person brain, and an owner with group-chat audiences, import exactly as before', async () => {
      {
        await one.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1)', [SRC]);
        const before = await importJson(one, fresh());
        await one.executeRaw("INSERT INTO access_members (id, kind) VALUES ($1, 'person'), ('room-a-example', 'audience'), ('room-b-example', 'audience')", [OWNER]);
        await setOwner(one, OWNER);
        expect(await callScopeGate(one, NO_STDIO)).toEqual({ applies: false });
        await one.executeRaw("DELETE FROM pages WHERE source_id = $1", [SRC]);
        const after = await importJson(one, fresh());
        for (const doc of [before, after]) {
          expect(doc.pages[0].scoped).toBeUndefined();
          expect(doc.readers).toBeUndefined();
        }
        const [row] = await one.executeRaw<{ frontmatter: Record<string, unknown> }>('SELECT frontmatter FROM pages WHERE source_id = $1 AND slug = $2', [SRC, SLUG.debrief]);
        expect(row!.frontmatter.readable_by).toBeUndefined();
      }
      expect(n).toBeGreaterThan(0);
      expect(prefixOf()).toBe('company/calls');
    }, 240_000);
  });
}

describe('call import keeps calls to their attendees (pglite, git-backed)', () => {
  let managed: PGLiteEngine;
  beforeAll(async () => { managed = new PGLiteEngine(); await managed.connect({}); await managed.initSchema(); }, 120_000);
  afterAll(async () => { await managed?.disconnect(); });
  test('the page file carries readable_by in the committed tree, and the guard is raised by the import even while the commit is queued', async () => {
    const fixture = temp('gbrain-calls-repo-');
    const brain = join(fixture, 'brain');
    const calls = join(fixture, 'calls');
    mkdirSync(brain);
    mkdirSync(calls);
    for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Example'], ['config', 'user.email', 'example@example.invalid'], ['config', 'commit.gpgsign', 'false'], ['commit', '-q', '--allow-empty', '-m', 'init']]) spawnSync('git', ['-C', brain, ...args]);
    writeFileSync(join(calls, '2026-11-12 hiring debrief.md'), CALLS['2026-11-12 hiring debrief.md']!);
    await managed.setConfig('sync.repo_path', brain);
    for (const id of [OWNER, 'carol-example', 'alice-example']) await managed.executeRaw('INSERT INTO access_members (id) VALUES ($1)', [id]);
    await setOwner(managed, OWNER);
    await withEnv({ GBRAIN_HOME: join(fixture, 'home') }, async () => {
      startPersistenceConsumer(managed, { engine: 'pglite' });
      await new Promise(r => setTimeout(r, 50));
      await managed.executeRaw("UPDATE persistence_host_bindings SET git_durability='enabled'");
      const chunks: string[] = [];
      const spy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { chunks.push(a.map(String).join(' ')); });
      try { await runCallImport(managed, calls, ['--calls', '--prefix', 'company/calls'], { json: true, unboundStdio: NO_STDIO }); } finally { spy.mockRestore(); }
      await managed.executeRaw("UPDATE persistence_host_bindings SET git_durability='enabled'");
      const doc = JSON.parse(chunks.join(''));
      expect(doc.pages[0]).toMatchObject({ status: 'imported', scoped: true, readers: [OWNER, 'carol-example'] });
      const guardedNow = async () => Number((await managed.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM page_label_guards g JOIN pages p ON p.id = g.page_id WHERE p.slug = $1', [SLUG.debrief]))[0]!.n);
      const show = () => spawnSync('git', ['-C', brain, 'show', `HEAD:${SLUG.debrief}.md`], { encoding: 'utf8' }).stdout;
      expect(readFileSync(join(brain, `${SLUG.debrief}.md`), 'utf8')).toMatch(/\nreadable_by:\n {2}- owner-example\n {2}- carol-example\n/);
      expect(await guardedNow()).toBe(1);
      for (let i = 0; i < 100 && !show(); i++) {
        await runPersistenceEffects(managed, { engine: 'pglite', embedding_disabled: true } as never, { hostId: localHostId() });
        if (!show()) await new Promise(r => setTimeout(r, 100));
      }
      expect(show()).toMatch(/\nreadable_by:\n {2}- owner-example\n {2}- carol-example\n/);
      if (doc.pages[0].git_state !== 'committed') {
        const again: string[] = [];
        const spy2 = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { again.push(a.map(String).join(' ')); });
        try { await runCallImport(managed, calls, ['--calls', '--prefix', 'company/calls'], { json: true, unboundStdio: NO_STDIO }); } finally { spy2.mockRestore(); }
        expect(JSON.parse(again.join('')).pages[0]).toMatchObject({ status: 'unchanged', readers: [OWNER, 'carol-example'], readers_from: 'stored' });
      }
      expect(await guardedNow()).toBe(1);
    }).finally(async () => { await disposePersistenceConsumer(managed); });
  }, 120_000);
});
