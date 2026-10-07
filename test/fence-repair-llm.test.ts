/**
 * #6188 PR4: Tier 3 fence repair, the model call (src/core/fence-repair/llm.ts).
 *
 * Protects: the model sees only the fence header and the residual rows a
 * row-level issue names (never the valid rows, never the rest of the page),
 * no tools and no fallback model; every failure class is distinct
 * (llm_unavailable, llm_empty, llm_refused, llm_malformed, llm_truncated) and
 * a truncated answer is rejected even when it parses; a wrong row count is a
 * gate (e) failure; the corrective re-ask carries the model's own answer plus
 * the gate letter and row numbers only, and runs only after a structural
 * failure (gate (a) or (e)), never after gate (f); a HOLD answer is
 * `llm_declined` and consumes the attempt memo; a headerless fence of typed
 * rows gets the wide header; the output ceiling leaves a reasoning model room
 * to think and the estimate reserves the ceiling the gateway sends; the splice
 * rebuilds only the fence; the prompt bytes are pinned (a change must bump
 * FENCE_REPAIR_PROMPT_VERSION).
 * Fails when: valid rows or page prose leak into the prompt, a tool or a
 * fallback chain reaches the call, a refusal or truncation is treated as an
 * answer, the re-ask quotes anything beyond its own answer or follows a gate
 * (f) rejection, a decline is retried or written, or the budget starves a
 * reasoning model.
 * Why new: the Tier 3 module is new in PR4.
 * Seams: the gateway's chat transport seam (__setChatTransportForTests).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { __setChatTransportForTests, configureGateway, resetGateway, type ChatOpts, type ChatResult } from '../src/core/ai/gateway.ts';
import { dailyLedger, FENCE_REPAIR_LEDGER } from '../src/core/budget/daily-ledger.ts';
import { attemptStore } from '../src/core/fence-repair/attempts.ts';
import { buildTier3Prompt, callTier3, correctionMessage, extractSingleTable, FENCE_REPAIR_PROMPT_VERSION, spliceTier3, tier3Requests, tier3TokenBudget, TIER3_REASONING_TOKENS } from '../src/core/fence-repair/llm.ts';
import { pageSha, type FenceTarget } from '../src/core/fence-repair/repair-io.ts';
import { analyzeFences, runTier3, type FenceAnalysis } from '../src/core/fence-repair/repair-tiers.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { safeNormalizeFences } from '../src/core/fence-repair/normalize.ts';
import { validateFenceRepair } from '../src/core/fence-repair/validate.ts';

const FB = '<!--- gbrain:facts:begin -->', FBE = '<!--- gbrain:facts:end -->';
const FH = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|';
const NARROW = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |';
const SEP = '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|';
const VALID = 'Validrowclaimzq9 stays private';
const PROSE = 'Pageproseqz9 is never sent';
const BROKEN = 'Brokenrowclaimzq9 ships';
/** One valid row and one row missing its trailing cells (short_row, row-level). */
const rowLevel = `${PROSE}\n\n${FB}\n${FH}\n| 1 | ${VALID} | fact | 0.9 | private | high | 2026-01-01 |  | chat | ctx |\n| 2 | ${BROKEN} | fact | 0.8 | private | low | 2026-02-01 |\n${FBE}\n`;
/** A fence with rows but no header (no_header, fence-level). */
const noHeader = `${PROSE}\n\n${FB}\n| 1 | ${BROKEN} | fact | 0.9 | private | high | 2026-01-01 |  | chat | ctx |\n${FBE}\n`;

