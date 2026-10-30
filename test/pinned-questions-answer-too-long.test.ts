/**
 * #7306: a pinned answer longer than the refresh output cap. The cap is
 * `cycle.standing_questions.max_output_tokens` (default 2,000); a reply cut off
 * at it (a `length` stop, or claude-cli's "exceeded the N output token maximum"
 * error) fails `refresh_failed:answer_too_long:<cap>` after one call, the receipt
 * names the key instead of a --full refresh that fails the same way, and the
 * cycle phase stops spending on the pin until the cap is raised. Stub model; no network.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { __setChatTransportForTests, type ChatOpts, type ChatResult } from '../src/core/ai/gateway.ts';
import { pinQuestion, questionStatus } from '../src/core/questions/service.ts';
import { refreshPin, type QuestionChatFn, type QuestionChatRequest } from '../src/core/questions/refresh.ts';
import { runPhaseStandingQuestions } from '../src/core/questions/phase.ts';
import { getPin } from '../src/core/questions/store.ts';
import { parseQuestionId } from '../src/core/questions/identity.ts';
import { withEnv } from './helpers/with-env.ts';
import { ENTITY, MODEL, QUESTION, localCtx, seedBrain, stubAnswer, stubChat } from './helpers/pinned-questions-fixture.ts';

const MAX_OUTPUT_TOKENS_KEY = 'cycle.standing_questions.max_output_tokens';
const DEFAULT_MAX_OUTPUT_TOKENS = 2000;

describe('pinned-question refresh output cap (#7306)', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 120_000);
  afterAll(async () => { await engine?.disconnect(); }, 60_000);

  const run = (name: string, fn: () => Promise<void>) => test(name, async () => {
    await engine.setConfig('models.standing_questions', MODEL);
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test-pinned-questions' }, fn);
  }, 60_000);

  async function pinned() {
    const s = await seedBrain(engine);
    const r = await pinQuestion(localCtx(engine, s.sourceId), { question: QUESTION, scope: { entity: ENTITY } }, { chat: stubChat().fn });
    const { slug } = parseQuestionId(r.receipt.id, s.sourceId)!;
    return { sourceId: s.sourceId, slug, id: r.receipt.id, pin: (await getPin(engine, s.sourceId, slug))! };
  }

  function recording(reply: (req: QuestionChatRequest) => ReturnType<QuestionChatFn>): { fn: QuestionChatFn; requests: QuestionChatRequest[] } {
    const requests: QuestionChatRequest[] = [];
    return { requests, fn: async (req) => { requests.push(req); return reply(req); } };
  }
  const cutOff = (req: QuestionChatRequest) => Promise.resolve({ text: stubAnswer(req.user).slice(0, 60), usage: { input_tokens: 1000, output_tokens: req.maxTokens }, model: MODEL, truncated: true });
  const cliCapError = () => Promise.reject(new Error("claude-cli reported error: API Error: Claude's response exceeded the 2000 output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable."));

  run('a reply cut off at the cap fails answer_too_long after one call, with no JSON retry, keeping the answer', async () => {
    const { sourceId, slug, pin } = await pinned();
    const chat = recording(cutOff);
    const outcome = await refreshPin(engine, sourceId, slug, { trigger: 'manual', full: true, chat: chat.fn, leaseOwner: 't' });
    expect(outcome).toMatchObject({ status: 'failed', error: `refresh_failed:answer_too_long:${DEFAULT_MAX_OUTPUT_TOKENS}` });
    expect(chat.requests).toHaveLength(1);
    const after = (await getPin(engine, sourceId, slug))!;
    expect(after.answer).toEqual(pin.answer);
    expect(after.last_error).toBe(`refresh_failed:answer_too_long:${DEFAULT_MAX_OUTPUT_TOKENS}`);
  });

  run("claude-cli's output-token-maximum error is answer_too_long, not provider_error", async () => {
    const { sourceId, slug } = await pinned();
    const outcome = await refreshPin(engine, sourceId, slug, { trigger: 'manual', full: true, chat: cliCapError, leaseOwner: 't' });
    expect(outcome).toMatchObject({ status: 'failed', error: 'refresh_failed:answer_too_long:2000' });
  });

  run('a length stop from the gateway is answer_too_long', async () => {
    const { sourceId, slug } = await pinned();
    let calls = 0;
    __setChatTransportForTests(async (opts: ChatOpts): Promise<ChatResult> => {
      calls++;
      const text = stubAnswer(String(opts.messages[opts.messages.length - 1]?.content ?? '')).slice(0, 40);
      return { text, blocks: [{ type: 'text', text }], stopReason: 'length', model: opts.model ?? MODEL, providerId: 'anthropic',
        usage: { input_tokens: 1000, output_tokens: 2000, cache_read_tokens: 0, cache_creation_tokens: 0 } };
    });
    try {
      const outcome = await refreshPin(engine, sourceId, slug, { trigger: 'manual', full: true, leaseOwner: 't' });
      expect(outcome).toMatchObject({ status: 'failed', error: 'refresh_failed:answer_too_long:2000' });
      expect(calls).toBe(1);
    } finally { __setChatTransportForTests(null); }
  });

  run('the receipt names the cap key, not a --full refresh', async () => {
    const { sourceId, slug, id } = await pinned();
    await refreshPin(engine, sourceId, slug, { trigger: 'manual', full: true, chat: cliCapError, leaseOwner: 't' });
    const receipt = await questionStatus(localCtx(engine, sourceId), { id });
    expect(receipt.blocked_reason).toBe('answer_too_long');
    expect(receipt.fix).toMatchObject({ argv: ['gbrain', 'config', 'set', MAX_OUTPUT_TOKENS_KEY, '<tokens>'], actor: 'user', consent: ['paid'] });
    expect(receipt.fix!.argv).not.toContain('--full');
  });

  run('the configured cap reaches the model call', async () => {
    const { sourceId, slug } = await pinned();
    await engine.setConfig(MAX_OUTPUT_TOKENS_KEY, '6000');
    try {
      const chat = recording(req => Promise.resolve({ text: stubAnswer(req.user), usage: { input_tokens: 1000, output_tokens: 200 }, model: MODEL }));
      const outcome = await refreshPin(engine, sourceId, slug, { trigger: 'manual', full: true, chat: chat.fn, leaseOwner: 't' });
      expect(outcome.status).toBe('published');
      expect(chat.requests[0]!.maxTokens).toBe(6000);
    } finally { await engine.setConfig(MAX_OUTPUT_TOKENS_KEY, ''); }
  });

  run('the cycle phase does not spend on a pin that failed answer_too_long at the current cap, and retries once it is raised', async () => {
    const { sourceId, slug, id } = await pinned();
    await refreshPin(engine, sourceId, slug, { trigger: 'manual', full: true, chat: cliCapError, leaseOwner: 't' });
    await engine.executeRaw("UPDATE pinned_questions SET last_attempt_at = now() - interval '3 days' WHERE source_id = $1 AND slug = $2", [sourceId, slug]);
    await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, source, visibility, confidence, valid_from)
      VALUES ($1, $2, 'Acme example opened a widget plant in Porto', 'fact', 'test', 'world', 1, now())`, [sourceId, ENTITY]);
    await engine.setConfig('cycle.standing_questions.cooldown_days', '0');
    try {
      const held = recording(cutOff);
      const first = await runPhaseStandingQuestions(engine, { dryRun: false, chat: held.fn });
      expect(held.requests.filter(r => r.user.includes(QUESTION))).toHaveLength(0);
      expect(first.status).toBe('warn');
      expect((first.details.outcomes as Array<{ id: string; status: string }>).find(o => o.id === id)?.status).toBe('blocked:answer_too_long');

      await engine.setConfig(MAX_OUTPUT_TOKENS_KEY, '4000');
      const raised = recording(req => Promise.resolve({ text: stubAnswer(req.user), usage: { input_tokens: 1000, output_tokens: 200 }, model: MODEL }));
      const receipt = await questionStatus(localCtx(engine, sourceId), { id });
      expect(receipt.blocked_reason).not.toBe('answer_too_long');
      await runPhaseStandingQuestions(engine, { dryRun: false, chat: raised.fn });
      const own = raised.requests.filter(r => r.user.includes(QUESTION));
      expect(own.length).toBeGreaterThanOrEqual(1);
      expect(own[0]!.maxTokens).toBe(4000);
      expect((await getPin(engine, sourceId, slug))!.last_error).toBeNull();
    } finally {
      await engine.setConfig(MAX_OUTPUT_TOKENS_KEY, '');
      await engine.setConfig('cycle.standing_questions.cooldown_days', '');
    }
  });
});
