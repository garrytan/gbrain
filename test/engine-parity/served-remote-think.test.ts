/**
 * BrainEngine parity: a remote think (src/core/ops/takes.ts), called over MCP stdio (dispatchToolCall with remote: true).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every arm (PGLite; Postgres with DATABASE_URL; the Rust arm, embedded, multi-user or served) a remote think
 *    runs on the caller's side of the brain and:
 *    - with no chat-model key, completes with the keyless synthesis status, gathers and cites (in its extractive answer;
 *      a keyless think has no synthesized citations) only the open page the question names, and carries no text of a
 *      page the caller may not read: an owner-private page and a page only a named member may read, seeded with their
 *      own markers and the question's marker. This holds for the owner's stdio pipe and for a non-owner member's
 *      read-only grant;
 *    - asked to save and to take, with a chat model that answers, saves nothing (save and take are forced off for a
 *      remote caller): it calls no write member (so no page, take, synthesis evidence or op_checkpoint row), warns of no
 *      save or take (a take with no brain repo would warn TAKE_MIRROR_UNAVAILABLE), the page and take counts are the
 *      same before and after, and the reply says `remote_persisted_blocked: true`;
 *    - with feedback turned on and a chat model, answers from the open page and records one retrieval event for the
 *      remote caller's client id that names the open page only.
 *  - Regression: the engine reads think reaches only through its save and take paths were listed as reachable by a
 *    remote caller of a served client; a remote think never reaches them, because it never saves or takes. A think that reached one would
 *    stop on its typed refusal on the served arm, and a think that saved would call a write member here.
 *  - Served-arm loss, pinned until S4 (retrieval): on multi-user Rust with feedback turned on (off by default), the served
 *    client refuses readPageFeedbackWeights, so a remote think's page stream fails and the think answers without page
 *    evidence. The remote caller sees the warning GATHER_HYBRID_FAILED in the reply, never a quiet empty answer; the case
 *    stops there (rustMultiuserStop, served only) only when that one member refused and the reply is that degraded
 *    answer, and compares on every other arm.
 *  - Why existing coverage misses it: think-gather-takes.test.ts runs the gather alone in process; no parity file ran a
 *    remote think on the served routes.
 *  - Seam: the chat model's text transport (__setGenerateTextTransportForTests), so no paid call runs; a test-local proxy
 *    that records the write members the think calls. Pages are seeded with putPage and sealChunks.
 */
