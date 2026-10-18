/**
 * #5461 (wave 15 P7.4): the think / synthesize pages-block budget becomes
 * configuration (`think.pages_budget_chars`, `think.excerpt_ceiling_chars`),
 * a truncated evidence block is reported (`evidence_truncated`), and the
 * synthesize verb adds source-qualified `citations[]` next to the frozen
 * `sources[]`.
 *
 * The budget is SOFT: the 600-character floor can push the total over the
 * budget, and the excerpt ceiling still cuts a long page when only the total
 * is raised. The assertions below pin that documented contract, not a hard
 * bound.
 *
 * Protects: what the model is shown and what the caller is told about it.
 * Fails when: the keys are ignored (default sizes with the key set), when a
 * cut block reports `evidence_truncated: false`, or when citations lose
 * their source. Why new: `test/think-pages-block.test.ts` covers the fixed
 * default sizing only. Seam: the existing stub client / chat transport.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { runThink, type ThinkLLMClient } from '../src/core/think/index.ts';
import { pagesBlockExcerptLen, EXCERPT_CUT_END_MARKER, EXCERPT_CUT_START_MARKER } from '../src/core/think/gather.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __setChatTransportForTests } from '../src/core/ai/gateway.ts';
import { withEnv } from './helpers/with-env.ts';
import { runConfig } from '../src/commands/config.ts';
import { KNOWN_CONFIG_KEYS } from '../src/core/config.ts';

const PAGES_BUDGET_KEY = 'think.pages_budget_chars';
const EXCERPT_CEILING_KEY = 'think.excerpt_ceiling_chars';
const PAGE_COUNT = 20;
const PAGE_CHARS = 10_000;

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (let i = 0; i < PAGE_COUNT; i++) {
    const body = `Quarterly roadmap review ${i}. ${'Roadmap review notes and decisions for the platform team. '.repeat(Math.ceil(PAGE_CHARS / 58))}`.slice(0, PAGE_CHARS);
    const imported = await importFromContent(engine, `notes/roadmap-review-${i}`,
      `---\ntitle: Roadmap review ${i}\ntype: note\n---\n\n${body}\n`, { noEmbed: true, sourceId: 'default' });
    if (imported.status !== 'imported') throw new Error(`fixture import failed: ${imported.status}`);
  }
}, 120_000);
afterAll(async () => { await engine.disconnect(); });
afterEach(async () => {
  __setChatTransportForTests(null);
  await engine.unsetConfig(PAGES_BUDGET_KEY);
  await engine.unsetConfig(EXCERPT_CEILING_KEY);
});

const QUESTION = 'What did the quarterly roadmap review decide for the platform team?';

function stubClient(capture: { prompt: string }, response: Record<string, unknown>): ThinkLLMClient {
  return {
    create: async (params: { messages?: Array<{ content: unknown }> }) => {
      const user = params.messages?.[0]?.content;
      capture.prompt = typeof user === 'string' ? user : JSON.stringify(user);
      return {
        id: 'msg_budget', type: 'message', role: 'assistant', model: 'stub', stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, service_tier: null },
        content: [{ type: 'text', text: JSON.stringify(response) }],
      } as never;
    },
  } as unknown as ThinkLLMClient;
}

function pagesBlockOf(prompt: string): string {
  const start = prompt.indexOf('<pages>');
  const end = prompt.indexOf('</pages>');
  if (start < 0 || end < 0) throw new Error('prompt carried no <pages> block');
  return prompt.slice(start, end);
}

describe('pagesBlockExcerptLen with a configurable budget (#5461)', () => {
  test('defaults are unchanged: 18 pages → 666 chars each, 40 pages → the 600 floor (soft total)', () => {
    expect(pagesBlockExcerptLen(18)).toBe(666);
    expect(pagesBlockExcerptLen(40)).toBe(600);
    expect(40 * pagesBlockExcerptLen(40)).toBeGreaterThan(12_000);
  });

  test('a bigger total alone is still capped per page by the excerpt ceiling', () => {
    expect(pagesBlockExcerptLen(18, 600, { totalChars: 60_000, ceilingChars: 2_400 })).toBe(2_400);
    expect(pagesBlockExcerptLen(18, 600, { totalChars: 60_000, ceilingChars: 60_000 })).toBe(3_333);
  });
});

describe('runThink honors think.pages_budget_chars / think.excerpt_ceiling_chars and reports truncation (#5461)', () => {
  test('default budget: 20 pages of 10 000 chars are cut and evidence_truncated is true', async () => {
    const capture = { prompt: '' };
    const result = await runThink(engine, { question: QUESTION, client: stubClient(capture, { answer: 'cut', citations: [], gaps: [] }), withTrajectory: false });
    // Hybrid keyword retrieval returns most, not necessarily all, of the fixture pages.
    const gathered = result.pagesGathered;
    expect(gathered).toBeGreaterThanOrEqual(12);
    expect(result.evidence_truncated).toBe(true);
    const block = pagesBlockOf(capture.prompt);
    expect(block).toContain(EXCERPT_CUT_END_MARKER);
    expect(block.length).toBeLessThan(gathered * 1_100);
  });

  test('budget 60 000 over 200 000 chars of pages: more evidence, still truncated by the 2 400 ceiling', async () => {
    await engine.setConfig(PAGES_BUDGET_KEY, '60000');
    const capture = { prompt: '' };
    const result = await runThink(engine, { question: QUESTION, client: stubClient(capture, { answer: 'cut', citations: [], gaps: [] }), withTrajectory: false });
    expect(result.evidence_truncated).toBe(true);
    const block = pagesBlockOf(capture.prompt);
    expect(block.length).toBeGreaterThan(result.pagesGathered * 2_000);
    expect(block.length).toBeLessThan(result.pagesGathered * 3_000);
    expect(result.warnings.some(w => w.startsWith('THINK_BUDGET_CONFIG_IGNORED'))).toBe(false);
  });

  // The gather hands think one chunk per page (chunk_text first), so a raised
  // ceiling shows each gathered chunk whole, not the 10 000-char page: [R38]
  // full pages are not promised while an excerpt ceiling exists.
  test('budget and ceiling both raised: whole gathered chunks, evidence_truncated false, no cut markers', async () => {
    await engine.setConfig(PAGES_BUDGET_KEY, '200000');
    await engine.setConfig(EXCERPT_CEILING_KEY, '200000');
    const capture = { prompt: '' };
    const result = await runThink(engine, { question: QUESTION, client: stubClient(capture, { answer: 'whole', citations: [], gaps: [] }), withTrajectory: false });
    expect(result.evidence_truncated).toBe(false);
    const block = pagesBlockOf(capture.prompt);
    expect(block).not.toContain(EXCERPT_CUT_START_MARKER);
    expect(block).not.toContain(EXCERPT_CUT_END_MARKER);
    expect(block.length).toBeGreaterThan(result.pagesGathered * 2_400);
  });

  test('an out-of-range or non-integer value is ignored with a warning and the default applies', async () => {
    await engine.setConfig(PAGES_BUDGET_KEY, '999999');
    await engine.setConfig(EXCERPT_CEILING_KEY, 'large');
    const capture = { prompt: '' };
    const result = await runThink(engine, { question: QUESTION, client: stubClient(capture, { answer: 'cut', citations: [], gaps: [] }), withTrajectory: false });
    expect(result.warnings).toContain(`THINK_BUDGET_CONFIG_IGNORED:${PAGES_BUDGET_KEY}`);
    expect(result.warnings).toContain(`THINK_BUDGET_CONFIG_IGNORED:${EXCERPT_CEILING_KEY}`);
    expect(result.evidence_truncated).toBe(true);
    expect(pagesBlockOf(capture.prompt).length).toBeLessThan(result.pagesGathered * 1_100);
  });

  test('citations carry the gathered source id; a slug outside the gather carries null', async () => {
    const capture = { prompt: '' };
    const result = await runThink(engine, { question: QUESTION, remote: false, client: stubClient(capture, {
      answer: 'Decided [notes/roadmap-review-3] and elsewhere [people/nobody].',
      citations: [
        { page_slug: 'notes/roadmap-review-3', row_num: null, citation_index: 1 },
        { page_slug: 'people/nobody', row_num: null, citation_index: 2 },
      ],
      gaps: [],
    }), withTrajectory: false });
    expect(result.citations.map(c => [c.page_slug, c.source_id])).toEqual([
      ['notes/roadmap-review-3', 'default'],
      ['people/nobody', null],
    ]);
  });
});

describe('synthesize verb: additive evidence_truncated and citations[] (#5461)', () => {
  test('the frozen sources[] stays; citations[] is parallel to it and source-qualified', async () => {
    __setChatTransportForTests(async () => ({
      text: JSON.stringify({ answer: 'Decided [notes/roadmap-review-3].', citations: [{ page_slug: 'notes/roadmap-review-3', row_num: null, citation_index: 1 }], gaps: [] }),
      blocks: [], stopReason: 'end' as const,
      usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-haiku-4-5-20251001', providerId: 'anthropic',
    }));
    const res = await withEnv({ ANTHROPIC_API_KEY: 'sk-test-hermetic' }, () =>
      dispatchToolCall(engine, 'synthesize', { question: QUESTION }, { remote: true, takesHoldersAllowList: ['world'], sourceId: 'default' }));
    expect(res.isError).not.toBe(true);
    const body = JSON.parse(res.content[0].text);
    expect(body.sources).toEqual(['notes/roadmap-review-3']);
    expect(body.citations).toEqual([{ slug: 'notes/roadmap-review-3', source_id: 'default', row_num: null }]);
    expect(body.evidence_truncated).toBe(true);
    expect(body.protocol_version).toBe(1);
  });
});

describe('gbrain config set refuses an out-of-range budget up front (#5461)', () => {
  async function configSet(args: string[]) {
    const errs: string[] = [];
    let exit: number | null = null;
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errs.push(a.join(' ')); });
    const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => { exit = code ?? 0; throw new Error(`EXIT:${code}`); }) as never);
    try { await runConfig(engine, ['set', ...args]); }
    catch (e) { if (!(e as Error).message.startsWith('EXIT:')) throw e; }
    finally { logSpy.mockRestore(); errSpy.mockRestore(); exitSpy.mockRestore(); }
    return { err: errs.join('\n'), exit: exit as number | null };
  }

  test('both keys are registered; a bad value exits 1 and is not stored; a good one is', async () => {
    expect(KNOWN_CONFIG_KEYS).toContain(PAGES_BUDGET_KEY);
    expect(KNOWN_CONFIG_KEYS).toContain(EXCERPT_CEILING_KEY);
    for (const [key, bad] of [[PAGES_BUDGET_KEY, '999'], [PAGES_BUDGET_KEY, '12k'], [EXCERPT_CEILING_KEY, '500'], [EXCERPT_CEILING_KEY, '300000']]) {
      const r = await configSet([key, bad]);
      expect(r.exit).toBe(1);
      expect(r.err).toContain(key);
      expect(r.err).toContain('between');
      expect(await engine.getConfig(key)).toBeNull();
    }
    expect((await configSet([PAGES_BUDGET_KEY, '30000'])).exit).toBeNull();
    expect(await engine.getConfig(PAGES_BUDGET_KEY)).toBe('30000');
  });
});
