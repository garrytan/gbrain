import { describe, expect, test } from 'bun:test';
import { renderPagesBlock } from '../src/core/think/gather.ts';
import type { SearchResult } from '../src/core/types.ts';

function searchResult(
  content: string,
  title = 'Widget Co',
  slug = 'companies/widget-co',
): SearchResult {
  return {
    slug,
    title,
    chunk_text: content,
  } as SearchResult;
}

function renderedExcerpt(rendered: string): string {
  const match = rendered.match(/<page[^>]*>\n([\s\S]*?)\n<\/page>/);
  if (!match) throw new Error('rendered page block did not contain an excerpt');
  return match[1];
}

describe('renderPagesBlock', () => {
  test('selects question-relevant facts beyond the leading 600 characters', () => {
    const prefix = [
      '# Widget Co',
      'General company background and operating context. '.repeat(18),
    ].join('\n');
    expect(prefix.length).toBeGreaterThan(600);

    const facts = [
      'Enterprise pricing: the plan costs 125 credits per month.',
      'The annual option includes priority support.',
    ].join(' ');
    const content = `${prefix}\n${facts}\n${'Other context. '.repeat(80)}`;
    const question = 'What is Widget Co enterprise pricing in credits per month?';

    const rendered = renderPagesBlock([searchResult(content)], 600, question);

    expect(rendered).toContain('Enterprise pricing');
    expect(rendered).toContain('125 credits per month');
    expect(rendered).toContain('annual option includes priority support');
  });

  test('matches query terms at token boundaries instead of inside unrelated words', () => {
    const content = `${'partial context '.repeat(70)}\nExact art marker lives here.\n${'tail '.repeat(200)}`;
    const rendered = renderPagesBlock([searchResult(content)], 120, 'Where is the art marker?');

    expect(rendered).toContain('Exact art marker');
  });

  test('keeps original offsets aligned when compatibility normalization expands earlier text', () => {
    const content = `${'ﬃ '.repeat(260)}${'filler '.repeat(30)}\nTarget booking evidence.\n${'tail '.repeat(200)}`;
    const rendered = renderPagesBlock(
      [searchResult(content)],
      180,
      'Where is the target booking evidence?',
    );

    expect(rendered).toContain('Target booking evidence');
  });

  test('never splits a surrogate pair at a selected window boundary', () => {
    const content = `${'a'.repeat(599)}🚀 target evidence ${'z'.repeat(1000)}`;
    const rendered = renderPagesBlock([searchResult(content)], 600, 'target evidence');
    const excerpt = renderedExcerpt(rendered);

    expect(rendered.isWellFormed()).toBe(true);
    expect(excerpt).toContain('target evidence');
    expect(excerpt.length).toBeLessThanOrEqual(600);
  });

  test('keeps every scored term when a candidate starts inside a surrogate pair', () => {
    const content = `🚀alpha${'.'.repeat(9)}omega${'.'.repeat(40)}`;
    const rendered = renderPagesBlock([searchResult(content)], 20, 'alpha omega');
    const excerpt = renderedExcerpt(rendered);

    expect(excerpt.isWellFormed()).toBe(true);
    expect(excerpt).toContain('alpha');
    expect(excerpt).toContain('omega');
  });

  test('prefers the queried attribute over entity-title terms', () => {
    const prefix = `# Widget Co\n${'General company background. '.repeat(40)}`;
    const fact = '## Pricing\nThe plan costs 125 credits per month.';
    const content = `${prefix}\n${fact}\n${'Other notes. '.repeat(80)}`;
    expect(content.indexOf(fact)).toBeGreaterThan(600);

    const rendered = renderPagesBlock(
      [searchResult(content)],
      120,
      "What is Widget Co's pricing?",
    );

    expect(renderedExcerpt(rendered)).toContain('125 credits per month');
  });

  test('matches common inflections such as price and pricing', () => {
    const prefix = 'General background without commercial details. '.repeat(25);
    const fact = '## Pricing\nThe plan costs 125 credits per month.';
    const content = `${prefix}\n${fact}`;
    expect(content.indexOf(fact)).toBeGreaterThan(600);

    const rendered = renderPagesBlock([searchResult(content)], 120, 'What is the price?');

    expect(renderedExcerpt(rendered)).toContain('125 credits per month');
  });

  test('considers windows that begin at a matched term', () => {
    const content = `${'.'.repeat(100)}alpha${'.'.repeat(45)}omega${'.'.repeat(200)}`;
    const rendered = renderPagesBlock([searchResult(content)], 60, 'alpha omega');
    const excerpt = renderedExcerpt(rendered);

    expect(excerpt).toContain('alpha');
    expect(excerpt).toContain('omega');
  });

  test('retains late occurrences when query terms repeat early', () => {
    const content = [
      'alpha '.repeat(20),
      'x'.repeat(200),
      'omega '.repeat(20),
      'y'.repeat(700),
      'decisive alpha omega evidence',
    ].join('');
    const rendered = renderPagesBlock([searchResult(content)], 80, 'alpha omega');

    expect(renderedExcerpt(rendered)).toContain('decisive alpha omega evidence');
  });

  test('finds a relevant middle occurrence between repeated edge terms', () => {
    const content = [
      'organization '.repeat(20),
      'x'.repeat(400),
      'decisive organization pricing evidence',
      'y'.repeat(400),
      'organization '.repeat(20),
    ].join('');
    const rendered = renderPagesBlock(
      [searchResult(content)],
      80,
      'organization pricing',
    );

    expect(renderedExcerpt(rendered)).toContain('decisive organization pricing evidence');
  });

  test('keeps trailing fact context after dense repeated matches', () => {
    const content = `${'organization '.repeat(100)}decisive organization pricing evidence`;
    const rendered = renderPagesBlock(
      [searchResult(content)],
      80,
      'organization pricing',
    );

    expect(renderedExcerpt(rendered)).toContain('decisive organization pricing evidence');
  });

  test('retains terms from the end of long questions', () => {
    const leadingTerms = Array.from({ length: 24 }, (_, i) => `term${i}`).join(' ');
    const content = `${'Generic background. '.repeat(60)}\ntarget evidence lives here.`;
    const rendered = renderPagesBlock(
      [searchResult(content)],
      100,
      `${leadingTerms} target evidence`,
    );

    expect(renderedExcerpt(rendered)).toContain('target evidence lives here');
  });

  test('matches CJK query bigrams without whitespace token boundaries', () => {
    const prefix = '一般背景。'.repeat(160);
    const fact = '企业版价格：每月125积分。';
    const content = `${prefix}\n${fact}\n${'其他信息。'.repeat(80)}`;
    expect(content.indexOf(fact)).toBeGreaterThan(600);

    const rendered = renderPagesBlock(
      [searchResult(content, '示例公司', 'companies/example')],
      100,
      '企业版价格是多少？',
    );

    expect(renderedExcerpt(rendered)).toContain('每月125积分');
  });

  test('preserves the leading fixed-budget fallback when no query token matches', () => {
    const content = '0123456789'.repeat(100);
    const rendered = renderPagesBlock(
      [searchResult(content)],
      600,
      'unmatched question',
    );

    expect(renderedExcerpt(rendered)).toBe(content.slice(0, 600));
  });

  test('keeps a complete surrogate pair ending exactly at the fallback budget', () => {
    const content = `${'a'.repeat(598)}🚀tail`;
    const rendered = renderPagesBlock([searchResult(content)], 600);
    const excerpt = renderedExcerpt(rendered);

    expect(excerpt).toBe(content.slice(0, 600));
    expect(excerpt.isWellFormed()).toBe(true);
  });

  test('preserves leading truncation for callers that omit the question', () => {
    const content = 'abcdefghij'.repeat(100);
    const rendered = renderPagesBlock([searchResult(content)], 600);

    expect(renderedExcerpt(rendered)).toBe(content.slice(0, 600));
  });
});
