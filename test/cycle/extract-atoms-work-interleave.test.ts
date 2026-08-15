// Regression guard: extract_atoms merges the transcript pool and the
// DB-page pool into one `work[]` list before applying the per-call budget
// cap. When transcripts are concatenated ahead of pages, a transcript
// corpus alone can exhaust the (default $0.30) budget every single call,
// so the page pool — the ONLY pool `countExtractAtomsBacklog` /
// doctor's extract_atoms_backlog check measures — never gets processed.
// `gbrain dream --phase extract_atoms --drain` then reports forward
// progress (atoms extracted) while the doctor-visible backlog number
// never moves, because it was all coming from transcripts. Real-world
// case: a brain with a growing transcript corpus and a stagnant
// page-backlog warning that the doctor's own suggested fix
// (`--drain --window 120`) can't clear.
//
// Fixed by interleaving the two pools 1-for-1 instead of concatenating
// transcripts-then-pages, so both pools make forward progress within a
// single budget-capped call.
//
// The budget cap in production is enforced entirely inside the real
// gatewayChat (AsyncLocalStorage-scoped BudgetTracker — see
// `withBudgetTracker` in ai/gateway.ts); the `_chat` test seam bypasses
// gatewayChat, so `budgetTracker.totalSpent` never advances from a plain
// stub. The loop's OWN budget-exhaustion path is driven by catching a
// thrown `BudgetExhausted` from `chat()` (extract-atoms.ts's
// `if (err instanceof BudgetExhausted) { budgetExhausted = true; ... }`).
// These tests throw that exact error from `_chat` after N successful
// calls, which is the same mechanism a real exhausted budget triggers.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runPhaseExtractAtoms, countExtractAtomsBacklog } from '../../src/core/cycle/extract-atoms.ts';
import { BudgetExhausted } from '../../src/core/budget/budget-tracker.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import type { ChatResult, ChatOpts } from '../../src/core/ai/gateway.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

function okChatResult(text: string): ChatResult {
  return {
    text,
    blocks: [{ type: 'text', text }],
    stopReason: 'end',
    usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-haiku-4-5',
    providerId: 'anthropic',
  };
}

/** N successful calls, then every further call throws BudgetExhausted — the
 *  same shape the real budget-tracker throws mid-loop once the cap is hit. */
function chatExhaustingAfter(n: number, text = '[]'): (o: ChatOpts) => Promise<ChatResult> {
  let calls = 0;
  return async (_o: ChatOpts) => {
    calls++;
    if (calls > n) {
      throw new BudgetExhausted('budget cap exceeded', {
        reason: 'cost',
        spent: 999,
        cap: 0.0005,
        modelId: 'anthropic:claude-haiku-4-5',
      });
    }
    return okChatResult(text);
  };
}

