/**
 * The Korean and Japanese boundary checks in findMentionedEntities decide per
 * gazetteer entry whether the entry is written only in Hangul or only in
 * Katakana. That answer depends on the entry alone, so it must not be worked
 * out again at every place in the text where the entry could match: a Latin
 * name on an English page should cost no script test per candidate.
 *
 * The second half pins the mentions found on Korean, Japanese, Chinese, Latin
 * and mixed text, as found before the checks were cached, so the speed-up
 * keeps every result the same.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildGazetteer, findMentionedEntities } from '../src/core/by-mention.ts';
import type { Gazetteer } from '../src/core/by-mention.ts';

let engine: PGLiteEngine;
let gazetteer: Gazetteer;
const opts = { fromSlug: 'notes/example', fromSourceId: 'default' };

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const [slug, title] of [
    ['companies/acme', 'Acme'],
    ['companies/acme-labs', 'Acme Labs'],
    ['companies/acme-labs-europe', 'Acme Labs Europe'],
    ['people/alice-example', 'Alice Example'],
    ['companies/widget-co', 'Widget Co'],
    ['people/jiwon', '지원'],
    ['companies/example-card', '예시카드'],
    ['companies/spaced', '예시 카드'],
    ['companies/den', 'デン'],
    ['companies/cafe', 'カフェ'],
    ['companies/den-cafe', 'デンカフェ'],
    ['people/tanaka', '田中'],
    ['companies/sakura-bank', 'さくら銀行'],
    ['people/zhang-example', '张例'],
    ['companies/example-corp', '例子公司'],
    ['companies/acme-card', 'Acme 카드'],
    ['companies/acme-den', 'Acme デン'],
  ]) {
    await engine.putPage(slug!, {
      type: 'company', title: title!, compiled_truth: '', timeline: '', frontmatter: {},
    });
  }
  gazetteer = await buildGazetteer(engine);
}, 60_000);

afterAll(async () => { await engine.disconnect(); });

/** Counts RegExp tests run by the Hangul or Katakana boundary checks during fn. */
function countScriptTests(fn: () => void): number {
  const original = RegExp.prototype.test;
  let count = 0;
  RegExp.prototype.test = function (this: RegExp, s: string): boolean {
    if (this.source.includes('가-힣') || this.source.includes('Katakana')) count++;
    return original.call(this, s);
  };
  try {
    fn();
  } finally {
    RegExp.prototype.test = original;
  }
  return count;
}

describe('script checks on Latin text', () => {
  test('a Latin name on an English page runs no script test per candidate', () => {
    const body = (n: number) => Array.from({ length: n }, (_, k) => `Acme Labs note ${k} with Alice Example.`).join(' ');
    const few = countScriptTests(() => findMentionedEntities(body(20), gazetteer, opts));
    const many = countScriptTests(() => findMentionedEntities(body(400), gazetteer, opts));
    // Each Latin entry may be classified once; the work must not grow with the
    // number of candidate positions in the text.
    const latinEntries = [...gazetteer.values()].flat().filter(e => /^[a-z ]+$/.test(e.tokens.join(' '))).length;
    expect(many).toBeLessThanOrEqual(few);
    expect(few).toBeLessThanOrEqual(2 * latinEntries);
  });
});

describe('mentions found stay the same', () => {
  const cases: Array<[string, string, Array<[string, number]>]> = [
    ['Latin', 'Acme Labs Europe hired Alice Example. Later acme and Widget Co met.', [['companies/acme-labs-europe', 0], ['people/alice-example', 23], ['companies/acme', 44], ['companies/widget-co', 53]]],
    ['Korean', '지원이 예시카드에 갔다. 재지원 안내. 예시 카드 소식.', [['people/jiwon', 0], ['companies/example-card', 4], ['companies/spaced', 22]]],
    ['Japanese', '「デン」に行った。インシデントとデンタル。デンカフェ、カフェ・デン。田中さんとさくら銀行。', [['companies/den', 1], ['companies/den-cafe', 21], ['companies/cafe', 27], ['people/tanaka', 34], ['companies/sakura-bank', 39]]],
    ['Chinese', '张例在例子公司工作。张例又去了。', [['people/zhang-example', 0], ['companies/example-corp', 3]]],
    ['Mixed', 'Acme 카드 and Acme デン. 지원 met Alice Example at デン, then 田中 at Acme Labs.', [['companies/acme-card', 0], ['companies/acme-den', 12], ['people/jiwon', 21], ['people/alice-example', 28], ['companies/den', 45], ['people/tanaka', 54], ['companies/acme-labs', 60]]],
  ];

  test.each(cases)('%s text', (_label, body, expected) => {
    const found = findMentionedEntities(body, gazetteer, opts).map(m => [m.slug, m.offset] as [string, number]);
    expect(found).toEqual(expected);
  });
});
