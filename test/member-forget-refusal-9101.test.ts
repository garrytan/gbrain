/**
 * #9101: a remote member's forget names who can withdraw a fact it can see but cannot withdraw.
 *
 * 1. Protects: a member-bound credential that forgets a fact it reads (a fact it shared, or another member's shared
 *    fact) gets scope_denied naming the brain host, and the fact stays active; a fact the caller cannot read (another
 *    member's private fact) still answers not_found, so the reply never confirms a hidden fact; the caller's own
 *    private fact is still withdrawn. GST-2346 D1: an owner-bound credential withdraws a fact it shared.
 * 2. Fails when: forget answers not_found for a fact the caller just saved or reads, or the refusal leaks a fact the
 *    caller cannot read.
 * 3. Existing coverage: test/access-member-facts.test.ts (GST-359 D) pins forget on the member page.
 * 4. Real seams: OAuth client-credentials tokens bound to members and to the owner, MCP dispatch as remote callers,
 *    a repo-less brain, PGLite and Postgres.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { addMember, bindCredential } from '../src/core/access/members.ts';
import { setOwner } from '../src/core/access/owner.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const SRC = 'source-a';
const ACME = 'companies/acme-example';

for (const kind of testBackends()) {
  describe('forget from a member or owner credential (' + kind + ', repo-less)', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const tokens: Record<string, string> = {};
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    async function call(who: string, op: string, params: Record<string, unknown>) {
      const out = await dispatchToolCall(engine, op, { ...params }, {
        remote: true, transport: 'http', auth: await provider().verifyAccessToken(tokens[who]!) as unknown as AuthInfo, sourceId: SRC, takesHoldersAllowList: ['world'],
      });
      const text = out.content.map(c => c.text).join('\n');
      let json: Record<string, any> = {};
      try { json = JSON.parse(text); } catch { /* prose */ }
      return { isError: out.isError === true, text, json };
    }
    const saved = async (who: string, fact: string, extra: Record<string, unknown> = {}) => {
      const out = await call(who, 'remember', { fact, entity: ACME, provenance: 'forget test', ...extra });
      expect(out.isError ? out.text : 'ok').toBe('ok');
      return String(out.json.id);
    };
    const active = async (id: string) => (await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM facts WHERE id = $1 AND expired_at IS NULL', [Number(id)]))[0]!.n === 1;

    beforeAll(async () => {
      configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'test' } });
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(() => new Array<number>(1536).fill(0).map((_, i) => (i === 0 ? 1 : 0))) })) as never);
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      __resetPrivateVisibilityCacheForTests();
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
      for (const id of ['alice-example', 'bob-example', 'carol-example']) await addMember(engine, id);
      await setOwner(engine, 'carol-example');
      await importFromContent(engine, ACME, '---\ntype: company\ntitle: Acme Example\n---\n# Acme Example\n\nAcme example builds harbor ledgers.', { sourceId: SRC });
      for (const [name, member] of [['alice', 'alice-example'], ['bob', 'bob-example'], ['owner', 'carol-example']] as const) {
        const c = await provider().registerClientManual('forget-' + name + '-' + randomUUID().slice(0, 8), ['client_credentials'], 'read write', [], SRC);
        await bindCredential(engine, { kind: 'client', id: c.clientId }, { member });
        tokens[name] = (await provider().exchangeClientCredentials(c.clientId, c.clientSecret ?? '')).access_token;
      }
    }, 120_000);

    afterAll(async () => { __setEmbedTransportForTests(null); resetGateway(); await close?.(); });

    test('a member forgetting a fact it shared is refused (scope_denied) with a reply naming the brain host, and the fact stays', async () => {
      const id = await saved('alice', 'Acme renewed for 40 seats canaryaliceshared', { share: true });
      const out = await call('alice', 'forget', { id });
      expect(out.isError).toBe(true);
      expect(out.json.error).toBe('scope_denied');
      expect(out.text).toContain('brain host');
      expect(out.text).toContain(`gbrain forget ${id}`);
      expect(out.text).not.toContain('No fact with id');
      expect(await active(id)).toBe(true);
      const viaFact = await call('alice', 'forget_fact', { id: Number(id) });
      expect([viaFact.isError, viaFact.json.error, viaFact.text.includes('brain host')]).toEqual([true, 'permission_denied', true]);
    }, 120_000);

    test("another member forgetting a shared fact is refused the same way; another member's private fact stays not_found", async () => {
      const shared = await saved('alice', 'Acme asked for SSO canarysharedforbob', { share: true });
      const kept = await saved('alice', 'Acme renewal worried me canaryaliceprivate');
      const sharedOut = await call('bob', 'forget', { id: shared });
      expect([sharedOut.isError, sharedOut.json.error]).toEqual([true, 'scope_denied']);
      expect(sharedOut.text).toContain('brain host');
      const hidden = await call('bob', 'forget', { id: kept });
      expect([hidden.isError, hidden.json.error]).toEqual([true, 'not_found']);
      expect(hidden.text).not.toContain('brain host');
      const hiddenFact = await call('bob', 'forget_fact', { id: Number(kept) });
      expect([hiddenFact.isError, hiddenFact.json.error]).toEqual([true, 'fact_not_found']);
      expect(await active(shared)).toBe(true);
      expect(await active(kept)).toBe(true);
    }, 120_000);

    test("an owner-bound credential withdraws a fact it shared (GST-2346 D1); a member's private fact stays not_found to it", async () => {
      const shared = await saved('owner', 'Acme moved its HQ canaryownershared', { share: true });
      const recalled = await call('owner', 'recall', { entity: ACME });
      const out = await call('owner', 'forget', { id: shared });
      expect(out.isError ? out.text : 'ok').toBe('ok');
      expect(await active(shared)).toBe(false);
      const bobs = await saved('bob', 'Acme lunch plans canarybobprivate');
      const hidden = await call('owner', 'forget', { id: bobs });
      expect([hidden.isError, hidden.json.error]).toEqual([true, 'not_found']);
      expect(await active(bobs)).toBe(true);
      expect([recalled.text.includes('canaryownershared'), (await call('owner', 'recall', { entity: ACME })).text.includes('canarybobprivate')]).toEqual([true, false]);
    }, 120_000);

    test("a member still withdraws its own private fact", async () => {
      const own = await saved('alice', 'Acme note canaryalicewithdraws');
      const out = await call('alice', 'forget', { id: own });
      expect(out.isError ? out.text : 'ok').toBe('ok');
      expect(await active(own)).toBe(false);
    }, 120_000);
  });
}
