// #4706 — extract_atoms: source_quote is verified against the text the model saw.
//
// EXTRACT_PROMPT asks the model for `source_quote (verbatim <=200 chars)`, and
// the persist path stored whatever came back. Nothing checked the claim, so a
// paraphrase — or an invented line — was written to the atom's frontmatter
// indistinguishable from a real quotation.
//
// The fix locates the quote in the exact text sent to the model (the
// truncateUtf8 prompt prefix). Located: store the ORIGINAL characters plus
// [start, end) offsets and stamp source_quote_verified. Not located: drop the
// quote and stamp quote_unverified. An atom without a quotation is honest; an
// atom with a fabricated one is not, and body/lesson/concepts stay useful
// either way.
//
// Verification happens at EXTRACTION on purpose: matching a stored quote back
// to its source later is not solvable (a passage and its negation are ~99%
// similar), so the only sound point is when we know exactly what the model
// received. Folding reuses synthesize-verify.ts's normalizeForGrounding — the
// v0.47.8.0 "ONE folding core" — so provenance and quote repair can never
// disagree about what "normalized substring" means.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runPhaseExtractAtoms, locateQuote } from '../../src/core/cycle/extract-atoms.ts';
import { normalizeForGrounding, normForGrounding } from '../../src/core/cycle/synthesize-verify.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import type { ChatResult, ChatOpts } from '../../src/core/ai/gateway.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

describe('locateQuote — offsets point into the ORIGINAL text', () => {
  test('exact substring: the returned span round-trips to the quote', () => {
    const content = 'Intro line.\nThe cap is the ceiling, not the target.\nOutro.';
    const quote = 'The cap is the ceiling, not the target.';
    const loc = locateQuote(content, quote);
    expect(loc).not.toBeNull();
    expect(content.slice(loc!.start, loc!.end)).toBe(quote);
  });

  test('typography folds, but the stored span is the ORIGINAL characters', () => {
    // Model returns straight quotes and a plain hyphen; the page has curly
    // quotes and an em dash. The match must succeed and the offsets must name
    // the original glyphs, not the folded ones.
    const content = 'He said “ship it” — then left.';
    const loc = locateQuote(content, '"ship it" - then left.');
    expect(loc).not.toBeNull();
    expect(content.slice(loc!.start, loc!.end)).toBe('“ship it” — then left.');
  });

  test('a line-wrapped source still matches a single-line quote', () => {
    const content = 'notes:\nthe budget is a\nceiling and not a target\nend';
    const loc = locateQuote(content, 'the budget is a ceiling and not a target');
    expect(loc).not.toBeNull();
    expect(content.slice(loc!.start, loc!.end)).toBe('the budget is a\nceiling and not a target');
  });

  test('an ellipsis character matches its three-dot rendering (shared-fold extension)', () => {
    const content = 'She paused… then answered.';
    const loc = locateQuote(content, 'She paused... then answered.');
    expect(loc).not.toBeNull();
    expect(content.slice(loc!.start, loc!.end)).toBe('She paused… then answered.');
  });

  test('a quote ending with a non-BMP char (surrogate pair) locates with the FULL code point', () => {
    // map[lastUnit]+1 used to split the 🚀 surrogate pair: the sliced
    // half-pair failed the round-trip re-fold, so the quote never located
    // and a genuinely verbatim quotation was dropped as "paraphrased".
    const content = 'Standup notes.\nAlice said ship it 🚀 and everyone agreed.';
    const loc = locateQuote(content, 'ship it 🚀');
    expect(loc).not.toBeNull();
    expect(content.slice(loc!.start, loc!.end)).toBe('ship it 🚀');
    // Also at end-of-content, where no trailing character can mask the split.
    const tail = 'we said ship it 🚀';
    const locTail = locateQuote(tail, 'ship it 🚀');
    expect(locTail).not.toBeNull();
    expect(tail.slice(locTail!.start, locTail!.end)).toBe('ship it 🚀');
  });

  test('rides the ONE folding core: locateQuote and normForGrounding agree by construction', () => {
    // Guard against a second folding implementation drifting: any string a
    // presence check would fold must fold identically here.
    const samples = ['“Weird — spacing…”  and İstanbul', 'plain ascii', 'ΟΔΟΣ ΟΔΟΣ'];
    for (const s of samples) {
      expect(normalizeForGrounding(s).norm).toBe(normForGrounding(s));
    }
  });
});

