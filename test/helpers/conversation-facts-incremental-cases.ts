/**
 * Incremental conversation facts on a segmented page (wave-b spec 8.2 "Conversation facts", PR 4 lane 4b), shared by
 * the PGLite arm (test/large-pages/conversation-facts-incremental-core.test.ts) and the Postgres arm
 * (test/e2e/conversation-facts-incremental-core-postgres.test.ts). A fake extractor counts calls by window text; no model
 * is called. Spend is metered (meterPaidCall, the facts ledger); the cap case's fake extractor calls the gateway, whose
 * fake transport reports token usage on a priced model, so its windows cost what that usage costs.
 *
 * 1. Protects: an import extracts each window once and anchors every fact (facts.source_window, a JSONB object); an
 *    append (by a remote writer) extracts only windows no earlier run extracted, keeps the facts (same ids) of every
 *    window still live and deletes only the facts of windows that no longer exist; a title change re-extracts every
 *    window and a no-op extracts nothing; the per-page cap stops the run before a call, newest windows first, and a
 *    later run resumes without repeating a window; unanchored facts of an earlier full-pass run stay until every live
 *    occurrence is settled, then go.
 * 2. Fails when: a run replays the whole page (the pre-PR-4 full pass), a fact loses its anchor or is double-encoded,
 *    an untouched window's fact is replaced, a retired window's fact survives, or a refused reservation still calls.
 */
import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { runExtractConversationFactsCore } from '../../src/commands/extract-conversation-facts.ts';
import { parseSourceWindow, sourceWindowKey, type SourceWindow } from '../../src/core/page-body/derivations.ts';
import { PAGE_EMBED_CAP_KEY } from '../../src/core/page-embedding-budget.ts';
import { PAGE_DERIVATION_CAP_KEY } from '../../src/core/page-spend.ts';
import type { AppendBrain } from './append-brain.ts';
import { runFactsBackstop } from '../../src/core/facts/backstop.ts';
import { lineWindows } from '../../src/core/facts/backstop-segments.ts';
import { MAX_TURN_TEXT_CHARS } from '../../src/core/facts/extract.ts';
import { truthLead } from '../../src/core/page-body/segment-blocks.ts';
import { __setChatTransportForTests, chat as gatewayChat, type ChatOpts, type ChatResult } from '../../src/core/ai/gateway.ts';
import { extractionInputTruncatedEntry } from '../../src/commands/doctor/checks/extraction-input.ts';
import type { DoctorContext } from '../../src/commands/doctor/context.ts';
import type { Check } from '../../src/commands/doctor.ts';

const SPEAKERS = ['Alice Example', 'Bob Example', 'Carol Example'];
const WORDS = ['launch', 'pricing', 'budget', 'roadmap', 'hiring', 'review', 'contract', 'latency', 'onboarding', 'forecast', 'retention', 'deploy'];
export const SOURCE = 'cli:extract-conversation-facts';

const clock = (minutes: number) => { const h = 9 + Math.floor(minutes / 60); return `${h > 12 ? h - 12 : h}:${String(minutes % 60).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`; };
const dateOf = (day: number) => new Date(Date.UTC(2025, 0, 1) + day * 86_400_000).toISOString().slice(0, 10);

/** Timed turns two minutes apart: one gap group per day. Deterministic per seed. */
export function turns(day: number, from: number, count: number, seed: number): string {
  let s = seed * 7919 + day * 104_729 + from;
  const next = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const out: string[] = [];
  for (let t = from; t < from + count; t++) {
    const words = Array.from({ length: 10 + Math.floor(next() * 30) }, () => WORDS[Math.floor(next() * WORDS.length)]);
    out.push(`**${SPEAKERS[t % 3]}** (${clock(2 * t)}): ${words.join(' ')}.`);
  }
  return out.join('\n\n');
}

