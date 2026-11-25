/**
 * The pinned-question stops on the Rust engine: the reads that return or compare pages.generation, and the pin record
 * writes and evidence reads the store does not serve yet (it keeps the pin rows: insert, one pin, the listing), refuse
 * with a typed engine_capability_missing that names the member and the missing piece, before any engine call.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each stopped question read refuses on the Rust engine naming pages.generation (or the pin records) with
 *    an owner and due date; each pin store function refuses on an engine without raw SQL naming itself, and sends no
 *    statement; on an engine with raw SQL the same functions run their statement.
 *  - Regression: these sites sent raw SQL, so a Rust brain refused them as a bare `executeRaw` raw_sql refusal that
 *    named neither the read nor what was missing.
 *  - Why existing coverage misses it: the parity file (test/engine-parity/question-reads.test.ts) counts these as
 *    stops; it does not pin the refusal's text.
 *  - Seam: the Rust engine's refusing member (no store is opened: the refusal runs before any work), an engine
 *    double with only `capabilities` and a recording `executeRaw` for the pin store guard, and a PGLite brain whose
 *    typed candidate read is replaced by a refusal (the refresh must surface it, not report a failed refresh).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { RustEngine } from '../src/core/rust-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { addSpend, getPin, releaseLease, updatePinState } from '../src/core/questions/store.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { pinQuestion } from '../src/core/questions/service.ts';
import { refreshPin } from '../src/core/questions/refresh.ts';
import { parseQuestionId } from '../src/core/questions/identity.ts';
import { capabilityMissing } from '../src/core/rust-engine/errors.ts';
import { openRustBrain, removeBrainDir, rustArmRequested } from './engine-parity/rust-arm.ts';
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
  test.each([...GENERATION_READS])('%s refuses naming the missing page generation, its owner and due date', async (member: string) => {
    const e = await refusal(member);
    expect(e.code).toBe('engine_capability_missing');
    expect(e.message).toContain(member);
    expect(e.message).toContain('pages.generation');
    expect(e.message).toContain('due 5 PM PST Nov 29');
    expect(e.detail).toContain('written=nothing');
  });

  test.each([...PIN_RECORD_READS])('%s refuses naming the missing evidence records', async (member: string) => {
    const e = await refusal(member);
    expect(e.code).toBe('engine_capability_missing');
    expect(e.message).toContain(member);
    expect(e.message).toContain('question_evidence');
  });

  test('questions pin refuses by name before its insert on an engine without raw SQL', async () => {
    const calls: string[] = [];
    const engine = { capabilities: new Set(['pages']), insertPinnedQuestion: async () => { calls.push('insertPinnedQuestion'); return null; },
      readSourceRow: async () => ({ id: 'default', local_path: null, config: {}, archived: false }) } as unknown as BrainEngine;
    const ctx = { engine, config: {}, remote: false, sourceId: 'default', dryRun: false, logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
    const e = await pinQuestion(ctx, { question: 'Who leads acme-example?', scope: { slug_prefix: 'projects/' }, defer: true })
      .then(() => null, (err: { code?: string; message: string }) => err);
    expect(e?.code).toBe('engine_capability_missing');
    expect(e?.message).toContain('pinned questions pin');
    expect(calls).toEqual([]);
  });

  test('the pin store refuses by name and sends no statement on an engine without raw SQL', async () => {
    const sent: string[] = [];
    const engine = { capabilities: new Set(['pages']), executeRaw: async (sql: string) => { sent.push(sql); return []; } } as unknown as BrainEngine;
    const outcomes = await Promise.all([
      getPin(engine, 'default', 'questions/x', { forUpdate: true }).then(() => null, (e: { code?: string; message: string }) => [e.code, e.message]),
      updatePinState(engine, 1, { state: 'archived' }).then(() => null, (e: { code?: string; message: string }) => [e.code, e.message]),
      releaseLease(engine, 1, 't', { error: null, spendUsd: 0 }).then(() => null, (e: { code?: string; message: string }) => [e.code, e.message]),
      addSpend(engine, 1, 0.5).then(() => null, (e: { code?: string; message: string }) => [e.code, e.message]),
    ]);
    expect(outcomes.map(o => o?.[0])).toEqual(Array(4).fill('engine_capability_missing'));
    expect(outcomes.map(o => /pinned questions (\w+)/.exec(String(o?.[1]))?.[1])).toEqual(['getPin', 'updatePinState', 'releaseLease', 'addSpend']);
    expect(String(outcomes[0]?.[1])).toContain('question_evidence');
    expect(sent).toEqual([]);
    // Spending nothing writes nothing, so it does not refuse.
    await addSpend(engine, 1, 0);
  });

  test('an engine with raw SQL runs the pin store statement', async () => {
    const sent: string[] = [];
    const engine = { capabilities: new Set(['raw_sql']), executeRaw: async (sql: string) => { sent.push(sql); return []; } } as unknown as BrainEngine;
    expect(await getPin(engine, 'default', 'questions/x', { forUpdate: true })).toBeNull();
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

  test('refuses by name, and no pin row and no question page is written', async () => {
    const ctx = { engine: rust, config: {}, remote: false, sourceId: 'default', dryRun: false, logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
    const e = await pinQuestion(ctx, { question: 'Who leads acme-example?', scope: { slug_prefix: 'projects/' }, defer: true })
      .then(() => null, (err: { code?: string; message: string }) => err);
    expect(e?.code).toBe('engine_capability_missing');
    expect(await rust.listPinnedQuestions({ includeArchived: true })).toEqual([]);
    expect((await rust.listPages({ limit: 10 })).map(p => p.slug)).toEqual([]);
  });
});