describe('extract_atoms work-list interleave (budget-starvation regression)', () => {
  // Codex review flagged that a transcript-first interleave ([t1, p1, ...])
  // still starves EVERY page when the budget only covers exactly one call —
  // item 0 (a transcript) succeeds, item 1 (the first page) never gets
  // attempted. That reproduces the original symptom exactly: `--drain`
  // extracts atoms from transcripts forever while the doctor-visible page
  // backlog never moves. Page-first interleave guarantees the FIRST work
  // item is always a page (when any exist), so even a budget-for-one call
  // makes forward progress on the backlog doctor actually measures.
  test('a budget that fits exactly 1 call processes a page, not a transcript', async () => {
    const result = await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _transcripts: [
        { filePath: '/tmp/t1.txt', content: 'transcript one', contentHash: '1'.repeat(16) },
        { filePath: '/tmp/t2.txt', content: 'transcript two', contentHash: '2'.repeat(16) },
        { filePath: '/tmp/t3.txt', content: 'transcript three', contentHash: '3'.repeat(16) },
      ],
      _pages: [
        { slug: 'note/a', content: 'page a', contentHash: 'a'.repeat(16) },
      ],
      _chat: chatExhaustingAfter(1),
    });

    expect(result.details.pages_processed).toBe(1);
    expect(result.details.transcripts_processed).toBe(0);
    expect(result.details.budget_exhausted).toBe(true);
  });

  test('a budget that fits exactly 2 calls processes one of each pool, not 2 transcripts', async () => {
    const result = await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _transcripts: [
        { filePath: '/tmp/t1.txt', content: 'transcript one', contentHash: '1'.repeat(16) },
        { filePath: '/tmp/t2.txt', content: 'transcript two', contentHash: '2'.repeat(16) },
        { filePath: '/tmp/t3.txt', content: 'transcript three', contentHash: '3'.repeat(16) },
      ],
      _pages: [
        { slug: 'note/a', content: 'page a', contentHash: 'a'.repeat(16) },
        { slug: 'note/b', content: 'page b', contentHash: 'b'.repeat(16) },
        { slug: 'note/c', content: 'page c', contentHash: 'c'.repeat(16) },
      ],
      _chat: chatExhaustingAfter(2),
    });

    // The regression: pre-fix, transcripts-then-pages concatenation means
    // the first 2 calls both land on transcripts — pagesProcessed stays 0
    // no matter how many batches run, as long as the transcript pool keeps
    // outrunning the budget. Interleaving guarantees the page pool gets a
    // turn within the same call.
    expect(result.details.transcripts_processed).toBe(1);
    expect(result.details.pages_processed).toBe(1);
    expect(result.details.budget_exhausted).toBe(true);
  });

  test('when only transcripts exist, all budget still goes to transcripts (no pages to starve)', async () => {
    const result = await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _transcripts: [
        { filePath: '/tmp/t1.txt', content: 'transcript one', contentHash: '1'.repeat(16) },
        { filePath: '/tmp/t2.txt', content: 'transcript two', contentHash: '2'.repeat(16) },
      ],
      _pages: [],
      _chat: chatExhaustingAfter(2),
    });

    expect(result.details.transcripts_processed).toBe(2);
    expect(result.details.pages_processed).toBe(0);
  });

  test('a lopsided pool (many transcripts, one page) still gives the page its turn before the budget runs out', async () => {
    const result = await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _transcripts: [
        { filePath: '/tmp/t1.txt', content: 'transcript one', contentHash: '1'.repeat(16) },
        { filePath: '/tmp/t2.txt', content: 'transcript two', contentHash: '2'.repeat(16) },
        { filePath: '/tmp/t3.txt', content: 'transcript three', contentHash: '3'.repeat(16) },
        { filePath: '/tmp/t4.txt', content: 'transcript four', contentHash: '4'.repeat(16) },
        { filePath: '/tmp/t5.txt', content: 'transcript five', contentHash: '5'.repeat(16) },
      ],
      _pages: [
        { slug: 'note/a', content: 'page a', contentHash: 'a'.repeat(16) },
      ],
      _chat: chatExhaustingAfter(2),
    });

    // Interleaved order is [a, t1, t2, t3, t4, t5] (page-first). The first 2
    // calls land on item 0 (a) and item 1 (t1) — the single page is NOT
    // starved just because 5 transcripts exist.
    expect(result.details.transcripts_processed).toBe(1);
    expect(result.details.pages_processed).toBe(1);
  });

  // Codex review (Minor): the tests above pin work-item ORDER via the
  // details counters, but not the actual user-facing consequence — that
  // `countExtractAtomsBacklog` (what doctor's extract_atoms_backlog check
  // reads) really drops. Seeds a real DB page (no `_pages` test seam, so
  // production `discoverExtractablePages` finds it) alongside a transcript
  // corpus that would have starved it pre-fix, and asserts the backlog
  // count goes 1 -> 0 across the call.
  test('a real DB page backlog count drops to 0 even with a starving transcript corpus', async () => {
    const BODY = 'x'.repeat(600); // >= MIN_PAGE_CHARS_FOR_EXTRACTION (500)
    await engine.putPage('article/real-page', {
      type: 'article',
      title: 'real-page',
      compiled_truth: BODY,
    });
    expect(await countExtractAtomsBacklog(engine, 'default')).toBe(1);

    const validAtomJson = JSON.stringify([
      { title: 'A', atom_type: 'insight', body: 'body a' },
    ]);
    await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _transcripts: [
        { filePath: '/tmp/t1.txt', content: 'transcript one', contentHash: '1'.repeat(16) },
        { filePath: '/tmp/t2.txt', content: 'transcript two', contentHash: '2'.repeat(16) },
        { filePath: '/tmp/t3.txt', content: 'transcript three', contentHash: '3'.repeat(16) },
      ],
      _chat: chatExhaustingAfter(1, validAtomJson),
    });

    expect(await countExtractAtomsBacklog(engine, 'default')).toBe(0);
  });
});
