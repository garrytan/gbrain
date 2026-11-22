/**
 * GST-2897 B: a member's remember with share: true about another member is held for the brain owner, and the member a
 * shared fact is about can withdraw it.
 *
 * 1. Protects: one member cannot publish a fact about another member to every reader of the source on its own say-so;
 *    the fact is stored private with a confirm proposal, and only the owner's accept shares it. The subject member's
 *    forget withdraws a shared fact about itself instead of being told only the brain host can.
 * 2. Fails when: the share is stored world or recalled by another member before the accept, no proposal is filed, the
 *    accept does not widen it, a share about the team's work or about the caller itself is held, the visibility "world"
 *    refusal still tells the agent to retry with share: true for another member's page, or the subject cannot forget it
 *    (or can forget a fact about someone else).
 * 3. Existing coverage: test/remember-share-gst2243.test.ts (share: true), test/member-forget-refusal-9101.test.ts
 *    (member forget refusals), test/remember-restated-private-2875.test.ts (the restatement hold this one extends).
 * 4. Real seams: OAuth client-credentials tokens bound to members and the owner, MCP dispatch as remote callers, a
 *    repo-less brain, managed and unmanaged, PGLite and Postgres.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { decideTrustProposal } from '../src/core/trust/decide.ts';
import { getTrustProposal, parseTrustProposalRef } from '../src/core/trust/proposals.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';

const SRC = 'source-a';
const ACME = 'companies/acme-example';
const BOB = 'people/bob-example';
const ALICE = 'people/alice-example';
const owner = { confirmation: { via: 'tty' as const } };

for (const kind of testBackends()) for (const managed of [false, true]) {
  describe('share: true about another member (' + kind + (managed ? ', managed' : '') + ', repo-less)', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const home = mkdtempSync(join(tmpdir(), 'gbrain-share-held-'));
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
    const saved = async (who: string, fact: string, entity: string, extra: Record<string, unknown> = {}) => {
      const out = await call(who, 'remember', { fact, entity, provenance: 'share test', ...extra });
      expect(out.isError ? out.text : 'ok').toBe('ok');
      return out.json;
    };
    const row = async (id: string) => (await engine.executeRaw<{ visibility: string; trust_tier: string; active: boolean }>(
      'SELECT visibility, trust_tier, expired_at IS NULL AS active FROM facts WHERE id = $1', [Number(id)]))[0]!;
    const recalls = async (who: string, entity: string, claim: string) => (await call(who, 'recall', { entity })).text.includes(claim);

    beforeAll(async () => {
      configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'test' } });
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(() => new Array<number>(1536).fill(0).map((_, i) => (i === 0 ? 1 : 0))) })) as never);
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      __resetPrivateVisibilityCacheForTests();
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
      for (const id of ['alice-example', 'bob-example', 'dave-example', 'owner-example']) await addMember(engine, id);
      await setOwner(engine, 'owner-example');
      await importFromContent(engine, ACME, '---\ntype: company\ntitle: Acme Example\n---\n# Acme Example\n\nAcme example builds harbor ledgers.', { sourceId: SRC });
      await importFromContent(engine, BOB, '---\ntype: person\ntitle: Bob Example\n---\n# Bob Example\n\nBob example runs the ledger team.', { sourceId: SRC });
      await importFromContent(engine, ALICE, '---\ntype: person\ntitle: Alice Example\n---\n# Alice Example\n\nAlice example runs sales.', { sourceId: SRC });
      for (const [name, member] of [['alice', 'alice-example'], ['bob', 'bob-example'], ['dave', 'dave-example'], ['owner', 'owner-example']] as const) {
        const c = await provider().registerClientManual('share-' + name + '-' + randomUUID().slice(0, 8), ['client_credentials'], 'read write', [], SRC);
        await bindCredential(engine, { kind: 'client', id: c.clientId }, { member });
        tokens[name] = (await provider().exchangeClientCredentials(c.clientId, c.clientSecret ?? '')).access_token;
      }
      if (managed) await withEnv({ GBRAIN_HOME: home }, async () => {
        await registerLocalWriter(engine, 'cli');
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      });
    }, 120_000);

    afterAll(async () => { __setEmbedTransportForTests(null); resetGateway(); await disposePersistenceConsumer(engine); await close?.(); rmSync(home, { recursive: true, force: true }); });

    test("a member's share about another member is held private until the owner's accept shares it", async () => {
      const out = await saved('alice', 'Bob example is interviewing elsewhere canaryheldshare', BOB, { share: true });
      expect(out.visibility).toBe('private');
      expect(out.held).toMatchObject({ member: 'bob-example' });
      expect(out.status_text).toContain('brain owner');
      expect(await row(out.id)).toMatchObject({ visibility: 'private', trust_tier: 'agent_written', active: true });
      expect([await recalls('dave', BOB, 'canaryheldshare'), await recalls('bob', BOB, 'canaryheldshare')]).toEqual([false, false]);
      expect((await call('dave', 'get_page', { slug: BOB })).text).not.toContain('canaryheldshare');
      const id = parseTrustProposalRef(out.held.proposal_ref)!;
      expect(await getTrustProposal(engine, id)).toMatchObject({ action: 'confirm', status: 'pending', target_id: Number(out.id), related_id: Number(out.id) });
      expect((await decideTrustProposal(engine, id, 'accept', owner)).status).toBe('accepted');
      expect(await row(out.id)).toMatchObject({ visibility: 'world', trust_tier: 'agent_written' });
      expect(await recalls('dave', BOB, 'canaryheldshare')).toBe(true);
      expect((await call('dave', 'get_page', { slug: BOB })).text).toContain('canaryheldshare');
      const withdrawn = await call('bob', 'forget', { id: out.id });
      expect(withdrawn.isError ? withdrawn.text : 'ok').toBe('ok');
      expect((await row(out.id)).active).toBe(false);
    }, 120_000);

    test('a dropped share stays private', async () => {
      const out = await saved('alice', 'Bob example asked for a raise canarydroppedshare', BOB, { share: true });
      const id = parseTrustProposalRef(out.held.proposal_ref)!;
      expect((await decideTrustProposal(engine, id, 'reject', owner)).status).toBe('rejected');
      expect(await row(out.id)).toMatchObject({ visibility: 'private', active: true });
      expect(await recalls('dave', BOB, 'canarydroppedshare')).toBe(false);
    }, 120_000);

    test("shares about the team's work, about the caller itself, and by the owner are not held", async () => {
      const team = await saved('alice', 'Acme renewed for 40 seats canaryteamshare', ACME, { share: true });
      const self = await saved('alice', 'Alice example moved to the Berlin office canaryselfshare', ALICE, { share: true });
      const byOwner = await saved('owner', 'Bob example leads the Q3 launch canaryownershare', BOB, { share: true });
      for (const out of [team, self, byOwner]) {
        expect(out.held).toBeUndefined();
        expect(out.visibility).toBe('world');
        expect((await row(out.id)).visibility).toBe('world');
      }
      expect([await recalls('dave', ACME, 'canaryteamshare'), await recalls('dave', ALICE, 'canaryselfshare'), await recalls('dave', BOB, 'canaryownershare')])
        .toEqual([true, true, true]);
    }, 120_000);

    test('the member a shared fact is about withdraws it; it still cannot withdraw a shared fact about someone else', async () => {
      const aboutBob = await saved('owner', 'Bob example joined the ledger guild canarybobwithdraws', BOB, { share: true });
      const aboutAlice = await saved('owner', 'Alice example closed the Acme deal canarynotbobs', ALICE, { share: true });
      const own = await call('bob', 'forget', { id: aboutBob.id });
      expect(own.isError ? own.text : 'ok').toBe('ok');
      expect((await row(aboutBob.id)).active).toBe(false);
      const other = await call('bob', 'forget', { id: aboutAlice.id });
      expect([other.isError, other.json.error]).toEqual([true, 'scope_denied']);
      expect(other.text).toContain('brain host');
      expect((await row(aboutAlice.id)).active).toBe(true);
    }, 120_000);

    test('visibility "world" about another member is refused without pointing at share: true', async () => {
      const other = await call('alice', 'remember', { fact: 'Bob example is out next week canaryworldrefused', entity: BOB, provenance: 'share test', visibility: 'world' });
      expect([other.isError, other.json.error]).toEqual([true, 'invalid_params']);
      expect(other.text).toContain('member bob-example');
      expect(other.text).not.toContain('Retry the same call with share: true');
      const team = await call('alice', 'remember', { fact: 'Acme moved its HQ canaryworldteam', entity: ACME, provenance: 'share test', visibility: 'world' });
      expect(team.text).toContain('Retry the same call with share: true');
    }, 120_000);
  });
}
