/**
 * Seeded property test of the conversation facts deletion invariant on a segmented page (wave-b spec 8.2; PR 4 lane 4b
 * round 5), shared by the PGLite arms (test/large-pages/conversation-facts-property-seeds-<first>-<last>.test.ts) and
 * the Postgres arms (test/e2e/conversation-facts-property-seeds-<first>-<last>-postgres.test.ts): one file per range of
 * PROPERTY_PARTITIONS on each engine, each with its own brains, so every file fits the e2e per-file budget. A fake
 * extractor yields one to three facts per window, determined by the window's text; no model is called.
 *
 * Each of PROPERTY_SEEDS seeds runs PROPERTY_STEPS steps, each an optional change (an append on the last day or a new
 * day through the remote append_page, a mid-page edit, insert, delete or oversized turn, a title of another length, a
 * visibility, model or derivation-version change) followed by one run under an optional constraint (a provider-wide
 * failure, a window-specific failure, a cap, an abort, --since, --segment-limit, --force). After every step:
 *   (i)   a fact that disappeared had its exact window key extracted again (or a moved window's facts re-anchored onto
 *         it) in that step, or the step fully settled the page and its key is no current window's; a moved fact keeps
 *         its window text;
 *   (ii)  every window key holds exactly one batch: the fact count its text yields, no fact twice; every window a live
 *         row records holds exactly that count (a key holding no fact included), and a window marked failed holds either
 *         that count (an earlier context's batch) or none;
 *   (iii) every window a row claims holds exactly the facts the row says, and a settled page holds only current windows.
 * Before a step, the page may also be rewritten to prose that keeps zero to three of its message lines, so no grammar
 * is detected while it still holds facts, then restored; each of the two runs is checked like a step. Or it may be
 * rewritten to another transcript format and run one window, so its rows record two grammars, then lose detection with
 * a few or about as many of its own message lines kept, then be restored: each run is checked like a step. A lost run on
 * a page some built-in format still parses a message in must be held: no call, no fact lost.
 * Each step records which paths it exercised (a moved window, a window-specific failure, a window marked failed, a
 * settled collection, a --since run, a cap refusal, a lost grammar on a page holding facts, a held page keeping quoted
 * lines, a held page recording two grammars); across each range's seeds every path must fire at least its floor. Each seed
 * also dooms the windows whose text hash starts with one chosen digit for a span of steps, so windows reach the failure
 * limit and block collection until the final --force run.
 * At the end a healthy unconstrained --force run leaves the same windows and facts as one extraction of the same page on
 * a fresh brain.
 *
 * 1. Protects: deletion only by exact-key replacement or settled collection, rows claiming exactly what exists.
 * 2. Fails when: any partial-run path deletes by coverage, keeps or stale bookkeeping, a move loses or duplicates a
 *    batch, a settling run leaves an old batch beside a new one, or incremental runs drift from a fresh extraction.
 */
import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { AppendBrain } from './append-brain.ts';
import { runExtractConversationFactsCore } from '../../src/commands/extract-conversation-facts.ts';
import { CONVERSATION_FACTS_DERIVATION_VERSION } from '../../src/core/facts/conversation-incremental.ts';
import { applyPattern, createPatternDetector, deriveDateContext } from '../../src/core/conversation-parser/parse.ts';
import { BUILTIN_PATTERNS } from '../../src/core/conversation-parser/builtins.ts';
import { parseSourceWindow, sourceWindowKey, type SourceWindow } from '../../src/core/page-body/derivations.ts';
import { PAGE_EMBED_CAP_KEY } from '../../src/core/page-embedding-budget.ts';
import { PAGE_DERIVATION_CAP_KEY } from '../../src/core/page-spend.ts';
import { __setChatTransportForTests, chat as gatewayChat } from '../../src/core/ai/gateway.ts';
import { chatDays, chatPage, derivations, PAID_MODEL, paidTransport, SOURCE, turns } from './conversation-facts-incremental-cases.ts';
import { claimMismatches } from './conversation-facts-invariant-cases.ts';

