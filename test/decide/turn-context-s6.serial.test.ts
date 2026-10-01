/**
 * System One S6 recall_needed wired through the real turn-context call site
 * (assembleTurnContext, the handler `gbrain serve` registers for the hook's
 * turn_context IPC kind) on PGLite with a fixture TypeSafe transport.
 *
 * Protects: all-off output is byte-identical and sends nothing; on mode fires
 * one keyword-only search when the reflex surfaced nothing, suppresses a
 * non-identity reflex window below suppress_below, never suppresses an alias
 * or exact-title hit, holds inside the margin; every failure (timeout, 429,
 * 5xx, budget, drift, egress, malformed, inactive, late fire) leaves the
 * reflex result unchanged; shadow changes nothing; the S6 deadline keeps the
 * IPC server budget from nulling the block; receipts carry no prompt text.
 * Serial: mutates GBRAIN_HOME and the process-global gateway.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { configureGateway, resetGateway, __setDecideTransportForTests } from '../../src/core/ai/gateway.ts';
import { flushDecideWrites, insertCalibration, __resetDecideStoreForTests } from '../../src/core/ai/decide/store.ts';
import { drainShadow } from '../../src/core/ai/decide/runtime.ts';
import { packShape } from '../../src/core/ai/decide/pack.ts';
import { resetDecideSearchCache } from '../../src/core/search/decide-stage.ts';
import { assembleTurnContext, type TurnContextResult } from '../../src/core/context/turn-context.ts';
import { applyRecallNeeded, startRecallNeeded, RECALL_NEEDED_DEADLINE_MS } from '../../src/core/context/recall-needed.ts';
import {
  ensureIpcSecret, requestTurnContext, resolveSocketPath, startResolveIpcServer, TURN_CONTEXT_SERVER_BUDGET_MS, type TurnContextResponse,
} from '../../src/core/context/resolve-ipc.ts';
import type { WindowTurn } from '../../src/core/context/entity-salience.ts';
import { SLOT_SPECS } from '../../src/core/ai/decide/slots.ts';

let engine: PGLiteEngine;
let home: string;
let prevHome: string | undefined;

/** Reflex resolves nothing (lowercase, indirect reference). */
const INDIRECT = 'what did the kelp farming founder want before committing?';
/** Reflex fires on the surname arm (not an identity hit). */
const SURNAME = 'Any update from Glimmerton on the round?';
/** Reflex fires on the exact-title arm (identity hit). */
const EXACT = 'Mateo Glimmerton emailed again';
const PROMPT_WORDS = ['kelp', 'farming', 'founder', 'committing', 'Glimmerton', 'emailed'];

interface Transport { p: number; delayMs?: number; status?: number; model?: string; omit?: boolean }
let bodies: any[] = [];
function transport(t: Transport) {
  __setDecideTransportForTests(async (_url, init) => {
    bodies.push(JSON.parse(init.body as string));
    if (t.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, t.delayMs);
        init.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal!.reason); }, { once: true });
      });
    }
    if (t.status) return new Response('{"error":"x"}', { status: t.status });
    const body = JSON.parse(init.body as string);
    const answers = t.omit ? {} : Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: 'noul', noul: t.p }]));
    return new Response(JSON.stringify({ model: t.model ?? 'jev-1.13.0', answers, usage: { input_tokens: 120, output_tokens: 1 } }));
  });
}

const S6_ON: Record<string, string> = {
  'decide.provider': 'typesafe:jev-1.13.0', 'decide.slots.recall_needed.mode': 'on', 'decide.slots.recall_needed.threshold': '0.5',
  'decide.slots.recall_needed.force_on': 'true', 'decide.slots.recall_needed.suppress_below': '0.2',
  'decide.egress.typesafe.conversation': 'allow', 'decide.egress.private': 'allow',
};

async function setConfig(kv: Record<string, string>) {
  for (const [k, v] of Object.entries(kv)) await engine.setConfig(k, v);
  resetDecideSearchCache();
}

async function unsetConfig(key: string) {
  await engine.executeRaw('DELETE FROM config WHERE key = $1', [key]);
}

