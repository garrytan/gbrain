/**
 * Conversation facts deletion invariant on a segmented page (wave-b spec 8.2; PR 4 lane 4b round 5), shared by the PGLite
 * arms (test/large-pages/conversation-facts-incremental-{deletion,held,grammar,grammar-flag,grammar-choice}.test.ts) and
 * the Postgres arms (test/e2e/conversation-facts-incremental-<same>-postgres.test.ts). Fake extractors only; appends go through the remote
 * append_page operation (remote=true).
 *
 * 1. Protects: a partial run only adds and replaces facts per window key, and a row claims exactly the facts it holds:
 *    two interrupted runs after an append lose no fact a row claims (F1); a window marked failed right after an append
 *    leaves the facts of the window the append retired standing (F2); a run that re-extracts every window under an
 *    unchanged key (a model change) leaves one batch per key (F6); rows from an older derivation version are never
 *    read as window positions (F9); the grammar is detected over the whole page, not its head (F3), and that read is
 *    counted; a page that reads as a transcript yet parses no message changes nothing and leaves a no_messages receipt;
 *    a transcript whose format the whole page no longer shows runs on the format it recorded while a message still
 *    parses under it (N1, R4), in the recorded format that parses the most messages and only while it parses more
 *    than twice any other (G1), and a page with no format that parses anything is non-extractable and collected, with
 *    or without rows (R3); an append that commits after the old version check and before the publication locks
 *    the page leaves the run unsettled (N2).
 * 2. Fails when: anything but an exact-key replacement or a fully settled collection deletes a fact, a moved window's
 *    old row keeps claiming it, a settling run keeps the old batch beside the new one, the head of a page picks its
 *    grammar, a lost grammar collects a transcript's facts (under a stale recorded format included) or holds a prose page's facts forever, or a run settles a page version it did not read.
 */
