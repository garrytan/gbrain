/**
 * #6258 — grounding treats markdown inline markup (`**`, backticks, `~~`) as
 * formatting, not words, on both the transcript and the page side, and the
 * cycle date the synthesis prompt supplied as "today" is not an invented date.
 */
import { describe, test, expect } from 'bun:test';
import {
  emptyQuoteVerifyStats,
  groundSource,
  normalizeForGrounding,
  normForGrounding,
  verifyBody,
  verifyDreamPage,
} from '../src/core/cycle/synthesize-verify.ts';

describe('grounding folds markdown inline markup (#6258)', () => {
  test('CJK quote of a bolded source phrase grounds exact and the page keeps its quote', () => {
    const src = groundSource('/t/2026-09-04-chat.md', '用户: **重要发现**:gbrain 是 Garry 的项目,而且规模不小。');
    const body = '他说 "重要发现:gbrain 是 Garry 的项目,而且规模不小。"';
    const r = verifyBody(body, [src]);
    expect(r.failures.quote_not_in_source).toBe(0);
    expect(r.quarantined).toHaveLength(0);
    expect(r.exact).toBe(1);
    expect(r.body).toBe(body);
  });

  test('quote of a source with inline code and bold grounds', () => {
    const src = groundSource('/t/chat.md', 'user: You should run `gbrain doctor` to check the **sync** step.');
    const body = 'He said "run gbrain doctor to check the sync step" before shipping.';
    const r = verifyBody(body, [src]);
    expect(r.failures.quote_not_in_source).toBe(0);
    expect(r.quarantined).toHaveLength(0);
    expect(r.exact).toBe(1);
  });

  test('page-side markup and strikethrough fold too; a case difference still repairs to a verbatim slice', () => {
    const src = groundSource('/t/chat.md', 'user: We ~~might~~ will ship the importer on Friday for real.');
    const r = verifyBody('She said "we **might** will ship the `importer` on friday for real."', [src]);
    expect(r.quarantined).toHaveLength(0);
    expect(r.normalized).toBe(1);
    expect(r.body).toBe('She said "We ~~might~~ will ship the importer on Friday for real."');
  });

  test('a fabricated quote wrapped in markup still flags', () => {
    const src = groundSource('/t/chat.md', 'user: You should run `gbrain doctor` to check the **sync** step.');
    const r = verifyBody('He said "run **gbrain repair** to delete the `sync` step"', [src]);
    expect(r.failures.quote_not_in_source).toBe(1);
  });

  test('`_` and a lone `~` are still words', () => {
    expect(normForGrounding('my_var ~5 min')).toBe('my_var ~5 min');
    expect(normForGrounding('**a** `b` ~~c~~ ~~~d')).toBe('a b c d');
  });

  test('the offset map points every kept non-space code unit at its original index', () => {
    const s = 'run `gbrain doctor` **now**';
    const { norm, map } = normalizeForGrounding(s);
    expect(norm).toBe('run gbrain doctor now');
    expect(map.length).toBe(norm.length);
    for (let i = 0; i < norm.length; i++) if (norm[i] !== ' ') expect(s[map[i]!]!.toLowerCase()).toBe(norm[i]!);
    const at = norm.indexOf('gbrain doctor now');
    expect(s.slice(map[at], map[at + 'gbrain doctor now'.length - 1]! + 1)).toBe('gbrain doctor` **now');
  });

  test('tolerant sources fold markup alongside link syntax', () => {
    const src = groundSource('/t/notes.md', 'The **[launch plan](plans/launch)** needs a `migration` step first.', { tolerant: true });
    const r = verifyBody('It said "the launch plan needs a migration step first"', [src], { checks: 'quotes' });
    expect(r.quarantined).toHaveLength(0);
  });
});

describe('the cycle date the prompt supplied is not an invented date (#6258)', () => {
  const src = groundSource('/t/2026-09-04-chat.md', 'user: I fixed the importer bug today.');

  test('verifyDreamPage exempts checkedAt and still flags another absent date', () => {
    const page = verifyDreamPage(
      { compiled_truth: 'On 2026-10-06 the user fixed the importer bug.\n\nThe follow-up is due 2026-10-20 at the latest.', timeline: '', frontmatter: {} },
      [src], { prior: null, checkedAt: '2026-10-06' }, emptyQuoteVerifyStats());
    const records = (page.frontmatter.unverified_claims ?? []) as Array<{ reason: string; detail: string }>;
    expect(records.map(r => [r.reason, r.detail])).toEqual([['number_not_in_source', '2026-10-20']]);
    expect(page.compiled_truth).toContain('On 2026-10-06 the user fixed the importer bug.');
  });

  test('verifyBody exempts only the keys it is given', () => {
    const body = 'On 2026-10-06 the user fixed the importer bug.';
    expect(verifyBody(body, [src]).failures.number_not_in_source).toBe(1);
    expect(verifyBody(body, [src], { exemptNumericKeys: new Set(['date:2026-10-06']) }).failures.number_not_in_source).toBe(0);
    expect(verifyBody('On October 6th the user fixed the importer bug.', [src], { exemptNumericKeys: new Set(['date:2026-10-06']) }).failures.number_not_in_source).toBe(1);
  });
});
