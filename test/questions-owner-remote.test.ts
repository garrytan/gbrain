/**
 * Pinned questions over remote MCP for the brain owner (config access.owner_member).
 *
 * 1. Protects: a credential bound to the owner lists pins and reads their status over MCP, limited to pins whose
 *    question page it reads under its source grant and readers, with answer sentences dropped when their evidence is
 *    stale or a page it cannot read. Every other remote caller keeps question_owner_only: another member, an unbound
 *    token, the owner speaking for another member, a slug-fenced owner credential and a delegated subagent run. Pin
 *    management stays refused for the owner.
 * 2. Fails when: the owner's credential is refused, sees a pin outside its grant or one whose page names other readers,
 *    or reads a sentence drawn from a page closed to it.
 * 3. Real seams: tokens minted by the token service, verified by the serve --http verifier and dispatched through MCP
 *    dispatch (remote: true), on a repo-less PGLite brain; the stub model answers.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { noGrantFederatedScope } from '../src/core/source-resolver.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests, withCallerAccess } from '../src/core/search/private-visibility.ts';
import { remoteCallerAccess } from '../src/core/access/caller.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { bindCredential } from '../src/core/access/members.ts';
import { listQuestions, pinQuestion, questionStatus } from '../src/core/questions/service.ts';
import type { QuestionReceipt } from '../src/core/questions/receipt.ts';
import type { AuthInfo, OperationContext } from '../src/core/ops/contract.ts';
import { CANARY, ENTITY, QUESTION, localCtx, logger, page, putPage, seedBrain, stubChat, type Seeded } from './helpers/pinned-questions-fixture.ts';
import { readsUnscopedOnPurpose } from './helpers/reads-unscoped.ts';

const OWNER = 'owner-example';
const OTHER = 'bob-example';
const CLOSED = 'notes/bob-widgets';

describe('pinned questions for the owner over remote MCP (pglite, repo-less)', () => {
  let engine: PGLiteEngine;
  let a: Seeded;
  let b: Seeded;
  let pinA: QuestionReceipt;
  let pinB: QuestionReceipt;
  let pinClosed: QuestionReceipt;
  const tokens: Record<string, string> = {};
  const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
  const verify = async (who: string) => await provider().verifyAccessToken(tokens[who]!) as unknown as AuthInfo;

  async function call(who: string, op: string, params: Record<string, unknown>, extra: { auth?: Partial<AuthInfo>; header?: string } = {}) {
    const auth = { ...await verify(who), ...extra.auth } as AuthInfo;
    const sourceId = auth.sourceId ?? 'default';
    const localFederated = await noGrantFederatedScope(engine, auth.hasSourceGrant, sourceId);
    const out = await dispatchToolCall(engine, op, { ...params }, {
      remote: true, transport: 'http', auth, sourceId, takesHoldersAllowList: auth.takesHoldersAllowList ?? ['world'],
      config: { engine: engine.kind, embedding_disabled: true } as never, logger,
      ...(localFederated ? { localFederatedSourceIds: localFederated } : {}), ...(extra.header ? { onBehalfOf: { header: extra.header } } : {}),
    });
    const text = out.content.map(c => (c as { text?: string }).text ?? '').join('\n');
    let body: Record<string, unknown> = {};
    try { body = JSON.parse((out.content[0] as { text: string }).text); } catch { /* not JSON */ }
    return { isError: out.isError === true, text, body };
  }

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    __resetPrivateVisibilityCacheForTests();
    a = await seedBrain(engine);
    b = await seedBrain(engine);
    await putPage(engine, a.sourceId, CLOSED, page('note', 'Bob widgets', 'Bob example tracks acme-example widgets in Porto.', `readable_by: [${OTHER}]\n`));
    pinA = (await pinQuestion(localCtx(engine, a.sourceId), { question: QUESTION, scope: { entity: ENTITY } }, { chat: stubChat().fn })).receipt;
    pinB = (await pinQuestion(localCtx(engine, b.sourceId), { question: QUESTION, scope: { entity: ENTITY } }, { chat: stubChat().fn })).receipt;
    pinClosed = (await pinQuestion(localCtx(engine, a.sourceId), { question: 'What does bob-example track for acme-example?', scope: { slug_prefix: 'notes/' } }, { chat: stubChat().fn })).receipt;
    await engine.executeRaw(`UPDATE pages SET frontmatter = frontmatter || jsonb_build_object('readable_by', jsonb_build_array($3::text)), page_readers = ARRAY['member:' || $3::text]
      WHERE source_id = $1 AND slug = $2`, [a.sourceId, pinClosed.slug, OTHER]);
    for (const id of [OWNER, OTHER]) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', [id]);
    const mint = async (name: string, member?: string, mayActFor?: string[]) => {
      const minted = await mintLegacyToken(engine, { name, scopes: ['read', 'write'], takesHolders: ['world'], sourceGrant: [a.sourceId] });
      tokens[name] = minted.token;
      if (member) await bindCredential(engine, { kind: 'token', id: minted.id }, { member, ...(mayActFor ? { mayActFor } : {}) });
      else await readsUnscopedOnPurpose(engine, minted.id);
    };
    await mint('owner', OWNER, [`member:${OWNER}`, `member:${OTHER}`]);
    await mint('other', OTHER);
    await mint('unbound');
    await setOwner(engine, OWNER);
  }, 240_000);

  afterAll(async () => { await engine?.disconnect(); }, 60_000);

  test('fixture control: the local CLI sees the pins of each source, and the closed page is cited in source a', async () => {
    const local = await listQuestions(localCtx(engine, a.sourceId), { source: a.sourceId });
    expect(local.questions.map(q => q.id).sort()).toEqual([pinA.id, pinClosed.id].sort());
    expect(pinA.answer!.some(s => s.text.includes(CLOSED))).toBe(true);
    expect(pinA.answer!.some(s => s.text.includes('notes/widget-plan'))).toBe(true);
    expect((await listQuestions(localCtx(engine, b.sourceId), { source: b.sourceId })).questions.map(q => q.id)).toEqual([pinB.id]);
  });

  test('the owner lists only pins in its granted source whose question page it reads', async () => {
    const out = await call('owner', 'questions_list', {});
    expect(out.isError).toBe(false);
    expect((out.body.questions as QuestionReceipt[]).map(q => q.id)).toEqual([pinA.id]);
    expect(out.text).not.toContain(pinB.id);
    expect(out.text).not.toContain(pinClosed.id);
  });

  test('the owner reads status, without sentences drawn from a page it cannot read', async () => {
    const out = await call('owner', 'questions_status', { id: pinA.id });
    expect(out.isError).toBe(false);
    const receipt = out.body as unknown as QuestionReceipt;
    expect(receipt.answer!.some(s => s.text.includes('notes/widget-plan'))).toBe(true);
    expect(receipt.answer!.some(s => s.text.includes(CLOSED))).toBe(false);
    expect(out.text).not.toContain('Porto');
    expect(receipt.sentences.withheld).toBeGreaterThan(0);
  });

  test('a world-only grant hides a sentence citing a page that holds another holder\'s take; a grant naming that holder reads it', async () => {
    const [cited] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id = $1 AND slug = $2', [a.sourceId, 'notes/widget-plan']);
    await engine.executeRaw("INSERT INTO takes (page_id, row_num, claim, kind, holder) VALUES ($1, 9001, 'A private view of the widget plan', 'take', 'alice-example')", [cited!.id]);
    try {
      const narrow = await call('owner', 'questions_status', { id: pinA.id });
      expect(narrow.isError).toBe(false);
      expect((narrow.body as unknown as QuestionReceipt).answer!.some(s => s.text.includes('notes/widget-plan'))).toBe(false);
      const wide = await call('owner', 'questions_status', { id: pinA.id }, { auth: { takesHoldersAllowList: ['world', 'alice-example'] } });
      expect((wide.body as unknown as QuestionReceipt).answer!.some(s => s.text.includes('notes/widget-plan'))).toBe(true);
    } finally {
      await engine.executeRaw('DELETE FROM takes WHERE page_id = $1 AND row_num = 9001', [cited!.id]);
    }
  });

  test('the owner gets not_found for a pin in an ungranted source or one whose page names other readers', async () => {
    for (const id of [pinB.id, pinClosed.id]) {
      const out = await call('owner', 'questions_status', { id });
      expect({ id, isError: out.isError, code: out.body.code }).toEqual({ id, isError: true, code: 'question_not_found' });
      expect(out.text).not.toContain(CANARY);
    }
  });

  test('every other remote caller is refused question_owner_only', async () => {
    const cases: Array<[string, string, { auth?: Partial<AuthInfo>; header?: string }]> = [
      ['another member', 'other', {}],
      ['an unbound token', 'unbound', {}],
      ['the owner speaking for another member', 'owner', { header: `member:${OTHER}` }],
      ['a slug-fenced owner credential', 'owner', { auth: { boundSlugPrefixes: ['notes/'] } }],
    ];
    for (const [label, who, extra] of cases) {
      for (const [op, params] of [['questions_list', {}], ['questions_status', { id: pinA.id }]] as const) {
        const out = await call(who, op, params, extra);
        expect({ label, op, isError: out.isError, code: out.body.code }).toEqual({ label, op, isError: true, code: 'question_owner_only' });
        expect(out.text).not.toContain(CANARY);
      }
    }
  });

  test('a delegated subagent run under the owner\'s credential is refused question_owner_only', async () => {
    const auth = await verify('owner');
    const access = await remoteCallerAccess(engine, auth, undefined, 'http', null, undefined, true);
    expect(access.owner).toBe(true);
    const ctx = { ...localCtx(engine, a.sourceId), remote: true, transport: 'http', auth, viaSubagent: true, subagentId: 1 } as OperationContext;
    for (const run of [() => listQuestions(ctx, {}), () => questionStatus(ctx, { id: pinA.id })] as Array<() => Promise<unknown>>) {
      const err = await withCallerAccess(access, run).then(() => null, (e: unknown) => e as { code?: string });
      expect(err?.code).toBe('question_owner_only');
    }
  });

  test('pin management stays refused for the owner over MCP', async () => {
    for (const [op, params] of [['questions_refresh', { id: pinA.id }], ['questions_unpin', { id: pinA.id }], ['questions_pin', { question: 'What changed at acme-example?' }]] as const) {
      const out = await call('owner', op, params);
      expect({ op, code: out.body.code }).toEqual({ op, code: 'question_owner_only' });
    }
  });

  test('a stale sentence is dropped from the owner\'s status; the local CLI still shows it as stale', async () => {
    await putPage(engine, a.sourceId, 'people/alice-example', page('person', 'Alice example', 'Alice example now leads acme-example design.'),
      (await engine.readPageSnapshot('people/alice-example', { sourceId: a.sourceId }))!.revision);
    const local = await questionStatus(localCtx(engine, a.sourceId), { id: pinA.id });
    const stale = local.answer!.filter(s => s.stale);
    expect(stale.length).toBeGreaterThan(0);
    const owner = (await call('owner', 'questions_status', { id: pinA.id })).body as unknown as QuestionReceipt;
    expect(owner.answer!.length).toBeGreaterThan(0);
    for (const s of stale) expect(owner.answer!.some(x => x.id === s.id)).toBe(false);
    expect(owner.answer!.every(s => !s.stale)).toBe(true);
  });
});
