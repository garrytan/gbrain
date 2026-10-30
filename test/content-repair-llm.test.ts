/**
 * The content-repair judgment call's attempt memo (src/core/content-repair/llm.ts callJudgment).
 *
 * Protects: a provider refusal of the prompt raised as an error (a
 * content-policy 400, a prompt block, a context overflow) is a verdict on
 * these exact bytes: it is held as `llm_refused` and consumes the memo, so
 * the next pass on unchanged inputs spends $0 and sends nothing; a plain
 * provider error (429, timeout) stays `llm_unavailable` and the next pass
 * asks again.
 * Fails when: the catch in askJudgment folds a refusal into
 * `llm_unavailable`, so every maintenance pass re-sends the same bytes and
 * the ledger settles the full estimate again.
 * Why new: repair-slug-conflicts.test.ts covers the transient 429 end to end
 * but no test raised a refusal as an error through callJudgment.
 * Seams: the gateway's chat transport seam (__setChatTransportForTests).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { __setChatTransportForTests, configureGateway, resetGateway, type ChatOpts, type ChatResult } from '../src/core/ai/gateway.ts';
import { judgmentParticipant, type JudgmentInput } from '../src/core/content-repair/judgment.ts';
import { callJudgment, judgmentCandidate } from '../src/core/content-repair/llm.ts';
import { attemptStore } from '../src/core/fence-repair/attempts.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const model = 'anthropic:claude-opus-5-5';
const answer = (text: string): ChatResult => ({ text, blocks: [], stopReason: 'end', usage: { input_tokens: 400, output_tokens: 30, cache_read_tokens: 0, cache_creation_tokens: 0 },
  model, providerId: 'anthropic' });
const policyRefusal = () => Object.assign(new Error('Bad Request'), { name: 'AI_APICallError', statusCode: 400,
  responseBody: JSON.stringify({ error: { code: 'content_policy_violation', message: 'flagged' } }) });

const input = (): JudgmentInput => ({
  held: judgmentParticipant({ path: 'people/alice-example-2.md', slug: 'people/alice-example-2', content: '---\ntitle: Alice Example\ntype: person\nslug: people/alice-example\n---\nA synthetic founder.\n', otherSlug: 'people/alice-example' }),
  named: judgmentParticipant({ path: 'people/alice-example.md', slug: 'people/alice-example', content: '---\ntitle: Alice Example\ntype: person\n---\nA synthetic founder.\n', otherSlug: 'people/alice-example-2', type: 'person' }),
  reason: 'frontmatter_slug_conflict',
});

let engine: PGLiteEngine;
let incarnation: string;
let calls: ChatOpts[] = [];

function transport(reply: () => ChatResult | Error) {
  calls = [];
  __setChatTransportForTests(async opts => { calls.push(opts); const out = reply(); if (out instanceof Error) throw out; return out; });
}

const judge = (path: string) => callJudgment(engine, model, input(), { sourceId: 'default', incarnation, path,
  memo: { heldSha256: 'a'.repeat(64), namedSha256: 'b'.repeat(64), heldPageId: null, namedPageId: null },
  capSource: 'default', perPageUsd: 1, perDayUsd: 10, timeoutMs: 30_000 });

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const [src] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");
  incarnation = src!.incarnation;
  configureGateway({ providers: { anthropic: { apiKey: 'test' } } } as never);
});
afterEach(() => __setChatTransportForTests(null));
afterAll(async () => {
  resetGateway();
  await engine.disconnect();
});

describe('callJudgment: a provider refusal raised as an error', () => {
  test('a content-policy 400 is held as llm_refused and consumes the memo: the same inputs are never sent again', async () => {
    transport(policyRefusal);
    const first = await judge('people/alice-example-2.md');
    expect(calls).toHaveLength(1);
    expect(first).toMatchObject({ ok: false, reason: 'llm_refused' });
    expect(await attemptStore(engine).read(judgmentCandidate('default', incarnation, 'people/alice-example-2.md'))).toMatchObject({ state: 'rejected', reason: 'llm_refused' });
    transport(() => answer('{"action":"needs_human"}'));
    const again = await judge('people/alice-example-2.md');
    expect(calls).toHaveLength(0);
    expect(again).toMatchObject({ ok: false, reason: 'llm_refused', memoHit: true, spentUsd: 0 });
  });

  test('a rate limit stays llm_unavailable and leaves the memo open, so the next pass asks again', async () => {
    transport(() => Object.assign(new Error('rate limited'), { status: 429 }));
    expect(await judge('people/bob-example-2.md')).toMatchObject({ ok: false, reason: 'llm_unavailable' });
    expect((await attemptStore(engine).read(judgmentCandidate('default', incarnation, 'people/bob-example-2.md')))?.state).not.toBe('rejected');
    transport(() => answer('{"action":"needs_human"}'));
    expect(await judge('people/bob-example-2.md')).toMatchObject({ ok: true, verdict: { action: 'needs_human' } });
    expect(calls).toHaveLength(1);
  });
});