import { expect, spyOn, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { AppendBrain } from './append-brain.ts';
import { PAGE_EMBED_CAP_KEY } from '../../src/core/page-embedding-budget.ts';
import { PAGE_DERIVATION_CAP_KEY } from '../../src/core/page-spend.ts';
import * as parser from '../../src/core/conversation-parser/parse.ts';
import { renderSegmentForExtraction, splitIntoSegments } from '../../src/core/facts/conversation-windows.ts';
import { WINDOW_FAILURE_LIMIT } from '../../src/core/facts/conversation-incremental.ts';
import { conversationDetectionWork } from '../../src/core/page-body/segment-conversation.ts';
import { extractionInputTruncatedEntry } from '../../src/commands/doctor/checks/extraction-input.ts';
import type { DoctorContext } from '../../src/commands/doctor/context.ts';
import type { Check } from '../../src/commands/doctor.ts';
import { chatDays, chatPage, derivations, extract, factsOf, SOURCE, turns } from './conversation-facts-incremental-cases.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { runExtractConversationFacts, runExtractConversationFactsCore } from '../../src/commands/extract-conversation-facts.ts';

const caps = async (engine: BrainEngine, usd: string) => { await engine.setConfig(PAGE_DERIVATION_CAP_KEY, usd); await engine.setConfig(PAGE_EMBED_CAP_KEY, usd); };

/** Window records some row claims whose facts in the table are not exactly what the record says. */
export async function claimMismatches(engine: BrainEngine, slug: string) {
  const rows = await derivations(engine, slug);
  const facts = await factsOf(engine, slug);
  const count = new Map<string, number>();
  for (const f of facts) count.set(f.key, (count.get(f.key) ?? 0) + 1);
  return rows.rows.flatMap(row => ((row.output as { windows?: Array<{ ordinal: number; sha: string; facts: number }> })?.windows ?? [])
    .map(w => ({ key: `${row.occurrenceId}:${w.ordinal}:${w.sha}`, claimed: w.facts }))
    .filter(w => (count.get(w.key) ?? 0) !== w.claimed).map(w => ({ ...w, held: count.get(w.key) ?? 0 })));
}

/** A meeting-notes transcript (`**Name:** text`, no times) whose turns carry `notes` continuation lines each: sparse enough
 *  that text added around it can tip the whole-page density test. */
const sparseTranscript = (count: number, notes: number) => Array.from({ length: count }, (_, t) => [`**${['Alice Example', 'Bob Example', 'Carol Example'][t % 3]}:** turn ${t} opens the item`,
  ...Array.from({ length: notes }, (_, j) => `note ${j} of item ${t} on the roadmap review`)].join('\n')).join('\n\n');
const references = (count: number) => Array.from({ length: count }, (_, i) => `Reference ${i}: the roadmap review moved to next quarter and the budget stays flat.`).join('\n\n');

/** Three runs (two plain, one --force) on a page whose grammar is no longer detected: what each reported and left. */
const lostGrammarRuns = async (brain: AppendBrain, slug: string) => {
  const out: Array<Record<string, unknown>> = [];
  for (const force of [false, false, true]) {
    const { calls, result } = await extract(brain.engine, slug, { force });
    const rows = await derivations(brain.engine, slug);
    out.push({ calls: calls.length, failed: result.pages_failed, held: result.pages_detection_ambiguous ?? 0, nonExtractable: result.pages_marked_non_extractable,
      facts: (await factsOf(brain.engine, slug)).length, windows: rows.keys.length, mismatches: (await claimMismatches(brain.engine, slug)).length });
  }
  return out;
};
const undetected = async (brain: AppendBrain, slug: string) => {
  const page = (await brain.engine.getPage(slug, { sourceId: 'default' }))!;
  return parser.parseConversation((await brain.body(slug)).truth, { page }).matched_pattern_id ?? null;
};
/** A held run: no call, no failure, nothing added or removed. */
const heldRun = (facts: number, windows: number) => ({ calls: 0, failed: 0, held: 1, nonExtractable: 0, facts, windows, mismatches: 0 });
/** Every conversation_facts row of the page, as it stands. */
const rowState = async (brain: AppendBrain, slug: string) => JSON.stringify((await derivations(brain.engine, slug)).rows.map(row => [row.occurrenceId, row.output, row.state, row.receipt]));
/** What doctor reports: the held pages with each format's count, and whether extraction_input_truncated (the spend-cap remedy) names anything. */
const heldPages = async (brain: AppendBrain) => {
  const checks = await extractionInputTruncatedEntry.run({ engine: brain.engine } as unknown as DoctorContext) as Check[];
  const held = checks.find(c => c.name === 'conversation_detection_ambiguous')!;
  return { status: held.status, samples: ((held.details as { samples?: Array<{ page: string; grammars: Record<string, number> }> } | undefined)?.samples ?? []),
    fix: held.fix?.argv ?? null, truncated: JSON.stringify(checks.find(c => c.name === 'extraction_input_truncated')?.details ?? {}) };
};

/**
 * A page whose rows record two formats, with none detected over it (round-8 review P1 and P2): a bold-name transcript
 * extracted in full, then a plain-role one extracted one window (its rows record plain-role, the rest bold-name), then
 * reference prose, the plain-role transcript and a section quoting `quotes` short bold-name turns under a new title.
 */
const mixedFormats = async (brain: AppendBrain, slug: string, quotes: number) => {
  await caps(brain.engine, 'off');
  const old = Array.from({ length: 100 }, (_, i) => `**${i % 2 ? 'Bob Example' : 'Alice Example'}:** old turn ${i} ${'detail '.repeat(1600)}`).join('\n');
  await brain.seed(slug, chatPage('Old transcript', old));
  await extract(brain.engine, slug);
  const current = Array.from({ length: 200 }, (_, i) => `${i % 2 ? 'Assistant' : 'User'}: current turn ${i} ${'present '.repeat(700)}`).join('\n');
  await brain.seed(slug, chatPage('Current transcript', current));
  await extract(brain.engine, slug, { segmentLimit: 1 });
  expect(await recordedGrammars(brain, slug)).toEqual(['bold-name-no-time', 'plain-role-no-time']);
  const quoted = Array.from({ length: quotes }, (_, i) => `**${i % 2 ? 'Bob Example' : 'Alice Example'}:** quoted historical turn ${i}.`).join('\n');
  const prose = Array.from({ length: 12_000 }, (_, i) => `Reference paragraph ${i} explains the migration.`).join('\n');
  await brain.seed(slug, chatPage('Combined transcript archive', `${prose}\n${current}\n## Quoted historical transcript\n${quoted}`));
  expect(await undetected(brain, slug)).toBeNull();
  return { prose, current, quoted };
};
const recordedGrammars = async (brain: AppendBrain, slug: string) =>
  [...new Set((await derivations(brain.engine, slug)).rows.map(row => (row.output as { pattern?: string | null }).pattern ?? null))].sort();
/** The plain-role turns the run's windows carry. */
const turnsIn = (calls: string[]) => new Set(calls.flatMap(text => [...text.matchAll(/current turn (\d+) /g)].map(m => m[1]))).size;

/** Deletion only by exact-key replacement or a settled collection: F1, F2, F6, F9 and N2. */
export function defineConversationFactsDeletionCases(opts: { getBrain: () => AppendBrain }): void {
  test('F1: two interrupted runs after an append lose no fact and leave every row claiming exactly the facts it holds', async () => {
    const brain = opts.getBrain();
    const slug = `notes/interrupted-moves-${randomUUID().slice(0, 8)}`;
    await caps(brain.engine, 'off');
    await brain.seed(slug, chatPage('Interrupted moves', chatDays(3800, 100, 31)));
    await extract(brain.engine, slug);
    const before = await factsOf(brain.engine, slug);
    // Three hundred more turns on the last day: its windows move to the occurrences the append makes.
    expect(await brain.call('append_page', { slug, text: turns(3899, 50, 300, 31), request_id: randomUUID() }, { remote: true })).toMatchObject({ isError: false });
    const outcomes: unknown[] = [];
    for (const abortAfter of [2, 3]) {
      await extract(brain.engine, slug, { abortAfter }).catch(() => undefined);
      const now = await factsOf(brain.engine, slug);
      outcomes.push({ lost: before.filter(f => !now.some(n => n.id === f.id)).length, mismatches: (await claimMismatches(brain.engine, slug)).slice(0, 3) });
    }
    expect(outcomes).toEqual([{ lost: 0, mismatches: [] }, { lost: 0, mismatches: [] }]);
    await extract(brain.engine, slug);
    const after = await factsOf(brain.engine, slug);
    const rows = await derivations(brain.engine, slug);
    expect({ mismatches: await claimMismatches(brain.engine, slug), facts: after.length, anchored: after.every(f => rows.keys.includes(f.key)), states: [...new Set(rows.states)] })
      .toEqual({ mismatches: [], facts: rows.keys.length, anchored: true, states: ['done'] });
  }, 600_000);

  test('F2: a window marked failed right after an append leaves the facts of the window the append retired standing', async () => {
    const brain = opts.getBrain();
    const slug = `notes/failed-after-append-${randomUUID().slice(0, 8)}`;
    await caps(brain.engine, 'off');
    await brain.seed(slug, chatPage('Failed after append', chatDays(3900, 100, 32)));
    await extract(brain.engine, slug);
    const before = await factsOf(brain.engine, slug);
    // Two more turns on the last day: its last window grows, and the window it was is retired.
    expect(await brain.call('append_page', { slug, text: turns(3999, 50, 2, 32), request_id: randomUUID() }, { remote: true })).toMatchObject({ isError: false });
    let grown = null as string | null;
    const failOn = (text: string) => { grown ??= text; return text === grown; };
    for (let run = 1; run <= WINDOW_FAILURE_LIMIT; run++) await extract(brain.engine, slug, { failOn });
    const after = await factsOf(brain.engine, slug);
    const rows = await derivations(brain.engine, slug);
    expect({ lost: before.filter(f => !after.some(a => a.id === f.id)).length, failed: rows.receipts.filter(r => (r as { kind?: string } | null)?.kind === 'failed_windows').length,
      mismatches: await claimMismatches(brain.engine, slug) }).toEqual({ lost: 0, failed: 1, mismatches: [] });
  }, 600_000);

  test('F6: a model change re-extracts every window under its unchanged key and leaves one batch per key', async () => {
    const brain = opts.getBrain();
    const slug = `notes/model-change-${randomUUID().slice(0, 8)}`;
    await caps(brain.engine, 'off');
    await brain.seed(slug, chatPage('Model change', chatDays(4000, 100, 33)));
    await extract(brain.engine, slug);
    const before = await factsOf(brain.engine, slug);
    await brain.engine.setConfig('facts.extraction_model', 'anthropic:claude-haiku-4-5');
    try {
      const { calls, result } = await extract(brain.engine, slug, { force: true });
      const after = await factsOf(brain.engine, slug);
      const rows = await derivations(brain.engine, slug);
      const perKey = new Map<string, number>();
      for (const f of after) perKey.set(f.key, (perKey.get(f.key) ?? 0) + 1);
      expect({ calls: calls.length, facts: after.length, keys: new Set(rows.keys).size, sameKeys: [...perKey.keys()].sort().join() === before.map(f => f.key).sort().join(),
        doubled: [...perKey.values()].filter(n => n > 1).length, survivors: before.filter(f => after.some(a => a.id === f.id)).length, cleaned: result.orphan_facts_cleaned })
        .toEqual({ calls: before.length, facts: before.length, keys: before.length, sameKeys: true, doubled: 0, survivors: 0, cleaned: before.length + 1 });
    } finally {
      await brain.engine.setConfig('facts.extraction_model', '');
    }
  }, 600_000);

  test('F9: rows from an older derivation version (round-3 spans) are never read as positions: a one-window run after an append deletes nothing', async () => {
    const brain = opts.getBrain();
    const slug = `notes/old-rows-${randomUUID().slice(0, 8)}`;
    await caps(brain.engine, 'off');
    await brain.seed(slug, chatPage('Old rows', chatDays(4100, 100, 34)));
    await extract(brain.engine, slug);
    const before = await factsOf(brain.engine, slug);
    const { pageId, rows } = await derivations(brain.engine, slug);
    // Version 1 rows: spans were [occurrence, ordinal, occurrence, ordinal].
    for (const row of rows) {
      const output = row.output as { windows: Array<Record<string, unknown>> };
      const windows = output.windows.map(w => ({ ...w, span: [row.occurrenceId, 0, row.occurrenceId, 40] }));
      await brain.engine.executeRaw(`UPDATE page_segment_derivations SET pipeline_version = 1, output = $1::jsonb WHERE page_id = $2 AND pipeline = 'conversation_facts' AND occurrence_id = $3`,
        [JSON.stringify({ ...output, windows }), pageId, row.occurrenceId]);
    }
    expect(await brain.call('append_page', { slug, text: turns(4199, 50, 2, 34), request_id: randomUUID() }, { remote: true })).toMatchObject({ isError: false });
    const limited = await extract(brain.engine, slug, { segmentLimit: 1 });
    const after = await factsOf(brain.engine, slug);
    expect({ calls: limited.calls.length, facts: after.length, lost: before.filter(f => !after.some(a => a.id === f.id)).length, cleaned: limited.result.orphan_facts_cleaned })
      .toEqual({ calls: 1, facts: before.length + 1, lost: 0, cleaned: 0 });
  }, 600_000);

  test('N2: an append_page that commits right after the old version check (before the publication locks the page) leaves the run unsettled with its facts kept; the next run settles it', async () => {
    const brain = opts.getBrain();
    const slug = `notes/concurrent-append-${randomUUID().slice(0, 8)}`;
    await caps(brain.engine, 'off');
    await brain.seed(slug, chatPage('Concurrent append', chatDays(4400, 100, 37)));
    await extract(brain.engine, slug);
    // Two new days: one or two new windows, fewer than a checkpoint, so the only publication after them is the final one.
    expect(await brain.call('append_page', { slug, text: chatDays(4500, 2, 37), request_id: randomUUID() }, { remote: true })).toMatchObject({ isError: false });
    const before = (await factsOf(brain.engine, slug)).map(f => f.id);
    let armed = false;
    let injected = 0;
    const transaction = brain.engine.transaction;
    // The outermost transaction the publication opens (a transaction engine inherits the spy; its nested calls are skipped).
    const spy = spyOn(brain.engine, 'transaction').mockImplementation((async function (this: BrainEngine, ...args: Parameters<BrainEngine['transaction']>) {
      if (armed && this === brain.engine && (new Error().stack ?? '').includes('maintenanceTransaction')) {
        armed = false;
        injected++;
        expect(await brain.call('append_page', { slug, text: chatDays(4502, 1, 37), request_id: randomUUID() }, { remote: true })).toMatchObject({ isError: false });
      }
      return transaction.apply(this, args);
    }) as typeof brain.engine.transaction);
    let run: Awaited<ReturnType<typeof extract>>;
    try {
      run = await extract(brain.engine, slug, { failOn: () => { armed = true; return false; } });
    } finally {
      spy.mockRestore();
    }
    const kept = await factsOf(brain.engine, slug);
    expect({ injected, calls: run.calls.length > 0, failed: run.result.pages_failed, processed: run.result.pages_processed, cleaned: run.result.orphan_facts_cleaned,
      lost: before.filter(id => !kept.some(f => f.id === id)).length, reason: run.result.failed_pages[0]?.error ?? null })
      .toEqual({ injected: 1, calls: true, failed: 1, processed: 0, cleaned: 0, lost: 0, reason: 'the page changed during extraction; left unfinished for replay' });
    const next = await extract(brain.engine, slug);
    const rows = await derivations(brain.engine, slug);
    expect({ calls: next.calls.length > 0, processed: next.result.pages_processed, mismatches: await claimMismatches(brain.engine, slug), states: [...new Set(rows.states)],
      facts: (await factsOf(brain.engine, slug)).length }).toEqual({ calls: true, processed: 1, mismatches: [], states: ['done'], facts: rows.keys.length });
  }, 600_000);
}

/** A transcript whose format the whole page no longer shows is held while a message still parses: N1, R4 and the held-page reuse. */
export function defineConversationFactsHeldCases(opts: { getBrain: () => AppendBrain }): void {
  test('N1: a transcript whose format the whole page no longer shows (references added, title changed) is held: no call, every fact and row kept, --force too, and doctor lists it with its format\'s count', async () => {
    const brain = opts.getBrain();
    const slug = `notes/grammar-lost-${randomUUID().slice(0, 8)}`;
    await caps(brain.engine, 'off');
    const transcript = sparseTranscript(3000, 18);
    await brain.seed(slug, chatPage('Grammar lost', transcript));
    const first = await extract(brain.engine, slug);
    const before = await factsOf(brain.engine, slug);
    expect({ processed: first.result.pages_processed, facts: before.length > 100 }).toEqual({ processed: 1, facts: true });
    await brain.seed(slug, chatPage('Grammar lost, renamed', `${transcript}\n\n## References\n\n${references(3000)}`));
    expect(await undetected(brain, slug)).toBeNull();
    const rows = await rowState(brain, slug);
    const runs = [];
    for (const force of [false, true]) {
      const { calls, result } = await extract(brain.engine, slug, { force });
      runs.push({ calls: calls.length, failed: result.pages_failed, held: result.pages_detection_ambiguous ?? 0, nonExtractable: result.pages_marked_non_extractable,
        facts: (await factsOf(brain.engine, slug)).map(f => f.id), rows: await rowState(brain, slug) });
    }
    const doctor = await heldPages(brain);
    const run = { calls: 0, failed: 0, held: 1, nonExtractable: 0, facts: before.map(f => f.id), rows };
    expect({ runs, status: doctor.status, listed: doctor.samples.find(s => s.page === `default:${slug}`)?.grammars, truncated: doctor.truncated.includes(slug) })
      .toEqual({ runs: [run, run], status: 'warn', listed: { 'bold-name-no-time': 3000 }, truncated: false });
  }, 600_000);

  test('R4 (case A): a transcript rewritten to prose that keeps one or three quoted message lines is held every run, --force too: its facts wait for the operator\'s call', async () => {
    const brain = opts.getBrain();
    const out: Record<string, unknown> = {};
    const expected: Record<string, unknown> = {};
    for (const quoted of [1, 3]) {
      const slug = `notes/quoted-line-${randomUUID().slice(0, 8)}`;
      await caps(brain.engine, 'off');
      // Each pass seeds its own transcript: a source never stores a claim twice (#7043), so a repeat of the first pass's
      // transcript would extract no new facts.
      await brain.seed(slug, chatPage('Was a chat', chatDays(4600, 100, 380 + quoted)));
      await extract(brain.engine, slug);
      const facts = (await factsOf(brain.engine, slug)).length;
      expect(facts).toBeGreaterThan(100);
      const windows = (await derivations(brain.engine, slug)).keys.length;
      const lines = Array.from({ length: quoted }, (_, i) => `**${i % 2 ? 'Bob Example' : 'Alice Example'}** (1:0${5 + i} PM): the orchard review moved, part ${i}.`).join('\n\n');
      await brain.seed(slug, chatPage('Was a chat', `${references(9000)}\n\nLines we quoted from the old chat:\n\n${lines}`));
      expect(await undetected(brain, slug)).toBeNull();
      out[quoted] = await lostGrammarRuns(brain, slug);
      expected[quoted] = [heldRun(facts, windows), heldRun(facts, windows), heldRun(facts, windows)];
    }
    expect(out).toEqual(expected);
  }, 600_000);

  test('a held page keeps its hold while its version is unchanged: the next plain run reads no detection byte; a --force run and a changed page check it again', async () => {
    const brain = opts.getBrain();
    const slug = `notes/held-reuse-${randomUUID().slice(0, 8)}`;
    await caps(brain.engine, 'off');
    await brain.seed(slug, chatPage('Was a chat', chatDays(4800, 100, 41)));
    await extract(brain.engine, slug);
    const quoted = '**Alice Example** (1:05 PM): the orchard review moved.';
    await brain.seed(slug, chatPage('Was a chat', `${references(9000)}\n\nA line we quoted:\n\n${quoted}`));
    expect(await undetected(brain, slug)).toBeNull();
    const facts = (await factsOf(brain.engine, slug)).map(f => f.id);
    const run = async (force = false) => {
      const before = conversationDetectionWork.bytes;
      const { calls, result } = await extract(brain.engine, slug, { force });
      return { read: conversationDetectionWork.bytes === before ? 'nothing' : 'the page', calls: calls.length, held: result.pages_detection_ambiguous ?? 0, failed: result.pages_failed,
        facts: (await factsOf(brain.engine, slug)).map(f => f.id) };
    };
    const runs: Record<string, unknown> = { first: await run(), again: await run(), forced: await run(true), afterForce: await run() };
    await brain.seed(slug, chatPage('Was a chat', `${references(9001)}\n\nA line we quoted:\n\n${quoted}`));
    runs.changed = await run();
    runs.afterChange = await run();
    const held = (read: string) => ({ read, calls: 0, held: 1, failed: 0, facts });
    expect(runs).toEqual({ first: held('the page'), again: held('nothing'), forced: held('the page'), afterForce: held('nothing'), changed: held('the page'), afterChange: held('nothing') });
  }, 600_000);

  test('R4 (cases B, B-heading): a transcript with reference lines added, before and after they move below a heading, is held every run with its facts kept', async () => {
    const brain = opts.getBrain();
    const slug = `notes/references-${randomUUID().slice(0, 8)}`;
    await caps(brain.engine, 'off');
    const transcript = `**Alice Example:** The old code is 4400.\n**Bob Example:** The launch is on Friday.\n**Alice Example:** ${'detail '.repeat(160_000)}\n`;
    const refs = Array.from({ length: 100 }, (_, i) => `Additional reference paragraph ${i}.`).join('\n');
    await brain.seed(slug, chatPage('References', transcript));
    await extract(brain.engine, slug);
    const facts = (await factsOf(brain.engine, slug)).length;
    const windows = (await derivations(brain.engine, slug)).keys.length;
    expect(facts).toBeGreaterThan(0);
    await brain.seed(slug, chatPage('References, retitled', transcript + refs));
    expect(await undetected(brain, slug)).toBeNull();
    const added = await lostGrammarRuns(brain, slug);
    await brain.seed(slug, chatPage('References, retitled again', `${transcript}\n## References\n\n${refs}`));
    expect(await undetected(brain, slug)).toBeNull();
    const heading = await lostGrammarRuns(brain, slug);
    const held = [heldRun(facts, windows), heldRun(facts, windows), heldRun(facts, windows)];
    expect({ added, heading }).toEqual({ added: held, heading: held });
  }, 600_000);
}

/** Which grammar a run reads: the whole page (F3), no_messages, two recorded formats (G1), p7 and pages with no format (R3). */
export function defineConversationFactsGrammarCases(opts: { getBrain: () => AppendBrain }): void {
  test('F3: the grammar is the whole page\'s, not its head\'s; the detection read is counted once, and a run on a pinned grammar reads none', async () => {
    const brain = opts.getBrain();
    const slug = `notes/preamble-${randomUUID().slice(0, 8)}`;
    await caps(brain.engine, 'off');
    const preamble = Array.from({ length: 4000 }, (_, i) => (i % 4 === 3 ? 'User: a line of the preamble' : `Notes line ${i} about the roadmap review.`)).join('\n');
    await brain.seed(slug, chatPage('Preamble', `${preamble}\n\n${chatDays(4200, 100, 35)}`));
    const page = (await brain.engine.getPage(slug, { sourceId: 'default' }))!;
    const truth = (await brain.body(slug)).truth;
    expect(parser.parseConversation(truth.slice(0, 64 * 1024), { page }).matched_pattern_id).toBe('plain-role-no-time');
    expect(parser.parseConversation(truth, { page }).matched_pattern_id).toBe('bold-paren-time-12h');
    const expected = splitIntoSegments(parser.parseConversation(truth, { page }).messages, { pageTitle: 'Preamble' }).map(seg => renderSegmentForExtraction('Preamble', seg));
    const detected = conversationDetectionWork.bytes;
    const { calls } = await extract(brain.engine, slug, { segmentLimit: 5 });
    const read = conversationDetectionWork.bytes - detected;
    const rest = await extract(brain.engine, slug);
    const all = [...calls, ...rest.calls];
    expect({ read, again: conversationDetectionWork.bytes - detected - read, same: [...all].sort().join('\n') === [...expected].sort().join('\n') })
      .toEqual({ read: Buffer.byteLength(truth), again: 0, same: true });
  }, 600_000);

  test('a page that reads as a transcript yet parses no message changes nothing and leaves a no_messages receipt doctor lists', async () => {
    const brain = opts.getBrain();
    const slug = `notes/parser-fault-${randomUUID().slice(0, 8)}`;
    await caps(brain.engine, 'off');
    await brain.seed(slug, chatPage('Parser fault', chatDays(4300, 100, 36)));
    await extract(brain.engine, slug);
    const before = (await factsOf(brain.engine, slug)).map(f => f.id);
    await brain.seed(slug, chatPage('Parser fault', Array.from({ length: 8000 }, (_, i) => `Paragraph ${i} of the notes: the roadmap review moved to next quarter and the budget stays flat.`).join('\n\n')));
    // A detector fault: it reports a transcript format the page's text does not hold.
    const spy = spyOn(parser, 'createPatternDetector').mockImplementation(() => ({ push() {}, finish: () => 'bold-paren-time-12h' }));
    try {
      const { calls, result } = await extract(brain.engine, slug);
      expect({ calls: calls.length, failed: result.pages_failed, nonExtractable: result.pages_marked_non_extractable, cleaned: result.orphan_facts_cleaned,
        facts: (await factsOf(brain.engine, slug)).map(f => f.id) }).toEqual({ calls: 0, failed: 1, nonExtractable: 0, cleaned: 0, facts: before });
    } finally {
      spy.mockRestore();
    }
    const check = (await extractionInputTruncatedEntry.run({ engine: brain.engine } as unknown as DoctorContext) as Check[]).find(c => c.name === 'extraction_input_truncated')!;
    const groups = (check.details as { groups: Array<{ pipeline: string; kind: string; samples: string[]; remedy: string | null }> }).groups;
    const group = groups.find(g => g.pipeline === 'conversation_facts' && g.kind === 'no_messages');
    expect({ listed: group?.samples.includes(`default:${slug}`), fault: group?.remedy?.includes('parser fault') }).toEqual({ listed: true, fault: true });
  }, 600_000);

  test('G1 (round-8 P1, P2): with two recorded formats and none detected, a current transcript beside 2, 250 or 600 quoted turns of the old format is held: no call, every fact and row kept, --force too, never a failed page, and doctor lists it with each format\'s count instead of a spend cap', async () => {
    const brain = opts.getBrain();
    const out: Record<number, unknown> = {};
    const expected: Record<number, unknown> = {};
    for (const quotes of [2, 250, 600]) {
      const slug = `notes/mixed-format-${quotes}-${randomUUID().slice(0, 8)}`;
      await mixedFormats(brain, slug, quotes);
      const facts = (await factsOf(brain.engine, slug)).map(f => f.id);
      const rows = await rowState(brain, slug);
      const runs = [];
      for (const force of [false, true]) {
        const { calls, result } = await extract(brain.engine, slug, { force });
        runs.push({ calls: calls.length, failed: result.pages_failed, held: result.pages_detection_ambiguous ?? 0, facts: (await factsOf(brain.engine, slug)).map(f => f.id), rows: await rowState(brain, slug) });
      }
      const doctor = await heldPages(brain);
      out[quotes] = { runs, status: doctor.status, listed: doctor.samples.find(s => s.page === `default:${slug}`)?.grammars, truncated: doctor.truncated.includes(slug), fix: doctor.fix?.includes('--grammar') };
      const run = { calls: 0, failed: 0, held: 1, facts, rows };
      expected[quotes] = { runs: [run, run], status: 'warn', listed: { 'plain-role-no-time': 200, 'bold-name-no-time': quotes }, truncated: false, fix: true };
    }
    expect(out).toEqual(expected);
  }, 600_000);

  test('p7: two transcripts inside prose on a page with no recorded format, whose facts the whole-page extractor left, are held, not collected as a page that is no transcript', async () => {
    const brain = opts.getBrain();
    const slug = `notes/two-formats-${randomUUID().slice(0, 8)}`;
    await caps(brain.engine, 'off');
    const plain = Array.from({ length: 100 }, (_, i) => `${i % 2 ? 'Assistant' : 'User'}: plain turn ${i} ${'present '.repeat(700)}`).join('\n');
    const bold = Array.from({ length: 100 }, (_, i) => `**${i % 2 ? 'Bob Example' : 'Alice Example'}:** bold turn ${i} ${'legacy '.repeat(700)}`).join('\n');
    await brain.seed(slug, chatPage('Two formats', plain));
    await extract(brain.engine, slug);
    await brain.seed(slug, chatPage('Two formats', bold));
    await extract(brain.engine, slug);
    const facts = (await factsOf(brain.engine, slug)).map(f => f.id);
    expect({ facts: facts.length >= 100, rows: (await derivations(brain.engine, slug)).rows.length }).toEqual({ facts: true, rows: 0 });
    const prose = Array.from({ length: 12_000 }, (_, i) => `Paragraph ${i} with unrelated reference material.`).join('\n');
    await brain.seed(slug, chatPage('Two formats merged', `${prose}\n${plain}\n\n${bold}`));
    expect({ undetected: await undetected(brain, slug), storage: (await brain.body(slug)).storage }).toEqual({ undetected: null, storage: 'segmented' });
    const runs = [];
    for (const force of [false, false, true]) {
      const { calls, result } = await extract(brain.engine, slug, { force });
      runs.push({ calls: calls.length, failed: result.pages_failed, held: result.pages_detection_ambiguous ?? 0, nonExtractable: result.pages_marked_non_extractable, facts: (await factsOf(brain.engine, slug)).map(f => f.id) });
    }
    const run = { calls: 0, failed: 0, held: 1, nonExtractable: 0, facts };
    expect({ runs, listed: (await heldPages(brain)).samples.find(s => s.page === `default:${slug}`)?.grammars })
      .toEqual({ runs: [run, run, run], listed: { 'plain-role-no-time': 100, 'bold-name-no-time': 100 } });
  }, 600_000);

  test('R3 (cases C, C2): a page turned to pure prose whose facts have no recorded grammar (rows without one, or no rows at all) is non-extractable and its facts are collected, --force too', async () => {
    const brain = opts.getBrain();
    const out: Record<string, unknown> = {};
    for (const shape of ['rows without a grammar', 'no rows'] as const) {
      const slug = `notes/no-grammar-${randomUUID().slice(0, 8)}`;
      await caps(brain.engine, 'off');
      await brain.seed(slug, chatPage('Was a chat', chatDays(4700, 100, 39)));
      await extract(brain.engine, slug);
      const { pageId } = await derivations(brain.engine, slug);
      if (shape === 'no rows') await brain.engine.executeRaw("DELETE FROM page_segment_derivations WHERE page_id = $1 AND pipeline = 'conversation_facts'", [pageId]);
      else await brain.engine.executeRaw("UPDATE page_segment_derivations SET output = output - 'pattern' WHERE page_id = $1 AND pipeline = 'conversation_facts'", [pageId]);
      const before = (await factsOf(brain.engine, slug)).length;
      await brain.seed(slug, chatPage('Was a chat', references(9000)));
      expect(await undetected(brain, slug)).toBeNull();
      out[shape] = { before: before > 100, runs: await lostGrammarRuns(brain, slug) };
    }
    const collected = { calls: 0, failed: 0, held: 0, nonExtractable: 1, facts: 0, windows: 0, mismatches: 0 };
    const settled = { ...collected, nonExtractable: 0 };
    expect(out).toEqual({ 'rows without a grammar': { before: true, runs: [collected, settled, collected] }, 'no rows': { before: true, runs: [collected, settled, collected] } });
  }, 600_000);

  test('R3 (legacy): facts the inline extractor left on a small transcript are collected once the page is segmented prose, --force too', async () => {
    const brain = opts.getBrain();
    const slug = `notes/former-conversation-${randomUUID().slice(0, 8)}`;
    await caps(brain.engine, 'off');
    await brain.seed(slug, chatPage('Former conversation', 'user: The fixture door code was 8844.\nassistant: Noted the fixture door code.\n'));
    await extract(brain.engine, slug);
    expect((await factsOf(brain.engine, slug)).length).toBe(1);
    await brain.seed(slug, chatPage('Former conversation', 'Ordinary reference prose with no speaker labels or message lines.\n'.repeat(18_000)));
    expect((await brain.body(slug)).storage).toBe('segmented');
    const runs = [];
    for (const force of [false, true]) {
      const { result } = await extract(brain.engine, slug, { force });
      runs.push({ failed: result.pages_failed, nonExtractable: result.pages_marked_non_extractable, facts: (await factsOf(brain.engine, slug)).length });
    }
    expect(runs).toEqual([{ failed: 0, nonExtractable: 1, facts: 0 }, { failed: 0, nonExtractable: 1, facts: 0 }]);
  }, 600_000);
}

/** The operator's --grammar on a held page: --dry-run, the run, and the one-page rule. */
export function defineConversationFactsGrammarFlagCases(opts: { getBrain: () => AppendBrain }): void {
  test('--grammar on a held page: --dry-run previews what a run under the format extracts and removes and changes nothing; the run does exactly that, later plain runs follow the choice until the page changes, and none settles a page as no transcript', async () => {
    const brain = opts.getBrain();
    const slug = `notes/operator-format-${randomUUID().slice(0, 8)}`;
    const { prose, current, quoted } = await mixedFormats(brain, slug, 250);
    expect((await extract(brain.engine, slug)).result.pages_detection_ambiguous).toBe(1);
    const receipt = async () => (await brain.engine.executeRaw<{ kind: string | null }>(
      "SELECT s.input_truncated->>'kind' AS kind FROM page_extraction_state s JOIN pages p ON p.id = s.page_id WHERE p.slug = $1 AND s.pipeline = 'conversation_facts'", [slug]))[0]?.kind ?? null;
    const ids = (await factsOf(brain.engine, slug)).map(f => f.id);
    const rows = await rowState(brain, slug);
    const preview = await extract(brain.engine, slug, { grammar: 'plain-role-no-time', dryRun: true });
    const p = preview.result.grammar_previews?.[0];
    expect({ calls: preview.calls.length, grammar: p?.grammar, messages: p?.messages, extracts: (p?.windows_to_extract ?? 0) > 0, collects: (p?.facts_to_collect ?? 0) > 0,
      facts: (await factsOf(brain.engine, slug)).map(f => f.id), rows: await rowState(brain, slug), receipt: await receipt() })
      .toEqual({ calls: 0, grammar: 'plain-role-no-time', messages: 200, extracts: true, collects: true, facts: ids, rows, receipt: 'detection_ambiguous' });
    const applied = await extract(brain.engine, slug, { grammar: 'plain-role-no-time' });
    const after = await factsOf(brain.engine, slug);
    const derived = await derivations(brain.engine, slug);
    expect({ calls: applied.calls.length, turns: turnsIn(applied.calls), removed: ids.filter(id => !after.some(f => f.id === id)).length, failed: applied.result.pages_failed,
      processed: applied.result.pages_processed, facts: after.length, grammars: await recordedGrammars(brain, slug), states: [...new Set(derived.states)],
      mismatches: await claimMismatches(brain.engine, slug), receipt: await receipt() })
      .toEqual({ calls: p!.windows_to_extract, turns: 200, removed: p!.facts_to_collect, failed: 0, processed: 1, facts: derived.keys.length, grammars: ['plain-role-no-time'],
        states: ['done'], mismatches: [], receipt: 'grammar_chosen' });
    const kept = after.map(f => f.id);
    const plainRuns = [];
    for (const force of [false, true]) {
      const { calls, result } = await extract(brain.engine, slug, { force });
      plainRuns.push({ calls: calls.length, failed: result.pages_failed, held: result.pages_detection_ambiguous ?? 0, facts: (await factsOf(brain.engine, slug)).map(f => f.id) });
    }
    await brain.seed(slug, chatPage('Combined transcript archive, edited', `${prose}\n${current}\n## Quoted historical transcript\n${quoted}`));
    const changed = await extract(brain.engine, slug);
    expect({ plainRuns, changed: { calls: changed.calls.length, held: changed.result.pages_detection_ambiguous ?? 0, facts: (await factsOf(brain.engine, slug)).map(f => f.id) } })
      .toEqual({ plainRuns: [{ calls: 0, failed: 0, held: 0, facts: kept }, { calls: 0, failed: 0, held: 0, facts: kept }], changed: { calls: 0, held: 1, facts: kept } });
    const none = await extract(brain.engine, slug, { grammar: null, dryRun: true });
    const q = none.result.grammar_previews?.[0];
    expect({ calls: none.calls.length, preview: q, facts: (await factsOf(brain.engine, slug)).map(f => f.id) })
      .toEqual({ calls: 0, preview: { source_id: 'default', slug, grammar: null, messages: 0, windows: 0, windows_to_extract: 0, facts_to_collect: kept.length }, facts: kept });
    const cleared = await extract(brain.engine, slug, { grammar: null });
    const later = await extract(brain.engine, slug);
    expect({ calls: cleared.calls.length + later.calls.length, nonExtractable: cleared.result.pages_marked_non_extractable, failed: cleared.result.pages_failed + later.result.pages_failed,
      held: later.result.pages_detection_ambiguous ?? 0, facts: (await factsOf(brain.engine, slug)).length, receipt: await receipt() })
      .toEqual({ calls: 0, nonExtractable: 1, failed: 0, held: 0, facts: 0, receipt: 'grammar_chosen' });
  }, 600_000);

  test('--grammar applies to one page: a slug in two sources refuses with nothing changed and names both commands; --source-id changes only that source; a slug in one source resolves to it', async () => {
    const brain = opts.getBrain();
    const engine = brain.engine;
    const slug = `notes/shared-chat-${randomUUID().slice(0, 8)}`;
    const other = `src-${randomUUID().slice(0, 8)}`;
    await caps(engine, 'off');
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [other]);
    const turns = Array.from({ length: 220 }, (_, i) => `${i % 2 ? 'Assistant' : 'User'}: turn ${i} ${'present '.repeat(800)}`).join('\n');
    for (const sourceId of ['default', other]) {
      await importFromContent(engine, slug, chatPage(`Chat in ${sourceId}`, turns), { noEmbed: true, sourceId });
      await runExtractConversationFactsCore(engine, { sourceId, slugs: [slug], sleepMs: 0,
        extractor: async input => [{ fact: `Alice Example noted window ${createHash('sha256').update(input.turnText).digest('hex').slice(0, 12)}`, kind: 'fact', entity_slug: null, source: SOURCE }] });
    }
    const state = async () => ({
      facts: await engine.executeRaw<{ source_id: string; n: number }>("SELECT source_id, count(*)::int AS n FROM facts WHERE source_markdown_slug = $1 AND source = $2 AND expired_at IS NULL GROUP BY source_id ORDER BY source_id", [slug, SOURCE]),
      choices: await engine.executeRaw<{ source_id: string; kind: string }>("SELECT p.source_id, s.input_truncated->>'kind' AS kind FROM page_extraction_state s JOIN pages p ON p.id = s.page_id WHERE p.slug = $1 AND s.pipeline = 'conversation_facts' ORDER BY 1", [slug]),
    });
    const cli = async (args: string[]) => {
      const lines: string[] = [];
      const log = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
      try { await runExtractConversationFacts(engine, args); return { error: null, lines }; }
      catch (error) { return { error: error as { code?: string; message: string; suggestion?: string; reason?: string }, lines }; }
      finally { log.mockRestore(); }
    };
    const before = await state();
    expect(before.facts.map(r => r.source_id).sort()).toEqual(['default', other].sort());
    const refused = [await cli(['--slug', slug, '--grammar', 'none', '--dry-run']), await cli(['--slug', slug, '--grammar', 'none'])];
    const afterRefused = await state();
    const scoped = await cli(['--source-id', 'default', '--slug', slug, '--grammar', 'none']);
    const afterScoped = await state();
    await engine.executeRaw('UPDATE pages SET deleted_at = now() WHERE source_id = $1 AND slug = $2', [other, slug]);
    const single = await cli(['--slug', slug, '--grammar', 'none', '--dry-run']);
    const serialized = JSON.stringify(refused.map(r => r.error));
    expect({
      refused: refused.map(r => ({ code: r.error?.code, names: [other, 'default'].every(s => r.error?.message.includes(s)), command: [other, 'default'].every(s => serialized.includes(`--source-id ${s} --slug ${slug} --grammar`)) })),
      unchangedByRefusal: JSON.stringify(afterRefused) === JSON.stringify(before),
      scoped: scoped.error?.message ?? null,
      afterScoped: { facts: afterScoped.facts, choices: afterScoped.choices },
      single: { error: single.error?.message ?? null, preview: single.lines.some(l => l.includes(`Preview of default:${slug} under --grammar none`)) },
    }).toEqual({
      refused: [{ code: 'invalid_params', names: true, command: true }, { code: 'invalid_params', names: true, command: true }],
      unchangedByRefusal: true,
      scoped: null,
      afterScoped: { facts: before.facts.filter(r => r.source_id === other), choices: [{ source_id: 'default', kind: 'grammar_chosen' }] },
      single: { error: null, preview: true },
    });
  }, 600_000);
}

