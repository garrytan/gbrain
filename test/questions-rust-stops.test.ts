/**
 * The pinned-question stops on the Rust engine: the pin record reads and writes refuse with a typed
 * engine_capability_missing that names the member and the missing piece, before any engine call. The reads that return
 * or compare pages.generation are served (the store keeps the counter: test/engine-parity/page-generation.test.ts) and
 * name no stop.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each pin record read refuses on the Rust engine naming the pin records with an owner and due date; each
 *    pin store function refuses on an engine without raw SQL naming itself, and sends no statement; on an engine with
 *    raw SQL the same functions run their statement; the generation reads are members the store serves, and the stop
 *    list holds exactly the two pin record reads.
 *  - Regression: these sites sent raw SQL, so a Rust brain refused them as a bare `executeRaw` raw_sql refusal that
 *    named neither the read nor what was missing; and the generation reads named a stop after the store served them.
 *  - Why existing coverage misses it: the parity file (test/engine-parity/question-reads.test.ts) counts these as
 *    stops; it does not pin the refusal's text.
 *  - Seam: the Rust engine's refusing member (no store is opened: the refusal runs before any work), an engine
 *    double with only `capabilities` and a recording `executeRaw` for the pin store guard, and a PGLite brain whose
 *    typed candidate read is replaced by a refusal (the refresh must surface it, not report a failed refresh).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { RustEngine, rustMemberCapability } from '../src/core/rust-engine.ts';
import { QUESTION_STOP_OWNERS } from '../src/core/rust-engine/question-stops.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { addSpend, getPin, listPins, releaseLease } from '../src/core/questions/store.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { pinQuestion } from '../src/core/questions/service.ts';
import { refreshPin } from '../src/core/questions/refresh.ts';
import { parseQuestionId } from '../src/core/questions/identity.ts';
import { capabilityMissing } from '../src/core/rust-engine/errors.ts';
import { ENTITY, QUESTION, localCtx, seedBrain, stubChat } from './helpers/pinned-questions-fixture.ts';

const GENERATION_READS = ['listQuestionCandidatePages', 'listQuestionEvidenceTimeline', 'listQuestionEvidenceTakes', 'readQuestionPageRow',
  'readQuestionEvidenceClock', 'hasNewQuestionPages', 'lockQuestionEvidenceRows'] as const;
const PIN_RECORD_READS = ['listQuestionEvidenceJoin', 'listPublishedQuestionAnswers'] as const;

interface Refusal { code?: string; message: string; detail?: string }

async function refusal(member: string): Promise<Refusal> {
  const fn = (RustEngine.prototype as unknown as Record<string, ((...a: unknown[]) => Promise<unknown>) | undefined>)[member];
  expect(typeof fn).toBe('function');
  try {
    await fn!.call(Object.create(RustEngine.prototype));
  } catch (e) {
    return e as Refusal;
  }
  throw new Error(`${member} did not refuse`);
}

describe('pinned-question stops on the Rust engine', () => {
  test.each([...GENERATION_READS])('%s is served: it names no stop and is not a refusal', (member: string) => {
    expect(rustMemberCapability(member)).toBeNull();
    expect(QUESTION_STOP_OWNERS[member]).toBeUndefined();
  });

  test('the stop list holds exactly the pin record reads', () => {
    expect(Object.keys(QUESTION_STOP_OWNERS).sort()).toEqual([...PIN_RECORD_READS].sort());
  });

  test.each([...PIN_RECORD_READS])('%s refuses naming the missing pin records', async (member: string) => {
    const e = await refusal(member);
    expect(e.code).toBe('engine_capability_missing');
    expect(e.message).toContain(member);
    expect(e.message).toContain('pinned_questions');
  });

  test('the pin store refuses by name and sends no statement on an engine without raw SQL', async () => {
    const sent: string[] = [];
    const engine = { capabilities: new Set(['pages']), executeRaw: async (sql: string) => { sent.push(sql); return []; } } as unknown as BrainEngine;
    const outcomes = await Promise.all([
      getPin(engine, 'default', 'questions/x').then(() => null, (e: { code?: string; message: string }) => [e.code, e.message]),
      listPins(engine).then(() => null, (e: { code?: string; message: string }) => [e.code, e.message]),
      releaseLease(engine, 1, 't', { error: null, spendUsd: 0 }).then(() => null, (e: { code?: string; message: string }) => [e.code, e.message]),
      addSpend(engine, 1, 0.5).then(() => null, (e: { code?: string; message: string }) => [e.code, e.message]),
    ]);
    expect(outcomes.map(o => o?.[0])).toEqual(Array(4).fill('engine_capability_missing'));
    expect(outcomes.map(o => /pinned questions (\w+)/.exec(String(o?.[1]))?.[1])).toEqual(['getPin', 'listPins', 'releaseLease', 'addSpend']);
    expect(String(outcomes[0]?.[1])).toContain('pinned_questions');
    expect(sent).toEqual([]);
    // Spending nothing writes nothing, so it does not refuse.
    await addSpend(engine, 1, 0);
  });

  test('an engine with raw SQL runs the pin store statement', async () => {
    const sent: string[] = [];
    const engine = { capabilities: new Set(['raw_sql']), executeRaw: async (sql: string) => { sent.push(sql); return []; } } as unknown as BrainEngine;
    expect(await getPin(engine, 'default', 'questions/x')).toBeNull();
    expect(sent.length).toBe(1);
  });
});

describe('a refresh surfaces an engine refusal instead of reporting a failed refresh', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 120_000);
  afterAll(async () => { await engine?.disconnect(); }, 60_000);

  test('a refused evidence read rejects refreshPin with engine_capability_missing, and the model is never called', async () => {
    const s = await seedBrain(engine);
    const r = await pinQuestion(localCtx(engine, s.sourceId), { question: QUESTION, scope: { entity: ENTITY }, defer: true });
    const { slug } = parseQuestionId(r.receipt.id, s.sourceId)!;
    const chat = stubChat();
    const refused = capabilityMissing('pages', 'listQuestionCandidatePages');
    const original = engine.listQuestionCandidatePages.bind(engine);
    engine.listQuestionCandidatePages = async () => { throw refused; };
    try {
      const outcome = await refreshPin(engine, s.sourceId, slug, { trigger: 'manual', full: true, chat: chat.fn, leaseOwner: 't' })
        .then(o => o.status, (e: { code?: string }) => e.code);
      expect(outcome).toBe('engine_capability_missing');
      expect(chat.calls).toEqual([]);
    } finally {
      engine.listQuestionCandidatePages = original;
    }
  });
});