export const PROPERTY_SEEDS = 30;
export const PROPERTY_STEPS = 16;
const FIRST_DAY = 5000;
const DAYS = 100;
const WORDS = ['launch', 'pricing', 'budget', 'roadmap', 'hiring', 'review', 'contract', 'latency', 'onboarding', 'forecast', 'retention', 'deploy'];
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const dateOf = (day: number) => new Date(Date.UTC(2025, 0, 1) + day * 86_400_000).toISOString().slice(0, 10);
/** Facts the fake extractor yields for a window, by its text. */
const yieldOf = (windowSha: string) => 1 + (parseInt(windowSha.slice(0, 2), 16) % 3);

function rng(seed: number) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
}

interface Fact { id: number; key: string; fact: string }
async function factsOf(engine: BrainEngine, slug: string): Promise<Fact[]> {
  const rows = await engine.executeRaw<{ id: number; w: unknown; fact: string }>(
    `SELECT id, source_window AS w, fact FROM facts WHERE source_id='default' AND source_markdown_slug=$1 AND source=$2 AND expired_at IS NULL ORDER BY id`, [slug, SOURCE]);
  return rows.map(row => { const w = parseSourceWindow(row.w) as SourceWindow | null; return { id: Number(row.id), key: w ? sourceWindowKey(w) : 'unanchored', fact: row.fact }; });
}
const shaOf = (key: string) => key.split(':')[2] ?? key;

interface RunOpts { force?: boolean; segmentLimit?: number; sinceIso?: string; abortAfter?: number; failAt?: number; doomed?: string; paid?: boolean }

/** One extraction run with the deterministic fake extractor; returns whether it threw and its counters. */
async function run(engine: BrainEngine, slug: string, o: RunOpts) {
  const controller = new AbortController();
  let calls = 0;
  try {
    const result = await runExtractConversationFactsCore(engine, { sourceId: 'default', slugs: [slug], sleepMs: 0, force: o.force, sinceIso: o.sinceIso, segmentLimit: o.segmentLimit,
      extractor: async input => {
        calls++;
        const windowSha = sha(input.turnText);
        if (o.paid) await gatewayChat({ model: PAID_MODEL, messages: [{ role: 'user', content: input.turnText }], maxTokens: 64 });
        if (calls === o.failAt) throw Object.assign(new Error('fake provider: upstream unavailable'), { status: 503 });
        if (o.doomed?.includes(windowSha[0]!)) throw Object.assign(new Error('fake extractor: malformed output on this window'), { extractionReason: 'malformed_output' });
        if (calls === o.abortAfter) controller.abort();
        return Array.from({ length: yieldOf(windowSha) }, (_, j) => ({ fact: `Alice Example noted window ${windowSha.slice(0, 16)} item ${j}`, kind: 'fact', entity_slug: null, source: SOURCE }));
      } }, controller.signal);
    return { threw: false, failed: result.pages_failed, calls };
  } catch {
    return { threw: true, failed: 1, calls };
  }
}

/** Every window key some row records, whether the page is fully settled, and the live occurrences' row windows. */
async function pageState(engine: BrainEngine, slug: string) {
  const d = await derivations(engine, slug);
  const liveRows = d.rows.filter(row => d.live.includes(row.occurrenceId));
  const windowsOf = (row: (typeof d.rows)[number]) => ((row.output as { windows?: Array<{ ordinal: number; sha: string; failed?: unknown }> })?.windows ?? []);
  const liveWindows = liveRows.flatMap(row => windowsOf(row).map(w => ({ key: `${row.occurrenceId}:${w.ordinal}:${w.sha}`, sha: w.sha, failed: !!w.failed })));
  const liveKeys = new Set(liveWindows.map(w => w.key));
  const settled = liveRows.length === d.live.length && liveRows.every(row => row.state === 'done' && row.version === CONVERSATION_FACTS_DERIVATION_VERSION)
    && d.rows.every(row => windowsOf(row).every(w => !w.failed));
  const retrying = liveRows.some(row => ((row.output as { retries?: unknown[] })?.retries ?? []).length > 0);
  const capped = d.receipts.some(r => (r as { reason?: string } | null)?.reason === 'cap_reached');
  return { liveKeys, liveWindows, settled, retrying, capped, windowShas: liveRows.flatMap(row => windowsOf(row).map(w => w.sha)).sort() };
}