/** How long an operator's format choice lasts: one page version, and a detected format after it streams from the head. */
export function defineConversationFactsGrammarChoiceCases(opts: { getBrain: () => AppendBrain; getFresh: () => AppendBrain }): void {
  test('a choice holds only for the page version it was made for: after an append the chosen rows do not pin their format, so a page still undetected is held with every fact kept', async () => {
    const brain = opts.getBrain();
    const slug = `notes/choice-version-${randomUUID().slice(0, 8)}`;
    await caps(brain.engine, 'off');
    const transcript = Array.from({ length: 160 }, (_, i) => `${i % 2 ? 'Assistant' : 'User'}: turn ${i} ${'fixture detail '.repeat(550)}`).join('\n');
    const preamble = Array.from({ length: 16_000 }, (_, i) => `Reference paragraph ${i} gives context, not a message.`).join('\n');
    await brain.seed(slug, chatPage('Constant title', `${preamble}\n${transcript}`));
    const receipt = async () => (await brain.engine.executeRaw<{ kind: string | null }>(
      "SELECT s.input_truncated->>'kind' AS kind FROM page_extraction_state s JOIN pages p ON p.id = s.page_id WHERE p.slug = $1 AND s.pipeline = 'conversation_facts'", [slug]))[0]?.kind ?? null;
    const summary = (r: Awaited<ReturnType<typeof extract>>) => ({ calls: r.calls.length, held: r.result.pages_detection_ambiguous ?? 0, failed: r.result.pages_failed });
    const held = summary(await extract(brain.engine, slug));
    const chosen = await extract(brain.engine, slug, { grammar: 'plain-role-no-time' });
    const same = summary(await extract(brain.engine, slug));
    const facts = (await factsOf(brain.engine, slug)).map(f => f.id);
    expect(await brain.call('append_page', { slug, text: '\nUser: a new message after the choice.\nAssistant: an appended response.', request_id: randomUUID() }, { remote: true })).toMatchObject({ isError: false });
    expect(await undetected(brain, slug)).toBeNull();
    const after = summary(await extract(brain.engine, slug));
    const again = summary(await extract(brain.engine, slug));
    expect({ held, chose: chosen.calls.length > 0 && chosen.result.pages_failed === 0, same, after, again, facts: (await factsOf(brain.engine, slug)).map(f => f.id), receipt: await receipt() })
      .toEqual({ held: { calls: 0, held: 1, failed: 0 }, chose: true, same: { calls: 0, held: 0, failed: 0 }, after: { calls: 0, held: 1, failed: 0 }, again: { calls: 0, held: 1, failed: 0 }, facts, receipt: 'detection_ambiguous' });
  }, 600_000);

  test('a format detected after an operator chose another one streams the page from its head: the chosen windows before the change do not survive, and the page equals a fresh extraction', async () => {
    const brain = opts.getBrain();
    const slug = `notes/choice-switch-${randomUUID().slice(0, 8)}`;
    await caps(brain.engine, 'off');
    const day = (i: number) => new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10);
    const old = Array.from({ length: 6000 }, (_, i) => `Reference line ${i} before the conversation.`).join('\n') + '\n' + Array.from({ length: 100 }, (_, i) =>
      `## ${day(i)}\n\n**Alice Example** (9:00 AM): old turn ${i} ${'detail '.repeat(800)}\n\n**Bob Example** (9:02 AM): old response ${i} ${'detail '.repeat(800)}`).join('\n\n');
    await brain.seed(slug, chatPage('Constant title', old));
    expect((await extract(brain.engine, slug)).result.pages_detection_ambiguous).toBe(1);
    await extract(brain.engine, slug, { grammar: 'bold-paren-time-12h' });
    const chosen = await factsOf(brain.engine, slug);
    const added = Array.from({ length: 12_000 }, (_, i) => `${i % 2 ? 'Assistant' : 'User'}: new format turn ${i} about a synthetic topic.`).join('\n');
    await brain.seed(slug, chatPage('Constant title', `${old}\n${added}`));
    const page = (await brain.engine.getPage(slug, { sourceId: 'default' }))!;
    const body = (await brain.body(slug)).truth;
    expect(parser.parseConversation(body, { page }).matched_pattern_id).toBe('plain-role-no-time');
    const run = await extract(brain.engine, slug);
    const after = await factsOf(brain.engine, slug);
    const freshSlug = `notes/choice-switch-fresh-${randomUUID().slice(0, 8)}`;
    // The fresh extraction runs on its own brain: in this one the switched page's facts already state every claim, and a
    // source never stores a claim twice (#7043).
    const freshBrain = opts.getFresh();
    await caps(freshBrain.engine, 'off');
    for (const key of ['facts.extraction_model', 'facts.default_visibility']) await freshBrain.engine.setConfig(key, (await brain.engine.getConfig(key)) ?? '');
    await freshBrain.seed(freshSlug, chatPage('Constant title', body));
    await extract(freshBrain.engine, freshSlug);
    const fresh = await factsOf(freshBrain.engine, freshSlug);
    const shas = (facts: typeof after) => facts.map(f => f.key.split(':')[2]).sort();
    const forced = await extract(brain.engine, slug, { force: true });
    const rows = await derivations(brain.engine, slug);
    expect({ failed: run.result.pages_failed, held: run.result.pages_detection_ambiguous ?? 0, facts: after.length, same: shas(after).join() === shas(fresh).join(),
      stale: shas(after).filter(s => shas(chosen).includes(s) && !shas(fresh).includes(s)).length, forcedCalls: forced.calls.length, forcedSame: shas(await factsOf(brain.engine, slug)).join() === shas(fresh).join(),
      grammars: [...new Set(rows.rows.map(r => (r.output as { pattern?: string | null }).pattern ?? null))], chosenRows: rows.rows.filter(r => (r.output as { chosen?: boolean }).chosen).length,
      mismatches: await claimMismatches(brain.engine, slug) })
      .toEqual({ failed: 0, held: 0, facts: fresh.length, same: true, stale: 0, forcedCalls: 0, forcedSame: true, grammars: ['plain-role-no-time'], chosenRows: 0, mismatches: [] });
  }, 600_000);
}
