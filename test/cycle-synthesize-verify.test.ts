/**
 * F1b/F4b — mechanical quote verify/repair on dream pages (eval write-path
 * fix wave). Pure repair-ladder cases + one PGLite write-back integration
 * block. The invariants under test everywhere: NEVER fabricate — every
 * replacement is a verbatim transcript slice inside one speaker turn — and
 * NEVER keep an unsupported claim as page text: its unit leaves the body and
 * is recorded in frontmatter `unverified_claims`.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  normalizeForGrounding,
  normForGrounding,
  extractQuoteSpans,
  groundQuote,
  verifyBody,
  groundSource,
  unsupportedNumericClaims,
  verifyAndRepairDreamPages,
  readVerifyEpoch,
} from '../src/core/cycle/synthesize-verify.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { renderMaterializedBullet } from '../src/core/persistence/canonical-projections.ts';

function grounded(content: string) {
  const { norm, map } = normalizeForGrounding(content);
  return { content, norm, map };
}

describe('normalizeForGrounding', () => {
  test('folds whitespace, curly quotes, dashes, case — and maps back to original offsets', () => {
    const s = 'He said  “We’re    NOT\n\nready — at all.”';
    const { norm, map } = normalizeForGrounding(s);
    expect(norm).toBe('he said "we\'re not ready - at all."');
    expect(map.length).toBe(norm.length);
    // Map invariant: every normalized char points at a real original index,
    // non-decreasing, and mapping a match back yields a verbatim slice.
    for (let i = 1; i < map.length; i++) expect(map[i]).toBeGreaterThanOrEqual(map[i - 1]);
    const at = norm.indexOf('not ready');
    const start = map[at];
    const end = map[at + 'not ready'.length - 1] + 1;
    expect(s.slice(start, end)).toBe('NOT\n\nready');
  });

  test('empty and whitespace-only inputs', () => {
    expect(normForGrounding('')).toBe('');
    expect(normForGrounding('   \n\t ')).toBe('');
  });
});

describe('extractQuoteSpans', () => {
  test('pairs straight and curly quotes; enforces min length', () => {
    const body = 'Intro. "This is a properly long quoted span." And “another long enough quoted span here.” But "short" is skipped.';
    const { spans, unbalanced } = extractQuoteSpans(body);
    expect(unbalanced).toBe(0);
    expect(spans.map(s => s.inner)).toEqual([
      'This is a properly long quoted span.',
      'another long enough quoted span here.',
    ]);
  });

  test('skips code fences, inline code, and wikilinks', () => {
    const body = [
      'Prose with "a real quote long enough to count here".',
      '```',
      'code with "a fake quote inside a fence that must not count"',
      '```',
      'Inline `"quoted in code"` and a wikilink [[people/alice-example "x"]] stay out.',
    ].join('\n');
    const { spans } = extractQuoteSpans(body);
    expect(spans.map(s => s.inner)).toEqual(['a real quote long enough to count here']);
  });

  test('unbalanced paragraph is skipped and counted; other paragraphs still pair', () => {
    const body = 'One lonely " mark in this paragraph breaks pairing.\n\nBut "this later balanced quoted span still counts fine."';
    const { spans, unbalanced } = extractQuoteSpans(body);
    expect(unbalanced).toBe(1);
    expect(spans.map(s => s.inner)).toEqual(['this later balanced quoted span still counts fine.']);
  });
});

describe('groundQuote — the repair ladder', () => {
  const transcript = [
    'user (t1): I think the real insight is that memory systems fail at the',
    'write path, not the read path — everyone measures retrieval.',
    'user (t2): We decided to ship the “verify-at-write” pass in Q3, budget $250K.',
    'assistant (t3): Noted. The team agreed the mechanical checker beats an LLM judge.',
  ].join('\n');
  const t = grounded(transcript);

  test('exact substring → exact', () => {
    const g = groundQuote('memory systems fail at the', t);
    expect(g.status).toBe('exact');
  });

  test('normalized match (straight vs curly, collapsed whitespace) → verbatim replacement', () => {
    const g = groundQuote('We decided to ship the "verify-at-write" pass in Q3, budget $250K.', t);
    expect(g.status).toBe('normalized');
    if (g.status === 'normalized') {
      expect(transcript).toContain(g.replacement);
      expect(g.replacement).toContain('“verify-at-write”');
    }
  });

  test('near match (light paraphrase, high token overlap) → verbatim window', () => {
    const g = groundQuote('the team agreed the mechanical checker beats an LLM judge today', t);
    expect(g.status).toBe('near');
    if (g.status === 'near') {
      expect(transcript).toContain(g.replacement);
      expect(normForGrounding(g.replacement)).toContain('mechanical checker beats an llm judge');
    }
  });

  test('heavy paraphrase (low overlap) → none (caller quarantines)', () => {
    const g = groundQuote('our fundamental product philosophy centers customer delight above metrics', t);
    expect(g.status).toBe('none');
  });

  test('short quotes never near-match (min 4 tokens)', () => {
    const g = groundQuote('checker beats judge', t);
    expect(g.status).toBe('none');
  });

  test('ambiguous near-match (two similar homes) → none, never guess', () => {
    const twin = grounded([
      'alpha version: the deploy failed because the cache was stale in region one today',
      'beta version: the deploy failed because the cache was stale in region two today',
    ].join('\n'));
    const g = groundQuote('the deploy failed because the cache was stale in some region', twin);
    expect(g.status).toBe('none');
  });
});

describe('verifyBody', () => {
  // The principle sentence carries an INTERIOR em-dash + curly apostrophe —
  // a page quote written with a hyphen + straight apostrophe is normalized-
  // equal but not byte-equal, which is exactly the rung-2 case. (Inner text
  // that is byte-identical is EXACT even when the surrounding quote-mark
  // style differs — quote fidelity is about the quoted content.)
  const transcript = 'user: We agreed the launch moves to March 14th because the audit slipped. Also: “the brain mustn’t invent quotes — ever.”';
  const src = groundSource('/t/session.txt', transcript);

  test('full ladder: exact kept, normalized repaired to verbatim, ungrounded unit quarantined', () => {
    const body = [
      'Summary paragraph without quotes.',
      '',
      'Decision: "We agreed the launch moves to March 14th because the audit slipped."',
      '',
      'Principle: "the brain mustn\'t invent quotes - ever."',
      '',
      'Invented: "our destiny is to reinvent human memory for all mankind forever."',
    ].join('\n');
    const r = verifyBody(body, [src]);
    expect(r.quotes).toBe(3);
    expect(r.exact).toBe(1);            // launch-date quote is verbatim already
    expect(r.normalized).toBe(1);       // hyphen/apostrophe span repaired to the verbatim original
    expect(r.changed).toBe(true);
    // Replacement is the verbatim INNER slice (page keeps its own quote marks).
    expect(r.body).toContain('"the brain mustn’t invent quotes — ever."');
    // The ungrounded unit is gone from the body, text and marks alike...
    expect(r.body).not.toContain('our destiny');
    expect(r.body).toBe([
      'Summary paragraph without quotes.',
      '',
      'Decision: "We agreed the launch moves to March 14th because the audit slipped."',
      '',
      'Principle: "the brain mustn’t invent quotes — ever."',
    ].join('\n'));
    // ...and preserved verbatim for review, with the reason.
    expect(r.quarantined).toEqual([{
      text: 'Invented: "our destiny is to reinvent human memory for all mankind forever."',
      reason: 'quote_not_in_source',
      detail: 'our destiny is to reinvent human memory for all mankind forever.',
    }]);
    expect(r.failures.quote_not_in_source).toBe(1);
    // Grounded quotes carry source-span + speaker provenance.
    expect(r.provenance).toHaveLength(2);
    for (const p of r.provenance) {
      expect(p.source).toBe('/t/session.txt');
      expect(p.speaker).toBe('user');
      expect(normForGrounding(transcript.slice(p.span[0], p.span[1]))).toBe(normForGrounding(p.text));
    }
  });

  test('clean body → changed=false, byte-identical', () => {
    const body = 'Decision: "We agreed the launch moves to March 14th because the audit slipped." Done.';
    const r = verifyBody(body, [src]);
    expect(r.changed).toBe(false);
    expect(r.body).toBe(body);
    expect(r.exact).toBe(1);
  });

  test('only the failing sentence leaves a multi-sentence line; list items and table rows go whole', () => {
    const body = [
      'The launch moved. The user said "we will triple revenue by next spring for sure." The audit slipped.',
      '- The user said "we will triple revenue by next spring for sure."',
      '- Kept bullet.',
      '| claim | "we will triple revenue by next spring for sure." |',
    ].join('\n');
    const r = verifyBody(body, [src]);
    expect(r.body).toBe('The launch moved. The audit slipped.\n- Kept bullet.');
    expect(r.quarantined).toHaveLength(3);
  });

  test('prior revision: only units absent from it are verified', () => {
    const prior = 'Alice said "a line quoted from some entirely different source conversation".';
    const body = `${prior}\n\nNew: "a fabricated line the child just added to the page."`;
    const r = verifyBody(body, [src], { priorNorm: normForGrounding(prior) });
    expect(r.body).toBe(prior);
    expect(r.quarantined.map(q => q.reason)).toEqual(['quote_not_in_source']);
  });
});

describe('verifyBody — materialized timeline history (#5567)', () => {
  const src = groundSource('/t/history.txt', 'user: We shipped the repair pass on Monday.');
  const marked = renderMaterializedBullet({ date: '2024-01-02', source: 'meeting', summary: 'Said "we will open a second office in 2025"', detail: 'Recorded "before write-through" in 2023.' }, 'x')!;
  const fabricated = '- **2026-08-30** | session — Said "we are shutting down the company next quarter"';
  const priorNorm = normForGrounding('A reflection.');

  test('a bullet materialized during the run is database history and is left alone, detail included', () => {
    expect(marked).toBeTruthy();
    const kept = verifyBody(`${marked}\n${fabricated}`, [src], { priorNorm });
    expect(kept.body).toBe(marked);
    expect(kept.quarantined.map(q => q.text)).toEqual([fabricated.slice(2)]);
  });

  test('a claim added under a marked bullet that already existed is verified', () => {
    const lines = marked.split('\n');
    const edited = [lines[0], lines[1], '  Also said "we are shutting down the company next quarter".'].join('\n');
    const result = verifyBody(edited, [src], { priorNorm: normForGrounding(`A reflection.\n${lines[0]}\n${lines[1]}`) });
    expect(result.body).toBe([lines[0], lines[1]].join('\n'));
    expect(result.quarantined).toHaveLength(1);
  });

  test('a new page has no history to exempt, and a forged marker is verified', () => {
    expect(verifyBody(marked, [src]).quarantined.length).toBeGreaterThan(0);
    const forged = marked.replace(/v1 [0-9a-f]+/, 'v1 000000000000');
    expect(verifyBody(forged, [src], { priorNorm }).quarantined.length).toBeGreaterThan(0);
  });
});

describe('speaker provenance (write-path audit C-6)', () => {
  const transcript = [
    'user (t1): I think the real insight is that memory systems fail at the',
    'write path, not the read path — everyone measures retrieval.',
    'user (t2): We decided to ship the “verify-at-write” pass in Q3, budget $250K.',
    'assistant (t3): Noted. The team agreed the mechanical checker beats an LLM judge.',
    'user (t4): Next we discuss hiring',
  ].join('\n');
  const src = groundSource('/t/2026-08-30-session.txt', transcript);

  test('near match is trimmed to the matched tokens inside one turn', () => {
    const g = groundQuote('the team decided the mechanical checker beats an LLM judge', src);
    expect(g.status).toBe('near');
    if (g.status === 'near') expect(g.replacement).toBe('The team agreed the mechanical checker beats an LLM judge');
  });

  test('a quote that spans two speaker turns is refused, never spliced', () => {
    const g = groundQuote('beats an LLM judge. user (t4): Next we discuss hiring', src);
    expect(g).toEqual({ status: 'none', reason: 'crosses_speakers' });
    const r = verifyBody('Summary: "Noted. The team agreed the mechanical checker beats an LLM judge.\nuser (t4): Next we discuss hiring"', [src]);
    expect(r.failures.quote_crosses_speakers + r.failures.quote_not_in_source).toBeGreaterThan(0);
    expect(r.body).not.toContain('Next we discuss hiring');
  });

  test('a real quote attributed to the wrong speaker is quarantined; the right speaker is kept', () => {
    const r = verifyBody([
      'The user said "The team agreed the mechanical checker beats an LLM judge."',
      'The assistant said "The team agreed the mechanical checker beats an LLM judge."',
    ].join('\n'), [src]);
    expect(r.body).toBe('The assistant said "The team agreed the mechanical checker beats an LLM judge."');
    expect(r.quarantined).toEqual([expect.objectContaining({ reason: 'speaker_mismatch' })]);
    expect(r.provenance[0].speaker).toBe('assistant');
  });

  test('named speakers: labels that open two or more lines count; prose labels do not', () => {
    const named = groundSource('/t/named.txt', [
      'Alice-example: we should price per seat, not per usage.',
      'Bob-example: agreed, and the pilot costs $40K.',
      'Note: this line is not a speaker.',
      'Alice-example: then we sign the pilot next week.',
      'Bob-example: fine.',
    ].join('\n'));
    expect(named.turns.map(t => t.speaker)).toEqual(['Alice-example', 'Bob-example', 'Alice-example', 'Bob-example']);
    const r = verifyBody([
      'Alice-example proposed "we should price per seat, not per usage."',
      'Bob-example proposed "we should price per seat, not per usage."',
      'The pilot costs $40K.',
      'The pilot costs $45K.',
    ].join('\n'), [named]);
    expect(r.body).toBe('Alice-example proposed "we should price per seat, not per usage."\nThe pilot costs $40K.');
    expect(r.quarantined.map(q => q.reason)).toEqual(['speaker_mismatch', 'number_not_in_source']);
  });
});

describe('verifyBody — replacement hygiene (red-team regression)', () => {
  test('a multi-line transcript match splices as ONE line (quote marks stay in one paragraph)', () => {
    const transcript = 'user: We agreed the launch moves\nto March 14th because\nthe audit slipped.';
    const src = groundSource('/t/s.txt', transcript);
    const body = 'Decision: "We agreed the launch moves to March 14th because the audit slipped."';
    const r = verifyBody(body, [src]);
    expect(r.normalized).toBe(1);
    expect(r.body).not.toContain('\n'); // no line break spliced inside the quote
    expect(r.body).toContain('"We agreed the launch moves to March 14th because the audit slipped."');
    // Re-verifying the repaired body is stable (the marks still pair).
    const again = verifyBody(r.body, [src]);
    expect(again.unbalanced).toBe(0);
    expect(again.quarantined).toHaveLength(0);
  });
});

describe('numeric grounding', () => {
  const src = groundSource('/t/2026-01-15-board.txt', 'user: ARR hit $2M in January 2026, churn 5%, headcount 12.');

  test('wikilinks and link targets are masked — dated slugs are not "claims" (red-team regression)', () => {
    const r = verifyBody('See [[meetings/2026-08-30-board]] and [the note](wiki/personal/reflections/2026-08-31-topic-a1b2c3). ARR reached $2M.', [src]);
    expect(r.quarantined).toHaveLength(0);
  });

  test('grounded claims pass; invented ones are reported once each; fences skipped', () => {
    const body = [
      'ARR reached $2M with churn at 5%.',          // both grounded
      'Series B raised $50M at a $900M cap.',       // 2 invented
      'Again: $50M.',                                // same claim, its own unit
      '```',
      '$77M inside a fence never counts',
      '```',
    ].join('\n');
    const r = verifyBody(body, [src]);
    expect(r.quarantined.map(q => q.detail)).toEqual(['$50M; $900M', '$50M']);
    expect(r.body).toBe(['ARR reached $2M with churn at 5%.', '```', '$77M inside a fence never counts', '```'].join('\n'));
  });

  test('values compare canonically: scaled amounts, separators, month-day dates, file-name dates', () => {
    expect(unsupportedNumericClaims('ARR was $2,000,000 and $2 million; the board met on 2026-01-15 and January 15th.', [src])).toEqual([]);
    expect(unsupportedNumericClaims('ARR was $2.5M on 2026-01-16.', [src])).toEqual(['$2.5M', '2026-01-16']);
  });
});

describe('extractQuoteSpans — separator drift (ship-review regression: offsets must never drift)', () => {
  test('spans survive 3-newline, whitespace-bearing, and CRLF paragraph separators', () => {
    for (const sep of ['\n\n\n', '\n   \n', '\r\n\r\n', '\n\t\n\n']) {
      const body = `Intro paragraph with no quotes at all here.${sep}Claim: "a quoted span that is definitely long enough to count."`;
      const { spans, unbalanced } = extractQuoteSpans(body);
      expect(spans.map(s => s.inner)).toEqual(['a quoted span that is definitely long enough to count.']);
      expect(unbalanced).toBe(0);
      // Offsets are exact: the span slices back out of the original body.
      expect(body.slice(spans[0].start + 1, spans[0].end)).toBe(spans[0].inner);
    }
  });

  test('fabricated quote after a long separator is still caught (the escape this fixes)', () => {
    const src = groundSource('/t/s.txt', 'user: routine chatter only, nothing else was said.');
    const body = 'Intro.\n\n\nClaim: "we decided to acquire acme-example for nine hundred million."';
    const r = verifyBody(body, [src]);
    expect(r.quotes).toBe(1);
    expect(r.quarantined).toHaveLength(1);
    expect(r.body).toBe('Intro.');
  });

  test('interior curly-quoted phrase inside a straight-quoted span pairs per type — outer span extracted whole', () => {
    const body = 'Note: "he told me “ship it now, no excuses” and then left the meeting early."';
    const { spans } = extractQuoteSpans(body);
    expect(spans).toHaveLength(1);
    expect(spans[0].inner).toBe('he told me “ship it now, no excuses” and then left the meeting early.');
  });

  test('unpaired curly close and odd straight marks count unbalanced without swallowing later paragraphs', () => {
    const body = 'Bad para with one " mark and a stray ” close.\n\nGood: "a later balanced quoted span that still counts fine."';
    const { spans, unbalanced } = extractQuoteSpans(body);
    expect(unbalanced).toBe(1);
    expect(spans.map(s => s.inner)).toEqual(['a later balanced quoted span that still counts fine.']);
  });
});

describe('normalizeForGrounding — multi-code-unit case folding (security-review regression)', () => {
  test('Turkish İ expands to two code units; map stays aligned and slices stay verbatim', () => {
    const s = 'İstanbul meeting: the founder said we pivot to infrastructure next quarter.';
    const { norm, map } = normalizeForGrounding(s);
    expect(map.length).toBe(norm.length); // the invariant the fix restores
    const probe = 'the founder said we pivot to infrastructure';
    const at = norm.indexOf(probe);
    expect(at).toBeGreaterThan(0);
    expect(s.slice(map[at], map[at + probe.length - 1] + 1)).toBe(probe);
  });

  test('groundQuote after İ returns the correct verbatim slice (was: shifted/garbled)', () => {
    const t = grounded('prefix İİİ noise. user: We agreed the launch moves to March 14th because the audit slipped.');
    const g = groundQuote('we agreed the launch moves to march 14th because the audit slipped.', t);
    expect(g.status).toBe('normalized');
    if (g.status === 'normalized') {
      expect(g.replacement).toBe('We agreed the launch moves to March 14th because the audit slipped.');
    }
  });

  test('normForGrounding (mapless) is parity with normalizeForGrounding().norm — including the cases a whole-string toLowerCase got wrong', () => {
    const cases = [
      'He said  “We’re    NOT\n\nready — at all.”',
      'İstanbul – café ʼn “mixed” ‘quotes’ \t\t tabs',
      'ΟΔΟΣ ΟΔΟΣ',            // Greek final sigma: whole-string lowercase → 'ς', per-char → 'σ'
      '𐐀𐐁 DESERET',           // non-BMP: surrogate pairs lowercase as pairs, never half by half
      '  leading and trailing   ',
      'plain ascii already normalized',
      '',
    ];
    for (const c of cases) {
      expect(normForGrounding(c)).toBe(normalizeForGrounding(c).norm);
      // The map invariant holds for every case too.
      const m = normalizeForGrounding(c);
      expect(m.map.length).toBe(m.norm.length);
    }
  });
});

describe('groundQuote — CPU bounds (performance-review regression)', () => {
  test('a very long ungroundable quote resolves quickly to none (probe budget, size cap)', () => {
    const transcript = ('routine words about scheduling and lunch orders and build status. '.repeat(5000));
    const t = grounded(transcript);
    const fabricated = 'entirely novel strategic manifesto sentence '.repeat(80); // ~3.5K chars > cap
    const started = Date.now();
    const g = groundQuote(fabricated, t);
    expect(g.status).toBe('none');
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('verifyAndRepairDreamPages — fail-open fault injection', () => {
  const T = new Map([['/t/x.md', { content: 'user: something quotable that is long enough to be a span here.' }]]);
  const since = new Date(0);
  const page = (compiled_truth: string) => ({ slug: 'x', compiled_truth, timeline: '', frontmatter: {}, type: 'note', title: 'x', created_at: new Date() });

  test('page read-back miss → errors++, later refs still processed', async () => {
    const engine = {
      getPage: async (slug: string) => slug.includes('missing') ? null : page('clean body, no quotes at all.'),
      getTags: async () => [],
    } as never;
    const stats = await verifyAndRepairDreamPages(engine, [
      { slug: 'wiki/personal/reflections/a-missing-aaaaaa', source_id: 'default', raw_source: '/t/x.md' },
      { slug: 'wiki/personal/reflections/b-ok-aaaaaa', source_id: 'default', raw_source: '/t/x.md' },
    ], T, { since });
    expect(stats.errors).toBe(1);
    expect(stats.pages_checked).toBe(1);
    expect(stats.pages_repaired).toBe(0); // clean page: nothing to write back
  });

  test('engine throw during page processing → errors++, loop continues (fail-open)', async () => {
    let calls = 0;
    const engine = {
      getPage: async () => { calls++; if (calls === 1) throw new Error('boom'); return page('clean body, no quotes at all.'); },
      getTags: async () => [],
    } as never;
    const stats = await verifyAndRepairDreamPages(engine, [
      { slug: 'wiki/personal/reflections/a-throw-aaaaaa', source_id: 'default', raw_source: '/t/x.md' },
      { slug: 'wiki/personal/reflections/b-fine-aaaaaa', source_id: 'default', raw_source: '/t/x.md' },
    ], T, { since });
    expect(stats.errors).toBe(1);
    expect(stats.pages_checked).toBe(1);
  });

  test('a pre-aborted signal unwinds instead of failing open', async () => {
    const ac = new AbortController();
    ac.abort();
    const engine = { getPage: async () => null, getTags: async () => [] } as never;
    await expect(verifyAndRepairDreamPages(engine, [
      { slug: 'wiki/personal/reflections/a-aaaaaa', source_id: 'default', raw_source: '/t/x.md' },
    ], T, { since, signal: ac.signal })).rejects.toThrow();
  });
});

describe('verifyAndRepairDreamPages — PGLite write-back integration', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
  });
  afterAll(async () => {
    try { await engine.disconnect(); } catch { /* best-effort */ }
  });

  test('new pages verified whole; pre-existing pages verified on their new units only; records land in frontmatter', async () => {
    const transcript = 'user: The verdict was “ship the repair pass now — measure later.” That is the whole plan.';
    const OTHER_SOURCE = 'Alice said "something from an entirely different source conversation".';
    // Pre-existing people page, written BEFORE the run's epoch.
    await importFromContent(engine, 'wiki/people/alice-example', `---\ntype: person\n---\n${OTHER_SOURCE}`, { noEmbed: true, remote: false, sourceId: 'default' });
    await new Promise(r => setTimeout(r, 5));
    const since = await readVerifyEpoch(engine);

    // The run: a new hash-suffixed page, a new page WITHOUT a hash suffix
    // (was skipped before this fix), and an edit to the pre-existing page.
    const slug = 'wiki/personal/reflections/2026-08-31-repair-pass-abc123';
    await importFromContent(engine, slug, [
      '---', 'type: note', '---',
      'The user concluded: "ship the repair pass now - measure later." Strong conviction.',
      '',
      'Fabricated: "we will rewrite the entire engine in Rust next week for fun."',
    ].join('\n'), { noEmbed: true, remote: false, sourceId: 'default' });
    await importFromContent(engine, 'wiki/people/bob-example', '---\ntype: person\n---\nBob-example said "we are closing a $5M round next month, guaranteed".', { noEmbed: true, remote: false, sourceId: 'default' });
    await importFromContent(engine, 'wiki/people/alice-example', `---\ntype: person\n---\n${OTHER_SOURCE}\n\nThe user said "ship the repair pass now — measure later."\n\nThe user also said "we are shutting down the company next quarter".`, { noEmbed: true, remote: false, sourceId: 'default' });

    const stats = await verifyAndRepairDreamPages(engine, [
      { slug, source_id: 'default', raw_source: '/t/session.md' },
      { slug: 'wiki/people/bob-example', source_id: 'default', raw_source: '/t/session.md' },
      { slug: 'wiki/people/alice-example', source_id: 'default', raw_source: '/t/session.md' },
      { slug: 'wiki/personal/reflections/orphan-def456', source_id: 'default' },              // no raw_source
    ], new Map([['/t/session.md', { content: transcript }]]), { since, checkedAt: '2026-08-31' });

    expect(stats.pages_checked).toBe(3);
    expect(stats.preexisting_diffed).toBe(1);
    expect(stats.skipped_no_transcript).toBe(1);
    expect(stats.normalized_fixed).toBe(1);    // straight → verbatim curly original
    expect(stats.quarantined_claims).toBe(3);  // one per page
    expect(stats.pages_with_quarantine).toBe(3);
    expect(stats.errors).toBe(0);

    const page = await engine.getPage(slug, { sourceId: 'default' });
    expect(page!.compiled_truth).toBe('The user concluded: "ship the repair pass now — measure later." Strong conviction.');
    expect((page!.frontmatter.unverified_claims as Array<{ text: string; reason: string; sources: string[] }>)).toEqual([
      expect.objectContaining({ text: 'Fabricated: "we will rewrite the entire engine in Rust next week for fun."', reason: 'quote_not_in_source', sources: ['/t/session.md'] }),
    ]);
    const grounding = page!.frontmatter.grounding as { sources: string[]; quotes: Array<{ speaker: string; span: [number, number] }> };
    expect(grounding.sources).toEqual(['/t/session.md']);
    expect(grounding.quotes).toHaveLength(1);
    expect(grounding.quotes[0].speaker).toBe('user');
    expect(transcript.slice(...grounding.quotes[0].span)).toBe('ship the repair pass now — measure later.');

    // New page without a hash suffix: verified whole; the only unit fails.
    const bob = await engine.getPage('wiki/people/bob-example', { sourceId: 'default' });
    expect(bob!.compiled_truth).not.toContain('$5M');

    // Pre-existing page: the other-source quote is untouched, the grounded
    // new quote is kept, the fabricated new quote is quarantined.
    const alice = await engine.getPage('wiki/people/alice-example', { sourceId: 'default' });
    expect(alice!.compiled_truth).toBe(`${OTHER_SOURCE}\n\nThe user said "ship the repair pass now — measure later."`);
    expect((alice!.frontmatter.unverified_claims as unknown[])).toHaveLength(1);

    // Quarantined text has no chunks: keyword search cannot reach it.
    const hits = await engine.searchKeyword('rewrite entire engine Rust', { limit: 5 });
    expect(hits.filter(h => h.slug === slug)).toHaveLength(0);
  }, 60_000);

  test('re-projection deletes the rows of quarantined bullets and keeps database-only timeline history (#5567)', async () => {
    const transcript = 'user: We shipped the repair pass on Monday.';
    const since = await readVerifyEpoch(engine);
    const slug = 'wiki/personal/reflections/2026-08-31-history-abc789';
    await importFromContent(engine, slug, [
      '---', 'type: note', '---', 'A reflection.', '', '## Timeline', '',
      '- **2026-08-30** | session — Said "we are shutting down the company next quarter"',
    ].join('\n'), { noEmbed: true, remote: false, sourceId: 'default' });
    const [page] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE slug=$1 AND source_id='default'", [slug]);
    const rows = () => engine.executeRaw<{ summary: string }>('SELECT summary FROM timeline_entries WHERE page_id=$1 ORDER BY summary', [page.id]);
    await engine.executeRaw(`INSERT INTO timeline_entries(page_id,date,source,summary,detail) VALUES
      ($1,'2026-08-30','session','Said "we are shutting down the company next quarter"',''),
      ($1,'2024-01-02','extract','Database-only history','')
      ON CONFLICT DO NOTHING`, [page.id]);
    expect((await rows()).map(r => r.summary)).toEqual(['Database-only history', 'Said "we are shutting down the company next quarter"']);

    const stats = await verifyAndRepairDreamPages(engine, [{ slug, source_id: 'default', raw_source: '/t/history.md' }],
      new Map([['/t/history.md', { content: transcript }]]), { since, checkedAt: '2026-08-31' });
    expect(stats.pages_repaired).toBe(1);
    expect((await engine.getPage(slug, { sourceId: 'default' }))!.timeline).not.toContain('shutting down');
    expect((await rows()).map(r => r.summary)).toEqual(['Database-only history']);
  }, 60_000);
});
