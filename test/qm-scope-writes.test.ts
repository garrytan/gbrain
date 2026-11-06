/**
 * GST-1113: gaps 1+2 of the internal QM provider. memory_write's per-call scope source (source_id), checked against the
 * credential's attest_sources, saves world facts on that source's scope page (memory/scope); the scope-source mark keeps
 * every other credential from reading it.
 *
 * 1. Protects: a scope write lands only on memory/scope in a marked source the attest credential lists, as world facts
 *    with qm provenance; a second member reads it through memory_recall source_id; the person route never reads a scope;
 *    a source outside the list, the credential's own source, an unattested call, a squatted page and every other remote
 *    writer of memory/scope are refused with nothing written; publication re-checks the list; request ids key per
 *    source; scope and member copies of one claim never merge; no credential grant, token or federation exposes a
 *    marked source, and the mark outlives the scope credential.
 * 2. Fails when: any of the above regresses.
 * 3. Existing coverage: test/qm-memory-tools.test.ts pins the member-page memory pair; test/qm-memory-contract.test.ts
 *    pins the contract (v1 byte-identical, v2 scope_write).
 * 4. Real seams: OAuth client-credentials tokens verified by the provider, MCP dispatch, the persistence coordinator on a
 *    repo-less brain, the grants service and token mint; embeddings stubbed.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { dispatchToolCall, type ToolResult } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { addMember, bindCredential } from '../src/core/access/members.ts';
import { linkMember } from '../src/core/access/actor.ts';
import { assertNotScopeSource, markedScopeSources } from '../src/core/access/attest-sources.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { authorizeWrite } from '../src/core/persistence/authority.ts';
import { memoryWriteRequestId } from '../src/core/ops/qm-memory.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { rescopeClientGrant } from '../src/core/grants/service.ts';
import { rescopeLegacyToken } from '../src/core/grants/legacy-token.ts';
import { isSourceFederated, loadAllSources, parseSourceConfig } from '../src/core/sources-load.ts';
import { restoreSource, softDeleteSource } from '../src/core/destructive-guard.ts';
import { proposeRevision } from '../src/core/access/policy.ts';
import { quarantineRestoredExecution } from '../src/core/backup/quarantine.ts';
import { registerScopedClient } from '../src/commands/auth.ts';
import { runSources } from '../src/commands/sources.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { attestRightFrom } from '../src/core/access/actor-model.ts';
import { testBackends } from './helpers/test-backends.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const DIMS = 1536;
function vectorFor(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    let h = 0;
    for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % DIMS] += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map(x => x / n);
}

const HOME = 'qm-home';
const SCOPE_A = 'scope-a';
const SCOPE_B = 'scope-b';
const SCOPE_C = 'scope-c';
const SHARED = 'team-shared';
const ALICE_ID = 'U0ALICE';
const BOB_ID = 'U0BOB';
const MEMORY_OPS = ['forget', 'forget_fact', 'get_write_request', 'memory_recall', 'memory_write'];
const tokenArgs = { reset: [], refreshOperations: false, allNew: false, dryRun: false, json: false } as const;

describe('scope sources (pure)', () => {
  test('a marked source is never federated, whatever its federated key says', () => {
    expect(isSourceFederated({ federated: true })).toBe(true);
    expect(isSourceFederated({ federated: true, qm_scope: true })).toBe(false);
    expect(isSourceFederated(JSON.stringify({ federated: true, qm_scope: true }))).toBe(false);
  });

  test('request ids key a scope write per source; without a source they are the member ids v1 published', async () => {
    const own = await memoryWriteRequestId('alice-example', 'key-1', 0);
    expect(await memoryWriteRequestId('alice-example', 'key-1', 0, undefined)).toBe(own);
    const a = await memoryWriteRequestId('alice-example', 'key-1', 0, SCOPE_A);
    expect(a).not.toBe(own);
    expect(await memoryWriteRequestId('alice-example', 'key-1', 0, SCOPE_A)).toBe(a);
    expect(await memoryWriteRequestId('alice-example', 'key-1', 0, SCOPE_B)).not.toBe(a);
    expect(await memoryWriteRequestId('bob-example', 'key-1', 0, SCOPE_A)).not.toBe(a);
  });
});

for (const kind of testBackends()) {
  describe('scope writes (' + kind + ', repo-less)', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    const tokens: Record<string, string> = {};
    const clients: Record<string, { id: string; secret: string }> = {};
    type Who = { token: string; actor?: string };
    const alice: Who = { token: 'scopes', actor: ALICE_ID };
    const bob: Who = { token: 'scopes', actor: BOB_ID };

    async function call(as: Who, op: string, params: Record<string, unknown>, extra: { writeWaitMs?: number } = {}) {
      const auth = await provider().verifyAccessToken(tokens[as.token]!) as unknown as AuthInfo;
      const out: ToolResult = await dispatchToolCall(engine, op, { ...params }, {
        remote: true, transport: 'http', auth, sourceId: auth.sourceId, takesHoldersAllowList: ['world'],
        ...(as.actor !== undefined ? { actor: { header: as.actor } } : {}), ...extra,
      });
      const text = out.content.map(c => c.text).join('\n');
      let json: Record<string, any> = {};
      try { json = JSON.parse(text); } catch { /* plain text */ }
      return { isError: out.isError === true, text, json, structured: out.structuredContent as Record<string, any> | undefined, all: text + JSON.stringify(out.structuredContent ?? {}) };
    }
    const write = (as: Who, facts: Array<Record<string, unknown>>, args: Record<string, unknown> = {}, key: string = randomUUID()) =>
      call(as, 'memory_write', { facts, idempotency_key: key, ...args }, { writeWaitMs: 30_000 });
    const factRows = (needle: string) => engine.executeRaw<Record<string, any>>(
      'SELECT id, source_id, visibility, source_markdown_slug, source FROM facts WHERE fact LIKE $1 ORDER BY id', ['%' + needle + '%']);
    const register = async (name: string, source: string, grantTypes = ['client_credentials']) => {
      const c = await provider().registerClientManual('s-' + name + '-' + randomUUID().slice(0, 8), grantTypes, 'read write', [], source);
      return (clients[name] = { id: c.clientId, secret: c.clientSecret ?? '' });
    };
    const refusal = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return e as Error & { code?: string; reason?: string }; } };

    beforeAll(async () => {
      configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test' } });
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(vectorFor) })) as never);
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      __resetPrivateVisibilityCacheForTests();
      for (const id of [HOME, SCOPE_A, SCOPE_B, SCOPE_C, SHARED]) await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [id]);
      for (const id of ['alice-example', 'bob-example']) await addMember(engine, id);
      await linkMember(engine, 'alice-example', 'qm', ALICE_ID);
      await linkMember(engine, 'bob-example', 'qm', BOB_ID);
      const scopes = await register('scopes', HOME);
      await bindCredential(engine, { kind: 'client', id: scopes.id }, { attestActor: 'qm', attestOps: MEMORY_OPS, attestSources: [SCOPE_A, SCOPE_B, SCOPE_C] });
      await rescopeClientGrant(engine, scopes.id, { federatedRead: [HOME, SCOPE_A, SCOPE_B, SCOPE_C] }, { actor: 'test' });
      const personal = await register('personal', HOME);
      await bindCredential(engine, { kind: 'client', id: personal.id }, { attestActor: 'qm', attestOps: MEMORY_OPS });
      const plain = await register('plain', SHARED);
      for (const name of ['scopes', 'personal', 'plain']) tokens[name] = (await provider().exchangeClientCredentials(clients[name]!.id, clients[name]!.secret)).access_token;
    }, 120_000);

    afterAll(async () => {
      __setEmbedTransportForTests(null);
      resetGateway();
      await disposePersistenceConsumer(engine).catch(() => undefined);
      await close?.();
    });

    test('a scope write lands world on memory/scope in that source only; another member recalls it by naming the source; no person read sees it', async () => {
      expect([...await markedScopeSources(engine, [HOME, SCOPE_A, SCOPE_B, SCOPE_C, SHARED])].sort()).toEqual([SCOPE_A, SCOPE_B, SCOPE_C]);
      const key = randomUUID();
      const out = await write(alice, [{ fact: 'The launch moves to Thursday canaryscopea', provenance: 'slack:C0SCOPE/p1' }], { source_id: SCOPE_A }, key);
      expect(out.isError).toBe(false);
      expect(out.structured).toEqual({ status: 'committed', request_id: await memoryWriteRequestId('alice-example', key, 0, SCOPE_A), fact_ids: [expect.any(String)] });
      const rows = await factRows('canaryscopea');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ source_id: SCOPE_A, visibility: 'world', source_markdown_slug: 'memory/scope' });
      expect(String(rows[0]!.source)).toContain('qm:' + ALICE_ID + '; slack:C0SCOPE/p1');
      const [page] = await engine.executeRaw<{ page_readers: string[] | null }>('SELECT page_readers FROM pages WHERE source_id = $1 AND slug = $2', [SCOPE_A, 'memory/scope']);
      expect(page!.page_readers).toBeNull();
      const named = await call(bob, 'memory_recall', { query: 'launch Thursday', source_id: SCOPE_A });
      expect(named.isError).toBe(false);
      expect(named.text).toContain('canaryscopea');
      for (const as of [alice, bob, { token: 'personal', actor: ALICE_ID }]) {
        const person = await call(as, 'memory_recall', { query: 'launch Thursday' });
        expect(person.isError).toBe(false);
        expect(person.all).not.toContain('canaryscopea');
      }
      const other = await call(bob, 'memory_recall', { query: 'launch Thursday', source_id: SCOPE_B });
      expect(other.all).not.toContain('canaryscopea');
    }, 60_000);

    test('get_write_request finds a scope receipt for the member who wrote it, and for no other member', async () => {
      const out = await write(alice, [{ fact: 'Receipt check canaryreceipt', provenance: 'turn r' }], { source_id: SCOPE_A });
      const id = out.structured!.request_id;
      const own = await call(alice, 'get_write_request', { request_id: id });
      expect(own.isError).toBe(false);
      expect(own.all).toContain(id);
      const other = await call(bob, 'get_write_request', { request_id: id });
      expect(other.isError).toBe(true);
      expect(other.all).toContain('not_found');
    }, 60_000);

    test('a source outside attest_sources, the own source and an unattested call are refused with nothing written', async () => {
      const cases: Array<[Who, string, string, string | undefined]> = [
        [alice, SHARED, 'source_not_attested', undefined],
        [{ token: 'personal', actor: ALICE_ID }, SCOPE_A, 'source_not_attested', undefined],
        [alice, HOME, 'source_is_member_source', 'invalid_params'],
        [{ token: 'scopes' }, SCOPE_A, 'actor_required', 'actor_not_attested'],
        [{ token: 'plain' }, SCOPE_A, 'actor_required', 'actor_not_attested'],
      ];
      for (const [as, source, reason, code] of cases) {
        const out = await write(as, [{ fact: 'Refused scope write canaryscoperefused', provenance: 'x' }], { source_id: source });
        expect({ isError: out.isError, reason: out.json.reason }).toEqual({ isError: true, reason });
        if (code) expect(out.json.code).toBe(code);
      }
      expect(await factRows('canaryscoperefused')).toHaveLength(0);
    }, 60_000);

    test('one key replays per source and is a separate write in another source; scope and member copies of a claim never merge', async () => {
      const key = 'scope-key-' + randomUUID();
      const fact = [{ fact: 'Standup is at nine canarysamekeyscope', provenance: 'turn 1' }];
      const a = await write(alice, fact, { source_id: SCOPE_A }, key);
      const again = await write(alice, fact, { source_id: SCOPE_A }, key);
      expect(again.structured).toEqual(a.structured);
      const b = await write(alice, fact, { source_id: SCOPE_B }, key);
      const own = await write(alice, fact, {}, key);
      expect(own.structured!.request_id).toBe(await memoryWriteRequestId('alice-example', key, 0));
      expect(new Set([a, b, own].map(r => r.structured!.request_id)).size).toBe(3);
      const rows = await factRows('canarysamekeyscope');
      expect(rows.map(r => r.source_id + ':' + r.source_markdown_slug + ':' + r.visibility).sort())
        .toEqual([HOME + ':memory/members/alice-example:private', SCOPE_A + ':memory/scope:world', SCOPE_B + ':memory/scope:world']);
    }, 60_000);

    test('publication re-checks attest_sources: a stored scope write is refused once the operator drops the source', async () => {
      const out = await write(alice, [{ fact: 'Budget review moved canaryrecheck', provenance: 'turn 2' }], { source_id: SCOPE_C });
      expect(out.structured!.status).toBe('committed');
      const [row] = await engine.executeRaw<{ authority: any }>('SELECT authority FROM persistence_requests WHERE request_id = $1::uuid', [out.structured!.request_id]);
      const authority = typeof row!.authority === 'string' ? JSON.parse(row!.authority) : row!.authority;
      expect(authority.attestedSource).toBe(SCOPE_C);
      await authorizeWrite(engine as never, authority, 'remember', 'memory/scope');
      expect((await refusal(authorizeWrite(engine as never, authority, 'remember', 'notes/elsewhere')))?.message).toBeTruthy();
      await rescopeClientGrant(engine, clients.scopes!.id, { federatedRead: [HOME, SCOPE_A, SCOPE_B] }, { actor: 'test' });
      await bindCredential(engine, { kind: 'client', id: clients.scopes!.id }, { attestSources: [SCOPE_A, SCOPE_B] });
      const refused = await refusal(authorizeWrite(engine as never, authority, 'remember', 'memory/scope'));
      expect(refused?.reason).toBe('source_not_attested');
      expect((await markedScopeSources(engine, [SCOPE_C])).has(SCOPE_C)).toBe(true);
      const after = await write(alice, [{ fact: 'After the drop canaryrecheckafter', provenance: 'turn 3' }], { source_id: SCOPE_C });
      expect(after.json.reason).toBe('source_not_attested');
      expect(await factRows('canaryrecheckafter')).toHaveLength(0);
    }, 60_000);

    test('restating --attest-sources re-marks a listed scope source that lost its mark', async () => {
      await engine.executeRaw(`UPDATE sources SET config = config - 'qm_scope' WHERE id = $1`, [SCOPE_B]);
      expect((await markedScopeSources(engine, [SCOPE_B])).has(SCOPE_B)).toBe(false);
      await bindCredential(engine, { kind: 'client', id: clients.scopes!.id }, { attestSources: [SCOPE_A, SCOPE_B] });
      expect((await markedScopeSources(engine, [SCOPE_A, SCOPE_B])).size).toBe(2);
    }, 60_000);

    test('a token minted while --attest-sources marks its source never ends up reading the scope (the check and insert commit together)', async () => {
      const RACE = 'qm-scope-race';
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [RACE]);
      const racer = await register('racer', HOME);
      await bindCredential(engine, { kind: 'client', id: racer.id }, { attestActor: 'qm', attestOps: MEMORY_OPS });
      const original = engine.executeRaw;
      let bind: Promise<Error | null> | null = null;
      engine.executeRaw = (async function (this: BrainEngine, ...args: Parameters<typeof engine.executeRaw>) {
        if (!bind && String(args[0]).includes('INSERT INTO access_tokens')) {
          let settled = false;
          bind = refusal(bindCredential(engine, { kind: 'client', id: racer.id }, { attestSources: [RACE] })).finally(() => { settled = true; });
          for (let i = 0; i < 30 && !settled; i++) await new Promise(r => setTimeout(r, 50));
        }
        return original.apply(this, args);
      }) as typeof engine.executeRaw;
      let minted: Error | null;
      try {
        minted = await refusal(mintLegacyToken(engine, { name: 'race-' + randomUUID().slice(0, 8), scopes: ['read'], takesHolders: ['world'], sourceGrant: [RACE] }));
      } finally {
        engine.executeRaw = original;
      }
      const bound = await bind;
      expect(bind).not.toBeNull();
      expect(minted === null && bound === null).toBe(false);
      if (minted === null) expect((await markedScopeSources(engine, [RACE])).has(RACE)).toBe(false);
    }, 60_000);

    test('publication rechecks attest_sources under the credential lock: a removal that lands first refuses the scope write', async () => {
      const out = await write(alice, [{ fact: 'Lock order canarylockorder', provenance: 'turn 9' }], { source_id: SCOPE_A });
      expect(out.structured!.status).toBe('committed');
      const [row] = await engine.executeRaw<{ authority: any }>('SELECT authority FROM persistence_requests WHERE request_id = $1::uuid', [out.structured!.request_id]);
      const authority = typeof row!.authority === 'string' ? JSON.parse(row!.authority) : row!.authority;
      const original = engine.executeRaw;
      let removed = false;
      engine.executeRaw = (async function (this: BrainEngine, ...args: Parameters<typeof engine.executeRaw>) {
        if (!removed && /FROM oauth_clients WHERE client_id\s*=\s*\$1.*FOR SHARE/s.test(String(args[0]))) {
          removed = true;
          await original.call(this, 'UPDATE oauth_clients SET attest_sources = NULL WHERE client_id = $1', [clients.scopes!.id]);
        }
        return original.apply(this, args);
      }) as typeof engine.executeRaw;
      const ROLLBACK = new Error('rollback');
      let outcome: Error | null = null;
      try {
        await engine.transaction(async tx => {
          outcome = await refusal(authorizeWrite(tx as never, authority, 'remember', 'memory/scope', true));
          throw ROLLBACK;
        }).catch(e => { if (e !== ROLLBACK) throw e; });
      } finally {
        engine.executeRaw = original;
      }
      expect(removed).toBe(true);
      expect((outcome as (Error & { reason?: string }) | null)?.reason).toBe('source_not_attested');
      const [still] = await engine.executeRaw<{ attest_sources: string[] | null }>('SELECT attest_sources FROM oauth_clients WHERE client_id = $1', [clients.scopes!.id]);
      expect(still!.attest_sources).toEqual([SCOPE_A, SCOPE_B]);
    }, 60_000);

    test('a credential cannot take one of its own scope sources as its write source', async () => {
      const refused = await refusal(rescopeClientGrant(engine, clients.scopes!.id, { sourceId: SCOPE_A }, { actor: 'test' }));
      expect(refused?.message).toContain('cannot be its write source');
      const [row] = await engine.executeRaw<{ source_id: string }>('SELECT source_id FROM oauth_clients WHERE client_id = $1', [clients.scopes!.id]);
      expect(row!.source_id).toBe(HOME);
    }, 60_000);

    test('a squatted scope page takes no scope write; no other remote writer may write memory/scope', async () => {
      await importFromContent(engine, 'memory/scope', '---\ntype: note\ntitle: Scope memory\nreadable_by:\n  - member:alice-example\n  - member:bob-example\n---\n# Scope memory\n', { sourceId: SCOPE_B });
      const squat = await write(alice, [{ fact: 'Squatted scope canarysquatscope', provenance: 'x' }], { source_id: SCOPE_B });
      expect({ isError: squat.isError, reason: squat.json.reason }).toEqual({ isError: true, reason: 'scope_page_not_shared' });
      await importFromContent(engine, 'memory/scope', '---\ntype: note\ntitle: Scope memory\nreadable_by:\n  - member:bob-example\n---\n# Scope memory\n', { sourceId: SCOPE_B });
      const hidden = await write(alice, [{ fact: 'Hidden squat canarysquatscope', provenance: 'x' }], { source_id: SCOPE_B });
      expect({ isError: hidden.isError, write_error: hidden.json.write_error }).toEqual({ isError: true, write_error: 'page_not_found' });
      expect(await factRows('canarysquatscope')).toHaveLength(0);
      for (const slug of ['memory/scope', 'memory/scope/notes']) {
        const put = await call({ token: 'plain' }, 'put_page', { slug, content: '---\ntype: note\ntitle: x\n---\nforged canaryforged' });
        expect(put.isError).toBe(true);
        expect(put.all).toContain('memory/scope');
      }
      const remember = await call({ token: 'plain' }, 'remember', { fact: 'Forged scope fact canaryforgedfact', entity: 'memory/scope' });
      expect(remember.isError).toBe(true);
      expect(await factRows('canaryforged')).toHaveLength(0);
      const writers: Array<[string, Record<string, unknown>]> = [
        ['delete_page', { slug: 'memory/scope' }], ['add_tag', { slug: 'memory/scope', tag: 'x' }],
        ['add_link', { from: 'memory/scope', to: 'notes/x' }], ['add_timeline_entry', { slug: 'memory/scope', date: '2026-01-01', summary: 'x' }],
      ];
      for (const [op, args] of writers) {
        const refused = await call({ token: 'plain' }, op, args);
        expect({ op, isError: refused.isError, guarded: refused.all.includes('written remotely only by an attested memory_write') }).toEqual({ op, isError: true, guarded: true });
      }
      await importFromContent(engine, 'memory/scope', '---\ntype: note\ntitle: Scope memory\n---\n# Scope memory\n', { sourceId: SCOPE_B });
      await proposeRevision(engine, SCOPE_B, [{ id: 'scope-folder', prefix: 'memory/', readable_by: ['member:alice-example', 'member:bob-example'] }], { origin: 'cli', store: 'database' });
      const ruled = await write(alice, [{ fact: 'Folder ruled canaryfolderscope', provenance: 'x' }], { source_id: SCOPE_B });
      expect({ isError: ruled.isError, reason: ruled.json.reason }).toEqual({ isError: true, reason: 'scope_page_not_shared' });
      expect(await factRows('canaryfolderscope')).toHaveLength(0);
    }, 60_000);

    test('no grant, token or federation exposes a scope source, and the mark outlives the scope credential', async () => {
      const grantRefused = await refusal(rescopeClientGrant(engine, clients.plain!.id, { federatedRead: [SHARED, SCOPE_A] }, { actor: 'test' }));
      expect(grantRefused?.message).toContain('QM scope source');
      expect((await refusal(register('newscope', SCOPE_A)))?.message).toContain('QM scope source');
      expect((await refusal(mintLegacyToken(engine, { name: 'scope-tok-' + randomUUID().slice(0, 8), scopes: ['read'], takesHolders: ['world'], sourceGrant: [SCOPE_A] })))?.message).toContain('QM scope source');
      const legacy = await mintLegacyToken(engine, { name: 'plain-tok-' + randomUUID().slice(0, 8), scopes: ['read'], takesHolders: ['world'], sourceGrant: [SHARED] });
      expect((await refusal(rescopeLegacyToken(engine, { ...tokenArgs, reset: [], target: { id: legacy.id }, sources: [SHARED, SCOPE_B] })))?.message).toContain('QM scope source');
      expect((await refusal(assertNotScopeSource(engine, SCOPE_A)))?.reason).toBe('scope_source_reserved');
      const federated = async () => (await loadAllSources(engine, { federatedOnly: true })).map(s => s.id);
      expect(await softDeleteSource(engine, SCOPE_A)).not.toBeNull();
      expect(await restoreSource(engine, SCOPE_A)).toBe(true);
      expect(await federated()).not.toContain(SCOPE_A);
      const [restored] = await engine.executeRaw<{ config: unknown }>('SELECT config FROM sources WHERE id = $1', [SCOPE_A]);
      expect(parseSourceConfig(restored!.config)).toMatchObject({ federated: false, qm_scope: true });
      await engine.executeRaw(`UPDATE sources SET config = COALESCE(config, '{}'::jsonb) || jsonb_build_object('federated', true) WHERE id = $1`, [SCOPE_A]);
      expect(await federated()).not.toContain(SCOPE_A);
      expect((await markedScopeSources(engine, [SCOPE_A])).has(SCOPE_A)).toBe(true);
      expect((await refusal(rescopeClientGrant(engine, clients.scopes!.id, { privatePages: 'granted_sources' }, { actor: 'test' })))?.message).toContain('private-pages');
      await engine.executeRaw(`UPDATE oauth_clients SET deleted_at = now() WHERE client_id = $1`, [clients.scopes!.id]);
      expect((await refusal(rescopeClientGrant(engine, clients.plain!.id, { federatedRead: [SHARED, SCOPE_A] }, { actor: 'test' })))?.message).toContain('QM scope source');
      await engine.executeRaw(`UPDATE oauth_clients SET deleted_at = NULL WHERE client_id = $1`, [clients.scopes!.id]);
    }, 60_000);

    test('attest_sources changes refuse sources others read, default, the own source, a shrink still read, and wider attested ops', async () => {
      const personal = { kind: 'client' as const, id: clients.personal!.id };
      const reason = async (patch: Parameters<typeof bindCredential>[2]) => (await refusal(bindCredential(engine, personal, patch)) as { reason?: string; message: string } | null);
      expect((await reason({ attestSources: [SHARED] }))?.message).toContain('can already read');
      expect((await reason({ attestSources: ['default'] }))?.reason).toBe('scope_source_reserved');
      expect((await reason({ attestSources: [HOME] }))?.message).toContain('own write source');
      expect((await reason({ attestSources: ['no-such-source'] }))?.message).toContain('not an active source');
      expect((await refusal(bindCredential(engine, { kind: 'client', id: clients.scopes!.id }, { attestSources: [SCOPE_A] })))?.message).toContain('still reads');
      expect((await refusal(bindCredential(engine, { kind: 'client', id: clients.scopes!.id }, { attestOps: [...MEMORY_OPS, 'search'] })))?.message).toContain('scope sources');
      expect((await refusal(bindCredential(engine, { kind: 'client', id: clients.plain!.id }, { attestSources: [SCOPE_A] })))?.message).toContain('attest right');
      expect((await markedScopeSources(engine, [SHARED, HOME])).size).toBe(0);
    }, 60_000);

    const storedAuthority = async (requestId: string) => {
      const [row] = await engine.executeRaw<{ authority: any }>('SELECT authority FROM persistence_requests WHERE request_id = $1::uuid', [requestId]);
      return typeof row!.authority === 'string' ? JSON.parse(row!.authority) : row!.authority;
    };
    const scopeClient = async (name: string, attest: string[], reads: string[]) => {
      for (const id of attest) await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [id]);
      const c = await register(name, HOME);
      await bindCredential(engine, { kind: 'client', id: c.id }, { attestActor: 'qm', attestOps: MEMORY_OPS, attestSources: attest });
      await rescopeClientGrant(engine, c.id, { federatedRead: reads }, { actor: 'test' });
      tokens[name] = (await provider().exchangeClientCredentials(c.id, c.secret)).access_token;
      return c;
    };
    const raceWhile = (matches: (sql: string, params: unknown[]) => boolean, racer: () => Promise<unknown>) => {
      const original = engine.executeRaw;
      let race: Promise<Error | null> | null = null;
      engine.executeRaw = (async function (this: BrainEngine, ...args: Parameters<typeof engine.executeRaw>) {
        if (!race && matches(String(args[0]), (args[1] ?? []) as unknown[])) {
          let settled = false;
          race = refusal(racer()).finally(() => { settled = true; });
          for (let i = 0; i < 30 && !settled; i++) await new Promise(r => setTimeout(r, 50));
        }
        return original.apply(this, args);
      }) as typeof engine.executeRaw;
      return { restore: () => { engine.executeRaw = original; }, result: () => race };
    };

    test('a stored scope write is refused once its OAuth client or legacy token is rescoped to no sources', async () => {
      const NONE_SCOPE = 'qm-scope-none';
      const c = await scopeClient('nonescope', [NONE_SCOPE], [HOME, NONE_SCOPE]);
      const out = await write({ token: 'nonescope', actor: ALICE_ID }, [{ fact: 'No sources canarynonesources', provenance: 'turn n' }], { source_id: NONE_SCOPE });
      expect(out.structured!.status).toBe('committed');
      const authority = await storedAuthority(out.structured!.request_id);
      await authorizeWrite(engine as never, authority, 'remember', 'memory/scope');
      await rescopeClientGrant(engine, c.id, { sourcesNone: true, sourceId: null, federatedRead: [] }, { actor: 'test' });
      expect((await refusal(authorizeWrite(engine as never, authority, 'remember', 'memory/scope')))?.message).toContain('revoked or its source changed');

      const TOKEN_SCOPE = 'qm-scope-none-token';
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [TOKEN_SCOPE]);
      const minted = await mintLegacyToken(engine, { name: 'none-tok-' + randomUUID().slice(0, 8), scopes: ['read', 'write'], takesHolders: ['world'], sourceGrant: [HOME, TOKEN_SCOPE] });
      await bindCredential(engine, { kind: 'token', id: minted.id }, { attestActor: 'qm', attestOps: MEMORY_OPS, attestSources: [TOKEN_SCOPE] });
      tokens.nonetoken = minted.token;
      const viaToken = await write({ token: 'nonetoken', actor: ALICE_ID }, [{ fact: 'No sources token canarynonetoken', provenance: 'turn t' }], { source_id: TOKEN_SCOPE });
      expect(viaToken.structured!.status).toBe('committed');
      const tokenAuthority = await storedAuthority(viaToken.structured!.request_id);
      await authorizeWrite(engine as never, tokenAuthority, 'remember', 'memory/scope');
      await rescopeLegacyToken(engine, { ...tokenArgs, reset: [], target: { id: minted.id }, sources: [] });
      expect((await refusal(authorizeWrite(engine as never, tokenAuthority, 'remember', 'memory/scope')))?.message).toContain('no longer permits this source write');
    }, 60_000);

    test('sources federate racing an --attest-sources mark never leaves a federated or unmarked scope source', async () => {
      const FED = 'qm-scope-fed-race';
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [FED]);
      const racer = await register('fedracer', HOME);
      await bindCredential(engine, { kind: 'client', id: racer.id }, { attestActor: 'qm', attestOps: MEMORY_OPS });
      const race = raceWhile((sql, params) => sql.includes('UPDATE sources SET config = $1::text::jsonb WHERE id = $2') && params[1] === FED,
        () => bindCredential(engine, { kind: 'client', id: racer.id }, { attestSources: [FED] }));
      try {
        await runSources(engine, ['federate', FED]);
      } finally {
        race.restore();
      }
      expect(race.result()).not.toBeNull();
      const bound = await race.result();
      const [row] = await engine.executeRaw<{ config: unknown }>('SELECT config FROM sources WHERE id = $1', [FED]);
      const config = parseSourceConfig(row!.config);
      if (bound === null) expect(config).toMatchObject({ qm_scope: true, federated: false });
      else expect({ marked: config.qm_scope === true, federated: config.federated }).toEqual({ marked: false, federated: true });
    }, 60_000);

    test('a read grant widened while --attest-sources drops that source never leaves the credential reading an unlisted scope', async () => {
      const [D1, D2] = ['qm-scope-drop-1', 'qm-scope-drop-2'];
      const c = await scopeClient('droprace', [D1, D2], [HOME, D1]);
      const race = raceWhile(sql => sql.includes('UPDATE oauth_clients SET member_id'),
        () => rescopeClientGrant(engine, c.id, { federatedRead: [HOME, D1, D2] }, { actor: 'test' }));
      let dropped: Error | null;
      try {
        dropped = await refusal(bindCredential(engine, { kind: 'client', id: c.id }, { attestSources: [D1] }));
      } finally {
        race.restore();
      }
      expect(race.result()).not.toBeNull();
      const widened = await race.result();
      expect(dropped === null && widened === null).toBe(false);
      const [row] = await engine.executeRaw<{ federated_read: string[] | null; attest_sources: string[] | null }>('SELECT federated_read, attest_sources FROM oauth_clients WHERE client_id = $1', [c.id]);
      const unlisted = (row!.federated_read ?? []).filter(s => [D1, D2].includes(s) && !(row!.attest_sources ?? []).includes(s));
      expect(unlisted).toEqual([]);
    }, 60_000);

    test('a read grant widened onto a scope source while a publication holds that source does not deadlock', async () => {
      const LOCKED = 'qm-scope-share';
      const c = await scopeClient('sharelock', [LOCKED], [HOME]);
      const out = await write({ token: 'sharelock', actor: ALICE_ID }, [{ fact: 'Share lock canarysharelock', provenance: 'turn s' }], { source_id: LOCKED });
      expect(out.structured!.status).toBe('committed');
      const authority = await storedAuthority(out.structured!.request_id);
      const ROLLBACK = new Error('rollback');
      let grant: Promise<Error | null> | null = null;
      let published: Error | null = new Error('not run');
      await engine.transaction(async tx => {
        await tx.executeRaw('SELECT 1 FROM sources WHERE id = $1 FOR SHARE', [LOCKED]);
        grant = refusal(rescopeClientGrant(engine, c.id, { federatedRead: [HOME, LOCKED] }, { actor: 'test' }));
        await new Promise(r => setTimeout(r, 300));
        published = await refusal(authorizeWrite(tx as never, authority, 'remember', 'memory/scope', true));
        throw ROLLBACK;
      }).catch(e => { if (e !== ROLLBACK) throw e; });
      expect(published).toBeNull();
      expect(await grant).toBeNull();
    }, 60_000);
  });
}

