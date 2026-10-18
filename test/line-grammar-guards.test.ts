/**
 * Line grammar guards for template and dictionary text (src/core/line-grammar.ts):
 * bare template slots, separator claims, placeholder claims and lexicographic
 * usage labels never parse as fact lines; decorated relation types explain
 * themselves; undeclared-type suggestions stay within a typo's distance. Every
 * guard reads one line, so a neighbor never changes a line's parse.
 */
import { describe, expect, test } from 'bun:test';
import { parseLineGrammar, USAGE_LABELS } from '../src/core/line-grammar.ts';

const BASE_VERBS = new Set(['works_at', 'advises', 'founded', 'invested_in', 'mentions', 'attended']);
const parse = (text: string, explainGuards = false) => parseLineGrammar(text, { declaredTypes: BASE_VERBS, explainGuards });
const facts = (text: string) => parse(text).facts;
const reasons = (text: string, explainGuards = false) => parse(text, explainGuards).diagnostics.map(d => d.reason);

describe('template and dictionary lines are not fact lines', () => {
  test('bare slots, separators, placeholders and usage labels', () => {
    for (const line of [
      '- [Time] - [Event]',
      '- [Time] [Event]',
      '- [Name]: [Role] at [Company]',
      '- [Date] — Kickoff',
      '- [Day] | Morning | Afternoon',
      '- [Step] = describe the step',
      '- [Owner] / [Due]',
      '- [Topic] > [Subtopic]',
      '- [Item] ...',
      '- [Note] TBD',
      '- [Value] <fill in>',
      '- [Answer] ___',
      '- [noun] a word for a thing',
      '- [informal] gonna, going to',
      '- [Slang] cheesy grin',
      '- [plural] mice',
      '- [transitive] to carry something',
    ]) expect(facts(line)).toEqual([]);
  });

  test('real fact lines keep parsing: links, wikilinks, escapes, code, negative numbers, slashes', () => {
    const kept = [
      '- [preference] Prefers oat milk #coffee (since the almond allergy)',
      '- [fact] value [label](https://example.invalid)',
      '- [fact] see [the guide][ref] for details',
      '- [event] Led the [[projects/pricing]] rework',
      '- [fact] -40 degrees is the lower operating limit',
      '- [fact] 3/4 of the team works remotely',
      '- [idea] Escape \\[Slot\\] literally',
      '- [technique] Use `[Event]` as the placeholder token in templates',
      '- [belief] Small teams win - most of the time',
      '- [commitment] Ship weekly (weekdays only)',
    ];
    for (const line of kept) expect(facts(line)).toHaveLength(1);
  });

  test('the usage-label list is lowercase and disjoint from the six named kinds', () => {
    for (const kind of ['event', 'preference', 'commitment', 'belief', 'fact', 'idea']) expect(USAGE_LABELS.has(kind)).toBe(false);
    for (const label of USAGE_LABELS) expect(label).toBe(label.toLowerCase());
  });
});

describe('guard diagnostics', () => {
  test('a template page stays quiet unless diagnostics are requested', () => {
    const template = '# Day plan\n\n- [Time] - [Event]\n- [Time] - [Event]\n';
    expect(reasons(template)).toEqual([]);
    expect(reasons(template, true)).toEqual(['template_slot', 'template_slot']);
  });

  test('on a page that uses the grammar, a refused line explains itself', () => {
    const page = '- [preference] Prefers tea\n- [noun] a thing\n- works_at [[companies/acme-example]]\n- [Idea] TBD\n';
    expect(reasons(page)).toEqual(['usage_label', 'placeholder_claim']);
    const message = parse(page).diagnostics[0].message;
    expect(message).toContain('stays page text');
    expect(message).toContain('- [preference] Prefers tea');
  });

  test('a placeholder message never asks the writer to fill the slot', () => {
    for (const d of parse('- [preference] Prefers tea\n- [Time] - [Event]\n- [Item] TBD').diagnostics) {
      expect(d.message).not.toMatch(/fill (it|the slot|in)/i);
    }
  });

  test('neighbor edits never change a line\'s parse', () => {
    const line = '- [preference] Prefers tea';
    for (const neighbor of ['- [Time] - [Event]', '- [Time] - [Event]\n- [Time] - [Event]', '- [noun] word', '']) {
      expect(parse(`${neighbor}\n${line}`).facts.map(f => f.claim)).toEqual(['Prefers tea']);
      expect(parse(`${line}\n${neighbor}`).facts.map(f => f.claim)).toEqual(['Prefers tea']);
    }
  });
});

describe('decorated relation types', () => {
  test('colon, bold and backticked types are reported, not read', () => {
    for (const line of ['- works_at: [[companies/acme]]', '- **works_at** [[companies/acme]]', '- `works_at` [[companies/acme]]', '- __advises__ [[companies/acme]]']) {
      const r = parse(line);
      expect(r.relations).toEqual([]);
      expect(r.diagnostics.map(d => d.reason)).toEqual(['type_punctuation']);
      expect(r.diagnostics[0].message).toMatch(/Write it bare: `- (works_at|advises) \[\[target\]\]`/);
    }
  });

  test('bold labels that are not types stay silent', () => {
    for (const line of ['- **Source:** [[companies/acme]]', '- **Note** [[companies/acme]]', '- Related: [[companies/acme]]']) {
      expect(parse(line).diagnostics).toEqual([]);
    }
  });
});

describe('undeclared-type suggestions', () => {
  test('a typo gets the declared verb it meant', () => {
    expect(parse('- wroks_at [[companies/acme]]').diagnostics[0].message).toContain('Did you mean works_at?');
  });

  test('an unrelated relationship never gets a substitute verb', () => {
    const message = parse('- board_member [[companies/acme]]').diagnostics[0].message;
    expect(message).not.toContain('Did you mean');
    expect(message).toContain('declare one in the pack');
  });
});