describe('Japanese and compatibility quote grounding (#10298)', () => {
  const source = '試料Ａは室温で２.０×１０<sup>－５</sup> S・cm<sup>－１</sup>の伝導率を示した．';

  test('sentence punctuation and width differences retain the original UTF-16 span', () => {
    const content = `🚀 前置き\n${source}\n後書き`;
    const quote = '試料Aは室温で2.0×10<sup>-5</sup> S･cm<sup>-1</sup>の伝導率を示した。';
    expect(locateQuote(content, quote)).toEqual({ start: '🚀 前置き\n'.length, end: '🚀 前置き\n'.length + source.length });
    expect(locateQuote('一方，試料Ｂは７３％であった．', '一方、試料Bは73%であった。')).not.toBeNull();
    expect(locateQuote('一方、試料Bは73%であった。', '一方，試料Ｂは７３％であった．')).not.toBeNull();
  });

  test('compatibility expansions, voiced kana and canonical spellings share one mapped fold', () => {
    for (const [original, quote] of [
      ['重さは２㎏。', '重さは2kg.'],
      ['面積は１０㎠', '面積は10cm2'],
      ['指数は１０⁻¹', '指数は10-1'],
      ['ｶﾞﾗｽの試料。', 'ガラスの試料.'],
      ['ガラスの試料。', 'ｶﾞﾗｽの試料.'],
      ['cafe\u0301 の試料。', 'café の試料.'],
    ]) {
      const content = `🚀 ${original}`;
      const loc = locateQuote(content, quote!);
      expect(loc).toEqual({ start: 3, end: content.length });
      expect(content.slice(loc!.start, loc!.end)).toBe(original!);
      const folded = normalizeForGrounding(content);
      expect(folded.norm.length).toBe(folded.map.length);
      expect(folded.norm).toBe(normForGrounding(content));
      expect(normForGrounding(original!)).toBe(normForGrounding(quote!));
    }
  });

  test('partial expansions, punctuation changes and omitted scientific notation remain refused', () => {
    expect(locateQuote('重さは２㎏', '重さは2k')).toBeNull();
    expect(locateQuote('面積は１０㎠', '面積は10cm')).toBeNull();
    expect(locateQuote('試料ガ', '試料カ')).toBeNull();
    expect(locateQuote('測定値は3.991 V。', '測定値は3,991 V。')).toBeNull();
    expect(locateQuote('測定値は３，９９１ V．', '測定値は3.991 V。')).toBeNull();
    expect(locateQuote(source, '試料Aは室温で2.0 10-5 S･cm-1の伝導率を示した。')).toBeNull();
    expect(locateQuote('試料は改善しなかった。', '試料は改善した。')).toBeNull();
  });

  test('compatibility and punctuation twins still make a quote ambiguous', () => {
    expect(locateQuote('試料Ａは２㎏．\n試料Aは2kg。', '試料Aは2kg.')).toBeNull();
    expect(locateQuote('ｶﾞﾗｽ。\nガラス．', 'ガラス.')).toBeNull();
  });

  test('real extraction stores original Japanese evidence and remains idempotent', async () => {
    const content = `論文の概要\n${source}\n`.padEnd(600, ' .');
    const options = {
      sourceId: 'default',
      _transcripts: [{ filePath: '/synthetic/japanese-paper.txt', content, contentHash: 'ab'.repeat(8) }],
      _pages: [],
      _chat: chatReturning([{
        title: 'Synthetic conductivity observation', atom_type: 'insight',
        body: 'The synthetic sample has a measured conductivity.',
        source_quote: '試料Aは室温で2.0×10<sup>-5</sup> S･cm<sup>-1</sup>の伝導率を示した。',
      }]),
    };
    await runPhaseExtractAtoms(engine, options);
    const atom = await onlyAtom();
    expect(atom.frontmatter.source_quote).toBe(source);
    expect(atom.frontmatter.source_quote_verified).toBe(true);
    expect(atom.frontmatter.quote_unverified).toBeUndefined();
    const [start, end] = atom.frontmatter.source_quote_offset as [number, number];
    expect(content.slice(start, end)).toBe(source);
    await runPhaseExtractAtoms(engine, options);
    expect((await onlyAtom()).id).toBe(atom.id);
  });
});

