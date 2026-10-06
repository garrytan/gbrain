/**
 * Line grammar parser (src/core/line-grammar.ts): typed fact and relation
 * lines, the guards that keep transcripts, task lists and citations out, and
 * the `@effective[start,end)` validity qualifier. Pure, no engine.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { normalizeRelationType, parseEffectiveQualifier, parseLineGrammar } from '../src/core/line-grammar.ts';

const facts = (text: string) => parseLineGrammar(text).facts;
const relations = (text: string, declared?: string[]) =>
  parseLineGrammar(text, { declaredTypes: declared ? new Set(declared) : null }).relations;
const reasons = (text: string, declared?: string[]) =>
  parseLineGrammar(text, { declaredTypes: declared ? new Set(declared) : null }).diagnostics.map(d => d.reason);

describe('fact lines', () => {
  test('category, claim, tags and context', () => {
    expect(facts('- [preference] Prefers oat milk #coffee #morning (since the almond allergy)')).toEqual([{ line: 1,
      category: 'preference', kind: 'preference', claim: 'Prefers oat milk', tags: ['coffee', 'morning'],
      context: 'since the almond allergy', effective: null }]);
  });

  test('a category outside the six kinds is kept and the kind is fact', () => {
    expect(facts('* [technique] Water at 205F extracts best')[0]).toMatchObject({ category: 'technique', kind: 'fact', claim: 'Water at 205F extracts best' });
  });

  test('numbered list items and nested items count', () => {
    expect(facts('1. [idea] Ship weekly\n   - [belief] Small teams win')).toHaveLength(2);
  });

  test('guards: timecodes, dates, task markers, citations, footnotes, links, images, multi-word brackets', () => {
    for (const line of [
      '- [00:00:11] Speaker one said hello',
      '- [1:02:03.500] later',
      '- [00:01 - 00:05] range',
      '- [2024-01-01] dated',
      '- [ ] open task',
      '- [x] done task',
      '- [X] done task',
      '- [/] in progress',
      '- [-] cancelled',
      '- [>] deferred',
      '- [?] question',
      '- [Source: email 2024] cited claim',
      '- [^1] footnote',
      '- [Acme](companies/acme) is a company',
      '- [Acme][ref] reference link',
      '- ![chart](img.png) image',
      '- [[people/alice]] wikilink',
      '- [two words] not a category',
      '- [todo] call bob',
      '- [WIP] draft',
      '- [D4] decision id',
      '- [ENG-1] review finding',
      '- [Q3] quarter',
      '- [NOTE] marker',
    ]) expect(facts(line)).toEqual([]);
  });

  test('code, blockquotes, HTML comments, frontmatter and machine sections are never read', () => {
    const text = [
      '---', 'title: x', 'tags:', '  - [idea] in frontmatter', '---',
      '```', '- [idea] in a fence', '```',
      '> - [idea] in a quote',
      '<!-- - [idea] in a comment -->',
      '## Timeline', '- [event] in the timeline section',
      '## Notes', '- [idea] counted',
    ].join('\n');
    expect(facts(text).map(f => f.claim)).toEqual(['counted']);
  });

  test('a backslash keeps the line literal', () => {
    expect(facts('- \\[idea] escaped')).toEqual([]);
  });

  test('CRLF line endings', () => {
    expect(facts('- [idea] one\r\n- [idea] two\r\n').map(f => f.claim)).toEqual(['one', 'two']);
  });
});

describe('relation lines', () => {
  test('type, link forms and context', () => {
    expect(relations('- works_at [[companies/acme-example]] (since 2024)')).toMatchObject([{ type: 'works_at', context: 'since 2024', line: 1 }]);
    expect(relations('- advises [Acme](companies/acme-example)')).toMatchObject([{ type: 'advises', context: null }]);
    expect(relations('- invested_in [[fund-a:companies/acme-example|Acme]]')).toMatchObject([{ type: 'invested_in' }]);
  });

  test('type normalization: camelCase, kebab, quoted phrases', () => {
    expect(normalizeRelationType('worksAt')).toBe('works_at');
    expect(normalizeRelationType('works-at')).toBe('works_at');
    expect(normalizeRelationType('Board Member')).toBe('board_member');
    expect(relations('- "board member" [[companies/acme]]')).toMatchObject([{ type: 'board_member' }]);
    expect(relations("- 'reports to' [[people/bob]]")).toMatchObject([{ type: 'reports_to' }]);
  });

  test('offsets cover the whole line so a link on it can be matched', () => {
    const text = 'Intro.\n- works_at [[companies/acme]]\n';
    const [r] = relations(text);
    expect(text.slice(r.start, r.end)).toBe('- works_at [[companies/acme]]');
  });

  test('sentences fall back silently: multi-word prefix, generic words, prose without a typed attempt', () => {
    expect(relations('- Met [[people/alice]] at the cafe')).toEqual([]);
    expect(reasons('- Met [[people/alice]] at the cafe')).toEqual([]);
    expect(relations('- works at [[companies/acme]]')).toEqual([]);
    expect(relations('- See [[people/alice]]')).toEqual([]);
    expect(reasons('- See [[people/alice]]')).toEqual([]);
    expect(relations('- [[people/alice]]')).toEqual([]);
  });

  test('typed attempts that do not parse explain themselves', () => {
    expect(reasons('- works_at [[companies/acme]] since 2024')).toEqual(['prose_tail']);
    expect(reasons('- invested_in [[a]] and [[b]]')).toEqual(['two_links']);
    expect(reasons('- "see" [[people/x]]')).toEqual(['stoplist_type']);
    expect(relations('- works_at [[companies/acme]] (primary) and [[b]] (secondary)')).toEqual([]);
  });

  test('a trailing [Source: ...] citation is set aside on both line kinds', () => {
    expect(relations('- works_at [[companies/acme]] (since 2024) [Source: User, chat, 2026-10-04]')).toMatchObject([{ type: 'works_at', context: 'since 2024' }]);
    expect(relations('- advises [[companies/acme]] [Source: [Acme blog](https://example.com/post)]')).toMatchObject([{ type: 'advises' }]);
    expect(facts('- [preference] Tea #drinks (mornings) [Source: User, 2026-10-04]')).toMatchObject([{ claim: 'Tea', context: 'mornings', tags: ['drinks'] }]);
  });

  test('links inside code are not links', () => {
    expect(relations('- works_at `[[companies/acme]]`')).toEqual([]);
  });

  test('declared vocabulary gate: undeclared types fall back with the nearest verb', () => {
    expect(relations('- workz_at [[companies/a]]', ['works_at', 'invested_in'])).toEqual([]);
    const [d] = parseLineGrammar('- workz_at [[companies/a]]', { declaredTypes: new Set(['works_at']) }).diagnostics;
    expect(d).toMatchObject({ reason: 'undeclared_type' });
    expect(d.message).toContain('Did you mean works_at?');
    expect(relations('- works_at [[companies/a]]', ['works_at'])).toHaveLength(1);
    expect(relations('- anything_goes [[companies/a]]')).toHaveLength(1);
  });

  test('machine sections are skipped', () => {
    expect(relations('## See also\n- works_at [[companies/acme]]\n## Related\n- advises [[x]]')).toEqual([]);
  });
});

describe('@effective qualifier', () => {
  const range = (q: string) => { const r = parseEffectiveQualifier(q); return r.kind === 'ok' ? [r.range.from, r.range.until] : r.kind; };

  test('precision and bound kinds normalize to half-open dates', () => {
    expect(range('@effective[2024-03,2024-09)')).toEqual(['2024-03-01', '2024-09-01']);
    expect(range('@effective[2022,2024]')).toEqual(['2022-01-01', '2025-01-01']);
    expect(range('@effective(2024-01-31,2024-02-29]')).toEqual(['2024-02-01', '2024-03-01']);
    expect(range('@valid[2024-12,)')).toEqual(['2024-12-01', null]);
    expect(range('@effective[,2020)')).toEqual([null, '2020-01-01']);
  });

  test('invalid, reversed, natural-language and unknown qualifiers are refused', () => {
    expect(range('@effective[2023-02-29,)')).toBe('refused');
    expect(range('@effective[2024,2023)')).toBe('refused');
    expect(range('@effective[2024,2024)')).toBe('refused');
    expect(range('@effective[last spring,)')).toBe('refused');
    expect(range('@occurred[2024,2025)')).toBe('refused');
    expect(range('@occurred:2024-01-01')).toBe('refused');
  });

  test('handles and emails are not qualifiers', () => {
    expect(range('@alice said hi')).toBe('none');
    expect(range('paul@example.com')).toBe('none');
  });

  test('on fact and relation lines; a refused qualifier is never peeled', () => {
    expect(facts('- [event] @effective[2024-03,2024-09) Led the pricing rework')[0]).toMatchObject({
      claim: 'Led the pricing rework', effective: { from: '2024-03-01', until: '2024-09-01' } });
    expect(facts('- [event] @effective[last year,) Led it')[0]).toMatchObject({ claim: '@effective[last year,) Led it', effective: null });
    expect(relations('- works_at @effective[2022,2024] [[companies/acme]]')[0]).toMatchObject({ type: 'works_at',
      effective: { from: '2022-01-01', until: '2025-01-01' } });
    expect(relations('- works_at [[companies/acme]] @effective[2022,) (CTO)')[0]).toMatchObject({ context: 'CTO',
      effective: { from: '2022-01-01', until: null } });
    expect(relations('- works_at [[companies/acme]] @occurred:2022')).toEqual([]);
    expect(reasons('- works_at [[companies/acme]] @occurred:2022')).toEqual(['unknown_qualifier']);
  });
});

test('adversarial input stays linear (bounded child process)', () => {
  const script = `
    const { parseLineGrammar } = await import(${JSON.stringify(new URL('../src/core/line-grammar.ts', import.meta.url).pathname)});
    const evil = ['- ' + '['.repeat(20000) + 'x', '- works_at ' + '('.repeat(20000), '- [a] ' + '(('.repeat(10000) + ')',
      '- t ' + '[[a]] '.repeat(5000), '- [idea] @effective[' + ','.repeat(20000)].join('\\n');
    const t = performance.now(); parseLineGrammar(evil.repeat(5)); console.log(Math.round(performance.now() - t));`;
  const run = spawnSync(process.execPath, ['-e', script], { timeout: 20_000, encoding: 'utf-8' });
  expect(run.status, run.stderr).toBe(0);
  expect(Number(run.stdout.trim())).toBeLessThan(5_000);
}, 30_000);
