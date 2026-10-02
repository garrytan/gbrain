/**
 * System One S8 (claim support) — pure decision logic plus the real call
 * site (verifyAndRepairDreamPages on PGLite) with a fixture decide transport.
 * The managed postprocess site is covered by grounding-postprocess.serial.test.ts.
 *
 * Protects: verifyBody's new `groundingUnits` output lists only passing units
 * with no quote, number or attribution (existing fields unchanged); up to
 * three source windows (substring, keyword, embedding); weak coverage records
 * insufficient_context and keeps the unit; a low answer with adequate
 * coverage quarantines as `unsupported_paraphrase` before the page is written;
 * S8 never sees (so never admits) a mechanically rejected unit; timeout, 429,
 * 5xx, budget, egress refusal and drift keep today's result; shadow changes
 * nothing; receipts carry hashes only.
 * Serial: mutates the process-global gateway and decide transport.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { configureGateway, resetGateway, __setDecideTransportForTests } from '../../src/core/ai/gateway.ts';
import { flushDecideWrites, __resetDecideStoreForTests, insertCalibration } from '../../src/core/ai/decide/store.ts';
import { groundSource, verifyBody, verifyAndRepairDreamPages, readVerifyEpoch, quarantineUnits, verifyDreamPage, emptyQuoteVerifyStats } from '../../src/core/cycle/synthesize-verify.ts';
import {
  selectSourceWindows, indexSourceWindows, reduceGrounding, whatIfGrounding, resolveGroundingDecide, GROUNDING_MAX_WINDOWS,
} from '../../src/core/cycle/grounding-decide.ts';
import { cycleSlotPackShape } from '../../src/core/cycle/decide-slot.ts';

const TRANSCRIPT = [
  'User: we charge for durability because reliable memories should survive every tool.',
  'Assistant: Discuss the long term roadmap for the storage tier.',
  'User: The storage tier should stay boring and cheap, nothing fancy there.',
  'Assistant: Understood, boring storage.',
].join('\n');

const SUPPORTED = 'Reliable memories should survive every tool change on the roadmap.';
const UNSUPPORTED = 'Reliable memories should never survive a tool change on the roadmap.';
const WEAK = 'Quarterly offsites happen in coastal towns with volleyball tournaments.';
const FABRICATED = 'Allegedly: "we will rewrite everything in a single weekend sprint soon".';

// ── pure logic ─────────────────────────────────────────────────────────

describe('S8 grounding units from verifyBody', () => {
  const src = [groundSource('/t/s.md', TRANSCRIPT)];

  test('only passing units without quote, number or attribution; headings and fragments excluded', () => {
    const body = [
      '## Storage strategy notes', '', SUPPORTED, 'Short fragment here.',
      'The user said "reliable memories should survive every tool".', 'The team budgets 250 servers for storage next year.',
      'Assistant recommended boring storage for the whole tier.', FABRICATED, WEAK,
    ].join('\n');
    const r = verifyBody(body, src);
    expect(r.groundingUnits).toEqual([SUPPORTED, WEAK]);
    expect(r.quarantined.map((q) => q.reason)).toEqual(['quote_not_in_source']);
  });

  test('existing verifyBody fields are unchanged by the new output', () => {
    const body = `${SUPPORTED}\n${FABRICATED}`;
    const r = verifyBody(body, src);
    const { groundingUnits, ...rest } = r;
    expect(groundingUnits).toEqual([SUPPORTED]);
    expect(Object.keys(rest).sort()).toEqual(['body', 'changed', 'exact', 'failures', 'near', 'normalized', 'provenance', 'quarantined', 'quotes', 'unbalanced']);
    expect(rest.body).toBe(SUPPORTED);
  });
});

describe('S8 source windows, reducer and what-if', () => {
  test('substring, keyword and embedding neighbours, at most three; weak coverage without overlap', () => {
    const index = indexSourceWindows([{ path: '/t/a.md', content: TRANSCRIPT }, { path: '/t/b.md', content: 'User: unrelated chatter about lunch.\nAssistant: tacos.' }]);
    const sel = selectSourceWindows(SUPPORTED, index);
    expect(sel.coverage).toBe('adequate');
    expect(sel.windows.length).toBeLessThanOrEqual(GROUNDING_MAX_WINDOWS);
    expect(sel.windows[0]!.text).toContain('reliable memories should survive every tool');
    expect(selectSourceWindows(WEAK, index).coverage).toBe('weak');
    // Embedding neighbour: the nearest vector is added even without keyword overlap.
    index.forEach((w, i) => { w.embedding = new Float32Array([i === index.length - 1 ? 1 : 0, 1]); });
    const withEmb = selectSourceWindows(WEAK, index, new Float32Array([1, 0]));
    expect(withEmb.windows.map((w) => w.via)).toContain('embedding');
    expect(withEmb.coverage).toBe('weak');
  });

  test('reducer: pass, margin_hold, insufficient_context on weak coverage, quarantine otherwise', () => {
    const p = { threshold: 0.5, margin: 0.05 };
    expect(reduceGrounding(0.8, 'adequate', p)).toBe('pass');
    expect(reduceGrounding(0.47, 'adequate', p)).toBe('margin_hold');
    expect(reduceGrounding(0.1, 'weak', p)).toBe('insufficient_context');
    expect(reduceGrounding(0.1, 'adequate', p)).toBe('quarantine');
    expect(reduceGrounding(null, 'adequate', p)).toBeNull();
    expect(whatIfGrounding([{ answer_value: 0.1, protected: false }, { answer_value: 0.1, protected: true }, { answer_value: 0.9, protected: false }], 0.5, 0.05))
      .toEqual({ pass: 1, quarantine: 1, insufficient_context: 1, margin_hold: 0 });
  });

  test('quarantineUnits removes only present units and records unsupported_paraphrase', () => {
    const page = verifyDreamPage({ compiled_truth: `${SUPPORTED}\n\n${UNSUPPORTED}`, timeline: '', frontmatter: {} }, [groundSource('/t/s.md', TRANSCRIPT)], { prior: null, checkedAt: '2026-09-30' }, emptyQuoteVerifyStats());
    expect(page.groundingUnits.map((u) => u.text)).toEqual([SUPPORTED, UNSUPPORTED]);
    const out = quarantineUnits(page, [
      { body: 'compiled_truth', text: UNSUPPORTED, reason: 'unsupported_paraphrase', detail: 'low' },
      { body: 'compiled_truth', text: 'not on the page at all, so nothing happens here', reason: 'unsupported_paraphrase', detail: 'x' },
    ], ['/t/s.md'], '2026-09-30');
    expect(out.compiled_truth).toBe(SUPPORTED);
    expect(out.changed).toBe(true);
    expect(out.frontmatter.unverified_claims).toEqual([expect.objectContaining({ text: UNSUPPORTED, reason: 'unsupported_paraphrase', sources: ['/t/s.md'] })]);
  });
});

// ── real call site: verifyAndRepairDreamPages on PGLite ─────────────────

let engine: PGLiteEngine;
let questions: string[] = [];
type Answer = (claim: string) => number | 'fail' | '429' | 'hang';
function transport(answer: Answer, model = 'jev-1.13.0') {
  __setDecideTransportForTests(async (_url, init) => {
    const body = JSON.parse(init.body as string);
    const answers: Record<string, unknown> = {};
    for (const [id, q] of Object.entries<any>(body.questions)) {
      questions.push(q.instructions.claim);
      const a = answer(q.instructions.claim);
      if (a === 'fail') return new Response('boom', { status: 502 });
      if (a === '429') return new Response('slow', { status: 429 });
      if (a === 'hang') await new Promise((_, rej) => init.signal?.addEventListener('abort', () => rej(init.signal!.reason)));
      answers[id] = { type: 'noul', noul: a };
    }
    return new Response(JSON.stringify({ model, answers, usage: { input_tokens: 200, output_tokens: 3 } }));
  });
}
const byClaim: Answer = (c) => (c.includes('never') ? 0.05 : c.includes('volleyball') ? 0.05 : 0.93);

const S8_ON: Record<string, string> = {
  'decide.provider': 'typesafe:jev-1.13.0', 'decide.slots.grounding.mode': 'on', 'decide.slots.grounding.threshold': '0.5',
  'decide.slots.grounding.force_on': 'true', 'decide.egress.private': 'allow', 'decide.egress.typesafe.conversation': 'allow',
};

let n = 0;
async function runPage(pageMs = 5_000): Promise<{ slug: string; body: string; fm: Record<string, unknown>; stats: Awaited<ReturnType<typeof resolveGroundingDecide>> }> {
  const since = await readVerifyEpoch(engine);
  await new Promise((r) => setTimeout(r, 5));
  const slug = `wiki/personal/reflections/grounding-${++n}-abc123`;
  await importFromContent(engine, slug, ['---', 'type: note', '---', SUPPORTED, '', UNSUPPORTED, '', WEAK, '', FABRICATED].join('\n'), { noEmbed: true, remote: false, sourceId: 'default' });
  const grounding = await resolveGroundingDecide(engine, { pageMs });
  await verifyAndRepairDreamPages(engine, [{ slug, source_id: 'default', raw_source: '/t/session.md' }], new Map([['/t/session.md', { content: TRANSCRIPT }]]),
    { since, checkedAt: '2026-09-30', grounding });
  const page = (await engine.getPage(slug, { sourceId: 'default' }))!;
  return { slug, body: page.compiled_truth, fm: page.frontmatter, stats: grounding };
}

async function receipts(): Promise<Array<Record<string, unknown>>> {
  await new Promise((r) => setTimeout(r, 30));
  await flushDecideWrites();
  return engine.executeRaw("SELECT * FROM decision_receipts WHERE slot = 'grounding' ORDER BY id");
}

const reasonsOf = (fm: Record<string, unknown>) => ((fm.unverified_claims ?? []) as Array<{ reason: string }>).map((r) => r.reason).sort();

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
  for (const table of ['decision_receipts', 'decide_spend', 'decide_calibrations']) await engine.executeRaw(`DELETE FROM ${table}`);
  __resetDecideStoreForTests();
  __setDecideTransportForTests(null);
  questions = [];
});

describe('S8 off', () => {
  test('no decide keys: nothing resolves and the mechanical result is unchanged', async () => {
    expect(await resolveGroundingDecide(engine)).toBeUndefined();
    transport(byClaim);
    const r = await runPage();
    expect(questions).toHaveLength(0);
    expect(r.body).toBe([SUPPORTED, UNSUPPORTED, WEAK].join('\n\n'));
    expect(reasonsOf(r.fm)).toEqual(['quote_not_in_source']);
  });
});

describe('S8 on at verifyAndRepairDreamPages', () => {
  test('quarantines an unsupported paraphrase before write-back; weak coverage is insufficient_context; the fabricated unit is never asked', async () => {
    await engine.executeRaw('SELECT 1');
    for (const [k, v] of Object.entries(S8_ON)) await engine.setConfig(k, v);
    transport(byClaim);
    const r = await runPage();
    expect(questions.sort()).toEqual([SUPPORTED, UNSUPPORTED, WEAK].sort());
    expect(questions.join(' ')).not.toContain('weekend sprint');
    expect(r.body).toBe([SUPPORTED, WEAK].join('\n\n'));
    expect(reasonsOf(r.fm)).toEqual(['quote_not_in_source', 'unsupported_paraphrase']);
    expect(r.stats!.stats).toMatchObject({ pages: 1, units: 3, pass: 1, quarantine: 1, insufficient_context: 1, kept_on_error: 0 });
    // Quarantined text has no chunks.
    const hits = await engine.searchKeyword('never survive tool change', { limit: 5 });
    expect(hits.filter((h) => h.slug === r.slug)).toHaveLength(0);
    const rows = await receipts();
    expect(rows.map((x) => x.outcome).sort()).toEqual(['insufficient_context', 'pass', 'quarantine']);
    expect(rows.find((x) => x.outcome === 'insufficient_context')!.protected).toBe(true);
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain('Reliable memories');
    expect(dump).not.toContain('reflections/grounding');
  });

  const keeps: Array<[string, Record<string, string>, Answer, string, number?]> = [
    ['timeout', {}, () => 'hang', 'timeout', 300],
    ['429', {}, () => '429', 'rate_limited'],
    ['5xx', {}, () => 'fail', 'provider_error'],
    ['budget exhausted', { 'decide.budget.daily_usd': '0' }, byClaim, 'budget_exhausted'],
    ['egress refused', { 'decide.egress.private': 'deny' }, byClaim, 'egress_private_denied'],
  ];
  for (const [name, extra, answer, reason, pageMs] of keeps) {
    test(`${name} keeps the mechanical result`, async () => {
      for (const [k, v] of Object.entries({ ...S8_ON, ...extra })) await engine.setConfig(k, v);
      transport(answer);
      const r = await runPage(pageMs ?? 5_000);
      expect(r.body).toBe([SUPPORTED, UNSUPPORTED, WEAK].join('\n\n'));
      expect(reasonsOf(r.fm)).toEqual(['quote_not_in_source']);
      const rows = await receipts();
      expect(rows.length).toBe(3);
      expect(rows.every((x) => x.error_reason === reason)).toBe(true);
    });
  }

  test('model drift against the calibration keeps the mechanical result', async () => {
    const { ['decide.slots.grounding.threshold']: _t, ...rest } = S8_ON;
    for (const [k, v] of Object.entries(rest)) await engine.setConfig(k, v);
    await insertCalibration(engine, {
      slot: 'grounding', call_site: 'dream', provider: 'typesafe:jev-1.13.0', model_resolved: 'jev-1.13.0', threshold: 0.5, min_keep: null,
      metric: 'f1', metric_value: 0.9, ece: 0.02, retest_sd: 0, repack_sd: 0, n: 100, dataset_hash: 'd', split_hash: 's',
      calibrate_ids_hash: 'c', calibrate_only: true, pack_shape: cycleSlotPackShape('grounding'), notes: null,
    });
    transport(byClaim, 'jev-1.14.0');
    const r = await runPage();
    expect(r.body).toBe([SUPPORTED, UNSUPPORTED, WEAK].join('\n\n'));
    expect((await receipts()).every((x) => x.error_reason === 'model_drift')).toBe(true);
  });

  test('shadow records receipts and changes nothing', async () => {
    for (const [k, v] of Object.entries({ ...S8_ON, 'decide.slots.grounding.mode': 'shadow' })) await engine.setConfig(k, v);
    transport(byClaim);
    const r = await runPage();
    expect(r.body).toBe([SUPPORTED, UNSUPPORTED, WEAK].join('\n\n'));
    const rows = await receipts();
    expect(rows.every((x) => x.mode === 'shadow')).toBe(true);
    expect(rows.map((x) => x.outcome).sort()).toEqual(['insufficient_context', 'pass', 'quarantine']);
  });
});