/** \`days\` dated days of 50 turns each, from day \`first\`. */
export function chatDays(first: number, days: number, seed: number): string {
  return Array.from({ length: days }, (_, i) => `## ${dateOf(first + i)}

${turns(first + i, 0, 50, seed)}`).join('\n\n');
}

export const chatPage = (title: string, body: string) => `---
type: conversation
title: ${title}
date: 2025-01-01
---

${body}
`;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

interface FactRow { id: number; key: string; type: string }

/** The page's live extractor facts (audit rows aside) with their window keys and the stored JSONB type. */
export async function factsOf(engine: BrainEngine, slug: string): Promise<FactRow[]> {
  const rows = await engine.executeRaw<{ id: number; w: unknown; t: string | null }>(
    `SELECT id, source_window AS w, jsonb_typeof(source_window) AS t FROM facts WHERE source_id='default' AND source_markdown_slug=$1 AND source=$2 AND expired_at IS NULL ORDER BY id`,
    [slug, SOURCE]);
  return rows.map(row => {
    const window = parseSourceWindow(row.w) as SourceWindow | null;
    return { id: Number(row.id), key: window ? sourceWindowKey(window) : 'unanchored', type: String(row.t) };
  });
}

/** Window keys every live occurrence's derivation row records, and the rows' states and receipts. */
export async function derivations(engine: BrainEngine, slug: string) {
  const [page] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE source_id='default' AND slug=$1", [slug]);
  const pageId = Number(page!.id);
  const rows = await engine.readSegmentDerivations(pageId, { kind: 'conversation_facts' });
  const live = await engine.readManifest(pageId);
  const keys = rows.flatMap(row => ((row.output as { windows?: Array<{ ordinal: number; sha: string }> })?.windows ?? [])
    .map(w => sourceWindowKey({ occurrence_id: row.occurrenceId, window_ordinal: w.ordinal, window_text_sha: w.sha })));
  return { pageId, rows, keys, live: live.map(row => row.occurrenceId), states: rows.map(row => row.state), receipts: rows.map(row => row.receipt) };
}

export const PAID_MODEL = 'anthropic:claude-sonnet-4-6';

/** A fake chat transport reporting usage on a priced model: a quarter token per input character, 32 output tokens. */
export function paidTransport(o: ChatOpts): Promise<ChatResult> {
  const chars = o.messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length), 0);
  return Promise.resolve({ text: '{"facts":[]}', blocks: [], stopReason: 'end', model: PAID_MODEL, providerId: 'anthropic',
    usage: { input_tokens: Math.ceil(chars / 4), output_tokens: 32, cache_read_tokens: 0, cache_creation_tokens: 0 } });
}

/**
 * One extraction run with a fake extractor; `calls` lists every window text it was handed, in call order. `paid`: each
 * window also calls the gateway (install paidTransport), so the call is booked. `failAt`: the extractor throws on that
 * call (1-based) after the provider answered; `failOn`: it fails with the window's own malformed output on every window text the predicate accepts;
 * `abortAfter`: the run is aborted after that many calls; `segmentLimit`: at most that many windows per page.
 */
export async function extract(engine: BrainEngine, slug: string, opts: { force?: boolean; paid?: boolean; failAt?: number; failOn?: (text: string) => boolean;
  abortAfter?: number; sinceIso?: string; segmentLimit?: number; grammar?: string | null; dryRun?: boolean } = {}) {
  const calls: string[] = [];
  const controller = new AbortController();
  const result = await runExtractConversationFactsCore(engine, { sourceId: 'default', slugs: [slug], sleepMs: 0, force: opts.force,
    sinceIso: opts.sinceIso, segmentLimit: opts.segmentLimit, grammar: opts.grammar, dryRun: opts.dryRun,
    extractor: async input => {
      calls.push(input.turnText);
      if (opts.paid) await gatewayChat({ model: PAID_MODEL, messages: [{ role: 'user', content: input.turnText }], maxTokens: 64 });
      if (calls.length === opts.failAt) throw new Error('fake extractor failure after the provider answered');
      if (opts.failOn?.(input.turnText)) throw Object.assign(new Error('fake extractor: malformed output on this window'), { extractionReason: 'malformed_output' });
      if (calls.length === opts.abortAfter) controller.abort();
      return [{ fact: `Alice Example noted window ${sha(input.turnText).slice(0, 12)}`, kind: 'fact', entity_slug: null, source: SOURCE }];
    } }, controller.signal);
  return { calls, result };
}