/** Problems with one page's facts after a step (the module doc's (i)–(iii)). */
async function violations(engine: BrainEngine, slug: string, before: Fact[], o: RunOpts, outcome: { threw: boolean; failed: number; calls: number }) {
  const after = await factsOf(engine, slug);
  const state = await pageState(engine, slug);
  const fullySettled = !outcome.threw && outcome.failed === 0 && !o.sinceIso && state.settled;
  const beforeById = new Map(before.map(f => [f.id, f]));
  const afterById = new Map(after.map(f => [f.id, f]));
  const replaced = new Set([...after.filter(f => !beforeById.has(f.id)).map(f => f.key),
    ...after.filter(f => beforeById.has(f.id) && beforeById.get(f.id)!.key !== f.key).map(f => f.key)]);
  const problems: string[] = [];
  const fired = new Set<PropertyPath>();
  if (state.retrying) fired.add('failed_window');
  if (state.liveWindows.some(w => w.failed)) fired.add('marked_failed');
  if (o.sinceIso && outcome.calls > 0) fired.add('since');
  if (o.paid && state.capped) fired.add('cap');
  for (const f of before) {
    if (afterById.has(f.id)) continue;
    if (replaced.has(f.key)) continue;
    if (fullySettled && !state.liveKeys.has(f.key)) { fired.add('collected'); continue; }
    problems.push(`(i) fact ${f.id} of window ${f.key} disappeared without its window being extracted again or a settled collection`);
  }
  for (const f of after) {
    const was = beforeById.get(f.id);
    if (was && was.key !== f.key) fired.add('moved');
    if (was && shaOf(was.key) !== shaOf(f.key)) problems.push(`(i) fact ${f.id} moved from ${was.key} to a window of other text ${f.key}`);
  }
  const perKey = new Map<string, Fact[]>();
  for (const f of after) perKey.set(f.key, [...(perKey.get(f.key) ?? []), f]);
  for (const [key, facts] of perKey) {
    if (key === 'unanchored') continue;
    if (facts.length !== yieldOf(shaOf(key)) || new Set(facts.map(f => f.fact)).size !== facts.length) problems.push(`(ii) window ${key} holds ${facts.length} facts, ${new Set(facts.map(f => f.fact)).size} distinct; its text yields ${yieldOf(shaOf(key))}`);
  }
  for (const w of state.liveWindows) {
    const held = perKey.get(w.key)?.length ?? 0;
    if (held !== yieldOf(w.sha) && !(w.failed && held === 0)) problems.push(`(ii) live window ${w.key}${w.failed ? ' (marked failed)' : ''} holds ${held} facts; its text yields ${yieldOf(w.sha)}`);
  }
  for (const m of await claimMismatches(engine, slug)) problems.push(`(iii) a row claims ${m.claimed} facts of ${m.key}; it holds ${m.held}`);
  if (fullySettled) for (const key of perKey.keys()) if (!state.liveKeys.has(key)) problems.push(`(iii) the settled page still holds facts of ${key}, no current window`);
  return { problems, after, fired };
}

type PropertyPath = 'moved' | 'failed_window' | 'marked_failed' | 'collected' | 'since' | 'cap' | 'grammar_lost' | 'held_quoted' | 'held_two_grammars';

/** Whether some built-in conversation format parses a message in the page's text `body`. */
async function anyFormatParses(engine: BrainEngine, slug: string, body: string): Promise<boolean> {
  const page = (await engine.getPage(slug, { sourceId: 'default' }))!;
  return BUILTIN_PATTERNS.some(entry => applyPattern(body, entry, deriveDateContext({ page })).length > 0);
}