describe('scope writes (pglite, repo-backed)', () => {
  test('a scope write to a repo-backed scope source is committed to that source\'s git checkout under the writer door', () => managedBrain(async ({ engine, root }) => {
    const scopeRoot = join(dirname(root), 'scope');
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test' } });
    __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(vectorFor) })) as never);
    try {
      await addMember(engine, 'alice-example');
      await linkMember(engine, 'alice-example', 'qm', ALICE_ID);
      const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
      const c = await provider.registerClientManual('s-repo-' + randomUUID().slice(0, 8), ['client_credentials'], 'read write', [], 'default');
      await bindCredential(engine, { kind: 'client', id: c.clientId }, { attestActor: 'qm', attestOps: MEMORY_OPS, attestSources: ['scope-repo'] });
      await rescopeClientGrant(engine, c.clientId, { federatedRead: ['default', 'scope-repo'] }, { actor: 'test' });
      const auth = await provider.verifyAccessToken((await provider.exchangeClientCredentials(c.clientId, c.clientSecret ?? '')).access_token) as unknown as AuthInfo;
      const result = await dispatchToolCall(engine, 'memory_write', { facts: [{ fact: 'The repo scope ships Friday canaryreposcope', provenance: 'slack:C0REPO/p1' }], idempotency_key: randomUUID(), source_id: 'scope-repo' },
        { remote: true, transport: 'http', auth, sourceId: auth.sourceId, actor: { header: ALICE_ID }, writeWaitMs: 30_000 });
      expect(result.isError).not.toBe(true);
      expect(['committed', 'pending']).toContain((result.structuredContent as { status: string }).status);
      await settleManagedGitEffects(engine, 'scope-repo');
      const file = readFileSync(join(scopeRoot, 'memory/scope.md'), 'utf8');
      expect(file).toContain('canaryreposcope');
      expect(file).not.toContain('readable_by');
      expect(git(scopeRoot, 'log', '--format=%H', '--', 'memory/scope.md').trim()).not.toBe('');
      expect(git(scopeRoot, 'status', '--porcelain', '--', 'memory').trim()).toBe('');
      expect(existsSync(join(root, 'memory/scope.md'))).toBe(false);
      const [row] = await engine.executeRaw<{ source_id: string; visibility: string }>("SELECT source_id, visibility FROM facts WHERE fact LIKE '%canaryreposcope%'");
      expect(row).toEqual({ source_id: 'scope-repo', visibility: 'world' });
    } finally { __setEmbedTransportForTests(null); resetGateway(); }
  }, { setup: async ({ engine, root }) => {
    const scopeRoot = join(dirname(root), 'scope');
    for (const dir of [root, scopeRoot]) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, '.gitignore'), '\n'); durableGitRepo(dir, ['.gitignore']); }
    await engine.executeRaw('INSERT INTO sources (id, name, local_path) VALUES ($1, $1, $2)', ['scope-repo', scopeRoot]);
    await claimWorktree(engine, 'scope-repo', scopeRoot);
  } }), 120_000);
});

