/**
 * Conversation facts on a segmented page when things go wrong (wave-b spec 8.2, 8.3; PR 4 lane 4b round 3), shared by
 * the PGLite arms (test/large-pages/conversation-facts-incremental-{recovery,page-change}.test.ts) and the Postgres arms
 * (test/e2e/conversation-facts-incremental-{recovery,page-change}-postgres.test.ts). Fake extractors only; appends go through the remote
 * append_page operation (remote=true).
 *
 * 1. Protects: a partial run on a transcript without per-message times (every message at the page date) clears only
 *    the windows it extracted again; a time-less transcript whose turns cross segment cuts streams exactly the
 *    whole-page windows and settles only then; a checkpoint write that fails keeps the window moves it carried for the
 *    write that follows, so no re-anchored fact is lost; a window that fails run after run is marked failed after
 *    WINDOW_FAILURE_LIMIT runs and the older windows are extracted, doctor names it and --force retries it.
 *    Round 4: a one-window run on oversized turns clears only the pieces that window holds; a page re-imported in
 *    another chat format is parsed in that format; a run parsing no message where windows were keeps every fact and
 *    leaves a no_messages receipt; provider-wide failures (auth, 503) never count against a window; a failed window
 *    keeps the facts of the window it replaced until it is extracted.
 * 2. Fails when: coverage is judged by timestamps or by a message shared by many pieces, a stale grammar pins the page, (one window "covers" every message at the page date), a continuation
 *    is dropped by re-detecting the grammar per occurrence, moves are dropped before their write commits, or one
 *    failing window stalls every older window of the page.
 */
import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { AppendBrain } from './append-brain.ts';
import { PAGE_EMBED_CAP_KEY } from '../../src/core/page-embedding-budget.ts';
import { PAGE_DERIVATION_CAP_KEY } from '../../src/core/page-spend.ts';
import { parseConversation } from '../../src/core/conversation-parser/parse.ts';
import { renderSegmentForExtraction, splitIntoSegments } from '../../src/core/facts/conversation-windows.ts';
import { WINDOW_FAILURE_LIMIT } from '../../src/core/facts/conversation-incremental.ts';
import { outcomeSession, regularPageVersionToken } from '../../src/core/facts/conversation-window-extract.ts';
import { TERMINAL_AUDIT_SOURCE } from '../../src/core/facts/audit-sources.ts';
import { extractionInputTruncatedEntry } from '../../src/commands/doctor/checks/extraction-input.ts';
import type { DoctorContext } from '../../src/commands/doctor/context.ts';
import type { Check } from '../../src/commands/doctor.ts';
import { __setChatTransportForTests } from '../../src/core/ai/gateway.ts';
import { chatDays, chatPage, derivations, extract, factsOf, PAID_MODEL, paidTransport, turns } from './conversation-facts-incremental-cases.ts';

const WORDS = ['launch', 'pricing', 'budget', 'roadmap', 'hiring', 'review', 'contract', 'latency', 'onboarding', 'forecast'];
const prose = (seed: number, words: number) => Array.from({ length: words }, (_, i) => WORDS[(seed * 7 + i * 3) % WORDS.length]).join(' ');
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const caps = async (engine: BrainEngine, usd: string) => { await engine.setConfig(PAGE_DERIVATION_CAP_KEY, usd); await engine.setConfig(PAGE_EMBED_CAP_KEY, usd); };

/**
 * A time-less transcript (plain-role-no-time: no per-message times, so every message is at the page date): `turns`
 * turns of a line plus continuation lines; turn `long` (if any) carries `longLines` of them, enough to span segment cuts.
 */
function timeless(count: number, seed: number, long = -1, longLines = 0): string {
  const lines: string[] = [];
  for (let t = 0; t < count; t++) {
    lines.push(`${t % 2 === 0 ? 'user' : 'assistant'}: ${prose(seed + t, 14)}`);
    const continuation = t === long ? longLines : 1 + ((t * 5 + seed) % 4);
    for (let c = 0; c < continuation; c++) lines.push(prose(seed + t + c, 12 + (c % 9)));
  }
  return lines.join('\n');
}

