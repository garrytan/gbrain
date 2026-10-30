/**
 * #7307: the decide (S7) triage path must not re-send transcripts that are
 * already judged. Runs the real call site (runTriagePass, the pass synthesize
 * and dream retriage share) on PGLite and, with DATABASE_URL, Postgres; a
 * fixture decide transport counts every window request and a fixture LLM
 * judge counts every LLM triage call. No provider is called.
 *
 * Protects:
 *   1. A verdict today's LLM triage stored for the same content, model and
 *      TRIAGE_VERSION is a cache hit for the decide path (no decide request);
 *      another model, an older version or a row before staleBefore is not.
 *   2. A margin hold is cached for DECIDE_MARGIN_HOLD_TTL_MS: when the LLM
 *      triage step that follows it is budget-deferred, the next pass does not
 *      ask decide again (and counts the hold once); the hold expires, `force`
 *      ignores it, and it never overwrites an LLM backoff marker, which also
 *      keeps decide from re-asking while its backoff runs.
 * Serial: mutates the process-global gateway and decide transport.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setDecideTransportForTests } from '../../src/core/ai/gateway.ts';
import { flushDecideWrites, __resetDecideStoreForTests } from '../../src/core/ai/decide/store.ts';
import { runTriagePass, TRIAGE_VERSION, type JudgeClient, type TriagePassCfg } from '../../src/core/cycle/synthesize.ts';
import { resolveTriageDecide, DECIDE_MARGIN_HOLD_TTL_MS } from '../../src/core/cycle/triage-decide.ts';
import { TRIAGE_UNRELIABLE_BACKOFF, TRIAGE_UNRELIABLE_CONTENT_TYPE } from '../../src/core/cycle/triage-backoff.ts';
import type { DiscoveredTranscript } from '../../src/core/cycle/transcript-discovery.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';

const LLM_MODEL = 'anthropic:claude-haiku-4-5-20251001';
const S7_ON: Record<string, string> = {
  'decide.provider': 'typesafe:jev-1.13.0', 'decide.slots.triage.mode': 'on', 'decide.slots.triage.threshold': '0.5',
  'decide.slots.triage.force_on': 'true', 'decide.egress.private': 'allow', 'decide.egress.typesafe.conversation': 'allow',
  'decide.background_concurrency': '2',
};

function transcript(name: string): DiscoveredTranscript {
  const content = Array.from({ length: 8 }, (_, i) => `[${i % 2 ? 'assistant' : 'user'}]\nNotes about the notes/x-example rollout, item ${i}.\n`).join('\n');
  return { filePath: `/corpus/${name}.txt`, contentHash: `hash-${name}-${content.length}`, content, basename: name, inferredDate: null };
}

for (const kind of testBackends()) {
  describe(`#7307 decide triage re-send (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let windowRequests = 0;
    let judgeCalls = 0;
    let clock = 0;

    /** Every window request answers `p`; each request advances the pass clock by `advanceMs`. */
    const transport = (p: number, advanceMs = 0) => __setDecideTransportForTests(async (_url, init) => {
      const body = JSON.parse(init.body as string);
      const answers: Record<string, unknown> = {};
      for (const [id, q] of Object.entries<any>(body.questions)) {
        if (q.type === 'choice') { answers[id] = { type: 'choice', choice: 'strategy', confidence: 0.8, probabilities: { strategy: 0.8 } }; continue; }
        windowRequests++;
        answers[id] = { type: 'noul', noul: p };
      }
      clock += advanceMs;
      return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 300, output_tokens: 5 } }));
    });
    const judge = (score: number, stop = 'end_turn'): JudgeClient => ({
      create: async () => {
        judgeCalls++;
        return { content: [{ type: 'text', text: JSON.stringify({ score, content_type: 'mixed', segments: [], entities: [], reasons: ['llm'] }) }], stop_reason: stop } as never;
      },
    });
    const pass = async (ts: DiscoveredTranscript[], over: Partial<TriagePassCfg> = {}) => {
      const decide = await resolveTriageDecide(engine, { decisionMs: 5_000 });
      return runTriagePass(engine, ts, { model: LLM_MODEL, maxChars: 24_000, maxTokens: 2048, threshold: 0.5, concurrency: 1, maxMs: 0, judge: judge(0.9), decide, ...over });
    };
    const verdict = (t: DiscoveredTranscript) => engine.getDreamVerdict(t.filePath, t.contentHash);
    const seedLlm = (t: DiscoveredTranscript, model = LLM_MODEL, version = TRIAGE_VERSION) => engine.putDreamVerdict(t.filePath, t.contentHash, {
      worth_processing: true, reasons: ['seed'], score: 0.9, content_type: 'idea', segments: [], entities: [], model, triage_version: version,
    });
    const age = (t: DiscoveredTranscript, ms: number) => engine.executeRaw(
      `UPDATE dream_verdicts SET judged_at = now() - make_interval(secs => $3::int) WHERE file_path = $1 AND content_hash = $2`,
      [t.filePath, t.contentHash, Math.ceil(ms / 1000)]);

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else {
        const pglite = new PGLiteEngine();
        await pglite.connect({});
        await pglite.initSchema();
        engine = pglite;
        close = () => pglite.disconnect();
      }
      configureGateway({ env: { TYPESAFE_API_KEY: 'sk-test-typesafe' } } as never);
    }, 120_000);
    afterAll(async () => {
      __setDecideTransportForTests(null);
      resetGateway();
      await close?.();
    });
    beforeEach(async () => {
      await engine.executeRaw(`DELETE FROM config WHERE key LIKE 'decide.%'`);
      for (const table of ['decision_receipts', 'decide_spend', 'decide_calibrations', 'dream_verdicts']) await engine.executeRaw(`DELETE FROM ${table}`);
      __resetDecideStoreForTests();
      for (const [k, v] of Object.entries(S7_ON)) await engine.setConfig(k, v);
      windowRequests = 0;
      judgeCalls = 0;
      clock = 0;
    });
    afterEach(async () => {
      await new Promise((r) => setTimeout(r, 20));
      await flushDecideWrites();
    });

    test('a transcript the LLM triage judged after a margin hold is a decide cache hit on the next pass', async () => {
      transport(0.47);
      const t = transcript('held-then-judged');
      const first = await pass([t]);
      expect({ requests: windowRequests > 0, judgeCalls, margin_hold: first.decide!.margin_hold }).toEqual({ requests: true, judgeCalls: 1, margin_hold: 1 });
      expect((await verdict(t))!.model).toBe(LLM_MODEL);
      windowRequests = 0;
      const second = await pass([t]);
      expect({ windowRequests, judgeCalls, cacheHits: second.cacheHits, worth: second.reports[0]!.worth, judged: second.decide!.judged })
        .toEqual({ windowRequests: 0, judgeCalls: 1, cacheHits: 1, worth: true, judged: 0 });
    });

    test('a stored LLM verdict is a hit only for the current model, TRIAGE_VERSION and staleBefore', async () => {
      transport(0.9);
      const hit = transcript('llm-current');
      await seedLlm(hit);
      const out = await pass([hit]);
      expect({ windowRequests, judgeCalls, cacheHits: out.cacheHits, model: (await verdict(hit))!.model }).toEqual({ windowRequests: 0, judgeCalls: 0, cacheHits: 1, model: LLM_MODEL });
      const misses: Array<[string, (t: DiscoveredTranscript) => Promise<void>, Partial<TriagePassCfg>]> = [
        ['llm-other-model', (t) => seedLlm(t, 'anthropic:claude-old-example'), {}],
        ['llm-older-version', (t) => seedLlm(t, LLM_MODEL, TRIAGE_VERSION - 1), {}],
        ['llm-before-stale-before', (t) => seedLlm(t), { staleBefore: new Date(Date.now() + 60_000) }],
      ];
      for (const [name, seed, over] of misses) {
        windowRequests = 0;
        const t = transcript(name);
        await seed(t);
        await pass([t], over);
        expect({ name, asked: windowRequests > 0 }).toEqual({ name, asked: true });
      }
    });

    test('a margin hold whose LLM triage was budget-deferred is not re-sent to decide on the next pass', async () => {
      transport(0.47, 10_000);
      const t = transcript('held-deferred');
      const now = () => clock;
      const first = await pass([t], { maxMs: 1_000, now });
      expect({ deferred: first.deferred, judgeCalls, margin_hold: first.decide!.margin_hold }).toEqual({ deferred: 1, judgeCalls: 0, margin_hold: 1 });
      windowRequests = 0;
      const second = await pass([t], { maxMs: 1_000, now });
      expect({ windowRequests, judgeCalls, deferred: second.deferred, worth: second.reports[0]!.worth })
        .toEqual({ windowRequests: 0, judgeCalls: 1, deferred: 0, worth: true });
      expect(second.decide).toMatchObject({ judged: 0, margin_hold: 0, held: 1, cache_hits: 0 });
      expect((await verdict(t))!.model).toBe(LLM_MODEL);
      const third = await pass([t], { maxMs: 1_000, now });
      expect({ windowRequests, judgeCalls, cacheHits: third.cacheHits }).toEqual({ windowRequests: 0, judgeCalls: 1, cacheHits: 1 });
    });

    test('the margin-hold cache expires after its TTL, and force ignores it', async () => {
      transport(0.47, 10_000);
      const t = transcript('held-expiring');
      const now = () => clock;
      await pass([t], { maxMs: 1_000, now });
      windowRequests = 0;
      await pass([t], { maxMs: 1_000, now, judge: null });
      expect(windowRequests).toBe(0);
      await age(t, DECIDE_MARGIN_HOLD_TTL_MS + 60_000);
      await pass([t], { maxMs: 1_000, now, judge: null });
      expect(windowRequests).toBeGreaterThan(0);
      windowRequests = 0;
      await pass([t], { maxMs: 1_000, now, judge: null, force: true });
      expect(windowRequests).toBeGreaterThan(0);
    });

    test('#7307 audit: shadow mode asks decide only for transcripts the LLM triage judged this pass, never for cache hits', async () => {
      await engine.setConfig('decide.slots.triage.mode', 'shadow');
      transport(0.9);
      const cached = transcript('shadow-cached');
      await seedLlm(cached);
      const out = await pass([cached]);
      expect({ windowRequests, judgeCalls, cacheHits: out.cacheHits }).toEqual({ windowRequests: 0, judgeCalls: 0, cacheHits: 1 });
      const fresh = transcript('shadow-fresh');
      await pass([fresh]);
      expect({ asked: windowRequests > 0, judgeCalls }).toEqual({ asked: true, judgeCalls: 1 });
      windowRequests = 0;
      const again = await pass([fresh]);
      expect({ windowRequests, judgeCalls, cacheHits: again.cacheHits }).toEqual({ windowRequests: 0, judgeCalls: 1, cacheHits: 1 });
    });

    test('an LLM backoff marker after a margin hold is kept, and decide is not asked again while it runs', async () => {
      transport(0.47);
      const t = transcript('held-unreliable');
      const first = await pass([t], { judge: judge(0.9, 'max_tokens') });
      expect({ unreliable: first.unreliable, judgeCalls }).toEqual({ unreliable: 1, judgeCalls: 1 });
      expect((await verdict(t))!.content_type).toBe(TRIAGE_UNRELIABLE_CONTENT_TYPE);
      windowRequests = 0;
      const second = await pass([t], { judge: judge(0.9, 'max_tokens') });
      expect({ windowRequests, judgeCalls, backoff: second.backoff, code: second.reports[0]!.code })
        .toEqual({ windowRequests: 0, judgeCalls: 1, backoff: 1, code: TRIAGE_UNRELIABLE_BACKOFF });
      const row = await verdict(t);
      expect({ content_type: row!.content_type, model: row!.model }).toEqual({ content_type: TRIAGE_UNRELIABLE_CONTENT_TYPE, model: LLM_MODEL });
    });
  });
}