describe('attest right of a scope credential (pure)', () => {
  test('a credential listing scope sources runs only the scope operations, whatever its stored or default attest_ops say', () => {
    const scoped = attestRightFrom({ attest_actor: 'qm', attest_ops: ['memory_recall', 'recall', 'search', 'memory_write'], attest_sources: ['scope-a'] }, 'client_credentials', null);
    expect(scoped).toEqual({ system: 'qm', ops: ['memory_recall', 'memory_write'], sources: ['scope-a'] });
    const defaults = attestRightFrom({ attest_actor: 'qm', attest_ops: null, attest_sources: ['scope-a'] }, 'legacy', null);
    expect(defaults?.ops.every(op => ['forget', 'forget_fact', 'get_write_request', 'memory_recall', 'memory_write'].includes(op))).toBe(true);
    const plain = attestRightFrom({ attest_actor: 'qm', attest_ops: ['memory_recall', 'recall'], attest_sources: null }, 'legacy', null);
    expect(plain?.ops).toEqual(['memory_recall', 'recall']);
  });
});

describe('backup restore quarantine keeps the scope mark', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
  }, 120_000);
  afterAll(async () => { await engine.disconnect(); });

  test('an external scope source detached by a restore stays a QM scope source', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('scope-q', 'scope-q', '{"qm_scope": true, "federated": false, "remote_url": "https://git.example.com/scope.git"}'::jsonb)`);
    const rows = await engine.executeRaw<{ id: string; local_path: string | null }>('SELECT id, local_path FROM sources ORDER BY id');
    const out = await quarantineRestoredExecution(engine, { sources: rows.map(r => ({ id: r.id, local_path: r.local_path, managed_relative_path: null })), originalRoot: '/old', root: '/new', managedPaths: [], restoreId: 'r1' });
    expect(out.sources.map(s => s.id)).toContain('scope-q');
    expect((await markedScopeSources(engine, ['scope-q'])).has('scope-q')).toBe(true);
  }, 120_000);
});

describe('CLI client registration keeps the pre-migration fallback', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
  }, 60_000);
  afterAll(async () => { await engine.disconnect(); });

  test('register-client on an oauth_clients table without source_id still registers when given a transaction', async () => {
    await engine.executeRaw('DROP TABLE IF EXISTS oauth_clients CASCADE');
    await engine.executeRaw(`CREATE TABLE oauth_clients (client_id TEXT PRIMARY KEY, client_secret_hash TEXT, client_name TEXT NOT NULL,
      redirect_uris TEXT[], grant_types TEXT[], scope TEXT, token_endpoint_auth_method TEXT, client_id_issued_at BIGINT, deleted_at TIMESTAMPTZ)`);
    const sql = sqlQueryForEngine(engine);
    const registered = await registerScopedClient(sql, 'old-schema-client', { grantTypes: ['client_credentials'], scopes: 'read', sourceId: 'default', federatedRead: [], redirectUris: [], tokenEndpointAuthMethod: 'client_secret_post' } as never,
      { transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    const rows = await engine.executeRaw<{ client_name: string }>('SELECT client_name FROM oauth_clients WHERE client_id = $1', [registered.clientId]);
    expect(rows.map(r => r.client_name)).toEqual(['old-schema-client']);
  }, 60_000);
});