describe('locateQuote — fails closed rather than guessing', () => {
  test('a paraphrase returns null', () => {
    const content = 'The cap is the ceiling, not the target.';
    expect(locateQuote(content, 'the cap should be treated as a ceiling')).toBeNull();
  });

  test('two identical passages are ambiguous -> null', () => {
    const content = 'ship it now.\n---\nship it now.';
    expect(locateQuote(content, 'ship it now.')).toBeNull();
  });

  test('a TYPOGRAPHIC twin is ambiguous too', () => {
    // The reason uniqueness is judged in folded space. Checking uniqueness
    // only among EXACT matches sees one hit here and confidently returns the
    // wrong passage; folded space sees both.
    const content = 'A: “go now”\nB: "go now"';
    expect(locateQuote(content, '"go now"')).toBeNull();
  });

  test('an invalid partial-character hit does not veto a valid unique one', () => {
    // "No." has two folded hits here, but the second lands part-way through
    // the ellipsis (… folds to "..."), so it is not a character-aligned
    // quotation. Validate first, judge ambiguity second, or the real match is
    // lost to a phantom.
    const content = 'No. First. No… not ever.';
    const loc = locateQuote(content, 'No.');
    expect(loc).not.toBeNull();
    expect(loc!.start).toBe(0);
    expect(content.slice(loc!.start, loc!.end)).toBe('No.');
  });

  test('a truncated candidate scan is UNPROVEN uniqueness -> null', () => {
    // More occurrences than the internal scan cap. Uniqueness cannot be
    // established, so the only safe answer is null.
    const content = Array.from({ length: 40 }, () => 'repeat me.').join(' ');
    expect(locateQuote(content, 'repeat me.')).toBeNull();
  });

  test('empty quote or empty content returns null', () => {
    expect(locateQuote('some content', '')).toBeNull();
    expect(locateQuote('', 'some quote')).toBeNull();
    expect(locateQuote('some content', '   ')).toBeNull();
  });
});

