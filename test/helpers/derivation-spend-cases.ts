/**
 * Paid derivations on a segmented page under their spend caps (wave-b spec 8.2, 8.3; PR 4 lane 4b round 2), shared by
 * the PGLite arm (test/large-pages/conversation-facts-incremental-core.test.ts) and the Postgres arm
 * (test/e2e/conversation-facts-incremental-core-postgres.test.ts). Fake extractors and fake chat transports only.
 *
 * 1. Protects: a window that throws after the provider answered is booked and the windows finished before it keep their
 *    facts and rows; an abort partway through a page keeps the finished windows; a facts call reserves every attempt
 *    extract.ts may make and books what the provider reported for each attempt; a cap stop after a title change keeps
 *    the facts of the windows it did not extract again; a --since run keeps the facts before it and never settles the
 *    page; windows run across segment cuts exactly as the whole-page pass cuts them; a visibility change re-extracts;
 *    the facts backstop keeps its finished windows' rows when a window throws.
 * 2. Fails when: a throw or an abort drops finished windows or their spend, a retry is paid past the cap, a partial or
 *    filtered run deletes facts it did not replace, or windows stop at segment cuts.
 */
import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { AppendBrain } from './append-brain.ts';
import { PAGE_EMBED_CAP_KEY } from '../../src/core/page-embedding-budget.ts';
import { PAGE_DERIVATION_CAP_KEY } from '../../src/core/page-spend.ts';
import { __setChatTransportForTests, type ChatOpts, type ChatResult } from '../../src/core/ai/gateway.ts';
import { reservationCostUsd } from '../../src/core/budget/reservation-cost.ts';
import { parseConversation } from '../../src/core/conversation-parser/parse.ts';
import { renderSegmentForExtraction, splitIntoSegments } from '../../src/core/facts/conversation-windows.ts';
import { outcomeSession, regularPageVersionToken } from '../../src/core/facts/conversation-window-extract.ts';
import { TERMINAL_AUDIT_SOURCE } from '../../src/core/facts/audit-sources.ts';
import { runFactsBackstop } from '../../src/core/facts/backstop.ts';
import { truthLead } from '../../src/core/page-body/segment-blocks.ts';
import { chatDays, chatPage, derivations, extract, factsOf, PAID_MODEL, paidTransport } from './conversation-facts-incremental-cases.ts';

