/**
 * The pinned-question members on the Rust engine: every question read (the generation reads included, since the store
 * keeps the page generation counter) and every pin record read and write is a member the store serves, so none of them
 * refuses; the pin store functions call their typed members and send no raw statement; `questions pin` on a real Rust
 * brain writes its pin row and its question page; and a refresh surfaces an engine refusal instead of recording it as a
 * failed refresh.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each question member is in STORE_MEMBERS and is not a refusal on the Rust engine; each pin store
 *    function calls its typed member on an engine without raw SQL and sends no statement; a pin on a Rust brain stores
 *    one pin and one question page; refreshPin rejects with a refused read's engine_capability_missing and never calls
 *    the model.
 *  - Regression: these sites sent raw SQL, so a Rust brain refused them as a bare `executeRaw` raw_sql refusal; and a
 *    refresh recorded such a refusal as `refresh_failed`.
 *  - Why existing coverage misses it: the parity files (question-reads, question-store, page-generation) compare
 *    answers; they do not pin that the store-member table covers every question member.
 *  - Seam: the Rust engine's member table, an engine double with recording pin members and a recording `executeRaw`,
 *    a real Rust brain (when the Rust arm is requested), and a PGLite brain whose typed candidate read is replaced by
 *    a refusal.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rustMemberCapability } from '../src/core/rust-engine.ts';
import { STORE_MEMBERS } from '../src/core/rust-engine/store-members/index.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { acquireLease, addSpend, getPin, insertPin, listPins, releaseLease, updatePinState } from '../src/core/questions/store.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { pinQuestion } from '../src/core/questions/service.ts';
import { refreshPin } from '../src/core/questions/refresh.ts';
import { parseQuestionId } from '../src/core/questions/identity.ts';
import { capabilityMissing } from '../src/core/rust-engine/errors.ts';
import { openRustBrain, removeBrainDir, rustArmRequested } from './engine-parity/rust-arm.ts';
import { ENTITY, QUESTION, localCtx, seedBrain, stubChat } from './helpers/pinned-questions-fixture.ts';

const GENERATION_READS = ['listQuestionCandidatePages', 'listQuestionEvidenceTimeline', 'listQuestionEvidenceTakes', 'readQuestionPageRow',
  'readQuestionEvidenceClock', 'hasNewQuestionPages', 'lockQuestionEvidenceRows'] as const;
// The pin records and the evidence rows (rust/docs/store/questions.md).
const PIN_RECORD_MEMBERS = ['insertPinnedQuestion', 'readPinnedQuestion', 'listPinnedQuestions', 'readPinnedQuestionForUpdate', 'updatePinRowState',
  'acquirePinLease', 'releasePinLease', 'addPinSpend', 'recordPinBlocked', 'lockPinRowForPublish', 'publishPinAnswer', 'deleteQuestionEvidence',
  'insertQuestionEvidence', 'listQuestionEvidenceJoin', 'listPublishedQuestionAnswers'] as const;

describe('pinned-question members on the Rust engine', () => {
  test.each([...GENERATION_READS, ...PIN_RECORD_MEMBERS])('%s is served by the store, and the engine does not refuse it', (member: string) => {
    expect(member in STORE_MEMBERS).toBe(true);
    expect(rustMemberCapability(member)).toBeNull();
  });

  test('the pin store functions call their typed members on an engine without raw SQL, and send no statement', async () => {
    const sent: string[] = [];
    const calls: string[] = [];
    const row = { id: 3, source_id: 'default', slug: 'questions/x', question: 'Q?', state: 'active', publish_mode: 'publish', origin: 'pin', created_by: 'cli',
      revision: 1, answer_revision: 0, answer: null, refresh_attempts: 0, spend_usd: 0, created_at: new Date(0) };
    const engine = {
      capabilities: new Set(['pages']), executeRaw: async (sql: string) => { sent.push(sql); return []; },
      readPinnedQuestion: async (...a: unknown[]) => { calls.push(`readPinnedQuestion ${JSON.stringify(a)}`); return row; },
      readPinnedQuestionForUpdate: async (...a: unknown[]) => { calls.push(`readPinnedQuestionForUpdate ${JSON.stringify(a)}`); return row; },
      listPinnedQuestions: async (f: unknown) => { calls.push(`listPinnedQuestions ${JSON.stringify(f)}`); return [row]; },
      insertPinnedQuestion: async () => { calls.push('insertPinnedQuestion'); return row; },
      updatePinRowState: async () => { calls.push('updatePinRowState'); return row; },
      acquirePinLease: async () => { calls.push('acquirePinLease'); return row; },
      releasePinLease: async (...a: unknown[]) => { calls.push(`releasePinLease ${JSON.stringify(a)}`); },
      addPinSpend: async (...a: unknown[]) => { calls.push(`addPinSpend ${JSON.stringify(a)}`); },
    } as unknown as BrainEngine;
    expect((await getPin(engine, 'default', 'questions/x', { forUpdate: true }))?.id).toBe(3);
    expect((await getPin(engine, 'default', 'questions/x'))?.id).toBe(3);
    expect((await listPins(engine, { sourceIds: ['default'] })).length).toBe(1);
    expect((await insertPin(engine, { sourceId: 'default', slug: 'questions/x', question: 'Q?', scope: { source: 'default' }, state: 'active', inactiveReason: null, publishMode: 'publish', createdBy: 'cli' })).created).toBe(true);
    await updatePinState(engine, 3, { state: 'archived' });
    await acquireLease(engine, 3, 't', 'o', 1000);
    await releaseLease(engine, 3, 't', { error: null, spendUsd: 0.5 });
    await addSpend(engine, 3, 0.5);
    // Spending nothing writes nothing.
    await addSpend(engine, 3, 0);
    expect(calls).toEqual([
      'readPinnedQuestionForUpdate ["default","questions/x"]',
      'readPinnedQuestion ["default","questions/x"]',
      'listPinnedQuestions {"sourceIds":["default"],"includeArchived":false}',
      'insertPinnedQuestion', 'updatePinRowState', 'acquirePinLease',
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

describe.skipIf(!rustArmRequested())('questions pin on a Rust brain', () => {
  let rust: BrainEngine;
  let dir: string;
  beforeAll(async () => {
    const opened = await openRustBrain();
    rust = opened.engine as unknown as BrainEngine;
    dir = opened.dir;
  }, 120_000);
  afterAll(async () => {
    await rust?.disconnect();
    if (dir) removeBrainDir(dir);
  });

  test('writes one pin row and its question page', async () => {
    const ctx = { engine: rust, config: {}, remote: false, sourceId: 'default', dryRun: false, logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
    const r = await pinQuestion(ctx, { question: 'Who leads acme-example?', scope: { slug_prefix: 'projects/' }, defer: true });
    expect(r.created).toBe(true);
    const pins = await rust.listPinnedQuestions({ includeArchived: true });
    expect(pins.map(p => p.slug)).toEqual([r.receipt.slug]);
    expect((await rust.listPages({ limit: 10 })).map(p => p.slug)).toEqual([r.receipt.slug]);
  });
});