/** A run on a page with no detected format but a parseable message is held: it never calls and never loses a fact. */
function heldOracle(checked: { problems: string[]; after: Fact[]; fired: Set<PropertyPath> }, before: Fact[], outcome: { calls: number; failed: number }, path: PropertyPath): void {
  checked.fired.add(path);
  if (outcome.calls !== 0 || outcome.failed !== 0 || checked.after.map(f => f.id).join() !== before.map(f => f.id).join()) {
    checked.problems.push(`(held) a page with no detected format and a parseable message made ${outcome.calls} call(s), failed ${outcome.failed} or changed its facts (${before.length} -> ${checked.after.length})`);
  }
}
/**
 * The seed ranges, one per arm file, together exactly 1..PROPERTY_SEEDS, and the steps each range's seeds must exercise
 * per path: half, rounded up, of the steps they exercise (the same on both engines; the 30 seeds exercise 206, 153, 47,
 * 153, 27, 23, 24, 18, 24), raised where needed so each path's floors sum to at least the old 30-seed floor (moved 96,
 * failed_window 82, marked_failed 23, collected 66, since 14, cap 10, grammar_lost 12, held_quoted 9,
 * held_two_grammars 12). A range whose seeds never reach a path has floor 0 for it.
 */
export const PROPERTY_PARTITIONS: ReadonlyArray<{ first: number; last: number; floors: Record<PropertyPath, number> }> = [
  { first: 1, last: 2, floors: { moved: 8, failed_window: 7, marked_failed: 5, collected: 6, since: 0, cap: 1, grammar_lost: 2, held_quoted: 1, held_two_grammars: 2 } },
  { first: 3, last: 4, floors: { moved: 8, failed_window: 5, marked_failed: 1, collected: 6, since: 1, cap: 1, grammar_lost: 1, held_quoted: 1, held_two_grammars: 1 } },
  { first: 5, last: 6, floors: { moved: 7, failed_window: 4, marked_failed: 2, collected: 5, since: 2, cap: 2, grammar_lost: 0, held_quoted: 0, held_two_grammars: 1 } },
  { first: 7, last: 8, floors: { moved: 8, failed_window: 6, marked_failed: 3, collected: 7, since: 1, cap: 0, grammar_lost: 2, held_quoted: 1, held_two_grammars: 0 } },
  { first: 9, last: 10, floors: { moved: 7, failed_window: 6, marked_failed: 2, collected: 6, since: 0, cap: 1, grammar_lost: 2, held_quoted: 1, held_two_grammars: 1 } },
  { first: 11, last: 12, floors: { moved: 6, failed_window: 5, marked_failed: 2, collected: 4, since: 1, cap: 1, grammar_lost: 1, held_quoted: 1, held_two_grammars: 1 } },
  { first: 13, last: 14, floors: { moved: 7, failed_window: 7, marked_failed: 0, collected: 6, since: 2, cap: 0, grammar_lost: 2, held_quoted: 1, held_two_grammars: 2 } },
  { first: 15, last: 16, floors: { moved: 8, failed_window: 3, marked_failed: 0, collected: 6, since: 1, cap: 1, grammar_lost: 2, held_quoted: 1, held_two_grammars: 1 } },
  { first: 17, last: 18, floors: { moved: 7, failed_window: 6, marked_failed: 3, collected: 5, since: 1, cap: 1, grammar_lost: 1, held_quoted: 1, held_two_grammars: 1 } },
  { first: 19, last: 20, floors: { moved: 6, failed_window: 9, marked_failed: 1, collected: 4, since: 1, cap: 1, grammar_lost: 0, held_quoted: 0, held_two_grammars: 2 } },
  { first: 21, last: 22, floors: { moved: 7, failed_window: 4, marked_failed: 0, collected: 5, since: 1, cap: 2, grammar_lost: 0, held_quoted: 0, held_two_grammars: 1 } },
  { first: 23, last: 24, floors: { moved: 7, failed_window: 6, marked_failed: 2, collected: 6, since: 2, cap: 1, grammar_lost: 0, held_quoted: 0, held_two_grammars: 1 } },
  { first: 25, last: 26, floors: { moved: 7, failed_window: 4, marked_failed: 2, collected: 6, since: 1, cap: 1, grammar_lost: 1, held_quoted: 1, held_two_grammars: 1 } },
  { first: 27, last: 28, floors: { moved: 6, failed_window: 7, marked_failed: 2, collected: 5, since: 1, cap: 1, grammar_lost: 1, held_quoted: 1, held_two_grammars: 0 } },
  { first: 29, last: 30, floors: { moved: 8, failed_window: 3, marked_failed: 0, collected: 5, since: 2, cap: 1, grammar_lost: 1, held_quoted: 0, held_two_grammars: 1 } },
];