async function turn(text: string, window: WindowTurn[] = []): Promise<TurnContextResult> {
  return assembleTurnContext(engine, { sourceId: 'default', window: [...window, { role: 'user', text }], sessionId: 's6-test' });
}

async function receipts(): Promise<Array<Record<string, any>>> {
  await drainShadow(2000);
  await new Promise((r) => setTimeout(r, 30));
  await flushDecideWrites();
  return engine.executeRaw('SELECT * FROM decision_receipts ORDER BY id');
}

const baselines: Record<string, string> = {};

beforeAll(async () => {
  prevHome = process.env.GBRAIN_HOME;
  home = mkdtempSync(join(tmpdir(), 'gbrain-decide-s6-'));
  process.env.GBRAIN_HOME = home;
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await importFromContent(engine, 'people/mateo-glimmerton', '---\ntitle: Mateo Glimmerton\ntype: person\nsummary: Founder of Kelpforge.\n---\n\nMateo Glimmerton founded Kelpforge. He wants a technical co-founder intro before committing to the seed round.\n', { noEmbed: true });
  await importFromContent(engine, 'companies/kelpforge', '---\ntitle: Kelpforge\ntype: company\nsummary: Seed-stage kelp farming company.\n---\n\nKelpforge is a seed-stage kelp farming company founded by Mateo Glimmerton.\n', { noEmbed: true });
  await importFromContent(engine, 'notes/kelp-secret', '---\ntitle: Kelp secret\ntype: note\nvisibility: private\n---\n\nPrivate: the kelp farming founder wants a secret side deal before committing.\n', { noEmbed: true });
  configureGateway({ env: { TYPESAFE_API_KEY: 'sk-test-typesafe' } } as any);
  for (const text of [INDIRECT, SURNAME, EXACT]) baselines[text] = JSON.stringify(await turn(text));
}, 120_000);

