/**
 * BrainEngine parity: a remote search, query and recall with retrieval feedback on record their retrieval event
 * (src/core/feedback/record.ts), called over MCP stdio (dispatchToolCall with remote: true).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every arm (PGLite; Postgres with DATABASE_URL; the Rust arm, embedded, multi-user or served) a remote
 *    search, query and recall, with `feedback.enabled` turned on and a caller whose grant names the client id
 *    `feedback-remote-caller`, answer without an error, return an `answer_id`, drain their feedback queue with nothing
 *    unfinished, and store one retrieval event for that client id and that op whose pages are the open page only (an
 *    owner-private page and a page only a named member may read, each carrying the query's marker too, are seeded and
 *    never named).
 *  - Regression: on the served arm (a client of a multi-user brain server) the feedback weights read was refused for a
 *    remote caller, so a remote search, query and recall failed, and the event write was refused inside the write-behind queue,
 *    which dropped it without a word: the caller held an answer id for an event that was never stored.
 *  - Why existing coverage misses it: search-feedback-and-date-headers.test.ts calls the feedback members directly with no
 *    remote caller; served-remote-think.test.ts case 4 stopped at the refused read, so it never reached the write.
 *  - Seam: pages are seeded with putPage and sealChunks; the answer runs through the real remote operation and the real
 *    queue; the stored event is read back with getRetrievalEvent.
 */
import { expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { chunk } from './chunk-fixtures.ts';
import { drainFeedbackQueue } from '../../src/core/feedback/record.ts';
import { _resetFeedbackSettingsCacheForTests } from '../../src/core/feedback/settings.ts';
import { getRetrievalEvent } from '../../src/core/feedback/store.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';

const { parityTest } = parityArms(testBackends());

const CALLER = 'feedback-remote-caller';
const OPEN = 'fbrecmarkopenpage3b7d';
const PRIVATE = 'fbrecmarkprivatepage8e14';
const READERS = 'fbrecmarkreaderspage5c92';
const CTX = {
  remote: true, admissionOrigin: 'interactive', transport: 'stdio', sourceId: 'default',
  auth: { token: 'feedback-caller-token', clientId: CALLER, scopes: ['read', 'write'], sourceId: 'default' },
} as const;

type Reply = Awaited<ReturnType<typeof dispatchToolCall>>;

async function seed(engine: BrainEngine): Promise<void> {
  const pages: Array<[string, string, Record<string, unknown>]> = [
    [OPEN, `${OPEN} is an open note.`, {}],
    [PRIVATE, `${PRIVATE} ${OPEN} private body.`, { visibility: 'private' }],
    [READERS, `${READERS} ${OPEN} readers body.`, { readable_by: ['alice-example'] }],
  ];
  for (const [slug, body, frontmatter] of pages) {
    await engine.putPage(`notes/${slug}`, { type: 'note' as never, title: slug, compiled_truth: body, timeline: '', frontmatter });
    await engine.sealChunks(`notes/${slug}`, [chunk(0, body)]);
  }
  await engine.setConfig('feedback.enabled', 'true');
  _resetFeedbackSettingsCacheForTests();
}

function bodyOf(out: Reply): Record<string, unknown> {
  try { return JSON.parse(out.content[0]?.text ?? '') as Record<string, unknown>; } catch { return {}; }
}

/**
 * Runs `fn` with an embedding provider that is configured and whose call fails (no paid call): recall's page arm runs
 * the hybrid search (and its feedback stage) only when a provider is available; a failed embed degrades it to keyword.
 */
async function withEmbedProvider<T>(fn: () => Promise<T>): Promise<T> {
  configureGateway({ env: { OPENAI_API_KEY: 'fake-openai' } });
  __setEmbedTransportForTests((async () => { throw new Error('embedding is not reachable in this test'); }) as never);
  try { return await fn(); } finally { __setEmbedTransportForTests(null); resetGateway(); }
}

/** One remote answer of `op` with feedback on, and the event the queue stored for it. */
async function recorded(engine: BrainEngine, op: 'search' | 'query' | 'recall', params: Record<string, unknown>) {
  await seed(engine);
  const out = await withEmbedProvider(() => dispatchToolCall(engine, op, params, CTX as never));
  const body = bodyOf(out);
  const drained = await drainFeedbackQueue(30_000);
  const meta = (out as { _meta?: { retrieval?: { answer_id?: unknown } } })._meta?.retrieval;
  const found = body.answer_id ?? meta?.answer_id;
  const answerId = typeof found === 'string' ? found : null;
  const event = answerId ? await getRetrievalEvent(engine, answerId) : null;
  _resetFeedbackSettingsCacheForTests();
  const result = {
    error: out.isError === true ? (out.content[0]?.text ?? '').slice(0, 300) : false,
    answered: answerId !== null,
    unfinished: drained.unfinished,
    client_id: event?.client_id ?? null,
    op: event?.op ?? null,
    pages: event?.pages.map(p => `${p.source_id}:${p.slug}`) ?? [],
  };
  expect(result).toEqual({ error: false, answered: true, unfinished: 0, client_id: CALLER, op, pages: [`default:notes/${OPEN}`] });
  return result;
}

parityTest('with feedback on, a remote search records its event for the caller and the open page only', { methods: ['putPage', 'sealChunks', 'setConfig'], timeout: 240_000 }, async (engine: BrainEngine) =>
  recorded(engine, 'search', { query: OPEN }));

parityTest('with feedback on, a remote recall records its event for the caller and the open page only', { methods: ['putPage', 'sealChunks', 'setConfig'], timeout: 240_000 }, async (engine: BrainEngine) =>
  recorded(engine, 'recall', { query: OPEN }));

parityTest('with feedback on, a remote query records its event for the caller and the open page only', { methods: ['putPage', 'sealChunks', 'setConfig'], timeout: 240_000 }, async (engine: BrainEngine) =>
  recorded(engine, 'query', { query: OPEN }));