const terminalStamps = async (engine: BrainEngine, slug: string) => {
  const page = await engine.getPage(slug, { sourceId: 'default' });
  return Number((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM facts WHERE source_markdown_slug=$1 AND source=$2 AND source_session=$3',
    [slug, TERMINAL_AUDIT_SOURCE, outcomeSession(TERMINAL_AUDIT_SOURCE, slug, regularPageVersionToken(page!))]))[0]!.n);
};

/** Partial runs, failed checkpoint writes and failing windows: what a run keeps when a window or the provider fails. */
export function defineConversationFactsRecoveryCases(opts: { getBrain: () => AppendBrain }): void {
  test('a partial run on a transcript without message times deletes nothing: the window it extracted is added beside the old facts', async () => {
    const brain = opts.getBrain();
    const slug = `notes/timeless-partial-${randomUUID().slice(0, 8)}`;
    await caps(brain.engine, 'off');
    await brain.seed(slug, chatPage('Timeless T1', timeless(9000, 1)));
    const all = await extract(brain.engine, slug);
    const before = await factsOf(brain.engine, slug);
    expect((await derivations(brain.engine, slug)).live.length).toBeGreaterThan(2);
    expect(before.length).toBe(all.calls.length);
    expect(before.length).toBeGreaterThan(50);
    await brain.seed(slug, chatPage('Timeless T2', (await brain.body(slug)).truth));
    const limited = await extract(brain.engine, slug, { segmentLimit: 1 });
    const after = await factsOf(brain.engine, slug);
    expect({ calls: limited.calls.length, before: before.length, after: after.length, cleaned: limited.result.orphan_facts_cleaned,
      kept: before.filter(f => after.some(a => a.id === f.id)).length })
      .toEqual({ calls: 1, before: before.length, after: before.length + 1, cleaned: 0, kept: before.length });
  }, 600_000);

  test('a time-less transcript whose turns cross segment cuts streams exactly the whole-page windows before it settles', async () => {
    const brain = opts.getBrain();
    const slug = `notes/timeless-cuts-${randomUUID().slice(0, 8)}`;
    await caps(brain.engine, 'off');
    await brain.seed(slug, chatPage('Timeless cuts', timeless(9000, 2, 4500, 25000)));
    const page = (await brain.engine.getPage(slug, { sourceId: 'default' }))!;
    const truth = (await brain.body(slug)).truth;
    expect(truth.length).toBeGreaterThan(3_000_000);
    expect((await brain.engine.readManifest(page.id)).length).toBeGreaterThan(3);
    const expected = splitIntoSegments(parseConversation(truth, { page }).messages, { pageTitle: 'Timeless cuts' }).map(seg => renderSegmentForExtraction('Timeless cuts', seg));
    const { calls } = await extract(brain.engine, slug);
    const rows = await derivations(brain.engine, slug);
    expect(expected.length).toBeGreaterThan(100);
    expect({ calls: calls.length, same: [...calls].sort().join('\n') === [...expected].sort().join('\n'), stamped: await terminalStamps(brain.engine, slug),
      states: [...new Set(rows.states)] }).toEqual({ calls: expected.length, same: true, stamped: 1, states: ['done'] });
  }, 600_000);

  test('a checkpoint write that fails keeps its window moves for the next write; no re-anchored fact is lost', async () => {
    const brain = opts.getBrain();
    const slug = `notes/chat-checkpoint-${randomUUID().slice(0, 8)}`;
    await caps(brain.engine, 'off');
    await brain.seed(slug, chatPage('Chat checkpoint', chatDays(3000, 100, 21)));
    const first = await extract(brain.engine, slug);
    const before = await factsOf(brain.engine, slug);
    // Three hundred more turns on the last day: one gap group with its earlier turns, so the rewritten tail's windows
    // move to their new occurrence in the same run that extracts the new windows, before its first checkpoint.
    expect(await brain.call('append_page', { slug, text: turns(3099, 50, 300, 21), request_id: randomUUID() }, { remote: true })).toMatchObject({ isError: false });
    let armed = true;
    const failing = (tx: BrainEngine): BrainEngine => new Proxy(tx, {
      get(target, prop) {
        if (prop === 'upsertSegmentDerivations') {
          return async (rows: Parameters<BrainEngine['upsertSegmentDerivations']>[0]) => {
            if (armed && rows.some(row => row.kind === 'conversation_facts')) { armed = false; throw new Error('fixture: checkpoint write failed'); }
            return target.upsertSegmentDerivations(rows);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const engine = new Proxy(brain.engine, {
      get(target, prop) {
        if (prop === 'transaction') return <T>(fn: (tx: BrainEngine) => Promise<T>) => target.transaction(tx => fn(failing(tx)));
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const broken = await extract(engine, slug).catch(error => ({ error, calls: [] as string[] }));
    expect(armed).toBe(false);
    // Right after the failed checkpoint, the write that followed it carried its moves: every fact of a window still on
    // the page is anchored to that window on its live occurrence, not to the occurrence the append retired.
    const mid = await derivations(brain.engine, slug);
    const liveKeys = new Set(mid.rows.filter(row => mid.live.includes(row.occurrenceId))
      .flatMap(row => ((row.output as { windows?: Array<{ ordinal: number; sha: string }> })?.windows ?? []).map(w => `${row.occurrenceId}:${w.ordinal}:${w.sha}`)));
    const liveShasMid = new Set([...liveKeys].map(key => key.split(':')[2]));
    const midFacts = await factsOf(brain.engine, slug);
    expect(midFacts.filter(f => liveShasMid.has(f.key.split(':')[2]) && !liveKeys.has(f.key)).length).toBe(0);
    const resumed = await extract(brain.engine, slug);
    const after = await factsOf(brain.engine, slug);
    const rows = await derivations(brain.engine, slug);
    const liveShas = new Set(rows.keys.map(key => key.split(':')[2]));
    const kept = before.filter(f => liveShas.has(f.key.split(':')[2]));
    const byId = new Map(after.map(f => [f.id, f]));
    const moved = kept.filter(f => byId.get(f.id) && byId.get(f.id)!.key !== f.key);
    expect(moved.length).toBeGreaterThan(0);
    expect({ keptLost: kept.filter(f => !byId.has(f.id)).length, facts: after.length, keys: rows.keys.length,
      repeats: resumed.calls.filter(text => first.calls.includes(text)).length, anchored: after.every(f => rows.keys.includes(f.key)) })
      .toEqual({ keptLost: 0, facts: rows.keys.length, keys: rows.keys.length, repeats: 0, anchored: true });
    expect('error' in broken || broken.calls.length > 0).toBe(true);
  }, 600_000);

  test('a window that fails run after run is marked failed after the limit and the older windows are extracted; doctor names it, --force retries it', async () => {
    const brain = opts.getBrain();
    const slug = `notes/chat-stuck-window-${randomUUID().slice(0, 8)}`;
    await caps(brain.engine, 'off');
    await brain.seed(slug, chatPage('Chat stuck', chatDays(3200, 100, 22)));
    let stuck = null as string | null;
    const failOn = (text: string) => { stuck ??= text; return text === stuck; };
    const runs: Array<{ calls: number; failed: number }> = [];
    for (let run = 1; run < WINDOW_FAILURE_LIMIT; run++) {
      const { calls, result } = await extract(brain.engine, slug, { failOn });
      runs.push({ calls: calls.length, failed: result.pages_failed });
      expect(calls[0]).toBe(stuck!);
    }
    const last = await extract(brain.engine, slug, { failOn });
    const rows = await derivations(brain.engine, slug);
    const facts = await factsOf(brain.engine, slug);
    expect({ runs, failed: last.result.pages_failed, first: last.calls[0] === stuck, facts: facts.length, stuckFacts: facts.filter(f => f.key.endsWith(':' + sha(stuck!))).length,
      receipts: rows.receipts.filter(Boolean).map(r => (r as { kind: string }).kind), stamped: await terminalStamps(brain.engine, slug) })
      .toEqual({ runs: Array.from({ length: WINDOW_FAILURE_LIMIT - 1 }, () => ({ calls: 1, failed: 1 })), failed: 0, first: true, facts: last.calls.length - 1,
        stuckFacts: 0, receipts: ['failed_windows'], stamped: 1 });
    expect(rows.keys.length).toBe(last.calls.length);
    const check = (await extractionInputTruncatedEntry.run({ engine: brain.engine } as unknown as DoctorContext) as Check[]).find(c => c.name === 'extraction_input_truncated')!;
    const groups = (check.details as { groups: Array<{ pipeline: string; kind: string; samples: string[]; remedy: string | null }> }).groups;
    const group = groups.find(g => g.pipeline === 'conversation_facts' && g.kind === 'failed_windows');
    expect({ status: check.status, named: group?.samples.some(s => s.startsWith(`default:${slug} window `)), retry: group?.remedy?.includes('--force') }).toEqual({ status: 'warn', named: true, retry: true });
    expect((await extract(brain.engine, slug, { failOn })).calls).toEqual([]);
    const forced = await extract(brain.engine, slug, { force: true });
    expect({ calls: forced.calls, receipts: (await derivations(brain.engine, slug)).receipts.filter(Boolean) }).toEqual({ calls: [stuck!], receipts: [] });
  }, 600_000);

  test('provider-wide failures (an auth error, a 503) never count against a window: it is never marked failed and extracts once the provider recovers', async () => {
    const brain = opts.getBrain();
    await caps(brain.engine, 'off');
    await brain.engine.setConfig('facts.extraction_model', PAID_MODEL);
    try {
      for (const [label, failure] of [['auth', () => Object.assign(new Error('invalid x-api-key'), { status: 401 })], ['503', () => Object.assign(new Error('upstream unavailable'), { status: 503 })]] as const) {
        const slug = `notes/provider-down-${label}-${randomUUID().slice(0, 8)}`;
        await brain.seed(slug, chatPage('Provider down', chatDays(3600, 100, 25)));
        let attempts = 0;
        __setChatTransportForTests(async () => { attempts++; throw failure(); });
        const runs: Array<{ attempts: number; failed: number }> = [];
        for (let run = 0; run < WINDOW_FAILURE_LIMIT + 2; run++) {
          attempts = 0;
          const result = await extractProductionRun(brain.engine, slug);
          runs.push({ attempts, failed: result.pages_failed });
        }
        const receipts = (await derivations(brain.engine, slug)).receipts.filter(Boolean).map(r => (r as { kind: string }).kind);
        __setChatTransportForTests(paidTransport);
        const recovered = await extractProductionRun(brain.engine, slug);
        const rows = await derivations(brain.engine, slug);
        expect({ label, runs, receipts, recovered: recovered.pages_failed, states: [...new Set(rows.states)], failedWindows: rows.receipts.filter(r => (r as { kind?: string } | null)?.kind === 'failed_windows').length }).toEqual({
          label, runs: Array.from({ length: WINDOW_FAILURE_LIMIT + 2 }, () => ({ attempts: 1, failed: 1 })), receipts: ['unread_windows'], recovered: 0, states: ['done'], failedWindows: 0 });
      }
    } finally {
      __setChatTransportForTests(null);
      await brain.engine.setConfig('facts.extraction_model', '');
    }
  }, 600_000);

  test('a window marked failed blocks collection across two context changes: every earlier fact stands until a --force run extracts it', async () => {
    const brain = opts.getBrain();
    const slug = `notes/failed-keeps-${randomUUID().slice(0, 8)}`;
    await caps(brain.engine, 'off');
    await brain.seed(slug, chatPage('Keeps T1', chatDays(3700, 100, 26)));
    await extract(brain.engine, slug);
    const before = await factsOf(brain.engine, slug);
    const survivors = (facts: Awaited<ReturnType<typeof factsOf>>) => before.filter(f => facts.some(s => s.id === f.id)).length;
    const stuck: string[] = [];
    for (const title of ['Keeps T2', 'Keeps, a third and longer title']) {
      await brain.seed(slug, chatPage(title, (await brain.body(slug)).truth));
      let first = null as string | null;
      const failOn = (text: string) => { first ??= text; return text === first; };
      for (let run = 1; run <= WINDOW_FAILURE_LIMIT; run++) await extract(brain.engine, slug, { failOn });
      stuck.push(first!);
      const facts = await factsOf(brain.engine, slug);
      expect({ title, survivors: survivors(facts), stamped: await terminalStamps(brain.engine, slug) }).toEqual({ title, survivors: before.length, stamped: 1 });
    }
    const forced = await extract(brain.engine, slug, { force: true });
    const after = await factsOf(brain.engine, slug);
    const rows = await derivations(brain.engine, slug);
    expect({ calls: forced.calls, facts: after.length, survivors: survivors(after), anchored: after.every(f => rows.keys.includes(f.key)) })
      .toEqual({ calls: [stuck[1]!], facts: rows.keys.length, survivors: 0, anchored: true });
  }, 600_000);
}

/** A page that changes shape: oversized turns under a new title, another chat format, prose, and a private transcript. */
export function defineConversationFactsPageChangeCases(opts: { getBrain: () => AppendBrain }): void {
  test('a one-window run on a page of oversized turns after a title of another length deletes nothing (piece numbers move with the title)', async () => {
    const brain = opts.getBrain();
    const slug = `notes/oversized-turns-${randomUUID().slice(0, 8)}`;
    await caps(brain.engine, 'off');
    // Thirty turns of about 100 KB each, a minute apart: each is split into many pieces, one window per few pieces.
    const lines = ['## 2025-04-01', ''];
    for (let t = 0; t < 30; t++) lines.push(`**${['Alice Example', 'Bob Example'][t % 2]}** (9:${String(t).padStart(2, '0')} AM): ${prose(t, 14_000)}.`, '');
    await brain.seed(slug, chatPage('Oversized T1', lines.join('\n')));
    const all = await extract(brain.engine, slug);
    const before = await factsOf(brain.engine, slug);
    expect(before.length).toBe(all.calls.length);
    expect(before.length).toBeGreaterThan(60);
    await brain.seed(slug, chatPage('Oversized turns, retitled with a much longer page title', (await brain.body(slug)).truth));
    const limited = await extract(brain.engine, slug, { segmentLimit: 1 });
    const after = await factsOf(brain.engine, slug);
    expect({ calls: limited.calls.length, after: after.length, cleaned: limited.result.orphan_facts_cleaned, kept: before.filter(f => after.some(a => a.id === f.id)).length })
      .toEqual({ calls: 1, after: before.length + 1, cleaned: 0, kept: before.length });
  }, 600_000);

  test('a page re-imported in another chat format is parsed in its new format, not the grammar its old rows recorded', async () => {
    const brain = opts.getBrain();
    const slug = `notes/reformatted-${randomUUID().slice(0, 8)}`;
    await caps(brain.engine, 'off');
    await brain.seed(slug, chatPage('Reformatted', chatDays(3400, 100, 23)));
    await extract(brain.engine, slug);
    const before = await factsOf(brain.engine, slug);
    expect(before.length).toBeGreaterThan(100);
    await brain.seed(slug, chatPage('Reformatted', timeless(9000, 3)));
    const page = (await brain.engine.getPage(slug, { sourceId: 'default' }))!;
    const truth = (await brain.body(slug)).truth;
    const expected = splitIntoSegments(parseConversation(truth, { page }).messages, { pageTitle: 'Reformatted' }).map(seg => renderSegmentForExtraction('Reformatted', seg));
    expect(parseConversation(truth, { page }).matched_pattern_id).toBe('plain-role-no-time');
    const { calls, result } = await extract(brain.engine, slug);
    const rows = await derivations(brain.engine, slug);
    expect({ calls: calls.length, same: [...calls].sort().join('\n') === [...expected].sort().join('\n'), nonExtractable: result.pages_marked_non_extractable,
      facts: (await factsOf(brain.engine, slug)).length, states: [...new Set(rows.states)] })
      .toEqual({ calls: expected.length, same: true, nonExtractable: 0, facts: expected.length, states: ['done'] });
  }, 600_000);

  test('a page that stops being a transcript settles as non-extractable and its conversation facts are collected, under --force too', async () => {
    const brain = opts.getBrain();
    const slug = `notes/unparsed-${randomUUID().slice(0, 8)}`;
    await caps(brain.engine, 'off');
    await brain.seed(slug, chatPage('Unparsed', chatDays(3500, 100, 24)));
    await extract(brain.engine, slug);
    const before = (await factsOf(brain.engine, slug)).length;
    expect(before).toBeGreaterThan(100);
    const prose = Array.from({ length: 6000 }, (_, i) => `Paragraph ${i} of the notes: the roadmap review moved to next quarter and the budget stays flat.`).join('\n\n');
    await brain.seed(slug, chatPage('Unparsed', prose));
    const { calls, result } = await extract(brain.engine, slug);
    const rows = await derivations(brain.engine, slug);
    expect({ calls: calls.length, failed: result.pages_failed, nonExtractable: result.pages_marked_non_extractable, cleaned: result.orphan_facts_cleaned,
      facts: (await factsOf(brain.engine, slug)).length, states: [...new Set(rows.states)], receipts: rows.receipts.filter(Boolean) })
      .toEqual({ calls: 0, failed: 0, nonExtractable: 1, cleaned: before + 1, facts: 0, states: ['done'], receipts: [] });
    const forced = await extract(brain.engine, slug, { force: true });
    expect({ calls: forced.calls.length, failed: forced.result.pages_failed, facts: (await factsOf(brain.engine, slug)).length }).toEqual({ calls: 0, failed: 0, facts: 0 });
    const check = (await extractionInputTruncatedEntry.run({ engine: brain.engine } as unknown as DoctorContext) as Check[]).find(c => c.name === 'extraction_input_truncated')!;
    const groups = ((check.details as { groups?: Array<{ pipeline: string; kind: string; samples: string[] }> } | undefined)?.groups ?? []);
    expect(groups.some(g => g.kind === 'no_messages' && g.samples.includes(`default:${slug}`))).toBe(false);
  }, 600_000);

  test('facts from a private segmented transcript stay private on a world-default brain, on the import run and on the incremental run after an append', async () => {
    const brain = opts.getBrain();
    const slug = `notes/private-chat-${randomUUID().slice(0, 8)}`;
    const privatePage = (body: string) => chatPage('Private chat', body).replace('date: 2025-01-01', 'date: 2025-01-01\nvisibility: private');
    const visibilities = async () => {
      const ids = (await factsOf(brain.engine, slug)).map(f => f.id);
      const rows = await brain.engine.executeRaw<{ visibility: string }>('SELECT DISTINCT visibility FROM facts WHERE id = ANY($1::bigint[])', [ids]);
      return { facts: ids.length, visibility: rows.map(r => r.visibility) };
    };
    await caps(brain.engine, 'off');
    await brain.engine.setConfig('facts.default_visibility', 'world');
    await brain.seed(slug, privatePage(chatDays(0, 100, 7)));
    const first = await extract(brain.engine, slug);
    expect((await derivations(brain.engine, slug)).live.length).toBeGreaterThan(2);
    expect(await visibilities()).toEqual({ facts: first.calls.length, visibility: ['private'] });
    await brain.seed(slug, privatePage(chatDays(0, 101, 7)));
    const second = await extract(brain.engine, slug);
    expect(second.calls.length).toBeGreaterThan(0);
    expect(second.calls.length).toBeLessThan(first.calls.length);
    expect((await visibilities()).visibility).toEqual(['private']);
  }, 600_000);
}

/** A production-extractor run (no injected extractor): the gateway's fake transport answers or fails. */
async function extractProductionRun(engine: BrainEngine, slug: string) {
  const { runExtractConversationFactsCore } = await import('../../src/commands/extract-conversation-facts.ts');
  return runExtractConversationFactsCore(engine, { sourceId: 'default', slugs: [slug], sleepMs: 0 });
}
