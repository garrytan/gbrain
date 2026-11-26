/**
 * GST-3786: an agent's grep -E style `a|b` used to match only the literal string, so a clause the page holds read
 * as "not on this page". An inner pipe now also matches each side, unioned with the literal term; a spaced,
 * leading or trailing pipe stays literal.
 */
import { describe, expect, test } from 'bun:test';
import { grepAlternatives, readGrep } from '../src/core/ops/get-page-slice.ts';

async function* stream(s: string): AsyncGenerator<Buffer> { yield Buffer.from(s); }

type Grep = { grep: { term: string; alternatives?: string[]; total_matches: number; blocks: Array<{ line_start: number; line_end: number; match_starts: number[]; text: string }> } };
const grep = async (doc: string, term: string) => await readGrep(stream(doc), term, 0, 100_000, t => t) as Grep;

const page = [
  '# Amendment No. 1', '',
  'Status: Executed.', '',
  '7a. Effective 2026-07-10, the uptime target changes to 99.9%.', '',
  '9. Payment terms move to Net 45.', '',
  'Ledger key acme-example|q3 is kept as written.', '',
  '| item | value |',
  '|---|---|',
  '| seats | 12 |',
  '|plan|pro|',
].join('\n') + '\n';

describe('grepAlternatives', () => {
  test('an inner pipe between non-space text names each side, lowercased, escapes dropped, deduplicated', () => {
    expect(grepAlternatives('uptime|SLA|seats')).toEqual(['uptime', 'sla', 'seats']);
    expect(grepAlternatives('Net 30|Net 45')).toEqual(['net 30', 'net 45']);
    expect(grepAlternatives('%|\\$')).toEqual(['%', '$']);
    expect(grepAlternatives('SLA|sla')).toEqual([]);
  });

  test('a spaced, leading or trailing pipe, or no pipe, names none', () => {
    for (const term of ['a | b', 'a |b', 'a| b', '| seats |', '|seats', 'seats|', 'uptime']) expect(grepAlternatives(term)).toEqual([]);
  });
});

describe('get_page grep with a|b', () => {
  test('each alternative matches, and the response lists them', async () => {
    const r = await grep(page, 'Uptime|Net 45');
    expect(r.grep.term).toBe('Uptime|Net 45');
    expect(r.grep.alternatives).toEqual(['uptime', 'net 45']);
    expect(r.grep.total_matches).toBe(2);
    expect(r.grep.blocks).toEqual([{ line_start: 5, line_end: 7, match_starts: [5, 7], text: '7a. Effective 2026-07-10, the uptime target changes to 99.9%.\n\n9. Payment terms move to Net 45.' }]);
  });

  test('a page that really holds the literal pipe still matches it, once', async () => {
    const r = await grep(page, 'acme-example|q3');
    expect(r.grep.alternatives).toEqual(['acme-example', 'q3']);
    expect(r.grep.total_matches).toBe(1);
    expect(r.grep.blocks[0].text).toBe('Ledger key acme-example|q3 is kept as written.');
  });

  test('a Markdown table row term stays literal and finds only that row', async () => {
    const spaced = await grep(page, '| seats |');
    expect(spaced.grep.alternatives).toBeUndefined();
    expect(spaced.grep.blocks.map(b => b.text)).toEqual(['| seats | 12 |']);
    const compact = await grep(page, '|plan|pro|');
    expect(compact.grep.alternatives).toBeUndefined();
    expect(compact.grep.blocks.map(b => b.text)).toEqual(['|plan|pro|']);
  });

  test('an alternative with no match drops out; when none match the result is empty', async () => {
    const one = await grep(page, 'availability|uptime');
    expect(one.grep.alternatives).toEqual(['availability', 'uptime']);
    expect(one.grep.total_matches).toBe(1);
    expect(one.grep.blocks[0].text).toContain('99.9%');
    const none = await grep(page, 'availability|warranty');
    expect(none.grep.alternatives).toEqual(['availability', 'warranty']);
    expect(none.grep).toMatchObject({ total_matches: 0, blocks: [] });
  });

  test('a plain term is unchanged and carries no alternatives', async () => {
    const r = await grep(page, 'uptime');
    expect(r.grep.total_matches).toBe(1);
    expect('alternatives' in r.grep).toBe(false);
  });
});