export function defineConversationFactsIncrementalCases(opts: { getBrain: () => AppendBrain }): void {
  const slug = `notes/chat-incremental-${randomUUID().slice(0, 8)}`;
  const BODY = chatDays(0, 100, 1);
  const seen = new Set<string>();
  let before: FactRow[] = [];

  test('an import extracts every window exactly once and anchors every fact to its window', async () => {
    const { engine, seed } = opts.getBrain();
    await engine.setConfig(PAGE_EMBED_CAP_KEY, 'off');
    await engine.setConfig(PAGE_DERIVATION_CAP_KEY, 'off');
    await seed(slug, chatPage('Chat A', BODY));
    const { calls, result } = await extract(engine, slug);
    const facts = await factsOf(engine, slug);
    const stored = await derivations(engine, slug);
    expect(stored.live.length).toBeGreaterThan(2);
    expect(calls.length).toBeGreaterThan(100);
    expect({ distinct: new Set(calls).size, facts: facts.length, keys: stored.keys.length, processed: result.pages_processed })
      .toEqual({ distinct: calls.length, facts: calls.length, keys: calls.length, processed: 1 });
    expect(facts.filter(f => f.key === 'unanchored' || f.type !== 'object')).toEqual([]);
    expect(new Set(facts.map(f => f.key))).toEqual(new Set(stored.keys));
    expect(new Set(facts.map(f => f.key.split(':')[2]))).toEqual(new Set(calls.map(sha)));
    expect({ rows: stored.rows.map(r => r.occurrenceId).sort(), states: [...new Set(stored.states)] })
      .toEqual({ rows: [...stored.live].sort(), states: ['done'] });
    for (const text of calls) seen.add(text);
    before = facts;
  }, 600_000);

  test('an append by a remote writer extracts only the new windows, keeps every live window\'s fact and deletes the retired windows\' facts', async () => {
    const brain = opts.getBrain();
    const keysBefore = new Set((await derivations(brain.engine, slug)).keys);
    // Twenty more turns on the last day (they join its last gap group) and three new days.
    const appended = `${turns(99, 50, 20, 1)}

${chatDays(100, 3, 1)}`;
    expect(await brain.call('append_page', { slug, text: appended, request_id: randomUUID() }, { remote: true })).toMatchObject({ isError: false });
    const { calls } = await extract(brain.engine, slug);
    const after = await derivations(brain.engine, slug);
    const facts = await factsOf(brain.engine, slug);
    const shasBefore = new Set([...keysBefore].map(key => key.split(':')[2]));
    const fresh = after.keys.filter(key => !shasBefore.has(key.split(':')[2]));
    expect(calls.filter(text => seen.has(text))).toEqual([]);
    expect(calls.length).toBe(fresh.length);
    expect(new Set(calls.map(sha))).toEqual(new Set(fresh.map(key => key.split(':')[2])));
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls.length * 10).toBeLessThan(seen.size);
    // A window still rendered verbatim keeps its fact (same id; a rewritten tail re-anchors it to its new occurrence);
    // a window that no longer exists (the last window the appended turns joined) loses it.
    const liveShas = new Set(after.keys.map(key => key.split(':')[2]));
    const byId = new Map(facts.map(f => [f.id, f]));
    const kept = before.filter(f => liveShas.has(f.key.split(':')[2]));
    const retired = before.filter(f => !liveShas.has(f.key.split(':')[2]));
    expect({ keptLost: kept.filter(f => byId.get(f.id)?.key.split(':')[2] !== f.key.split(':')[2]), retiredKept: retired.filter(f => byId.has(f.id)) })
      .toEqual({ keptLost: [], retiredKept: [] });
    expect(retired.length).toBeGreaterThanOrEqual(1);
    expect(kept.length + retired.length).toBe(before.length);
    expect({ facts: facts.length, anchored: facts.filter(f => f.type === 'object').length }).toEqual({ facts: after.keys.length, anchored: after.keys.length });
    for (const text of calls) seen.add(text);
    before = facts;
  }, 600_000);

  test('a title change re-extracts every window; a no-op rewrite and a forced rerun extract nothing', async () => {
    const brain = opts.getBrain();
    const body = (await brain.body(slug)).truth;
    await brain.seed(slug, chatPage('Chat A', body));
    const noop = await extract(brain.engine, slug);
    const forced = await extract(brain.engine, slug, { force: true });
    expect({ noop: noop.calls.length, forced: forced.calls.length, facts: (await factsOf(brain.engine, slug)).map(f => f.id) })
      .toEqual({ noop: 0, forced: 0, facts: before.map(f => f.id) });
    await brain.seed(slug, chatPage('Chat B', body));
    const { calls } = await extract(brain.engine, slug);
    const after = await derivations(brain.engine, slug);
    const facts = await factsOf(brain.engine, slug);
    const ids = new Set(before.map(f => f.id));
    expect({ calls: calls.length, distinct: new Set(calls).size, facts: facts.length, survivors: facts.filter(f => ids.has(f.id)).length,
      repeats: calls.filter(text => seen.has(text)).length })
      .toEqual({ calls: after.keys.length, distinct: after.keys.length, facts: after.keys.length, survivors: 0, repeats: 0 });
    expect(calls.every(text => text.startsWith('Page: Chat B\n'))).toBe(true);
  }, 600_000);

  test('the per-page cap refuses before the call, spends on the newest windows first, and a later run resumes without repeats', async () => {
    const { engine, seed } = opts.getBrain();
    const capped = `notes/chat-capped-${randomUUID().slice(0, 8)}`;
    await engine.setConfig('facts.extraction_model', 'anthropic:claude-sonnet-4-6');
    await seed(capped, chatPage('Chat C', chatDays(200, 100, 3)));
    // A fact from an earlier full-pass run: no window anchor.
    await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, source, source_markdown_slug, row_num, confidence)
      VALUES ('default', NULL, 'Bob Example owns the forecast', 'fact', 'private', 'medium', $2, $1, 5000, 0.9)`, [capped, SOURCE]);
    const unanchored = async () => (await factsOf(engine, capped)).filter(f => f.key === 'unanchored').length;
    await engine.setConfig(PAGE_DERIVATION_CAP_KEY, '0.5');
    __setChatTransportForTests(paidTransport);
    const first = await extract(engine, capped, { paid: true }).finally(() => __setChatTransportForTests(null));
    const partial = await derivations(engine, capped);
    const [ledger] = await engine.executeRaw<{ spent: number }>("SELECT spent_usd AS spent FROM page_derivation_spend WHERE page_id=$1 AND family='facts'", [partial.pageId]);
    expect(first.calls.length).toBeGreaterThanOrEqual(1);
    expect(Number(ledger!.spent)).toBeLessThanOrEqual(0.5);
    expect(Number(ledger!.spent)).toBeGreaterThan(0);
    // A cap stop partway through the page publishes the windows it finished: one fact each, anchored to its window.
    expect((await factsOf(engine, capped)).filter(f => f.key !== 'unanchored').length).toBe(first.calls.length);
    expect(partial.receipts.filter(Boolean)).toEqual([expect.objectContaining({ kind: 'unread_windows', reason: 'cap_reached' })]);
    expect(await unanchored()).toBe(1);
    // The newest windows: the last day's turns are in the first call.
    expect(first.calls[0]).toContain(`${dateOf(299)}`);
    await engine.setConfig(PAGE_DERIVATION_CAP_KEY, 'off');
    const second = await extract(engine, capped);
    const done = await derivations(engine, capped);
    expect({ repeats: second.calls.filter(text => first.calls.includes(text)).length, total: first.calls.length + second.calls.length,
      states: [...new Set(done.states)], facts: (await factsOf(engine, capped)).length, unanchored: await unanchored() })
      .toEqual({ repeats: 0, total: done.keys.length, states: ['done'], facts: done.keys.length, unanchored: 0 });
    expect(first.calls.length).toBeLessThan(done.keys.length);
    await engine.setConfig('facts.extraction_model', '');
  }, 600_000);
}

/**
 * The facts backstop over a segmented page (wave-b spec 8.2 "Facts backstop"): an import extracts every
 * MAX_TURN_TEXT_CHARS window of every occurrence once; an append (by a remote writer) extracts only the windows no run
 * extracted before (the new text plus the window it grew), never the page again; an unchanged page extracts nothing;
 * a cap the first window does not fit refuses before any call. Fake chat transport, counted by prompt.
 */
export function defineSegmentedBackstopCases(opts: { getBrain: () => AppendBrain }): void {
  const slug = `notes/backstop-segmented-${randomUUID().slice(0, 8)}`;
  let prompts: string[] = [];
  let firstPrompts: string[] = [];
  const pageOf = async (engine: BrainEngine, s: string) => (await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE source_id='default' AND slug=$1", [s]))[0]!;
  const backstop = async (engine: BrainEngine, s: string) => {
    const page = await pageOf(engine, s);
    return runFactsBackstop({ slug: s, type: 'note', compiled_truth: await truthLead(engine, Number(page.id), 4096), frontmatter: {}, segmentedPageId: Number(page.id) },
      { engine, sourceId: 'default', sessionId: null, source: 'mcp:put_page', mode: 'inline' });
  };
  const install = () => {
    prompts = [];
    __setChatTransportForTests(async (o: ChatOpts): Promise<ChatResult> => {
      prompts.push(JSON.stringify(o.messages));
      return { text: '{"facts":[]}', blocks: [], stopReason: 'end', model: 'test:stub', providerId: 'test',
        usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 } };
    });
  };

  test('an import extracts each window of each occurrence once; an unchanged page extracts nothing', async () => {
    const { engine, seed, body } = opts.getBrain();
    await engine.setConfig(PAGE_EMBED_CAP_KEY, 'off');
    await engine.setConfig(PAGE_DERIVATION_CAP_KEY, 'off');
    await seed(slug, chatPage('Backstop', chatDays(400, 100, 5)).replace('type: conversation', 'type: note'));
    const page = await pageOf(engine, slug);
    const truth = Buffer.from((await body(slug)).truth, 'utf8');
    const manifest = await engine.readManifest(Number(page.id));
    const expected = manifest.flatMap(row => lineWindows(truth.subarray(row.byteStart, row.byteStart + row.byteLen).toString('utf8'), MAX_TURN_TEXT_CHARS));
    install();
    try {
      await backstop(engine, slug);
      firstPrompts = prompts;
      const rows = await engine.readSegmentDerivations(Number(page.id), { kind: 'facts_backstop' });
      expect(manifest.length).toBeGreaterThan(2);
      expect({ calls: prompts.length, distinct: new Set(prompts).size, rows: rows.length, states: [...new Set(rows.map(r => r.state))] })
        .toEqual({ calls: expected.length, distinct: expected.length, rows: manifest.length, states: ['done'] });
      install();
      await backstop(engine, slug);
      expect(prompts.length).toBe(0);
    } finally { __setChatTransportForTests(null); }
  }, 600_000);

  test('an append by a remote writer extracts only the new text\'s windows', async () => {
    const brain = opts.getBrain();
    const appended = chatDays(500, 3, 5);
    expect(await brain.call('append_page', { slug, text: appended, request_id: randomUUID() }, { remote: true })).toMatchObject({ isError: false });
    install();
    try {
      await backstop(brain.engine, slug);
      expect(prompts.filter(p => firstPrompts.includes(p))).toEqual([]);
      expect(prompts.length).toBeGreaterThanOrEqual(Math.ceil(appended.length / MAX_TURN_TEXT_CHARS));
      expect(prompts.length).toBeLessThanOrEqual(Math.ceil(appended.length / MAX_TURN_TEXT_CHARS) + 2);
      const page = await pageOf(brain.engine, slug);
      const rows = await brain.engine.readSegmentDerivations(Number(page.id), { kind: 'facts_backstop' });
      expect({ rows: rows.length, states: [...new Set(rows.map(r => r.state))] }).toEqual({ rows: (await brain.engine.readManifest(Number(page.id))).length, states: ['done'] });
    } finally { __setChatTransportForTests(null); }
  }, 600_000);

  test('a cap the newest window does not fit refuses before any call', async () => {
    const { engine, seed } = opts.getBrain();
    const capped = `notes/backstop-capped-${randomUUID().slice(0, 8)}`;
    await seed(capped, chatPage('Backstop capped', chatDays(600, 100, 6)).replace('type: conversation', 'type: note'));
    await engine.setConfig(PAGE_DERIVATION_CAP_KEY, '0.000001');
    install();
    try {
      await backstop(engine, capped);
      const page = await pageOf(engine, capped);
      const rows = await engine.readSegmentDerivations(Number(page.id), { kind: 'facts_backstop' });
      expect({ calls: prompts.length, receipts: rows.map(r => r.receipt) })
        .toEqual({ calls: 0, receipts: [expect.objectContaining({ kind: 'unread_windows', pipeline: 'facts_backstop', reason: 'cap_reached', windows_read: 0 })] });
    } finally {
      __setChatTransportForTests(null);
      await engine.setConfig(PAGE_DERIVATION_CAP_KEY, 'off');
    }
  }, 600_000);
}

/** Doctor's extraction_input_truncated reads page_segment_derivations receipts too (wave-b spec 8.1), not only page_extraction_state. */
export function defineSegmentReceiptDoctorCases(opts: { getBrain: () => AppendBrain }): void {
  test('doctor lists a segmented page whose windows the cap left unread, with the per-page cap as the fix', async () => {
    const { engine, seed } = opts.getBrain();
    const s = `notes/doctor-unread-${randomUUID().slice(0, 8)}`;
    await seed(s, chatPage('Doctor unread', chatDays(950, 100, 5)).replace('type: conversation', 'type: note'));
    const [page] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE source_id='default' AND slug=$1", [s]);
    const [first] = await engine.readManifest(Number(page!.id));
    await engine.upsertSegmentDerivations([{ pageId: Number(page!.id), kind: 'facts_backstop', occurrenceId: first!.occurrenceId, version: 1,
      segmentSha256: first!.sha256, contextHash: new Uint8Array(32), state: 'partial', output: { windows: [] },
      receipt: { kind: 'unread_windows', pipeline: 'facts_backstop', reason: 'cap_reached', windows_read: 0, windows_total: 3 } }]);
    const check = (await extractionInputTruncatedEntry.run({ engine } as unknown as DoctorContext) as Check[]).find(c => c.name === 'extraction_input_truncated')!;
    const groups = (check.details as { groups: Array<{ pipeline: string; kind: string; samples: string[] }> }).groups;
    expect({ status: check.status, argv: (check as { fix?: { argv: string[] } }).fix?.argv,
      listed: groups.some(g => g.pipeline === 'facts_backstop' && g.kind === 'unread_windows' && g.samples.includes(`default:${s}`)) })
      .toEqual({ status: 'warn', argv: ['gbrain', 'config', 'set', PAGE_DERIVATION_CAP_KEY, '<USD>'], listed: true });
  }, 600_000);
}