export function defineConversationFactsPropertyCases(opts: { getBrain: () => AppendBrain; getFresh: () => AppendBrain; first: number }): void {
  const { first, last, floors } = PROPERTY_PARTITIONS.find(range => range.first === opts.first)!;
  const firedSteps: Record<PropertyPath, number> = { moved: 0, failed_window: 0, marked_failed: 0, collected: 0, since: 0, cap: 0, grammar_lost: 0, held_quoted: 0, held_two_grammars: 0 };
  let seedsRun = 0;
  for (let seed = first; seed <= last; seed++) {
    test(`seed ${seed}: ${PROPERTY_STEPS} seeded changes and constrained runs keep the deletion invariant, and the page converges to a fresh extraction`, async () => {
      const brain = opts.getBrain();
      const engine = brain.engine;
      const next = rng(seed);
      const pick = <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)]!;
      const words = (n: number) => Array.from({ length: n }, () => pick(WORDS)).join(' ');
      const slug = `notes/property-${seed}-${randomUUID().slice(0, 8)}`;
      for (const key of [PAGE_DERIVATION_CAP_KEY, PAGE_EMBED_CAP_KEY]) await engine.setConfig(key, 'off');
      await engine.setConfig('facts.extraction_model', '');
      await engine.setConfig('facts.default_visibility', 'private');
      let title = 'Property chat';
      let lastDay = FIRST_DAY + DAYS - 1;
      let nextTurn = 50;
      await brain.seed(slug, chatPage(title, chatDays(FIRST_DAY, DAYS, seed)));
      const log: string[] = [];
      let facts = await factsOf(engine, slug);
      // Its own stream, so the steps the main stream draws stay those of a run with no lost grammar.
      const lost = rng(seed + 7919);
      /** Rewrite the page to prose keeping up to three of its message lines (no grammar is detected while it holds facts), run, then restore the transcript and run; each run is checked like a step. */
      const loseGrammar = async (step: number) => {
        const truth = (await brain.body(slug)).truth;
        const quoted = truth.split('\n').filter(line => line.startsWith('**')).slice(-(1 + Math.floor(lost() * 40))).slice(0, Math.floor(lost() * 4));
        const prose = Array.from({ length: 12_000 }, (_, i) => `Paragraph ${i} of the notes: ${WORDS[Math.floor(lost() * WORDS.length)]} and ${WORDS[i % WORDS.length]}.`).join('\n\n');
        for (const phase of ['lost', 'restored'] as const) {
          await brain.seed(slug, chatPage(title, phase === 'lost' ? [prose, ...quoted].join('\n\n') : truth));
          const detector = createPatternDetector();
          detector.push((await brain.body(slug)).truth);
          const lostGrammar = phase === 'lost' && detector.finish() === null && facts.length > 0;
          const parseable = lostGrammar && await anyFormatParses(engine, slug, (await brain.body(slug)).truth);
          const constraint = (['none', 'none', 'abort', 'limit'] as const)[Math.floor(lost() * 4)]!;
          const o: RunOpts = constraint === 'abort' ? { abortAfter: 1 + Math.floor(lost() * 30) } : constraint === 'limit' ? { segmentLimit: 1 + Math.floor(lost() * 20) } : {};
          const outcome = await run(engine, slug, o);
          const checked = await violations(engine, slug, facts, o, outcome);
          if (lostGrammar) checked.fired.add('grammar_lost');
          if (parseable) heldOracle(checked, facts, outcome, 'held_quoted');
          log.push(`step ${step} (grammar ${phase}, ${quoted.length} message line(s) kept): ${constraint} ${JSON.stringify(o)} -> ${JSON.stringify(outcome)}, ${checked.after.length} facts; ${[...checked.fired].join(' ') || 'no path'}`);
          for (const path of checked.fired) firedSteps[path]++;
          expect({ step, log: log.at(-1), problems: checked.problems.slice(0, 5) }).toEqual({ step, log: log.at(-1), problems: [] });
          facts = checked.after;
        }
      };
      // Its own stream as well, so the steps the other streams draw stay those of a run with no rival grammar.
      const rival = rng(seed + 104_729);
      /**
       * Rewrite the page to a plain-role transcript and run one window of it, so the rows record two grammars; then put
       * prose before it and keep a few of the page's own message lines or about as many as it has turns, so no grammar is
       * detected, and run; then restore the page and run. Each run is checked like a step, and the lost run also holds
       * that a page with a parseable message and no detected format is held: no call, no fact lost.
       */
      const rivalGrammar = async (step: number) => {
        const truth = (await brain.body(slug)).truth;
        const own = truth.split('\n').filter(line => line.startsWith('**'));
        // Long turns, so the page stays above the segmented demotion size while each turn fits one window.
        const count = 110 + Math.floor(rival() * 60);
        const plain = Array.from({ length: count }, (_, i) => `${i % 2 ? 'Assistant' : 'User'}: turn ${i} of step ${step} on the ${WORDS[Math.floor(rival() * WORDS.length)]} and the ${WORDS[i % WORDS.length]}. ${'detail '.repeat(700)}`).join('\n');
        const competing = rival() < 0.5;
        const keep = Math.min(own.length, competing ? Math.ceil(count * (0.6 + rival())) : Math.floor(rival() * 4));
        const kept = own.slice(own.length - keep);
        const prose = Array.from({ length: 12_000 }, (_, i) => `Paragraph ${i} of the notes: ${WORDS[Math.floor(rival() * WORDS.length)]} and ${WORDS[i % WORDS.length]}.`).join('\n\n');
        for (const phase of ['recorded', 'lost', 'restored'] as const) {
          await brain.seed(slug, chatPage(title, phase === 'recorded' ? plain : phase === 'lost' ? [prose, plain, ...kept].join('\n\n') : truth));
          const body = (await brain.body(slug)).truth;
          const detector = createPatternDetector();
          detector.push(body);
          const grammars = [...new Set((await derivations(engine, slug)).rows.map(row => (row.output as { pattern?: string | null }).pattern).filter((p): p is string => !!p))];
          const lostTwo = phase === 'lost' && detector.finish() === null && facts.length > 0 && grammars.length > 1;
          const parseable = lostTwo && await anyFormatParses(engine, slug, body);
          const constraint = phase === 'recorded' ? 'limit' : (['none', 'none', 'abort', 'limit'] as const)[Math.floor(rival() * 4)]!;
          const o: RunOpts = phase === 'recorded' ? { segmentLimit: 1 } : constraint === 'abort' ? { abortAfter: 1 + Math.floor(rival() * 30) }
            : constraint === 'limit' ? { segmentLimit: 1 + Math.floor(rival() * 20) } : {};
          const outcome = await run(engine, slug, o);
          const checked = await violations(engine, slug, facts, o, outcome);
          if (parseable) heldOracle(checked, facts, outcome, 'held_two_grammars');
          log.push(`step ${step} (rival grammar ${phase}, ${count} plain-role turns, ${keep} own line(s) kept, recorded ${grammars.join('+') || 'none'}): ${constraint} ${JSON.stringify(o)} -> ${JSON.stringify(outcome)}, ${checked.after.length} facts; ${[...checked.fired].join(' ') || 'no path'}`);
          for (const path of checked.fired) firedSteps[path]++;
          expect({ step, log: log.at(-1), problems: checked.problems.slice(0, 5) }).toEqual({ step, log: log.at(-1), problems: [] });
          facts = checked.after;
        }
      };
      // The windows whose text hash starts with this digit fail in every run of these steps.
      const doomDigit = pick([...'0123456789abcdef']);
      const doomFrom = 1 + Math.floor(next() * (PROPERTY_STEPS - 6));
      const doomSteps = 4 + Math.floor(next() * 3);
      const reseed = async (edit: (lines: string[], turnsAt: number[]) => void) => {
        const lines = (await brain.body(slug)).truth.split('\n');
        const turnsAt = lines.flatMap((line, i) => (line.startsWith('**') ? [i] : []));
        edit(lines, turnsAt.slice(Math.floor(turnsAt.length / 3), Math.floor((2 * turnsAt.length) / 3)));
        await brain.seed(slug, chatPage(title, lines.join('\n')));
      };
      try {
        for (let step = 1; step <= PROPERTY_STEPS + 1; step++) {
          const final = step > PROPERTY_STEPS;
          // Never inside the doomed span, whose windows must fail run after run to reach the failure limit.
          if (lost() < 0.08 && !final && !(step >= doomFrom && step < doomFrom + doomSteps)) await loseGrammar(step);
          if (rival() < 0.06 && !final && !(step >= doomFrom && step < doomFrom + doomSteps)) await rivalGrammar(step);
          const change = final ? 'none' : pick(['none', 'none', 'append', 'append', 'append', 'new-day', 'edit', 'edit', 'insert', 'insert', 'delete', 'oversized',
            'title', 'title', 'visibility', 'model', 'version'] as const);
          if (change === 'append') {
            const count = 1 + Math.floor(next() * 20);
            expect(await brain.call('append_page', { slug, text: turns(lastDay, nextTurn, count, seed * 100 + step), request_id: randomUUID() }, { remote: true })).toMatchObject({ isError: false });
            nextTurn += count;
          } else if (change === 'new-day') {
            lastDay++;
            nextTurn = 1 + Math.floor(next() * 30);
            expect(await brain.call('append_page', { slug, text: `## ${dateOf(lastDay)}\n\n${turns(lastDay, 0, nextTurn, seed * 100 + step)}`, request_id: randomUUID() }, { remote: true }))
              .toMatchObject({ isError: false });
          } else if (change === 'edit' || change === 'oversized') {
            await reseed((lines, mid) => { const i = pick(mid); lines[i] = lines[i]!.replace(/\): .*$/, `): ${words(change === 'oversized' ? 1800 : 5 + Math.floor(next() * 40))} (step ${step}).`); });
          } else if (change === 'insert') {
            await reseed((lines, mid) => { const i = pick(mid); lines.splice(i + 1, 0, '', lines[i]!.replace(/\): .*$/, `): ${words(10 + Math.floor(next() * 30))} (inserted ${step}).`)); });
          } else if (change === 'delete') {
            await reseed((lines, mid) => { lines.splice(pick(mid), 1); });
          } else if (change === 'title') {
            title = `Property ${words(1 + Math.floor(next() * 12))}`;
            await reseed(() => {});
          } else if (change === 'visibility') {
            await engine.setConfig('facts.default_visibility', (await engine.getConfig('facts.default_visibility')) === 'world' ? 'private' : 'world');
          } else if (change === 'model') {
            await engine.setConfig('facts.extraction_model', (await engine.getConfig('facts.extraction_model')) === PAID_MODEL ? '' : PAID_MODEL);
          } else if (change === 'version') {
            const { pageId, rows } = await derivations(engine, slug);
            for (const row of rows) {
              const output = row.output as { windows?: Array<Record<string, unknown>> };
              const windows = (output.windows ?? []).map(w => ({ ...w, span: [row.occurrenceId, Number(w.ordinal), row.occurrenceId, Number(w.ordinal) + 3] }));
              await engine.executeRaw(`UPDATE page_segment_derivations SET pipeline_version = $1, output = $2::jsonb WHERE page_id = $3 AND pipeline = 'conversation_facts' AND occurrence_id = $4`,
                [1 + Math.floor(next() * (CONVERSATION_FACTS_DERIVATION_VERSION - 1)), JSON.stringify({ ...output, windows }), pageId, row.occurrenceId]);
            }
          }
          const constraint = final ? 'force' : pick(['none', 'none', 'none', 'limit', 'limit', 'abort', 'abort', 'provider', 'provider', 'doomed', 'doomed', 'since', 'cap', 'force'] as const);
          const o: RunOpts = {};
          if (constraint === 'force' || (['visibility', 'model', 'version'].includes(change) && next() < 0.7)) o.force = true;
          if (constraint === 'limit') o.segmentLimit = 1 + Math.floor(next() * 20);
          if (constraint === 'abort') o.abortAfter = 1 + Math.floor(next() * 30);
          if (constraint === 'provider') o.failAt = 1 + Math.floor(next() * 30);
          if (constraint === 'doomed') o.doomed = '01';
          if (!final && step >= doomFrom && step < doomFrom + doomSteps) o.doomed = `${o.doomed ?? ''}${doomDigit}`;
          if (constraint === 'since') o.sinceIso = `${dateOf(FIRST_DAY + Math.floor(next() * (lastDay - FIRST_DAY)))}T12:00:00Z`;
          if (constraint === 'cap') {
            const { pageId } = await derivations(engine, slug);
            const [ledger] = await engine.executeRaw<{ spent: number }>("SELECT spent_usd AS spent FROM page_derivation_spend WHERE page_id=$1 AND family='facts'", [pageId]);
            await engine.setConfig(PAGE_DERIVATION_CAP_KEY, (Number(ledger?.spent ?? 0) + 0.02 + next() * 0.3).toFixed(4));
            __setChatTransportForTests(paidTransport);
            o.paid = true;
          }
          const outcome = await run(engine, slug, o).finally(async () => {
            __setChatTransportForTests(null);
            await engine.setConfig(PAGE_DERIVATION_CAP_KEY, 'off');
          });
          const checked = await violations(engine, slug, facts, o, outcome);
          log.push(`step ${step}: ${change} + ${constraint} ${JSON.stringify(o)} -> ${JSON.stringify(outcome)}, ${checked.after.length} facts; ${[...checked.fired].join(' ') || 'no path'}`);
          for (const path of checked.fired) firedSteps[path]++;
          expect({ step, log: log.at(-1), problems: checked.problems.slice(0, 5) }).toEqual({ step, log: log.at(-1), problems: [] });
          facts = checked.after;
        }
        const state = await pageState(engine, slug);
        expect({ settled: state.settled, log: log.at(-1) }).toEqual({ settled: true, log: log.at(-1) });
        // The same page, extracted once on a fresh brain under the same configuration.
        const fresh = opts.getFresh();
        const freshSlug = `notes/property-fresh-${seed}-${randomUUID().slice(0, 8)}`;
        for (const key of ['facts.extraction_model', 'facts.default_visibility']) await fresh.engine.setConfig(key, (await engine.getConfig(key)) ?? '');
        for (const key of [PAGE_DERIVATION_CAP_KEY, PAGE_EMBED_CAP_KEY]) await fresh.engine.setConfig(key, 'off');
        await fresh.seed(freshSlug, chatPage(title, (await brain.body(slug)).truth));
        expect(await run(fresh.engine, freshSlug, {})).toMatchObject({ threw: false, failed: 0 });
        const freshState = await pageState(fresh.engine, freshSlug);
        const byWindow = (list: Fact[]) => list.map(f => `${shaOf(f.key)} ${f.fact}`).sort();
        expect({ windows: state.windowShas.length, sameWindows: state.windowShas.join() === freshState.windowShas.join(), facts: facts.length,
          sameFacts: byWindow(facts).join('\n') === byWindow(await factsOf(fresh.engine, freshSlug)).join('\n') })
          .toEqual({ windows: freshState.windowShas.length, sameWindows: true, facts: (await factsOf(fresh.engine, freshSlug)).length, sameFacts: true });
        seedsRun++;
      } finally {
        await engine.setConfig('facts.extraction_model', '');
        await engine.setConfig('facts.default_visibility', 'private');
      }
    }, 900_000);
  }

  test(`every path fires at least its floor across seeds ${first} to ${last}`, () => {
    process.stderr.write(`[property] steps per path across ${seedsRun} seeds (${first} to ${last}): ${JSON.stringify(firedSteps)}\n`);
    const tiled = PROPERTY_PARTITIONS.flatMap(range => Array.from({ length: range.last - range.first + 1 }, (_, i) => range.first + i));
    expect({ seedsRun, short: Object.entries(floors).filter(([path, floor]) => firedSteps[path as PropertyPath] < floor).map(([path]) => path),
      tiled: tiled.join() === Array.from({ length: PROPERTY_SEEDS }, (_, i) => i + 1).join() })
      .toEqual({ seedsRun: last - first + 1, short: [], tiled: true });
  });
}
