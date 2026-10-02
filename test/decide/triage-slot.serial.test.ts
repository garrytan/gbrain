/**
 * System One S7 (dream triage) — pure decision logic plus the real call site
 * (runTriagePass on PGLite, the same pass the synthesize phase and dream
 * retriage run) with a fixture decide transport. No provider is called.
 *
 * Protects: whole-turn windows (~1,500 chars, never sentences; oversized turns
 * split at paragraphs and are marked); one request per window under the
 * background concurrency cap; transcript score = max window p so one buried
 * signal passes; pass/reject verdicts cached under the decide identity with a
 * verbatim segment map; margin_hold and every incomplete decision (5xx, 429,
 * timeout, budget, drift, egress refusal) take today's LLM triage and never
 * cache a rejection; no LLM triage configured → pass; passesTriageGate reads
 * decide verdicts against the slot threshold without the rescue band; S7 off
 * re-triages nothing; shadow and inactive `on` change nothing but receipts;
 * receipts carry hashes only.
 * Serial: mutates the process-global gateway and decide transport.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setDecideTransportForTests, __setChatTransportForTests } from '../../src/core/ai/gateway.ts';
import { flushDecideWrites, __resetDecideStoreForTests, insertCalibration, storeQualification } from '../../src/core/ai/decide/store.ts';
import { policyFingerprint } from '../../src/core/ai/decide/policy.ts';
import { runTriagePass, buildTriageMapBlock, TRIAGE_VERSION, type JudgeClient, type TriagePassCfg } from '../../src/core/cycle/synthesize.ts';
import { passesTriageGate, DEFAULT_RESCUE_CONFIG } from '../../src/core/cycle/triage-rescue.ts';
import {
  splitTurnWindows, windowQuote, reduceTriage, whatIfTriage, decideSegmentMap, resolveTriageDecide, estimateTriageDecideUsd,
  TRIAGE_WINDOW_CHARS, TRIAGE_QUOTE_CHARS,
} from '../../src/core/cycle/triage-decide.ts';
import { cycleSlotPackShape } from '../../src/core/cycle/decide-slot.ts';
import type { DiscoveredTranscript } from '../../src/core/cycle/transcript-discovery.ts';

const LLM_MODEL = 'anthropic:claude-haiku-4-5-20251001';
const SIGNAL = 'I decided to move the launch to March and ask Alice Example to lead the migration.';

function turns(n: number, text = 'Can you check the build status and remind me about groceries later today please.'): string {
  return Array.from({ length: n }, (_, i) => `[${i % 2 ? 'assistant' : 'user'}]\n${text} (${i})\n`).join('\n');
}

function transcript(name: string, content: string): DiscoveredTranscript {
  return { filePath: `/corpus/${name}.txt`, contentHash: `hash-${name}-${content.length}`, content, basename: name, inferredDate: null };
}

const buried = () => transcript('buried', `${turns(30)}\n[user]\n${SIGNAL}\n\n[assistant]\nNoted.\n\n${turns(30)}`);
const routine = () => transcript('routine', turns(20));

// ── pure logic ─────────────────────────────────────────────────────────

describe('S7 turn windows', () => {
  test('windows hold whole turns, about 1,500 characters, and start on turn boundaries', () => {
    const t = buried();
    const ws = splitTurnWindows(t.content);
    expect(ws.length).toBeGreaterThan(2);
    for (const w of ws) {
      expect(w.text.startsWith('[user]') || w.text.startsWith('[assistant]')).toBe(true);
      expect(w.text.length).toBeLessThanOrEqual(TRIAGE_WINDOW_CHARS + 50);
      expect(w.split).toBeUndefined();
    }
    expect(ws.map((w) => w.text).join('\n')).toContain(SIGNAL);
    expect(ws.filter((w) => w.text.includes(SIGNAL))).toHaveLength(1);
  });

  test('speaker anchors (`User:` / bold) are turns too; a turn is never split into sentences', () => {
    const long = `User: ${'A long reflective sentence about the plan. '.repeat(60)}\nAssistant: ok.\n`;
    const ws = splitTurnWindows(long);
    expect(ws[0]!.text.startsWith('User:')).toBe(true);
    expect(ws[0]!.text).toContain('A long reflective sentence about the plan. '.repeat(60).trim());
    const bold = splitTurnWindows('**Alice** (10:00): first thought here.\n**Bob** (10:01): reply here.\n');
    expect(bold).toHaveLength(1);
  });

  test('a turn over the request limit splits at paragraph boundaries and is marked', () => {
    const para = 'Paragraph text that goes on for a while. '.repeat(20);
    const ws = splitTurnWindows(`[user]\n${Array.from({ length: 8 }, () => para).join('\n\n')}\n`, 1500, 2000);
    expect(ws.length).toBeGreaterThan(1);
    expect(ws.every((w) => w.split === true)).toBe(true);
    expect(ws.every((w) => w.text.length <= 2000)).toBe(true);
  });

  test('no turn structure falls back to paragraphs; empty content has no windows', () => {
    expect(splitTurnWindows('one para.\n\nsecond para.\n\nthird.').length).toBe(1);
    expect(splitTurnWindows('')).toHaveLength(0);
  });

  test('segment quotes are verbatim, at most 300 chars, cut at the first turn boundary', () => {
    const t = buried();
    const ws = splitTurnWindows(t.content);
    for (const w of ws) {
      const q = windowQuote(t.content, w);
      expect(q.length).toBeLessThanOrEqual(TRIAGE_QUOTE_CHARS);
      expect(t.content.includes(q)).toBe(true);
      expect(q.includes('\n[assistant]') || q.includes('\n[user]')).toBe(false);
    }
  });
});

describe('S7 reducer, what-if and gate', () => {
  test('max window p against threshold and margin; null is incomplete', () => {
    const p = { threshold: 0.5, margin: 0.05 };
    expect(reduceTriage(0.9, p)).toBe('pass');
    expect(reduceTriage(0.5, p)).toBe('pass');
    expect(reduceTriage(0.47, p)).toBe('margin_hold');
    expect(reduceTriage(0.2, p)).toBe('reject');
    expect(reduceTriage(null, p)).toBeNull();
  });

  test('what-if groups windows by decision and replays the transcript maximum', () => {
    const rows = [
      { decision_id: 'a', answer_value: 0.1 }, { decision_id: 'a', answer_value: 0.8 },
      { decision_id: 'b', answer_value: 0.1 }, { decision_id: 'b', answer_value: 0.2 },
    ];
    expect(whatIfTriage(rows, 0.5, 0.05)).toEqual({ pass: 2, reject: 2, margin_hold: 0 });
    expect(whatIfTriage(rows, 0.9, 0.05)).toEqual({ pass: 0, reject: 4, margin_hold: 0 });
  });

  test('passesTriageGate reads a decide verdict against the slot threshold and never rescues it', () => {
    const v = { score: 0.4, content_type: 'mixed', segments: [{ quote: 'x'.repeat(60) }, { quote: 'y'.repeat(60) }], model: 'decide:typesafe:jev-1.13.0@jev-1.13.0#abc' };
    const content = `${'x'.repeat(60)} ${'y'.repeat(60)}`;
    expect(passesTriageGate(v, content, 0.5, DEFAULT_RESCUE_CONFIG, { threshold: 0.35 }).pass).toBe(true);
    const low = passesTriageGate(v, content, 0.5, DEFAULT_RESCUE_CONFIG, { threshold: 0.45 });
    expect(low).toEqual({ pass: false, rescued: false, verified_segments: 0 });
    // The same scores on an LLM row still take the rescue band.
    expect(passesTriageGate({ ...v, model: LLM_MODEL }, content, 0.5, DEFAULT_RESCUE_CONFIG).rescued).toBe(true);
  });

  test('the segment map keeps top windows, verbatim quotes the TRIAGE MAP accepts, and entities', () => {
    const t = buried();
    const ws = splitTurnWindows(t.content);
    const values = ws.map((w) => (w.text.includes(SIGNAL) ? 0.9 : 0.1));
    const map = decideSegmentMap(t.content, ws, values);
    expect(map.segments.length).toBeLessThanOrEqual(8);
    expect(map.entities).toContain('Alice Example');
    const block = buildTriageMapBlock({ score: 0.9, content_type: null, segments: map.segments, entities: map.entities }, t.content, 1);
    expect(block).toContain(map.segments[0]!.quote.slice(0, 40));
  });

  test('retriage spend estimate prices S7 windows (Jev) and returns null for llm providers', () => {
    const usd = estimateTriageDecideUsd('typesafe:jev-1.13.0', 30_000);
    expect(usd).toBeGreaterThan(0);
    expect(usd!).toBeLessThan(0.01);
    expect(estimateTriageDecideUsd('llm:openai:gpt-5.4-mini', 30_000)).toBeNull();
  });
});

// ── real call site: runTriagePass on PGLite ─────────────────────────────

let engine: PGLiteEngine;
let bodies: any[] = [];
let inFlight = 0;
let maxInFlight = 0;

type Answer = (window: string) => number | 'fail' | '429' | 'hang';
function transport(answer: Answer, model = 'jev-1.13.0') {
  __setDecideTransportForTests(async (_url, init) => {
    const body = JSON.parse(init.body as string);
    bodies.push(body);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((r) => setTimeout(r, 2));
      const answers: Record<string, unknown> = {};
      for (const [id, q] of Object.entries<any>(body.questions)) {
        if (q.type === 'choice') { answers[id] = { type: 'choice', choice: 'strategy', confidence: 0.8, probabilities: { strategy: 0.8, routine: 0.2 } }; continue; }
        const a = answer(q.instructions.window ?? '');
        if (a === 'fail') return new Response('boom', { status: 503 });
        if (a === '429') return new Response('slow down', { status: 429 });
        if (a === 'hang') { await new Promise((_, rej) => init.signal?.addEventListener('abort', () => rej(init.signal!.reason))); }
        answers[id] = { type: 'noul', noul: a };
      }
      return new Response(JSON.stringify({ model, answers, usage: { input_tokens: 300, output_tokens: 5 } }));
    } finally {
      inFlight--;
    }
  });
}

let judgeCalls = 0;
function judge(score: number): JudgeClient {
  return {
    create: async () => {
      judgeCalls++;
      return { content: [{ type: 'text', text: JSON.stringify({ score, content_type: 'mixed', segments: [], entities: [], reasons: ['llm'] }) }], stop_reason: 'end_turn' } as never;
    },
  };
}

const S7_ON: Record<string, string> = {
  'decide.provider': 'typesafe:jev-1.13.0', 'decide.slots.triage.mode': 'on', 'decide.slots.triage.threshold': '0.5',
  'decide.slots.triage.force_on': 'true', 'decide.egress.private': 'allow', 'decide.egress.typesafe.conversation': 'allow',
  'decide.background_concurrency': '2',
};

async function setConfig(kv: Record<string, string>) {
  for (const [k, v] of Object.entries(kv)) await engine.setConfig(k, v);
}

async function pass(ts: DiscoveredTranscript[], over: Partial<TriagePassCfg> = {}, decisionMs = 5_000) {
  const decide = await resolveTriageDecide(engine, { decisionMs });
  return runTriagePass(engine, ts, { model: LLM_MODEL, maxChars: 24_000, maxTokens: 2048, threshold: 0.5, concurrency: 2, maxMs: 0, judge: judge(0.9), decide, ...over });
}

async function receipts(): Promise<Array<Record<string, unknown>>> {
  await new Promise((r) => setTimeout(r, 30));
  await flushDecideWrites();
  return engine.executeRaw("SELECT * FROM decision_receipts WHERE slot = 'triage' ORDER BY id");
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  configureGateway({ env: { TYPESAFE_API_KEY: 'sk-test-typesafe' } } as never);
});

afterAll(async () => {
  __setDecideTransportForTests(null);
  resetGateway();
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw(`DELETE FROM config WHERE key LIKE 'decide.%'`);
  for (const table of ['decision_receipts', 'decide_spend', 'decide_calibrations', 'dream_verdicts']) await engine.executeRaw(`DELETE FROM ${table}`);
  __resetDecideStoreForTests();
  __setDecideTransportForTests(null);
  bodies = [];
  inFlight = 0;
  maxInFlight = 0;
  judgeCalls = 0;
});

describe('S7 off', () => {
  test('no TypeSafe key and no decide keys: the slot resolves to nothing and cached LLM verdicts stay hits (nothing re-triages)', async () => {
    configureGateway({ env: {} } as never);
    try {
      expect(await resolveTriageDecide(engine)).toBeUndefined();
      const t0 = routine();
      await pass([t0]);
      expect(judgeCalls).toBe(1);
      expect(bodies).toHaveLength(0);
    } finally {
      configureGateway({ env: { TYPESAFE_API_KEY: 'sk-test-typesafe' } } as never);
    }
  });

  test('explicit off with a key: the slot resolves to nothing and cached LLM verdicts stay hits (nothing re-triages)', async () => {
    await setConfig({ 'decide.slots.triage.mode': 'off' });
    expect(await resolveTriageDecide(engine)).toBeUndefined();
    const t = routine();
    await pass([t]);
    expect(judgeCalls).toBe(1);
    await setConfig({ ...S7_ON, 'decide.slots.triage.mode': 'off' });
    expect(await resolveTriageDecide(engine)).toBeUndefined();
    transport(() => 0.9);
    const again = await pass([t]);
    expect(judgeCalls).toBe(1);
    expect(again.cacheHits).toBe(1);
    expect(again.decide).toBeUndefined();
    expect(bodies).toHaveLength(0);
  });
});

describe('S7 key-aware default', () => {
  test('a TypeSafe key and no decide keys: on with the shipped reference calibration, nothing written to config', async () => {
    const slot = await resolveTriageDecide(engine);
    expect(slot).toBeDefined();
    expect(slot!.stats).toMatchObject({ mode: 'on', provider: 'typesafe:jev-1.13.0', threshold: 0.77 });
    expect(slot!.acting).toBe(true);
    transport((w) => (w.includes(SIGNAL) ? 0.92 : 0.04));
    const out = await pass([buried()]);
    expect(judgeCalls).toBe(0);
    expect(out.reports[0]!.worth).toBe(true);
    expect(await engine.executeRaw(`SELECT key FROM config WHERE key LIKE 'decide.%'`)).toEqual([]);
  });

  test('decide.egress.private deny set explicitly keeps the default off', async () => {
    await setConfig({ 'decide.egress.private': 'deny' });
    expect(await resolveTriageDecide(engine)).toBeUndefined();
  });
});

describe('S7 on through runTriagePass', () => {
  test('a buried signal passes; a routine transcript is rejected; verdicts are cached under the decide identity', async () => {
    await setConfig(S7_ON);
    transport((w) => (w.includes(SIGNAL) ? 0.92 : 0.04));
    const b = buried();
    const r = routine();
    const out = await pass([b, r]);
    expect(judgeCalls).toBe(0);
    const [rb, rr] = out.reports;
    expect(rb!.worth).toBe(true);
    expect(rb!.score).toBeCloseTo(0.92, 5);
    expect(rr!.worth).toBe(false);
    expect(rr!.score).toBeCloseTo(0.04, 5);
    // One question per request; paced under decide.background_concurrency.
    const windowBodies = bodies.filter((x) => Object.values<any>(x.questions)[0].type === 'noul');
    expect(windowBodies.every((x) => Object.keys(x.questions).length === 1)).toBe(true);
    expect(windowBodies.length).toBe(splitTurnWindows(b.content).length + splitTurnWindows(r.content).length);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    // Cached verdict: decide identity, segment map from the top windows, worth from the S7 decision.
    const vb = await engine.getDreamVerdict(b.filePath, b.contentHash);
    expect(vb!.model!.startsWith('decide:typesafe:jev-1.13.0@jev-1.13.0#')).toBe(true);
    expect(vb!.triage_version).toBe(TRIAGE_VERSION);
    expect(vb!.worth_processing).toBe(true);
    expect(vb!.content_type).toBe('strategy');
    expect(b.content.includes(vb!.segments[0]!.quote)).toBe(true);
    expect(vb!.segments[0]!.quote).toContain('decided to move the launch');
    const vr = await engine.getDreamVerdict(r.filePath, r.contentHash);
    expect(vr!.worth_processing).toBe(false);
    expect(out.decide).toMatchObject({ mode: 'on', pass: 1, reject: 1, incomplete: 0, judged: 2 });
    // Receipts: one row per window, transcript outcome, hashes only.
    const rows = await receipts();
    expect(rows.length).toBe(windowBodies.length);
    expect(new Set(rows.map((x) => x.outcome))).toEqual(new Set(['pass', 'reject']));
    expect(new Set(rows.map((x) => x.decision_id)).size).toBe(2);
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain('decided to move');
    expect(dump).not.toContain('/corpus/');
    // Second pass: decide cache hits, no calls.
    bodies = [];
    const again = await pass([b, r]);
    expect(bodies).toHaveLength(0);
    expect(again.cacheHits).toBe(2);
    expect(again.reports.map((x) => x.worth)).toEqual([true, false]);
  });

  test('margin_hold takes today\'s LLM triage for that transcript', async () => {
    await setConfig(S7_ON);
    transport(() => 0.47);
    const t = routine();
    const out = await pass([t]);
    expect(judgeCalls).toBe(1);
    expect(out.reports[0]!.worth).toBe(true);
    expect((await engine.getDreamVerdict(t.filePath, t.contentHash))!.model).toBe(LLM_MODEL);
    expect(out.decide!.margin_hold).toBe(1);
    expect(new Set((await receipts()).map((x) => x.outcome))).toEqual(new Set(['margin_hold']));
  });

  const incomplete: Array<[string, Record<string, string>, Answer, string, number?]> = [
    ['5xx', {}, (w) => (w.includes('(3)') ? 'fail' : 0.01), 'provider_error'],
    ['429', {}, (w) => (w.includes('(3)') ? '429' : 0.01), 'rate_limited'],
    ['timeout', {}, (w) => (w.includes('(3)') ? 'hang' : 0.01), 'timeout', 300],
    ['budget exhausted', { 'decide.budget.daily_usd': '0' }, () => 0.01, 'budget_exhausted'],
    ['egress refused (private conversation)', { 'decide.egress.private': 'deny' }, () => 0.01, 'egress_private_denied'],
  ];
  for (const [name, extra, answer, reason, decisionMs] of incomplete) {
    test(`incomplete coverage (${name}) never caches a rejection and runs today's triage`, async () => {
      await setConfig({ ...S7_ON, ...extra });
      transport(answer);
      const t = routine();
      const out = await pass([t], {}, decisionMs ?? 5_000);
      expect(judgeCalls).toBe(1);
      const v = await engine.getDreamVerdict(t.filePath, t.contentHash);
      expect(v!.model).toBe(LLM_MODEL);
      expect(out.decide!.incomplete).toBe(1);
      const rows = await receipts();
      expect(rows.some((x) => x.error_reason === reason)).toBe(true);
      expect(rows.every((x) => x.outcome === 'error' || x.outcome === 'skipped')).toBe(true);
    });
  }

  test('model drift against the calibration takes today\'s triage', async () => {
    await setConfig({ ...S7_ON, 'decide.slots.triage.threshold': '' });
    await engine.executeRaw("DELETE FROM config WHERE key = 'decide.slots.triage.threshold'");
    await insertCalibration(engine, {
      slot: 'triage', call_site: 'dream', provider: 'typesafe:jev-1.13.0', model_resolved: 'jev-1.13.0', threshold: 0.5, min_keep: null,
      metric: 'f1', metric_value: 0.9, ece: 0.02, retest_sd: 0, repack_sd: 0, n: 100, dataset_hash: 'd', split_hash: 's',
      calibrate_ids_hash: 'c', calibrate_only: true, pack_shape: cycleSlotPackShape('triage'), notes: null,
    });
    transport(() => 0.01, 'jev-1.14.0');
    const t = routine();
    const out = await pass([t]);
    expect(judgeCalls).toBe(1);
    expect((await engine.getDreamVerdict(t.filePath, t.contentHash))!.model).toBe(LLM_MODEL);
    expect(out.decide!.incomplete).toBe(1);
    expect((await receipts()).some((x) => x.error_reason === 'model_drift')).toBe(true);
  });

  test('a qualified calibration (no force_on) acts; no LLM triage configured + incomplete → pass', async () => {
    const { ['decide.slots.triage.force_on']: _f, ['decide.slots.triage.threshold']: _t, ...rest } = S7_ON;
    await setConfig(rest);
    const id = await insertCalibration(engine, {
      slot: 'triage', call_site: 'dream', provider: 'typesafe:jev-1.13.0', model_resolved: 'jev-1.13.0', threshold: 0.5, min_keep: null,
      metric: 'f1', metric_value: 0.9, ece: 0.02, retest_sd: 0, repack_sd: 0, n: 100, dataset_hash: 'd', split_hash: 's',
      calibrate_ids_hash: 'c', calibrate_only: true, pack_shape: cycleSlotPackShape('triage'), notes: null,
    });
    await storeQualification(engine, id, {
      action_precision_lb: 0.95, qualification: '{}',
      policy_fingerprint: policyFingerprint({ slot: 'triage', callSite: 'dream', threshold: 0.5, marginFloor: 0.05, minKeep: 0, packShape: cycleSlotPackShape('triage') }),
    });
    transport(() => 0.01);
    const out = await pass([routine()]);
    expect(out.reports[0]!.worth).toBe(false);
    expect(out.decide!.reject).toBe(1);
    transport(() => 'fail');
    const t2 = transcript('other', turns(4));
    const noJudge = await pass([t2], { judge: null });
    expect(noJudge.reports[0]!.worth).toBe(true);
    expect(noJudge.reports[0]!.reasons[0]).toContain('incomplete');
  });
});

describe('S7 on a local llm: provider (vendor independence)', () => {
  test('llm:ollama runs the same windows through structured chat; the verdict is cached under the llm identity', async () => {
    await setConfig({ 'decide.slots.triage.provider': 'llm:ollama:qwen3:8b', 'decide.slots.triage.mode': 'on', 'decide.slots.triage.threshold': '0.5', 'decide.slots.triage.force_on': 'true' });
    const prompts: any[] = [];
    __setChatTransportForTests(async (opts) => {
      const req = JSON.parse(String(opts.messages?.[0]?.content ?? '{}'));
      prompts.push({ req, schema: Boolean((opts as { responseSchema?: unknown }).responseSchema), purpose: (opts as { purpose?: string }).purpose });
      const answers = Object.fromEntries(req.questions.map((q: any) => [q.id, q.type === 'choice'
        ? { type: 'choice', choice: 'strategy', confidence: 0.7, probabilities: { strategy: 0.7 } }
        : { type: 'noul', noul: String(q.inputs?.window ?? '').includes(SIGNAL) ? 0.8 : 0.1 }]));
      const text = JSON.stringify({ answers });
      return { text, blocks: [{ type: 'text', text }], stopReason: 'end', usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'ollama:qwen3:8b', providerId: 'ollama', responseModel: 'qwen3:8b-q4' } as never;
    });
    try {
      const b = buried();
      const out = await pass([b]);
      expect(judgeCalls).toBe(0);
      expect(out.reports[0]!.worth).toBe(true);
      const windowPrompts = prompts.filter((p) => p.req.questions[0].type === 'noul');
      expect(windowPrompts.every((p) => p.req.questions.length === 1 && p.schema && p.purpose === 'decide:triage')).toBe(true);
      const v = await engine.getDreamVerdict(b.filePath, b.contentHash);
      expect(v!.model!.startsWith('decide:llm:ollama:qwen3:8b@qwen3:8b-q4#')).toBe(true);
      const rows = await receipts();
      expect(rows.every((x) => x.provider === 'llm:ollama:qwen3:8b' && x.model_resolved === 'qwen3:8b-q4')).toBe(true);
    } finally {
      __setChatTransportForTests(null);
    }
  });
});

describe('S7 shadow and inactive on', () => {
  test('shadow: today\'s LLM verdict decides; receipts in shadow mode only', async () => {
    await setConfig({ ...S7_ON, 'decide.slots.triage.mode': 'shadow' });
    transport(() => 0.01);
    const t = routine();
    const out = await pass([t]);
    expect(judgeCalls).toBe(1);
    expect(out.reports[0]!.worth).toBe(true);
    expect((await engine.getDreamVerdict(t.filePath, t.contentHash))!.model).toBe(LLM_MODEL);
    const rows = await receipts();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((x) => x.mode === 'shadow' && x.outcome === 'reject')).toBe(true);
  });

  test('on without a calibration runs today\'s path and records the inactive cause', async () => {
    const { ['decide.slots.triage.threshold']: _t, ...rest } = S7_ON;
    // A pinned model with no shipped reference calibration (jev-1.13.0 has one).
    await setConfig({ ...rest, 'decide.provider': 'typesafe:jev-1.99.0' });
    transport(() => 0.9);
    const out = await pass([routine()]);
    expect(judgeCalls).toBe(1);
    expect(bodies).toHaveLength(0);
    expect(out.decide!.inactive).toBe('no_calibration');
    const rows = await receipts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'skipped', error_reason: 'no_calibration' });
  });
});