import { expect } from 'bun:test';
import { MultiuserStopError, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { chunk } from './chunk-fixtures.ts';
import { drainFeedbackQueue } from '../../src/core/feedback/record.ts';
import { _resetFeedbackSettingsCacheForTests } from '../../src/core/feedback/settings.ts';
import { getRetrievalEvent } from '../../src/core/feedback/store.ts';
import { configureGateway, resetGateway, __setGenerateTextTransportForTests } from '../../src/core/ai/gateway.ts';
import { IGNORED_WRITE_MEMBERS, UNMAPPED_WRITE_MEMBERS, memberKind } from '../../src/shadow/write-map.ts';

const { parityTest } = parityArms(testBackends());

const STDIO = { remote: true, admissionOrigin: 'interactive', transport: 'stdio', takesHoldersAllowList: ['world'], sourceId: 'default' } as const;
/** A non-owner member's read-only grant (not the member the readers-only page names). */
const MEMBER_AUTH = { token: 'think-member-token', clientId: 'think-member-client', principal: { kind: 'oauth_client', id: 'think-member-client' }, member: { id: 'bob-example', groups: [] }, scopes: ['read'], sourceId: 'default' };
const OPEN = 'thinkmarkopenpage5d2a';
const PRIVATE = 'thinkmarkprivatepage7f31';
const READERS = 'thinkmarkreaderspage2c86';
const QUESTION = `What is ${OPEN}?`;
const CHAT_MODEL = 'anthropic:claude-opus-4-7';
const HYBRID_FAILED = 'GATHER_HYBRID_FAILED';
/** The fake chat gateway has no embedding key, so a think with it warns that the question was not embedded; nothing else. */
const NO_EMBED_WARNINGS = ['QUESTION_EMBED_FAILED', 'GATHER_DEGRADED:embed_unavailable'];

type Reply = Awaited<ReturnType<typeof dispatchToolCall>>;
type ThinkBody = Record<string, unknown> & { warnings?: string[]; extractive?: { citations?: Array<{ page_slug?: unknown }> } };

async function seed(engine: BrainEngine, withReaders = true): Promise<void> {
  const pages: Array<[string, string, Record<string, unknown>]> = [
    [OPEN, `${OPEN} is an open note.`, {}],
    [PRIVATE, `${PRIVATE} ${OPEN} private body.`, { visibility: 'private' }],
    ...(withReaders ? [[READERS, `${READERS} ${OPEN} readers body.`, { readable_by: ['alice-example'] }] as [string, string, Record<string, unknown>]] : []),
  ];
  for (const [slug, body, frontmatter] of pages) {
    await engine.putPage(`notes/${slug}`, { type: 'note' as never, title: slug, compiled_truth: body, timeline: '', frontmatter });
    await engine.sealChunks(`notes/${slug}`, [chunk(0, body)]);
  }
}

function bodyOf(out: Reply): ThinkBody {
  try { return JSON.parse(out.content[0]?.text ?? '') as ThinkBody; } catch { return {}; }
}

/** What the remote caller sees of a keyless think: the status, the gathered and cited pages, and any leaked marker. */
function keylessView(out: Reply) {
  const text = out.content.map(c => c.text ?? '').join('\n');
  const body = bodyOf(out);
  return {
    error: out.isError === true ? text.slice(0, 300) : false,
    synthesis_status: body.synthesis_status ?? null,
    pagesGathered: body.pagesGathered ?? null,
    cited: (body.extractive?.citations ?? []).map(c => c.page_slug),
    saved_slug: body.saved_slug ?? null,
    leaked: [PRIVATE, READERS].filter(marker => text.includes(marker)),
  };
}

const KEYLESS = { error: false, synthesis_status: 'no_llm', pagesGathered: 1, cited: [`notes/${OPEN}`], saved_slug: null, leaked: [] };

parityTest('a remote keyless think completes, cites the open page, and shows no page the caller may not read', { methods: ['putPage', 'sealChunks'], timeout: 240_000 }, async (engine: BrainEngine) => {
  await seed(engine);
  const result = keylessView(await dispatchToolCall(engine, 'think', { question: QUESTION }, STDIO as never));
  expect(result).toEqual(KEYLESS);
  return result;
});

parityTest('a non-owner member\'s remote keyless think completes the same, with no page the member may not read', { methods: ['putPage', 'sealChunks'], timeout: 240_000 }, async (engine: BrainEngine) => {
  await seed(engine);
  const result = keylessView(await dispatchToolCall(engine, 'think', { question: QUESTION }, { ...STDIO, auth: MEMBER_AUTH } as never));
  expect(result).toEqual(KEYLESS);
  return result;
});

/** Runs `fn` with a fake chat model that answers from the open page (no paid call), then restores the gateway. */
async function withFakeChat<T>(fn: () => Promise<T>): Promise<T> {
  configureGateway({ chat_model: CHAT_MODEL, env: { ANTHROPIC_API_KEY: 'fake-anthropic' } });
  __setGenerateTextTransportForTests((async () => ({ content: [{ type: 'text', text: JSON.stringify({ answer: `${OPEN} is an open note [notes/${OPEN}].`, citations: [{ page_slug: `notes/${OPEN}` }], gaps: [] }) }], finishReason: 'stop', usage: { inputTokens: 3, outputTokens: 2 } })) as never);
  try { return await fn(); } finally { __setGenerateTextTransportForTests(null); resetGateway(); }
}

/**
 * `engine` behind a test-local proxy that records each write member called on it or on a transaction it opens, and each
 * member that refused with a typed capability refusal (`engine_capability_missing`).
 */
function recorder(engine: BrainEngine): { engine: BrainEngine; writes: Set<string>; refusals: string[] } {
  const writes = new Set<string>();
  const refusals: string[] = [];
  const isWrite = (n: string) => memberKind(n) === 'mapped' || UNMAPPED_WRITE_MEMBERS.has(n) || IGNORED_WRITE_MEMBERS.has(n);
  const noteRefusal = (name: string, e: unknown) => { if ((e as { code?: unknown } | null)?.code === 'engine_capability_missing') refusals.push(name); };
  const wrap = (target: BrainEngine): BrainEngine => new Proxy(target, {
    get(t, name, receiver) {
      const value = Reflect.get(t, name, receiver);
      if (typeof name !== 'string' || typeof value !== 'function' || name === 'constructor') return value;
      if (name === 'transaction') return (fn: (tx: BrainEngine) => unknown, ...rest: unknown[]) => (value as (...a: unknown[]) => unknown).call(t, (tx: BrainEngine) => fn(wrap(tx)), ...rest);
      return (...args: unknown[]) => {
        if (isWrite(name)) writes.add(name);
        let ran: unknown;
        try { ran = (value as (...a: unknown[]) => unknown).apply(t, args); } catch (e) { noteRefusal(name, e); throw e; }
        if (ran instanceof Promise) return ran.catch((e: unknown) => { noteRefusal(name, e); throw e; });
        return ran;
      };
    },
  });
  return { engine: wrap(engine), writes, refusals };
}

parityTest('a remote think asked to save and take saves nothing', { methods: ['putPage', 'sealChunks', 'setConfig', 'getAllSlugs', 'listTakes'], timeout: 240_000 }, async (engine: BrainEngine) => {
  await seed(engine, false);
  const counts = async () => ({ pages: (await engine.getAllSlugs()).size, takes: (await engine.listTakes({ limit: 1000 } as never)).length });
  const before = await counts();
  await engine.setConfig('models.think', CHAT_MODEL);
  const recorded = recorder(engine);
  const out = await withFakeChat(() => dispatchToolCall(recorded.engine, 'think', { question: QUESTION, save: true, take: true, anchor: `notes/${OPEN}` }, STDIO as never));
  const body = bodyOf(out);
  const result = {
    error: out.isError === true,
    synthesis_status: body.synthesis_status ?? null,
    remote_persisted_blocked: body.remote_persisted_blocked ?? null,
    saved_slug: body.saved_slug ?? null,
    take_row: body.take_row ?? null,
    evidence_inserted: body.evidence_inserted ?? null,
    warnings: body.warnings ?? [],
    writes: [...recorded.writes].sort(),
    refusals: recorded.refusals,
    countsBefore: before,
    countsAfter: await counts(),
  };
  expect(result).toEqual({ error: false, synthesis_status: 'ok', remote_persisted_blocked: true, saved_slug: null, take_row: null, evidence_inserted: 0, warnings: NO_EMBED_WARNINGS, writes: [], refusals: [], countsBefore: before, countsAfter: before });
  return result;
});

/** S4 (retrieval) serves readPageFeedbackWeights to a remote caller of a served client and removes this pin. */
const FEEDBACK_GATHER_STOP = {
  code: 'gather_hybrid_failed',
  message: `${HYBRID_FAILED}: the served client refused readPageFeedbackWeights`,
  owner: 'L3 S4 retrieval',
  due: '2026-12-04',
  served: true as const,
};

parityTest('with feedback on, a remote think records one retrieval event for the caller and the open page only', { methods: ['putPage', 'sealChunks', 'setConfig'], rustMultiuserStop: FEEDBACK_GATHER_STOP, timeout: 240_000 }, async (engine: BrainEngine) => {
  await seed(engine, false);
  await engine.setConfig('feedback.enabled', 'true');
  await engine.setConfig('models.think', CHAT_MODEL);
  _resetFeedbackSettingsCacheForTests();
  const ctx = { ...STDIO, auth: { token: 'think-caller-token', clientId: 'think-remote-caller', scopes: ['read', 'write'], sourceId: 'default' } };
  const recorded = recorder(engine);
  const out = await withFakeChat(() => dispatchToolCall(recorded.engine, 'think', { question: QUESTION }, ctx as never));
  const body = bodyOf(out) as ThinkBody & { answer_id?: string };
  // The served-arm loss (see the file header). The case stops only on that loss: the one typed refusal is
  // readPageFeedbackWeights, and the remote caller gets an answer with the warning and no page evidence. Any other
  // refusal or reply shape fails the case.
  if (body.warnings?.includes(HYBRID_FAILED)) {
    _resetFeedbackSettingsCacheForTests();
    expect({ error: out.isError === true, refusals: recorded.refusals, pagesGathered: body.pagesGathered ?? null, warned: true })
      .toEqual({ error: false, refusals: ['readPageFeedbackWeights'], pagesGathered: 0, warned: true });
    throw new MultiuserStopError(FEEDBACK_GATHER_STOP.code, FEEDBACK_GATHER_STOP.message);
  }
  await drainFeedbackQueue(30_000);
  const event = body.answer_id ? await getRetrievalEvent(engine, body.answer_id) : null;
  _resetFeedbackSettingsCacheForTests();
  const result = {
    error: out.isError === true,
    synthesis_status: body.synthesis_status ?? null,
    refusals: recorded.refusals,
    answered: typeof body.answer_id === 'string',
    client_id: event?.client_id ?? null,
    op: event?.op ?? null,
    pages: event?.pages.map(p => `${p.source_id}:${p.slug}`) ?? [],
  };
  expect(result).toEqual({ error: false, synthesis_status: 'ok', refusals: [], answered: true, client_id: 'think-remote-caller', op: 'think', pages: [`default:notes/${OPEN}`] });
  return result;
});