afterAll(async () => {
  __setDecideTransportForTests(null);
  resetGateway();
  await engine.disconnect();
  if (prevHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

beforeEach(async () => {
  await engine.executeRaw(`DELETE FROM config WHERE key LIKE 'decide.%'`);
  await engine.executeRaw('DELETE FROM decision_receipts');
  await engine.executeRaw('DELETE FROM decide_spend');
  await engine.executeRaw('DELETE FROM decide_calibrations');
  resetDecideSearchCache();
  __resetDecideStoreForTests();
  bodies = [];
  __setDecideTransportForTests(null);
});

afterEach(() => __setDecideTransportForTests(null));

describe('baselines (reflex only)', () => {
  test('the slot is wired and harmful (on needs a qualified calibration or force_on)', () => {
    expect(SLOT_SPECS.recall_needed.wired).toBe(true);
    expect(SLOT_SPECS.recall_needed.harmful).toBe(true);
    expect(SLOT_SPECS.recall_needed.callSites).toEqual(['turn_context']);
  });

  test('the fixtures exercise a silent reflex, a surname hit and an exact-title hit', () => {
    expect(JSON.parse(baselines[INDIRECT]!).pointers).toEqual([]);
    expect(JSON.parse(baselines[SURNAME]!).pointers.map((p: any) => p.arm)).toEqual(['title-surname']);
    expect(JSON.parse(baselines[EXACT]!).pointers.map((p: any) => p.arm)).toEqual(['title']);
  });
});

describe('all slots off', () => {
  test('byte-identical with S6 off (and another slot on), nothing sent, no receipts', async () => {
    transport({ p: 0.99 });
    await setConfig({ ...S6_ON, 'decide.slots.recall_needed.mode': 'off', 'decide.slots.evidence.mode': 'on' });
    for (const text of [INDIRECT, SURNAME, EXACT]) expect(JSON.stringify(await turn(text))).toBe(baselines[text]!);
    expect(bodies).toHaveLength(0);
    expect(await receipts()).toHaveLength(0);
  });
});

describe('S6 on', () => {
  test('fires one keyword-only search when the reflex was silent; world pages only; receipt fire', async () => {
    transport({ p: 0.9 });
    await setConfig(S6_ON);
    const r = await turn(INDIRECT, [{ role: 'assistant', text: 'Happy to help.' }]);
    expect(r.pointers.length).toBeGreaterThan(0);
    expect(r.pointers.length).toBeLessThanOrEqual(3);
    expect(r.pointers.every((p) => p.arm === 'recall')).toBe(true);
    expect(r.pointers.map((p) => p.slug)).not.toContain('notes/kelp-secret');
    expect(r.pointers.map((p) => p.slug).some((s) => s === 'people/mateo-glimmerton' || s === 'companies/kelpforge')).toBe(true);
    expect(r.text).toContain(`→ \`${r.pointers[0]!.slug}\``);
    expect(r.decide?.recall_needed).toMatchObject({ mode: 'on', effective: 'on', model_resolved: 'jev-1.13.0', threshold: 0.5, outcomes: { fire: 1 } });
    expect(r.decide?.recall_needed.skipped).toBeUndefined();
    expect(bodies).toHaveLength(1);
    expect(Object.keys(bodies[0].state)).toEqual(['prompt', 'last_turn']);
    expect(bodies[0].state.prompt).toBe(INDIRECT);
    expect(Object.keys(bodies[0].questions)).toEqual(['recall_needed:0']);
    const rows = await receipts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ slot: 'recall_needed', mode: 'on', outcome: 'fire', call_site: 'turn_context', lane: 'hot', answer_value: 0.9, error_reason: null });
  });

  test('below threshold on a silent reflex: no_fire, block unchanged', async () => {
    transport({ p: 0.3 });
    await setConfig(S6_ON);
    const r = await turn(INDIRECT);
    const { decide, ...rest } = r;
    expect(JSON.stringify(rest)).toBe(baselines[INDIRECT]!);
    expect(decide?.recall_needed.outcomes).toEqual({ no_fire: 1 });
    expect((await receipts())[0]!.outcome).toBe('no_fire');
  });

  test('suppresses a non-identity reflex window below suppress_below', async () => {
    transport({ p: 0.01 });
    await setConfig(S6_ON);
    const r = await turn(SURNAME);
    expect(r.pointers).toEqual([]);
    expect(r.volunteered).toEqual([]);
    expect(r.text).toBe('');
    expect(r.decide?.recall_needed.outcomes).toEqual({ suppress: 1 });
    expect((await receipts())[0]).toMatchObject({ outcome: 'suppress', protected: false });
  });

  test('never suppresses an exact-title hit; receipt marks it protected', async () => {
    transport({ p: 0.01 });
    await setConfig(S6_ON);
    const { decide, ...rest } = await turn(EXACT);
    expect(JSON.stringify(rest)).toBe(baselines[EXACT]!);
    expect(decide?.recall_needed.outcomes).toEqual({ no_fire: 1 });
    expect((await receipts())[0]).toMatchObject({ outcome: 'no_fire', protected: true });
  });

  test('inside the margin below suppress_below: margin_hold, block unchanged', async () => {
    transport({ p: 0.17 });
    await setConfig(S6_ON);
    const { decide, ...rest } = await turn(SURNAME);
    expect(JSON.stringify(rest)).toBe(baselines[SURNAME]!);
    expect(decide?.recall_needed.outcomes).toEqual({ margin_hold: 1 });
    expect((await receipts())[0]!.outcome).toBe('margin_hold');
  });

  test('receipts carry hashes only, never prompt text', async () => {
    await setConfig(S6_ON);
    transport({ p: 0.9 });
    await turn(INDIRECT, [{ role: 'assistant', text: 'Glimmerton emailed earlier' }]);
    transport({ p: 0.01 });
    await turn(SURNAME);
    const rows = await receipts();
    expect(rows).toHaveLength(2);
    const dump = JSON.stringify(rows).toLowerCase();
    for (const w of PROMPT_WORDS) expect(dump).not.toContain(w.toLowerCase());
    for (const r of rows) {
      expect(r.state_hash).toMatch(/^[0-9a-f]{32,}$/);
      expect(r.subject_ref).toMatch(/^[0-9a-f]{32,}$/);
    }
  });
});

describe('fail directions: the reflex result stands', () => {
  const cases: Array<{ name: string; t?: Transport; config?: Record<string, string>; reason: string; outcome: string; sends: boolean }> = [
    { name: 'timeout', t: { p: 0.01, delayMs: 2000 }, reason: 'timeout', outcome: 'error', sends: true },
    { name: '429', t: { p: 0.01, status: 429 }, reason: 'rate_limited', outcome: 'error', sends: true },
    { name: '5xx', t: { p: 0.01, status: 503 }, reason: 'provider_error', outcome: 'error', sends: true },
    { name: 'malformed', t: { p: 0.01, omit: true }, reason: 'malformed_response', outcome: 'error', sends: true },
    { name: 'budget', t: { p: 0.01 }, config: { 'decide.budget.daily_usd': '0' }, reason: 'budget_exhausted', outcome: 'error', sends: false },
    { name: 'egress (private conversation text denied)', t: { p: 0.01 }, config: { 'decide.egress.private': 'deny' }, reason: 'egress_private_denied', outcome: 'skipped', sends: false },
    { name: 'egress (no conversation consent)', t: { p: 0.01 }, config: { 'decide.egress.typesafe.conversation': 'deny' }, reason: 'egress_class_denied', outcome: 'skipped', sends: false },
  ];
  for (const c of cases) {
    test(c.name, async () => {
      transport(c.t!);
      await setConfig({ ...S6_ON, ...(c.config ?? {}) });
      for (const text of [SURNAME, INDIRECT]) {
        const t0 = Date.now();
        const { decide, ...rest } = await turn(text);
        const elapsed = Date.now() - t0;
        expect(JSON.stringify(rest)).toBe(baselines[text]!);
        expect(decide?.recall_needed).toMatchObject({ mode: 'on', effective: 'off', skipped: c.reason });
        expect(elapsed).toBeLessThan(RECALL_NEEDED_DEADLINE_MS + 150);
      }
      expect(bodies.length > 0).toBe(c.sends);
      const rows = await receipts();
      expect(rows.map((r) => [r.outcome, r.error_reason])).toEqual([[c.outcome, c.reason], [c.outcome, c.reason]]);
    });
  }

  test('model drift against the calibration: skipped model_drift', async () => {
    await insertCalibration(engine, {
      slot: 'recall_needed', call_site: 'turn_context', provider: 'typesafe:jev-1.13.0', model_resolved: 'jev-1.13.0', threshold: 0.5, min_keep: null,
      metric: 'f1', metric_value: 0.9, ece: 0.02, retest_sd: 0, repack_sd: 0, n: 100, dataset_hash: 'd', split_hash: 's',
      calibrate_ids_hash: 'c', calibrate_only: true, pack_shape: packShape('recall_needed'), notes: null,
    });
    const { 'decide.slots.recall_needed.threshold': _, ...noOverride } = S6_ON;
    await setConfig(noOverride);
    transport({ p: 0.01, model: 'jev-1.14.0' });
    const { decide, ...rest } = await turn(SURNAME);
    expect(JSON.stringify(rest)).toBe(baselines[SURNAME]!);
    expect(decide?.recall_needed).toMatchObject({ effective: 'off', skipped: 'model_drift', model_resolved: 'jev-1.14.0' });
    expect((await receipts())[0]).toMatchObject({ outcome: 'skipped', error_reason: 'model_drift' });
  });

  test('on without a calibration or override: inactive no_calibration, nothing sent', async () => {
    transport({ p: 0.01 });
    const { 'decide.slots.recall_needed.threshold': _, ...noOverride } = S6_ON;
    await setConfig(noOverride);
    const { decide, ...rest } = await turn(SURNAME);
    expect(JSON.stringify(rest)).toBe(baselines[SURNAME]!);
    expect(decide?.recall_needed).toEqual({ mode: 'on', effective: 'off', provider: 'typesafe:jev-1.13.0', skipped: 'no_calibration' });
    expect(bodies).toHaveLength(0);
    expect((await receipts())[0]).toMatchObject({ outcome: 'skipped', error_reason: 'no_calibration' });
  });

  test('a fire decided with under 150 ms of the server budget left does not search: outcome fire, reason late', async () => {
    transport({ p: 0.9 });
    await setConfig(S6_ON);
    const window: WindowTurn[] = [{ role: 'user', text: INDIRECT }];
    const pending = startRecallNeeded(engine, { sourceId: 'default', window, sessionId: 's6-test', startedAt: Date.now() });
    await (await pending)!.call;
    const applied = await applyRecallNeeded(engine, pending, { startedAt: Date.now() - 300, prompt: INDIRECT, pointers: [], volunteered: [] });
    expect(applied?.window).toBeUndefined();
    expect(applied?.meta).toMatchObject({ effective: 'on', outcomes: { fire: 1 }, skipped: 'late' });
    expect((await receipts())[0]).toMatchObject({ outcome: 'fire', error_reason: 'late' });
  });
});

describe('shadow (advanced diagnostics)', () => {
  test('async shadow changes nothing and adds no meta; the receipt records the would-be outcome', async () => {
    transport({ p: 0.01 });
    await setConfig({ ...S6_ON, 'decide.slots.recall_needed.mode': 'shadow' });
    expect(JSON.stringify(await turn(SURNAME))).toBe(baselines[SURNAME]!);
    expect((await receipts())[0]).toMatchObject({ mode: 'shadow', outcome: 'suppress' });
  });

  test('shadow_wait adds the diagnostics line and still changes nothing', async () => {
    transport({ p: 0.9 });
    await setConfig({ ...S6_ON, 'decide.slots.recall_needed.mode': 'shadow', 'decide.slots.recall_needed.shadow_wait': 'on' });
    const { decide, ...rest } = await turn(INDIRECT);
    expect(JSON.stringify(rest)).toBe(baselines[INDIRECT]!);
    expect(decide?.recall_needed).toMatchObject({ mode: 'shadow', effective: 'shadow', outcomes: { fire: 1 } });
  });
});

describe('through the IPC server (the serve handler shape the hook talks to)', () => {
  const dirs: string[] = [];
  const servers: Array<{ close: () => void }> = [];
  afterAll(() => {
    for (const s of servers) s.close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  async function serve(): Promise<{ sock: string; secret: string }> {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-s6-ipc-'));
    dirs.push(dir);
    const secret = ensureIpcSecret(dir);
    const sock = resolveSocketPath(dir);
    const server = await startResolveIpcServer(sock, {
      resolve: async () => null,
      turn_context: (req) => assembleTurnContext(engine, { sourceId: 'default', window: req.window ?? [], priorContextText: req.priorContextText, sessionId: req.sessionId, maxBytes: req.maxBytes }),
    }, { secret, boundSourceId: 'default' });
    servers.push(server!);
    return { sock, secret };
  }

  test('a provider slower than the server budget never nulls the reflex block', async () => {
    transport({ p: 0.01, delayMs: 5000 });
    await setConfig(S6_ON);
    const { sock, secret } = await serve();
    const t0 = Date.now();
    const res = await requestTurnContext(sock, { secret, window: [{ role: 'user', text: SURNAME }], sessionId: 's6-ipc' }) as TurnContextResponse;
    expect(Date.now() - t0).toBeLessThan(TURN_CONTEXT_SERVER_BUDGET_MS);
    expect(res.ok).toBe(true);
    expect(res.degradedReason).toBeUndefined();
    expect(res.block?.pointers.map((p) => p.slug)).toEqual(['people/mateo-glimmerton']);
    expect(res.block?.decide?.recall_needed.skipped).toBe('timeout');
  });

  test('a fired retrieval reaches the hook response', async () => {
    transport({ p: 0.9, delayMs: 60 });
    await setConfig(S6_ON);
    const { sock, secret } = await serve();
    const res = await requestTurnContext(sock, { secret, window: [{ role: 'user', text: INDIRECT }], sessionId: 's6-ipc' }) as TurnContextResponse;
    expect(res.ok).toBe(true);
    expect(res.block?.pointers.length).toBeGreaterThan(0);
    expect(res.block?.pointers.every((p) => p.arm === 'recall')).toBe(true);
    expect(res.block?.text).toContain('## Brain pages mentioned this turn');
  });
});