const pageIdOf = async (engine: BrainEngine, slug: string) =>
  Number((await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE source_id='default' AND slug=$1", [slug]))[0]!.id);
const factsSpent = async (engine: BrainEngine, slug: string) => Number((await engine.executeRaw<{ spent: number }>(
  "SELECT spent_usd AS spent FROM page_derivation_spend WHERE page_id=$1 AND family='facts'", [await pageIdOf(engine, slug)]))[0]?.spent ?? 0);
/** What one paidTransport call over `text` costs (the fake extractor sends the window text alone). */
const paidCost = (text: string) => reservationCostUsd(PAID_MODEL, 'chat', Math.ceil(text.length / 4), 32)!;
const createSha = (text: string) => createHash('sha256').update(text).digest('hex');
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const caps = async (engine: BrainEngine, usd: string) => { await engine.setConfig(PAGE_DERIVATION_CAP_KEY, usd); await engine.setConfig(PAGE_EMBED_CAP_KEY, usd); };
const terminalStamps = async (engine: BrainEngine, slug: string) => {
  const page = await engine.getPage(slug, { sourceId: 'default' });
  return Number((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM facts WHERE source_markdown_slug=$1 AND source=$2 AND source_session=$3',
    [slug, TERMINAL_AUDIT_SOURCE, outcomeSession(TERMINAL_AUDIT_SOURCE, slug, regularPageVersionToken(page!))]))[0]!.n);
};

export function defineDerivationSpendCases(opts: { getBrain: () => AppendBrain }): void {
  test('a window that throws after the provider answered is booked; the windows finished before it keep their facts and rows', async () => {
    const { engine, seed } = opts.getBrain();
    const slug = `notes/chat-throw-${randomUUID().slice(0, 8)}`;
    await caps(engine, 'off');
    await seed(slug, chatPage('Chat throw', chatDays(1000, 100, 7)));
    __setChatTransportForTests(paidTransport);
    try {
      const first = await extract(engine, slug, { paid: true, failAt: 3 });
      const rows = await derivations(engine, slug);
      expect({ calls: first.calls.length, failed: first.result.pages_failed, facts: (await factsOf(engine, slug)).length, recorded: rows.keys.length })
        .toEqual({ calls: 3, failed: 1, facts: 2, recorded: 2 });
      expect(await factsSpent(engine, slug)).toBeCloseTo(sum(first.calls.map(paidCost)), 9);
      const second = await extract(engine, slug, { paid: true });
      expect(second.calls.filter(text => first.calls.slice(0, 2).includes(text))).toEqual([]);
      expect(second.calls[0]).toBe(first.calls[2]);
      expect(await factsSpent(engine, slug)).toBeCloseTo(sum([...first.calls, ...second.calls].map(paidCost)), 9);
    } finally { __setChatTransportForTests(null); }
  }, 600_000);

  test('an abort partway through a page keeps the finished windows; the next run resumes without repeats', async () => {
    const { engine, seed } = opts.getBrain();
    const slug = `notes/chat-abort-${randomUUID().slice(0, 8)}`;
    await caps(engine, 'off');
    await seed(slug, chatPage('Chat abort', chatDays(1200, 100, 8)));
    const first = await extract(engine, slug, { abortAfter: 3 }).catch(error => ({ error }));
    const facts = await factsOf(engine, slug);
    const rows = await derivations(engine, slug);
    expect({ facts: facts.length, recorded: rows.keys.length, anchored: facts.every(f => rows.keys.includes(f.key)) }).toEqual({ facts: 3, recorded: 3, anchored: true });
    const second = await extract(engine, slug);
    const done = await derivations(engine, slug);
    expect({ repeats: second.calls.filter(text => facts.some(f => f.key.endsWith(':' + createSha(text)))).length, facts: (await factsOf(engine, slug)).length,
      total: second.calls.length + 3, states: [...new Set(done.states)] }).toEqual({ repeats: 0, facts: done.keys.length, total: done.keys.length, states: ['done'] });
    expect('error' in first || first.result.pages_failed === 1).toBe(true);
  }, 600_000);

  test('a facts call reserves every attempt extract.ts may make and books each attempt the provider answered', async () => {
    const { engine, seed } = opts.getBrain();
    const slug = `notes/chat-attempts-${randomUUID().slice(0, 8)}`;
    await engine.setConfig('facts.extraction_model', PAID_MODEL);
    await seed(slug, chatPage('Chat attempts', chatDays(1400, 100, 9)));
    // One call fits $0.2 (about $0.07 at most); its truncation and malformed-output retries (twice the output each) do not.
    await caps(engine, '0.2');
    const usage: number[] = [];
    let n = 0;
    __setChatTransportForTests(async (o: ChatOpts): Promise<ChatResult> => {
      const chars = o.messages.reduce((c, m) => c + (typeof m.content === 'string' ? m.content.length : 0), 0) + (o.system?.length ?? 0);
      const input = Math.ceil(chars / 4);
      usage.push(reservationCostUsd(PAID_MODEL, 'chat', input, 50)!);
      return { text: '{"facts":[]}', blocks: [], stopReason: ++n % 2 === 1 ? 'length' : 'end', model: PAID_MODEL, providerId: 'anthropic',
        usage: { input_tokens: input, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 } };
    });
    try {
      await extractProduction(engine, slug);
      expect({ attempts: usage.length, receipts: (await derivations(engine, slug)).receipts.filter(Boolean).map(r => (r as { reason: string }).reason) })
        .toEqual({ attempts: 0, receipts: ['cap_reached'] });
      await caps(engine, '1');
      await extractProduction(engine, slug);
      expect(usage.length).toBeGreaterThanOrEqual(2);
      expect(usage.length % 2).toBe(0);
      expect(await factsSpent(engine, slug)).toBeCloseTo(sum(usage), 9);
      expect(await factsSpent(engine, slug)).toBeLessThanOrEqual(1);
    } finally {
      __setChatTransportForTests(null);
      await engine.setConfig('facts.extraction_model', '');
      await caps(engine, 'off');
    }
  }, 600_000);

  test('a cap stop after a title change keeps every fact of the windows it did not extract again', async () => {
    const brain = opts.getBrain();
    const slug = `notes/chat-retitle-${randomUUID().slice(0, 8)}`;
    await caps(brain.engine, 'off');
    await brain.seed(slug, chatPage('Chat T1', chatDays(1600, 100, 10)));
    await extract(brain.engine, slug);
    const before = (await factsOf(brain.engine, slug)).map(f => f.id);
    expect(before.length).toBeGreaterThan(100);
    await brain.seed(slug, chatPage('Chat T2', (await brain.body(slug)).truth));
    await caps(brain.engine, '0.000001');
    const capped = await extract(brain.engine, slug);
    expect({ calls: capped.calls.length, facts: (await factsOf(brain.engine, slug)).map(f => f.id) }).toEqual({ calls: 0, facts: before });
    await caps(brain.engine, 'off');
    const full = await extract(brain.engine, slug);
    const after = await factsOf(brain.engine, slug);
    expect({ calls: full.calls.length, survivors: after.filter(f => before.includes(f.id)).length, facts: after.length })
      .toEqual({ calls: (await derivations(brain.engine, slug)).keys.length, survivors: 0, facts: full.calls.length });
  }, 600_000);

  test('a --since run keeps every fact before it and never settles the page; the next full run settles it without repeats', async () => {
    const brain = opts.getBrain();
    const slug = `notes/chat-since-${randomUUID().slice(0, 8)}`;
    await caps(brain.engine, 'off');
    const body = chatDays(1800, 100, 11);
    await brain.seed(slug, chatPage('Chat since', body));
    await extract(brain.engine, slug);
    const before = await factsOf(brain.engine, slug);
    await brain.seed(slug, chatPage('Chat since', `${body}\n\n${chatDays(1900, 2, 11)}`));
    const sinceIso = `${new Date(Date.UTC(2025, 0, 1) + 1850 * 86_400_000).toISOString().slice(0, 10)}T00:00:00Z`;
    // Windows never span a day (a day's turns end hours before the next day's), so a fact whose window starts before the
    // --since day comes from a window wholly before it.
    const early = (await brain.engine.executeRaw<{ id: number }>(
      "SELECT id FROM facts WHERE source_markdown_slug=$1 AND source='cli:extract-conversation-facts' AND expired_at IS NULL AND valid_from < $2::timestamptz",
      [slug, sinceIso])).map(r => ({ id: Number(r.id) }));
    const filtered = await extract(brain.engine, slug, { sinceIso });
    const kept = (await factsOf(brain.engine, slug)).map(f => f.id);
    expect({ calls: filtered.calls.length > 0, earlyKept: early.filter(f => !kept.includes(f.id)).length, stamped: await terminalStamps(brain.engine, slug) })
      .toEqual({ calls: true, earlyKept: 0, stamped: 0 });
    expect(early.length).toBeGreaterThan(before.length / 3);
    const full = await extract(brain.engine, slug);
    expect({ repeats: full.calls.filter(text => filtered.calls.includes(text)).length, stamped: await terminalStamps(brain.engine, slug),
      facts: (await factsOf(brain.engine, slug)).length }).toEqual({ repeats: 0, stamped: 1, facts: (await derivations(brain.engine, slug)).keys.length });
  }, 600_000);

  test('windows run across segment cuts: the segmented page extracts exactly the whole-page windows', async () => {
    const brain = opts.getBrain();
    const slug = `notes/chat-cuts-${randomUUID().slice(0, 8)}`;
    await caps(brain.engine, 'off');
    const words = ['launch', 'pricing', 'budget', 'roadmap', 'hiring', 'review', 'contract', 'latency', 'onboarding', 'forecast'];
    const clock = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    // One day header and one gap group (turns a minute apart), so the segment cuts fall inside the group.
    const lines = ['## 2025-03-01', ''];
    // Turn lengths vary, so window boundaries do not line up with the segment cuts.
    for (let t = 0; t < 1400; t++) lines.push(`**${['Alice Example', 'Bob Example'][t % 2]}** (${clock(t)}): ${Array.from({ length: 50 + (t * 37) % 80 }, (_, i) => words[(t * 7 + i) % words.length]).join(' ')}.`, '');
    await brain.seed(slug, chatPage('Chat cuts', lines.join('\n')));
    const page = (await brain.engine.getPage(slug, { sourceId: 'default' }))!;
    expect((await brain.engine.readManifest(page.id)).length).toBeGreaterThan(2);
    const truth = (await brain.body(slug)).truth;
    const expected = splitIntoSegments(parseConversation(truth, { page }).messages, { pageTitle: 'Chat cuts' }).map(seg => renderSegmentForExtraction('Chat cuts', seg));
    const { calls } = await extract(brain.engine, slug);
    expect(expected.length).toBeGreaterThan(10);
    expect([...calls].sort()).toEqual([...expected].sort());
  }, 600_000);

  test('a change of facts.default_visibility re-extracts every window', async () => {
    const brain = opts.getBrain();
    const slug = `notes/chat-visibility-${randomUUID().slice(0, 8)}`;
    await caps(brain.engine, 'off');
    await brain.seed(slug, chatPage('Chat visibility', chatDays(2000, 100, 12)));
    const first = await extract(brain.engine, slug);
    await brain.engine.setConfig('facts.default_visibility', 'world');
    try {
      const second = await extract(brain.engine, slug, { force: true });
      expect({ calls: second.calls.length, same: [...second.calls].sort().join('\n') === [...first.calls].sort().join('\n') }).toEqual({ calls: first.calls.length, same: true });
    } finally { await brain.engine.setConfig('facts.default_visibility', 'private'); }
  }, 600_000);

  test('the facts backstop keeps the rows of the windows it finished when a window throws', async () => {
    const { engine, seed } = opts.getBrain();
    const slug = `notes/backstop-throw-${randomUUID().slice(0, 8)}`;
    await caps(engine, 'off');
    await seed(slug, chatPage('Backstop throw', chatDays(2200, 100, 13)).replace('type: conversation', 'type: note'));
    const pageId = await pageIdOf(engine, slug);
    const prompts: string[] = [];
    const controller = new AbortController();
    const lead = await truthLead(engine, pageId, 4096);
    const backstop = (signal?: AbortSignal) => runFactsBackstop({ slug, type: 'note', compiled_truth: lead, frontmatter: {}, segmentedPageId: pageId },
      { engine, sourceId: 'default', sessionId: null, source: 'mcp:put_page', mode: 'inline', abortSignal: signal });
    __setChatTransportForTests(async (o: ChatOpts): Promise<ChatResult> => {
      prompts.push(JSON.stringify(o.messages));
      if (prompts.length === 3 && !controller.signal.aborted) { controller.abort(); throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }); }
      return { text: '{"facts":[]}', blocks: [], stopReason: 'end', model: 'test:stub', providerId: 'test', usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 } };
    });
    try {
      await backstop(controller.signal).catch(() => null);
      const firstTwo = prompts.slice(0, 2);
      const rows = await engine.readSegmentDerivations(pageId, { kind: 'facts_backstop' });
      expect(rows.flatMap(r => (r.output as { windows: unknown[] }).windows).length).toBe(2);
      prompts.length = 0;
      await backstop();
      expect(prompts.filter(p => firstTwo.includes(p))).toEqual([]);
      expect(prompts.length).toBeGreaterThan(0);
    } finally { __setChatTransportForTests(null); }
  }, 600_000);
}

/** A production-extractor run (no injected extractor): the gateway's fake transport answers. */
async function extractProduction(engine: BrainEngine, slug: string) {
  const { runExtractConversationFactsCore } = await import('../../src/commands/extract-conversation-facts.ts');
  return runExtractConversationFactsCore(engine, { sourceId: 'default', slugs: [slug], sleepMs: 0 });
}