const result = (text: string, stopReason: ChatResult['stopReason'] = 'end'): ChatResult => ({ text, blocks: [], stopReason,
  usage: { input_tokens: 400, output_tokens: 80, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-opus-4-7', providerId: 'anthropic' });

function stub(answers: Array<ChatResult | Error>) {
  const calls: ChatOpts[] = [];
  __setChatTransportForTests(async opts => {
    calls.push(opts);
    const next = answers.shift()!;
    if (next instanceof Error) throw next;
    return next;
  });
  return calls;
}

function residualOf(text: string) {
  const page = { compiled_truth: text, timeline: '' };
  const normalized = safeNormalizeFences(page, { pageVisibility: 'private' });
  return { page, normalized, ...tier3Requests(normalized.page, normalized.residual, 'private') };
}

afterEach(() => __setChatTransportForTests(null));
afterAll(() => resetGateway());

describe('Tier 3 requests and prompt', () => {
  test('a row-level issue sends the header and that row only; a fence-level issue sends every row; page prose never', () => {
    const row = residualOf(rowLevel);
    expect(row.normalized.residual.map(i => i.reason)).toEqual(['short_row']);
    expect(row.requests).toHaveLength(1);
    const req = row.requests[0]!;
    expect(req.rows.map(r => r.occurrence)).toEqual([1]);
    const prompt = buildTier3Prompt(req);
    const all = `${prompt.system}\n${prompt.user}`;
    expect(all).toContain(BROKEN);
    expect(all).not.toContain(VALID);
    expect(all).not.toContain(PROSE);
    expect(prompt.user).toContain('short_row: row(s) 2');
    const fence = residualOf(noHeader);
    expect(fence.requests[0]!.header).toBeNull();
    expect(fence.requests[0]!.rows).toHaveLength(1);
    expect(buildTier3Prompt(fence.requests[0]!).user).not.toContain(PROSE);
  });

  test('prompt bytes are pinned; a prompt change must bump FENCE_REPAIR_PROMPT_VERSION', () => {
    const prompt = buildTier3Prompt(residualOf(noHeader).requests[0]!);
    const digest = createHash('sha256').update(`${prompt.system}\u0000${prompt.user}`).digest('hex');
    expect({ version: FENCE_REPAIR_PROMPT_VERSION, digest }).toEqual({ version: 2, digest: PROMPT_DIGEST });
    expect(prompt.system).toContain('return only the single word HOLD instead of a table');
  });

  test('a headerless fence of typed 14-cell rows is sent with the wide header', () => {
    const typed = `${FB}\n| 1 | Typedrowzq9 revenue | fact | 0.9 | private | high | 2026-05-01 |  | deck |  | revenue | 120k | USD | monthly |\n${FBE}\n`;
    const req = residualOf(typed).requests[0]!;
    expect(req.layout).toBe('wide');
    expect(buildTier3Prompt(req).system).toContain('| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context | claim_metric | claim_value | claim_unit | claim_period |');
    expect(residualOf(noHeader).requests[0]!.layout).toBe('narrow');
  });

  test('the output ceiling adds room to reason only where the call cannot turn reasoning off, and reserves what the gateway sends', () => {
    const req = residualOf(rowLevel).requests[0]!;
    const table = tier3TokenBudget(req, 'anthropic:claude-opus-4-7').maxOutputTokens;
    expect(tier3TokenBudget(req, 'anthropic:claude-fable-5-1').maxOutputTokens).toBe(table + TIER3_REASONING_TOKENS);
    expect(tier3TokenBudget(req, 'openai:gpt-6.1-sol').maxOutputTokens).toBe(table + TIER3_REASONING_TOKENS);
    expect(tier3TokenBudget(req, 'claude-cli:claude-fable-5-1').maxOutputTokens).toBe(32000);
  });

  test('a fence with a stray text line inside is not eligible (rebuilding the table would drop it)', () => {
    const stray = `${FB}\n| 1 | ${BROKEN} | fact | 0.9 | private | high | 2026-01-01 |  | chat | ctx |\na stray note\n${FBE}\n`;
    const out = residualOf(stray);
    expect(out.requests).toEqual([]);
    expect(out.ineligible.map(i => i.why)).toEqual(['stray_lines']);
  });
});

describe('extracting the answer', () => {
  const req = { kind: 'facts' as const, layout: 'narrow' as const };
  test('a single table (optionally in one code fence) is accepted; prose, a wrong header or nothing is not', () => {
    expect(extractSingleTable(`${NARROW}\n${SEP}\n| 1 | x | fact | 1 | private | high |  |  |  |  |`, req)).toMatchObject({ ok: true });
    expect(extractSingleTable('```markdown\n' + `${NARROW}\n${SEP}\n| 1 | x | fact | 1 | private | high |  |  |  |  |` + '\n```', req)).toMatchObject({ ok: true });
    expect(extractSingleTable(`Here is the table:\n${NARROW}\n${SEP}\n| 1 | x |`, req)).toEqual({ ok: false, reason: 'llm_malformed' });
    expect(extractSingleTable('| # | claim | type |\n|---|---|---|\n| 1 | x | fact |', req)).toEqual({ ok: false, reason: 'llm_malformed' });
    expect(extractSingleTable('   ', req)).toEqual({ ok: false, reason: 'llm_empty' });
    expect(extractSingleTable("I can't help rewrite that table.", req)).toEqual({ ok: false, reason: 'llm_refused' });
  });

  test('the single word HOLD (plain, bold or in a code fence) is a decline', () => {
    for (const text of ['HOLD', ' **HOLD** ', '```\nHOLD\n```', 'HOLD.']) expect(extractSingleTable(text, req)).toEqual({ ok: false, reason: 'llm_declined' });
    expect(extractSingleTable('HOLD: row 2 has two kinds', req)).toEqual({ ok: false, reason: 'llm_malformed' });
  });
});

describe('the gateway call', () => {
  const realigned = `${NARROW}\n${SEP}\n| 2 | ${BROKEN} | fact | 0.8 | private | low | 2026-02-01 |  |  |  |`;

  test('no tools, no fallback, the configured model; a realigned answer splices into a page that passes every gate', async () => {
    configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', chat_fallback_chain: ['openai:gpt-6-luna'] } as never);
    const calls = stub([result(realigned)]);
    const { page, normalized, requests } = residualOf(rowLevel);
    const answer = await callTier3(requests[0]!, { model: 'anthropic:claude-fable-5' });
    expect(answer.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.tools).toBeUndefined();
    expect(calls[0]!.allowFallback).toBe(false);
    expect(calls[0]!.model).toBe('anthropic:claude-fable-5');
    expect(calls[0]!.thinking).toBe('off');
    expect(calls[0]!.maxTokens).toBe(tier3TokenBudget(requests[0]!, 'anthropic:claude-fable-5').maxOutputTokens);
    const spliced = spliceTier3(normalized.page, requests[0]!, (answer as Extract<typeof answer, { ok: true }>).table)!;
    expect(spliced.compiled_truth.startsWith(`${PROSE}\n\n${FB}\n${NARROW}\n${SEP}\n| 1 | ${VALID} |`)).toBe(true);
    const final = safeNormalizeFences(spliced, { pageVisibility: 'private' });
    expect(final.residual).toEqual([]);
    expect(validateFenceRepair(page, final.page, { pageVisibility: 'private', tier: 'llm', issues: [...normalized.fixes, ...normalized.residual] })).toEqual({ ok: true });
  });

  test('each failure class is distinct; a truncated answer that parses is still rejected; a wrong row count is a gate (e) failure', async () => {
    const req = residualOf(rowLevel).requests[0]!;
    const cases: Array<[ChatResult | Error, string]> = [
      [Object.assign(new Error('rate limited'), { status: 429 }), 'llm_unavailable'],
      [result(''), 'llm_empty'],
      [result('', 'refusal'), 'llm_refused'],
      [result(realigned, 'content_filter'), 'llm_refused'],
      [result('Sure! I fixed it.'), 'llm_malformed'],
      [result(realigned, 'length'), 'llm_truncated'],
      [result('HOLD'), 'llm_declined'],
      [result(`${realigned}\n| 3 | Extra row | fact | 1 | private | high |  |  |  |  |`), 'row_count_changed'],
    ];
    for (const [answer, reason] of cases) expect(await reasonOf(req, answer)).toBe(reason);
  });

  test('the corrective re-ask repeats the model\'s own answer and names only the gate letter and rows', async () => {
    const req = residualOf(rowLevel).requests[0]!;
    const calls = stub([result(realigned)]);
    await callTier3(req, { model: 'anthropic:claude-opus-4-7', correction: { answer: 'PRIOR-ANSWER', gate: 'f', rows: [2] } });
    const messages = calls[0]!.messages;
    expect(messages.map(m => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(messages[1]!.content).toBe('PRIOR-ANSWER');
    expect(messages[2]!.content).toBe(correctionMessage('f', [2]));
    expect(String(messages[2]!.content)).toBe("Your table was rejected by validation gate (f) cell_changed at row(s) 2: a cell's text changed, or a valid cell moved out of its column. Return the corrected full table following every rule above, or HOLD if a row has more than one reasonable reading. Output only the table or HOLD.");
  });
});

describe('runTier3: the re-ask and the decline', () => {
  let engine: PGLiteEngine;
  let incarnation: string;
  const model = 'anthropic:claude-opus-4-7';
  const fixed = `${NARROW}\n${SEP}\n| 2 | ${BROKEN} | fact | 0.8 | private | low | 2026-02-01 |  |  |  |`;
  const cellChanged = `${NARROW}\n${SEP}\n| 2 | ${BROKEN} | fact | 0.8 | private | low | 2026-02-02 |  |  |  |`;
  const extraRow = `${fixed}\n| 3 | Inventedrowzq9 | fact | 1.0 | private | low |  |  |  |  |`;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    const [src] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");
    incarnation = src!.incarnation;
  });
  afterAll(async () => { await engine.disconnect(); });

  async function attempt(slug: string, answers: ChatResult[]) {
    const page = { compiled_truth: rowLevel, timeline: '' };
    const target: FenceTarget = { mode: 'db', sourceId: 'default', key: slug, slug, path: null, sourcePath: null, page, content: null, before: pageSha(page), snapshot: null, hold: null,
      ctx: { pageVisibility: 'private' } } as FenceTarget;
    const analysis = await analyzeFences(engine, target, { pageId: null });
    expect(analysis.status).toBe('llm');
    const calls = stub(answers);
    const out = await runTier3(target, analysis as Extract<FenceAnalysis, { status: 'llm' }>, incarnation, { ledger: dailyLedger(engine, FENCE_REPAIR_LEDGER), store: attemptStore(engine),
      model, capSource: 'default', perPageUsd: 1, perDayUsd: 10, timeoutMs: 30_000, now: () => new Date() });
    return { out, calls };
  }

  test('a gate (f) rejection is final: no re-ask, so the gates cannot steer the model to an allowed but wrong placement', async () => {
    const { out, calls } = await attempt('t3/cell', [result(cellChanged), result(fixed)]);
    expect(calls).toHaveLength(1);
    expect(out).toMatchObject({ ok: false, reason: 'cell_changed', gate: 'f' });
  });

  test('a structural failure (wrong row count, gate e) still earns one re-ask', async () => {
    const { out, calls } = await attempt('t3/rows', [result(extraRow), result(fixed)]);
    expect(calls).toHaveLength(2);
    expect(out.ok).toBe(true);
  });

  test('a headerless row whose claim an unescaped pipe cut in two is held before any model call', async () => {
    const page = { compiled_truth: `${FB}\n| 1 | Headerlesszq9 revenue grew | mostly from enterprise renewals, per the memo | fact | 0.9 | private | high | 2026-06-30 |  | memo |  |\n${FBE}\n`, timeline: '' };
    const target = { mode: 'db', sourceId: 'default', key: 't3/split', slug: 't3/split', path: null, sourcePath: null, page, content: null, before: pageSha(page), snapshot: null, hold: null,
      ctx: { pageVisibility: 'private' } } as FenceTarget;
    expect(await analyzeFences(engine, target, { pageId: null })).toMatchObject({ status: 'manual', reason: 'claim_split' });
  });

  test('HOLD is held as llm_declined and consumes the memo: the same bytes are never sent again', async () => {
    const first = await attempt('t3/hold', [result('HOLD')]);
    expect(first.calls).toHaveLength(1);
    expect(first.out).toMatchObject({ ok: false, reason: 'llm_declined' });
    const again = await attempt('t3/hold', [result(fixed)]);
    expect(again.calls).toHaveLength(0);
    expect(again.out).toMatchObject({ ok: false, reason: 'llm_declined', memoHit: true, spentUsd: 0 });
  });
});

async function reasonOf(req: Parameters<typeof callTier3>[0], answer: ChatResult | Error): Promise<string> {
  stub([answer]);
  const out = await callTier3(req, { model: 'anthropic:claude-opus-4-7' });
  return out.ok ? 'ok' : out.reason;
}

const PROMPT_DIGEST = '71cf09e5a19efc76b1c8b2b02d20074fcc3cfed172f43ba654de124d202dba3e';
