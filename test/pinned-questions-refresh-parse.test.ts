/**
 * Pinned-question refresh parsing: a model reply with prose or a draft object
 * around the answer JSON still parses, and a reply with no parseable answer is
 * retried once with a JSON-only reminder before the refresh fails (the pin
 * keeps its previous answer). Stub model; no network.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { pinQuestion } from '../src/core/questions/service.ts';
import { parseModelAnswer, refreshPin, type EvidenceItem, type QuestionChatFn } from '../src/core/questions/refresh.ts';
import { getPin, type PinRow } from '../src/core/questions/store.ts';
import { parseQuestionId } from '../src/core/questions/identity.ts';
import { ENTITY, MODEL, QUESTION, localCtx, seedBrain, stubAnswer, stubChat } from './helpers/pinned-questions-fixture.ts';

const item = (ref: string): EvidenceItem => ({ ref, kind: 'page', source_id: 'default', page_id: 1, page_slug: 'notes/a', page_generation: 1, page_revision: '1', item_id: null, content_hash: null, text: 'x' });
const items = [item('E1'), item('E2')];
const answer = (text: string, cite = 'E1') => JSON.stringify({ sentences: [{ text, cite: [cite] }], gaps: [] });

describe('parseModelAnswer', () => {
  test('a bare answer object parses', () => {
    expect(parseModelAnswer(answer('It builds widgets in Porto.'), items).sentences.map(s => s.text)).toEqual(['It builds widgets in Porto.']);
  });

  test('prose with braces before and after the JSON still parses', () => {
    const text = `Looking at {E1} and {E2}, the newest note wins.\n${answer('It builds widgets in Lyon.')}\nNote: {E2} is older.`;
    expect(parseModelAnswer(text, items).sentences.map(s => s.text)).toEqual(['It builds widgets in Lyon.']);
  });

  test('a draft object followed by a corrected one takes the last answer', () => {
    const text = `${answer('It builds widgets in Ghent.')}\nWait, E2 is newer:\n${answer('It builds widgets in Turin.', 'E2')}`;
    expect(parseModelAnswer(text, items).sentences.map(s => s.text)).toEqual(['It builds widgets in Turin.']);
  });

  test('a fenced block followed by notes with braces parses, and braces inside strings do not confuse the scan', () => {
    const text = '```json\n' + answer('The memo said {Porto} but the correction says Lyon.') + '\n```\nCaveat: {see E2}.';
    expect(parseModelAnswer(text, items).sentences.map(s => s.text)).toEqual(['The memo said {Porto} but the correction says Lyon.']);
  });

  test('no answer object throws model_output_not_json', () => {
    expect(() => parseModelAnswer('I could not find an answer.', items)).toThrow('model_output_not_json');
    expect(() => parseModelAnswer('{"note": "no answer here"}', items)).toThrow('model_output_not_json');
    expect(() => parseModelAnswer('{"sentences": [{"text": "cut off', items)).toThrow('model_output_not_json');
  });
});

describe('refreshPin retries an unparseable reply once', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 120_000);
  afterAll(async () => { await engine?.disconnect(); }, 60_000);

  async function pinned(): Promise<{ sourceId: string; slug: string; pin: PinRow }> {
    const s = await seedBrain(engine);
    const r = await pinQuestion(localCtx(engine, s.sourceId), { question: QUESTION, scope: { entity: ENTITY } }, { chat: stubChat().fn });
    const { slug } = parseQuestionId(r.receipt.id, s.sourceId)!;
    return { sourceId: s.sourceId, slug, pin: (await getPin(engine, s.sourceId, slug))! };
  }

  function scripted(replies: Array<(user: string) => string>): { fn: QuestionChatFn; users: string[] } {
    const users: string[] = [];
    return { users, fn: async (req) => {
      users.push(req.user);
      return { text: replies[Math.min(users.length - 1, replies.length - 1)]!(req.user), usage: { input_tokens: 1000, output_tokens: 200 }, model: MODEL };
    } };
  }

  test('a malformed first reply is retried and the second reply publishes; both calls are charged', async () => {
    const { sourceId, slug, pin } = await pinned();
    const chat = scripted([() => 'Here is the answer: Lisbon.', user => stubAnswer(user)]);
    const outcome = await refreshPin(engine, sourceId, slug, { trigger: 'manual', full: true, chat: chat.fn, leaseOwner: 't' });
    expect(outcome.status).toBe('published');
    expect(chat.users).toHaveLength(2);
    expect(chat.users[1]).toContain('Reply with only the JSON object');
    const single = await refreshPin(engine, sourceId, slug, { trigger: 'manual', full: true, chat: scripted([user => stubAnswer(user)]).fn, leaseOwner: 't' });
    expect(outcome.status === 'published' && single.status === 'published' && outcome.cost_usd).toBeCloseTo(2 * (single as { cost_usd: number }).cost_usd, 9);
    expect((await getPin(engine, sourceId, slug))!.answer_revision).toBe(pin.answer_revision + 2);
  });

  test('two malformed replies fail with model_output_not_json after exactly one retry, keeping the previous answer', async () => {
    const { sourceId, slug, pin } = await pinned();
    const chat = scripted([() => 'Still no JSON.']);
    const outcome = await refreshPin(engine, sourceId, slug, { trigger: 'manual', full: true, chat: chat.fn, leaseOwner: 't' });
    expect(outcome).toMatchObject({ status: 'failed', error: 'refresh_failed:model_output_not_json' });
    expect(chat.users).toHaveLength(2);
    const after = (await getPin(engine, sourceId, slug))!;
    expect(after.answer_revision).toBe(pin.answer_revision);
    expect(after.answer).toEqual(pin.answer);
    expect(after.last_error).toBe('refresh_failed:model_output_not_json');
  });
});