function chatReturning(atoms: unknown[]): (o: ChatOpts) => Promise<ChatResult> {
  const text = JSON.stringify(atoms);
  return async () => ({
    text,
    blocks: [{ type: 'text', text }],
    stopReason: 'end',
    usage: { input_tokens: 100, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-haiku-4-5',
    providerId: 'anthropic',
  });
}

async function onlyAtom() {
  const pages = await engine.listPages({ type: 'atom', limit: 10 });
  expect(pages.length).toBe(1);
  return (await engine.getPage(pages[0]!.slug))!; // gbrain-allow-unscoped-getpage
}

describe('extract_atoms persists provenance, not claims (#4706)', () => {
  const SOURCE = [
    'Meeting notes, 12 March.',
    'The budget is a ceiling and not a target.',
    'We agreed to revisit in April.',
  ].join('\n').padEnd(600, ' .');

  test('a real quote is stored verbatim with offsets and verified', async () => {
    await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _transcripts: [{ filePath: '/tmp/q1.txt', content: SOURCE, contentHash: 'a1'.repeat(8) }],
      _pages: [],
      _chat: chatReturning([{
        title: 'Budgets are ceilings',
        atom_type: 'insight',
        body: 'A budget caps spend; it is not a goal to reach.',
        source_quote: 'The budget is a ceiling and not a target.',
      }]),
    });

    const atom = await onlyAtom();
    expect(atom.frontmatter.source_quote).toBe('The budget is a ceiling and not a target.');
    expect(atom.frontmatter.source_quote_verified).toBe(true);
    const [start, end] = atom.frontmatter.source_quote_offset as [number, number];
    // The offsets are real indices into the source text.
    expect(SOURCE.slice(start, end)).toBe('The budget is a ceiling and not a target.');
    expect(atom.frontmatter.quote_unverified).toBeUndefined();
  });

  test('a paraphrase is flagged and NO source_quote is stored', async () => {
    await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _transcripts: [{ filePath: '/tmp/q2.txt', content: SOURCE, contentHash: 'b2'.repeat(8) }],
      _pages: [],
      _chat: chatReturning([{
        title: 'Budgets are ceilings',
        atom_type: 'insight',
        body: 'A budget caps spend; it is not a goal to reach.',
        // Plausible, close to the source, and never actually said.
        source_quote: 'Treat the budget as a ceiling rather than a target.',
      }]),
    });

    const atom = await onlyAtom();
    expect(atom.frontmatter.source_quote).toBeUndefined();
    expect(atom.frontmatter.source_quote_verified).toBeUndefined();
    expect(atom.frontmatter.quote_unverified).toBe('model paraphrased; not present in source');
    // The atom itself still lands — the body is unaffected by the missing quote.
    expect(atom.frontmatter.atom_type).toBe('insight');
  });

  test('the stored quote is the SOURCE glyphs, not the model rendering', async () => {
    // End-to-end guard for the fold: the page has curly quotes and an em dash,
    // the model answers with straight quotes and a hyphen. What lands must be
    // the page's own characters, or typographic drift accumulates in the
    // brain one atom at a time.
    const typographic = [
      'Standup, 3 April.',
      'She said “ship it now” — and nobody argued.',
      'Then we moved on.',
    ].join('\n').padEnd(600, ' .');

    await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _transcripts: [{ filePath: '/tmp/q4.txt', content: typographic, contentHash: 'd4'.repeat(8) }],
      _pages: [],
      _chat: chatReturning([{
        title: 'Nobody argued',
        atom_type: 'insight',
        body: 'The decision met no resistance.',
        source_quote: '"ship it now" - and nobody argued.',
      }]),
    });

    const atom = await onlyAtom();
    expect(atom.frontmatter.source_quote_verified).toBe(true);
    // Curly quotes and the em dash survive; the model's ASCII rendering does not.
    expect(atom.frontmatter.source_quote).toBe('“ship it now” — and nobody argued.');
    const [start, end] = atom.frontmatter.source_quote_offset as [number, number];
    expect(typographic.slice(start, end)).toBe('“ship it now” — and nobody argued.');
  });

  test('a quote past max_input_chars is NOT verified — only the sent prefix counts', async () => {
    // The model never saw this text, so a "quote" matching it is not
    // provenance. Verifying against the whole item instead of the sent prefix
    // would stamp a hallucination that happens to collide with unsent text as
    // verified.
    await engine.setConfig('cycle.extract_atoms.max_input_chars', '1000');
    try {
      const beyond = 'The quiet part nobody transmitted.';
      const content = 'A'.repeat(1200) + '\n' + beyond;

      await runPhaseExtractAtoms(engine, {
        sourceId: 'default',
        _transcripts: [{ filePath: '/tmp/q5.txt', content, contentHash: 'e5'.repeat(8) }],
        _pages: [],
        _chat: chatReturning([{
          title: 'Beyond the cap',
          atom_type: 'insight',
          body: 'Something the model was never shown.',
          source_quote: beyond,
        }]),
      });

      // Present in the ITEM, absent from the PROMPT.
      expect(content).toContain(beyond);
      const atom = await onlyAtom();
      expect(atom.frontmatter.source_quote).toBeUndefined();
      expect(atom.frontmatter.source_quote_verified).toBeUndefined();
      expect(atom.frontmatter.quote_unverified).toBe('model paraphrased; not present in source');
    } finally {
      await engine.setConfig('cycle.extract_atoms.max_input_chars', '');
    }
  });

  test('an atom that offered no quote is untouched', async () => {
    await runPhaseExtractAtoms(engine, {
      sourceId: 'default',
      _transcripts: [{ filePath: '/tmp/q3.txt', content: SOURCE, contentHash: 'c3'.repeat(8) }],
      _pages: [],
      _chat: chatReturning([{
        title: 'Revisit in April',
        atom_type: 'insight',
        body: 'The team deferred the decision by a month.',
      }]),
    });

    const atom = await onlyAtom();
    expect(atom.frontmatter.source_quote).toBeUndefined();
    expect(atom.frontmatter.quote_unverified).toBeUndefined();
    expect(atom.frontmatter.source_quote_verified).toBeUndefined();
  });
});
