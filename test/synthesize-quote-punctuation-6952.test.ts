import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { groundQuote, groundSource, readVerifyEpoch, verifyAndRepairDreamPages, verifyBody } from '../src/core/cycle/synthesize-verify.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';

const path = '/transcripts/acme-example.txt';
const words = 'always open at the right price';
const transcript = '**alice-example** (10:02): The deal desk is always open at the right price for us.\n\n**bob-example** (10:03): Fine, send terms.\n';
const source = groundSource(path, transcript);

describe('strict synthesis quote punctuation (#6952)', () => {
  for (const ending of ['.', ',', ';', ':', '!', '?', '...']) {
    test(`repairs added ${ending} to a verbatim source span before near matching`, () => {
      const quote = `${words}${ending}`;
      const result = groundQuote(quote, source);
      expect(result.status).toBe('normalized');
      if (result.status !== 'normalized') throw new Error('expected a source-slice repair');
      expect(result.replacement).toBe(words);
      for (const [start, end] of result.spans) expect(transcript.slice(start, end)).toBe(words);
      const body = `alice-example said the desk is "${quote}" That framing recurs.`;
      const verified = verifyBody(body, [source]);
      expect(verified.quarantined).toEqual([]);
      expect(verified.body).toContain(`"${words}"`);
    });
  }

  test('folded words retain original Unicode and exact offsets', () => {
    const content = '**alice-example** (10:02): İstanbul’s **DESK** stays open for us.';
    const s = groundSource(path, content);
    const result = groundQuote("İSTANBUL'S DESK STAYS OPEN.", s);
    expect(result.status).toBe('normalized');
    if (result.status !== 'normalized') throw new Error('expected normalized');
    expect(result.replacement).toBe('İstanbul’s **DESK** stays open');
    expect(content.slice(...result.spans[0]!)).toBe(result.replacement);
  });

  test('an existing full punctuation match wins over an earlier bare core', () => {
    const content = `**alice-example** (10:02): ${words} for us.\n\n**bob-example** (10:03): ${words}.`;
    const result = groundQuote(`${words}.`, groundSource(path, content));
    expect(result.status).toBe('exact');
    expect(content.slice(...(result as { spans: Array<[number, number]> }).spans[0]!)).toBe(`${words}.`);
  });

  test('a source slice from another speaker still fails attribution', () => {
    const result = verifyBody(`bob-example said "${words}."`, [source]);
    expect(result.quarantined.map(q => q.reason)).toContain('speaker_mismatch');
  });

  test('fabrications, interior changes and tolerant-only editorial forms are not accepted as punctuation repairs', () => {
    for (const quote of [
      'always closed at the wrong price.',
      'always [open] at the right price.',
      'always open at the right [price].',
      'always open at the right price for aliens.',
    ]) {
      const result = groundQuote(quote, source);
      expect(result.status).not.toBe('exact');
      expect(result.status).not.toBe('normalized');
    }
  });

  test('punctuation cannot turn a one-word fragment into a grounded claim', () => {
    expect(groundQuote('open..............', source).status).toBe('none');
  });
});

describe('classic synthesis write-back keeps genuine evidence', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });
  afterAll(async () => { await engine.disconnect(); });

  test('the stored reflection and chunks retain repaired words, quarantine only unsupported evidence, and replay unchanged', async () => {
    const since = await readVerifyEpoch(engine);
    const slug = 'wiki/personal/reflections/punctuation-example';
    await importFromContent(engine, slug, `---\ntype: note\n---\n## Reflection\n\nalice-example said "${words}."\n\nInvented: "we will open a station on the moon next week".`, { noEmbed: true, remote: false, sourceId: 'default' });
    const refs = [{ slug, source_id: 'default', raw_source: path }];
    const sources = new Map([[path, { content: transcript }]]);
    const stats = await verifyAndRepairDreamPages(engine, refs, sources, { since });
    expect(stats).toMatchObject({ errors: 0, normalized_fixed: 1, quote_not_in_source: 1, quarantined_claims: 1 });
    const page = (await engine.getPage(slug, { sourceId: 'default' }))!;
    expect(page.compiled_truth).toContain(`alice-example said "${words}"`);
    expect(page.compiled_truth).not.toContain('moon');
    const grounding = page.frontmatter.grounding as { quotes: Array<{ speaker: string; span: [number, number] }> };
    expect(grounding.quotes[0]!.speaker).toBe('alice-example');
    expect(transcript.slice(...grounding.quotes[0]!.span)).toBe(words);
    expect((await engine.searchKeyword('always open right price', { sourceId: 'default', limit: 5 })).some(r => r.slug === slug)).toBe(true);
    const repeat = await verifyAndRepairDreamPages(engine, refs, sources, { since });
    expect(repeat).toMatchObject({ errors: 0, normalized_fixed: 0, quarantined_claims: 0 });
    expect((await engine.getPage(slug, { sourceId: 'default' }))!.compiled_truth).toBe(page.compiled_truth);
  }, 60_000);
});
