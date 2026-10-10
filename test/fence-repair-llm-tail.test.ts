/**
 * #6377: Tier 3 tail classification (src/core/fence-repair/llm-tail.ts).
 *
 * Protects: the model sees only the unclosed fence's region (begin line,
 * header, rows, trailing lines), never prose before the fence and never the
 * other section; a pipe-free tail is never ambiguous; each answer and failure
 * class is distinct (prose/rows/unsure, HOLD = llm_declined, prose refusal =
 * llm_refused, anything else = llm_malformed, truncation rejected even when
 * it parses); the call sends no tools and no fallback; the prompt bytes are
 * pinned (a change must bump TAIL_PROMPT_VERSION).
 * Fails when: page text outside the fence region leaks into the prompt, a
 * malformed answer is treated as a verdict, or the prompt changes silently.
 * Why new: the tail classifier is new in #6377.
 * Seams: the gateway's chat transport seam (__setChatTransportForTests).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { __setChatTransportForTests, configureGateway, resetGateway, type ChatOpts, type ChatResult } from '../src/core/ai/gateway.ts';
import { buildTailPrompt, callTailClassifier, parseTailAnswer, TAIL_PROMPT_VERSION, tailAmbiguous, tailRequest, tailTokenBudget } from '../src/core/fence-repair/llm-tail.ts';
import { dailyLedger, FENCE_REPAIR_LEDGER } from '../src/core/budget/daily-ledger.ts';
import { attemptStore } from '../src/core/fence-repair/attempts.ts';
import { pageSha, type FenceTarget } from '../src/core/fence-repair/repair-io.ts';
import { analyzeFences, attemptCandidate, runTier3, type FenceAnalysis } from '../src/core/fence-repair/repair-tiers.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const TB = '<!--- gbrain:takes:begin -->';
const TH = '| # | claim | kind | who | weight | since | source |\n|---|-------|------|-----|--------|-------|--------|';
const PROSE = 'Bodyproseqz9 sits above the fence';
const ROW = '| 1 | Takeclaimzq9 holds | take | brain | 0.5 | 2026-01-01 | chat |';
const BULLET_A = '- 2026-03-01: metqz9 for coffee';
const BULLET_B = '- 2026-03-02: pipe | inside a sentence';
const page = (tail: string) => ({ compiled_truth: `${PROSE}\n`, timeline: `## Timeline\n\n${TB}\n${TH}\n${ROW}\n${tail}\n` });

const result = (text: string, stopReason: ChatResult['stopReason'] = 'end'): ChatResult => ({ text, blocks: [], stopReason,
  usage: { input_tokens: 200, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-opus-5-5', providerId: 'anthropic' });

function stub(answers: Array<ChatResult | Error>) {
  const calls: ChatOpts[] = [];
  __setChatTransportForTests(async opts => {
    calls.push(opts);
    const next = answers.shift()!;
    if (next instanceof Error) throw next;
    return next;
  });
  return calls;
}

beforeAll(() => configureGateway({ providers: { anthropic: { apiKey: 'test' } } } as never));
afterEach(() => __setChatTransportForTests(null));
afterAll(() => resetGateway());

describe('tail request', () => {
  test('carries the fence region and the trailing lines only', () => {
    const req = tailRequest(page(`${BULLET_A}\n${BULLET_B}`), { fence: 'takes', section: 'timeline' }, 'world')!;
    expect(req.kind).toBe('takes');
    expect(req.rows).toEqual([ROW]);
    expect(req.tail).toEqual([BULLET_A, BULLET_B]);
    expect(req.lastRowLine).toBe(6);
    const prompt = buildTailPrompt(req);
    expect(prompt.user).not.toContain(PROSE);
    expect(prompt.user).not.toContain('## Timeline');
    expect(prompt.user).toContain(BULLET_B);
  });

  test('null for a closed fence or an empty tail', () => {
    expect(tailRequest(page(''), { fence: 'takes', section: 'timeline' }, 'world')).toBeNull();
    expect(tailRequest({ compiled_truth: `${TB}\n${TH}\n${ROW}\n<!--- gbrain:takes:end -->\n${BULLET_A}\n`, timeline: '' }, { fence: 'takes', section: 'body' }, 'world')).toBeNull();
  });

  test('a tail is ambiguous only when a line holds a pipe', () => {
    expect(tailAmbiguous([BULLET_A])).toBe(false);
    expect(tailAmbiguous([BULLET_A, BULLET_B])).toBe(true);
  });
});

describe('answers', () => {
  test('each verdict and failure class is distinct', () => {
    expect(parseTailAnswer('{"tail":"prose"}')).toEqual({ ok: true, tail: 'prose' });
    expect(parseTailAnswer('```json\n{"tail": "rows"}\n```')).toEqual({ ok: true, tail: 'rows' });
    expect(parseTailAnswer('{"tail":"unsure"}')).toEqual({ ok: true, tail: 'unsure' });
    expect(parseTailAnswer('HOLD')).toEqual({ ok: false, reason: 'llm_declined' });
    expect(parseTailAnswer('')).toEqual({ ok: false, reason: 'llm_empty' });
    expect(parseTailAnswer('I cannot help with that.')).toEqual({ ok: false, reason: 'llm_refused' });
    expect(parseTailAnswer('{"tail":"maybe"}')).toEqual({ ok: false, reason: 'llm_malformed' });
    expect(parseTailAnswer('The tail is prose.')).toEqual({ ok: false, reason: 'llm_malformed' });
    expect(parseTailAnswer('[1]')).toEqual({ ok: false, reason: 'llm_malformed' });
  });

  test('the call sends no tools and no fallback, and a truncated answer is rejected even when it parses', async () => {
    const req = tailRequest(page(BULLET_B), { fence: 'takes', section: 'timeline' }, 'private')!;
    const calls = stub([result('{"tail":"prose"}'), result('{"tail":"prose"}', 'length'), new Error('boom')]);
    const first = await callTailClassifier(req, { model: 'anthropic:claude-opus-5-5' });
    expect(first).toMatchObject({ ok: true, tail: 'prose' });
    expect(calls[0]!.tools).toBeUndefined();
    expect(calls[0]!.allowFallback).toBe(false);
    expect(calls[0]!.maxTokens).toBe(tailTokenBudget(req, 'anthropic:claude-opus-5-5').maxOutputTokens);
    expect(await callTailClassifier(req, { model: 'anthropic:claude-opus-5-5' })).toMatchObject({ ok: false, reason: 'llm_truncated' });
    expect(await callTailClassifier(req, { model: 'anthropic:claude-opus-5-5' })).toMatchObject({ ok: false, reason: 'llm_unavailable' });
  });

  test('prompt bytes are pinned to TAIL_PROMPT_VERSION', () => {
    const req = tailRequest(page(BULLET_B), { fence: 'takes', section: 'timeline' }, 'world')!;
    const prompt = buildTailPrompt(req);
    const digest = createHash('sha256').update(`${TAIL_PROMPT_VERSION}\n${prompt.system}`).digest('hex').slice(0, 16);
    expect(digest).toBe('529e70be1ef8b25b');
  });
});

describe('the tail tier through runTier3 (#6377)', () => {
  let engine: PGLiteEngine;
  let incarnation: string;
  const model = 'anthropic:claude-opus-5-5';
  const piped = { compiled_truth: `${PROSE}\n`, timeline: `## Timeline\n\n${TB}\n${TH}\n${ROW}\n${BULLET_A}\n${BULLET_B}\n` };
  const closed = `## Timeline\n\n${TB}\n${TH}\n${ROW}\n<!--- gbrain:takes:end -->\n${BULLET_A}\n${BULLET_B}\n`;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    const [src] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");
    incarnation = src!.incarnation;
  });
  afterAll(async () => { await engine.disconnect(); });

  async function attempt(slug: string, visibility: 'private' | 'world', answers: Array<ChatResult | Error>, approve = false) {
    const target = { mode: 'db', sourceId: 'default', key: slug, slug, path: null, sourcePath: null, page: piped, content: null, before: pageSha(piped), snapshot: null, hold: null,
      ctx: { pageVisibility: visibility } } as FenceTarget;
    const opts = { pageId: null, ...(approve ? { approveTailExposure: true } : {}) };
    const analysis = await analyzeFences(engine, target, opts);
    expect(analysis.status).toBe('llm');
    expect((analysis as Extract<FenceAnalysis, { status: 'llm' }>).tails).toHaveLength(1);
    const calls = stub(answers);
    const out = await runTier3(target, analysis as Extract<FenceAnalysis, { status: 'llm' }>, incarnation, { ledger: dailyLedger(engine, FENCE_REPAIR_LEDGER), store: attemptStore(engine),
      model, capSource: 'default', perPageUsd: 1, perDayUsd: 10, timeoutMs: 30_000, now: () => new Date(),
      reanalyze: prose => analyzeFences(engine, target, { ...opts, tailProse: prose }) });
    return { out, calls, target };
  }

  test('a prose verdict closes the fence on a private page; the prompt carried only the fence region', async () => {
    const { out, calls } = await attempt('tail/private', 'private', [result('{"tail":"prose"}')]);
    expect(calls).toHaveLength(1);
    const sent = JSON.stringify(calls[0]!.messages) + calls[0]!.system;
    expect(sent).toContain(BULLET_B);
    expect(sent).not.toContain(PROSE);
    expect(out).toMatchObject({ ok: true, cleared: ['unclosed_trailing_content'] });
    expect((out as Extract<typeof out, { ok: true }>).after.timeline).toBe(closed);
  });

  test('a prose verdict on a world page waits for the user (tail_exposure_approval); the memo stores it, and the approved apply closes without a second call', async () => {
    const first = await attempt('tail/world', 'world', [result('{"tail":"prose"}')]);
    expect(first.calls).toHaveLength(1);
    expect(first.out).toMatchObject({ ok: false, reason: 'tail_exposure_approval' });
    const memo = await attemptStore(engine).read(attemptCandidate(first.target, incarnation));
    expect(memo).toMatchObject({ state: 'rejected', reason: 'tail_exposure_approval' });
    const again = await attempt('tail/world', 'world', [result('{"tail":"prose"}')]);
    expect(again.calls).toHaveLength(0);
    expect(again.out).toMatchObject({ ok: false, reason: 'tail_exposure_approval', memoHit: true });
    const approved = await analyzeFences(engine, first.target, { pageId: null, approveTailExposure: true, tailProse: new Set(['*']) });
    expect(approved).toMatchObject({ status: 'proposal', tier: 'deterministic' });
    expect((approved as Extract<FenceAnalysis, { status: 'proposal' }>).after.timeline).toBe(closed);
    expect((approved as Extract<FenceAnalysis, { status: 'proposal' }>).fixes.map(f => f.class)).toEqual(['close_fence_trailing']);
  });

  test('rows, unsure, HOLD and a provider error each leave the fence open with their own reason', async () => {
    expect((await attempt('tail/rows', 'private', [result('{"tail":"rows"}')])).out).toMatchObject({ ok: false, reason: 'unclosed_ambiguous_tail' });
    expect((await attempt('tail/unsure', 'private', [result('{"tail":"unsure"}')])).out).toMatchObject({ ok: false, reason: 'unclosed_ambiguous_tail' });
    expect((await attempt('tail/hold', 'private', [result('HOLD')])).out).toMatchObject({ ok: false, reason: 'unclosed_ambiguous_tail' });
    expect((await attempt('tail/down', 'private', [new Error('ECONNRESET')])).out).toMatchObject({ ok: false, reason: 'llm_unavailable' });
    const memo = await attemptStore(engine).read({ sourceId: 'default', incarnation, key: 'slug:tail/down' });
    expect(memo?.state).not.toBe('rejected');
  });
});
