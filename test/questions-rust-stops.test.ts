/**
 * The pinned-question stops on the Rust engine: the reads that return or compare pages.generation refuse with a typed
 * engine_capability_missing that names the member and the missing piece, before any engine call. The pin records are
 * served (no stop names them).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each stopped question read refuses on the Rust engine naming pages.generation with an owner and due
 *    date; the pin record members are served by the store and named by no stop; each pin store function calls its typed
 *    member on an engine without raw SQL and sends no statement.
 *  - Regression: these sites sent raw SQL, so a Rust brain refused them as a bare `executeRaw` raw_sql refusal that
 *    named neither the read nor what was missing.
 *  - Why existing coverage misses it: the parity file (test/engine-parity/question-reads.test.ts) counts these as
 *    stops; it does not pin the refusal's text.
 *  - Seam: the Rust engine's refusing member (no store is opened: the refusal runs before any work), an engine
 *    double with recording pin members and a recording `executeRaw` for the pin store functions, and a PGLite brain whose
 *    typed candidate read is replaced by a refusal (the refresh must surface it, not report a failed refresh).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { RustEngine, rustMemberCapability } from '../src/core/rust-engine.ts';
import { STORE_MEMBERS } from '../src/core/rust-engine/store-members/index.ts';
import { QUESTION_STOP_OWNERS } from '../src/core/rust-engine/question-stops.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { acquireLease, addSpend, getPin, insertPin, listPins, releaseLease, updatePinState } from '../src/core/questions/store.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { pinQuestion } from '../src/core/questions/service.ts';
import { refreshPin } from '../src/core/questions/refresh.ts';
import { parseQuestionId } from '../src/core/questions/identity.ts';
import { capabilityMissing } from '../src/core/rust-engine/errors.ts';
import { ENTITY, QUESTION, localCtx, seedBrain, stubChat } from './helpers/pinned-questions-fixture.ts';

const GENERATION_READS = ['listQuestionCandidatePages', 'listQuestionEvidenceTimeline', 'listQuestionEvidenceTakes', 'readQuestionPageRow',
  'readQuestionEvidenceClock', 'hasNewQuestionPages', 'lockQuestionEvidenceRows'] as const;
// The pin records are served since lane 15 head 2 (rust/docs/store/questions.md): none of these has a stop.
const PIN_RECORD_MEMBERS = ['readPinRow', 'listPinRows', 'insertPinRow', 'updatePinRowState', 'acquirePinLease', 'releasePinLease', 'addPinSpend',
  'recordPinBlocked', 'lockPinRowForPublish', 'publishPinAnswer', 'deleteQuestionEvidence', 'insertQuestionEvidence', 'listQuestionEvidenceJoin',
  'listPublishedQuestionAnswers'] as const;

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
  test.each([...GENERATION_READS])('%s refuses naming the missing page generation, its owner and due date', async (member: string) => {
    const e = await refusal(member);
    expect(e.code).toBe('engine_capability_missing');
    expect(e.message).toContain(member);
    expect(e.message).toContain('pages.generation');
    expect(e.message).toContain('due 5 PM PST Nov 29');
    expect(e.detail).toContain('written=nothing');
  });

  test.each([...PIN_RECORD_MEMBERS])('%s is served by the store: no stop names it, and the engine does not refuse it', (member: string) => {
    expect(member in STORE_MEMBERS).toBe(true);
    expect(member in QUESTION_STOP_OWNERS).toBe(false);
    expect(rustMemberCapability(member)).toBeNull();
  });

  test('the pin store functions call their typed members on an engine without raw SQL, and send no statement', async () => {
    const sent: string[] = [];
    const calls: string[] = [];
    const row = { id: 3, source_id: 'default', slug: 'questions/x', question: 'Q?', state: 'active', publish_mode: 'publish', origin: 'pin', created_by: 'cli',
      revision: 1, answer_revision: 0, answer: null, refresh_attempts: 0, spend_usd: 0, created_at: new Date(0) };
    const engine = {
      capabilities: new Set(['pages']), executeRaw: async (sql: string) => { sent.push(sql); return []; },
      readPinRow: async (...a: unknown[]) => { calls.push(`readPinRow ${JSON.stringify(a)}`); return row; },
      listPinRows: async (f: unknown) => { calls.push(`listPinRows ${JSON.stringify(f)}`); return [row]; },
      insertPinRow: async () => { calls.push('insertPinRow'); return row; },
      updatePinRowState: async () => { calls.push('updatePinRowState'); return row; },
      acquirePinLease: async () => { calls.push('acquirePinLease'); return row; },
      releasePinLease: async (...a: unknown[]) => { calls.push(`releasePinLease ${JSON.stringify(a)}`); },
      addPinSpend: async (...a: unknown[]) => { calls.push(`addPinSpend ${JSON.stringify(a)}`); },
    } as unknown as BrainEngine;
    expect((await getPin(engine, 'default', 'questions/x', { forUpdate: true }))?.id).toBe(3);
    expect((await listPins(engine, { sourceIds: ['default'] })).length).toBe(1);
    expect((await insertPin(engine, { sourceId: 'default', slug: 'questions/x', question: 'Q?', scope: {}, state: 'active', inactiveReason: null, publishMode: 'publish', createdBy: 'cli' })).created).toBe(true);
    await updatePinState(engine, 3, { state: 'archived' });
    await acquireLease(engine, 3, 't', 'o', 1000);
    await releaseLease(engine, 3, 't', { error: null, spendUsd: 0.5 });
    await addSpend(engine, 3, 0.5);
    // Spending nothing writes nothing.
    await addSpend(engine, 3, 0);
    expect(calls).toEqual([
      'readPinRow ["default","questions/x",true]',
      'listPinRows {"sourceIds":["default"],"states":null,"includeArchived":false}',
      'insertPinRow', 'updatePinRowState', 'acquirePinLease',
      'releasePinLease [3,"t",null,0.5]', 'addPinSpend [3,0.5]',
    ]);
    expect(sent).toEqual([]);
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
