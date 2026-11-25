/**
 * 1. An owner-bound read can see existing pins within its source and reader
 *    policy. The same policy applies to their saved evidence.
 * 2. Reverting owner admission refuses the readable pin. Dropping the read
 *    policy admits pins or evidence that the normal page read withholds.
 * 3. The pinned-questions suites cover the legacy privacy opt-out and local
 *    refresh. They do not cover an owner-bound OAuth client on a member brain.
 * 4. Uses the production OAuth exchange, credential binding and MCP dispatch,
 *    with the existing deterministic answer fixture. No new production seam.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { addMember, bindCredential } from '../src/core/access/members.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { proposeRevision } from '../src/core/access/policy.ts';
import { rescopeClientGrant } from '../src/core/grants/service.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { pinQuestion } from '../src/core/questions/service.ts';
import type { QuestionReceipt } from '../src/core/questions/receipt.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { TEST_PKCE_CHALLENGE, TEST_PKCE_VERIFIER } from './helpers/oauth.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { CANARY, ENTITY, MODEL, QUESTION, localCtx, newSource, seedBrain, stubAnswer } from './helpers/pinned-questions-fixture.ts';
import { testBackends } from './helpers/test-backends.ts';

const OWNER = 'owner-example';
const OTHER = 'member-example';
const REDIRECT = 'https://connector.example/oauth/callback';
const SCOPES = ['read', 'write'];

for (const backend of testBackends()) {
  describe(`owner reads pinned questions over MCP (${backend})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let provider: GBrainOAuthProvider;
    let token: string;
    let legacyToken: string;
    let memberToken: string;
    let visible: QuestionReceipt;
    let restricted: QuestionReceipt;
    let outside: QuestionReceipt;

    async function call(
      accessToken: string, op: string, args: Record<string, unknown>, audience?: string,
    ) {
      __resetPrivateVisibilityCacheForTests();
      const auth = await provider.verifyAccessToken(accessToken) as unknown as AuthInfo;
      const out = await dispatchToolCall(engine, op, args, {
        remote: true, transport: 'http', sourceId: auth.sourceId ?? 'default', auth,
        takesHoldersAllowList: auth.takesHoldersAllowList,
        ...(audience ? { onBehalfOf: { header: audience } } : {}),
      });
      const text = out.content.map(c => c.text).join('\n');
      const json = out.content[0]?.text ?? '{}';
      return { isError: out.isError === true, text, json };
    }

    beforeAll(async () => {
      if (backend === 'postgres') {
        ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      } else {
        engine = new PGLiteEngine();
        await engine.connect({ engine: 'pglite' });
        close = () => engine.disconnect();
        await engine.initSchema();
      }
      const { sourceId } = await seedBrain(engine);
      const keptSource = await newSource(engine);
      const outsideSource = await newSource(engine);
      // These pins predate the owner designation.
      visible = (await pinQuestion(localCtx(engine, sourceId), { question: QUESTION, scope: { entity: ENTITY } }, {
        chat: async req => ({ text: stubAnswer(req.user), usage: { input_tokens: 1000, output_tokens: 200 }, model: MODEL }),
      })).receipt;
      restricted = (await pinQuestion(localCtx(engine, keptSource), { question: 'Which example plans are next?', defer: true })).receipt;
      outside = (await pinQuestion(localCtx(engine, outsideSource), { question: 'Which example plans are current?', defer: true })).receipt;

      await addMember(engine, OWNER);
      await addMember(engine, OTHER);
      await setOwner(engine, OWNER);
      const policy = await proposeRevision(engine, keptSource, [
        { id: 'kept-pins', prefix: 'questions/', readable_by: [`member:${OTHER}`] },
      ], { origin: 'cli', store: 'database' });
      expect(policy.state).toBe('applied');

      provider = new GBrainOAuthProvider({
        sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))),
      });
      const { clientId } = await provider.registerClientManual(
        'owner-console-example', ['authorization_code'], SCOPES.join(' '), [REDIRECT],
        sourceId, [sourceId, keptSource], 'none',
      );
      await rescopeClientGrant(engine, clientId, {
        privatePages: 'granted_sources', takesHolders: ['world'],
      }, { actor: 'operator:cli' });
      await bindCredential(engine, { kind: 'client', id: clientId }, {
        member: OWNER, mayActFor: [`member:${OWNER}`, `member:${OTHER}`],
      });
      const request = await provider.grants.begin(clientId, {
        scopes: SCOPES, codeChallenge: TEST_PKCE_CHALLENGE, redirectUri: REDIRECT,
      });
      const approval = new URL(await provider.grants.decide(request, true));
      const client = (await provider.clientsStore.getClient(clientId))!;
      token = (await provider.exchangeAuthorizationCode(client, approval.searchParams.get('code')!, TEST_PKCE_VERIFIER, REDIRECT)).access_token;
      const auth = await provider.verifyAccessToken(token) as unknown as AuthInfo;
      expect(auth.takesHoldersAllowList).toEqual(['world']);

      for (const member of [OWNER, OTHER]) {
        const legacy = await mintLegacyToken(engine, { name: member, scopes: SCOPES, sourceGrant: [sourceId], takesHolders: ['world'] });
        await bindCredential(engine, { kind: 'token', id: legacy.id }, { member });
        if (member === OWNER) legacyToken = legacy.token;
        else memberToken = legacy.token;
      }
    }, 240_000);

    afterAll(async () => { await close?.(); }, 60_000);

    test('the owner OAuth client sees a preexisting pin and its readable answer', async () => {
      const list = await call(token, 'questions_list', {});
      expect(list.isError).toBe(false);
      expect(JSON.parse(list.json).questions.map((q: QuestionReceipt) => q.id)).toEqual([visible.id]);
      const status = await call(token, 'questions_status', { id: visible.id });
      expect(status.isError).toBe(false);
      expect(JSON.parse(status.json)).toMatchObject({ id: visible.id, question: QUESTION });
      expect(status.text).toContain(CANARY);
    });

    test('an owner legacy token also sees that pin', async () => {
      const status = await call(legacyToken, 'questions_status', { id: visible.id });
      expect(status.isError).toBe(false);
      expect(JSON.parse(status.json).id).toBe(visible.id);
    });

    test('a restricted question page is absent from list and status', async () => {
      const page = await call(token, 'get_page', { source_id: restricted.source_id, slug: restricted.slug });
      expect(page.isError).toBe(true);
      const list = await call(token, 'questions_list', { source: restricted.source_id });
      expect(list.isError).toBe(false);
      expect(JSON.parse(list.json).questions).toEqual([]);
      const status = await call(token, 'questions_status', { id: restricted.id });
      expect(status.isError).toBe(true);
      expect(status.text).toContain('question_not_found');
    });

    test('source grants apply to owner reads', async () => {
      const status = await call(token, 'questions_status', { id: outside.id });
      expect(status.isError).toBe(true);
      expect(status.text).toContain('question_not_found');
    });

    test('member and shared-audience requests retain their existing access', async () => {
      const member = await call(memberToken, 'questions_list', {});
      expect(member.isError).toBe(true);
      expect(member.text).toContain('question_owner_only');
      const audience = await call(token, 'questions_list', {}, `member:${OWNER},member:${OTHER}`);
      expect(audience.isError).toBe(true);
      expect(audience.text).toContain('question_owner_only');
    });

    test('an owner read does not widen pin writes or context packs', async () => {
      const unpin = await call(token, 'questions_unpin', { id: visible.id });
      expect(unpin.isError).toBe(true);
      expect(unpin.text).toContain('question_owner_only');
      const pack = await call(token, 'context_pack', { entity_refs: [{ source_id: visible.source_id, slug: ENTITY }] });
      expect(pack.isError).toBe(false);
      expect(JSON.parse(pack.json).pinned_questions).toBeUndefined();
    });

    test('saved sentences follow current evidence access and the take-holder grant', async () => {
      const original = visible.answer?.map(sentence => sentence.text).join('\n') ?? '';
      expect(original).toContain('40 employees');
      expect(original).toContain('will ship widgets');
      const policy = await proposeRevision(engine, visible.source_id, [
        { id: 'kept-evidence', prefix: 'companies/', readable_by: [`member:${OTHER}`] },
      ], { origin: 'cli', store: 'database' });
      expect(policy.state).toBe('applied');
      const status = await call(token, 'questions_status', { id: visible.id });
      expect(status.isError).toBe(false);
      const receipt = JSON.parse(status.json) as QuestionReceipt;
      expect(receipt.sentences.withheld).toBeGreaterThan(0);
      const answer = receipt.answer?.map(sentence => sentence.text).join('\n') ?? '';
      expect(answer).not.toContain('40 employees');
      expect(answer).not.toContain('builds widgets in Lisbon');
      expect(answer).toContain('leads acme-example engineering');
      expect(answer).not.toContain('will ship widgets');
    });
  });
}
