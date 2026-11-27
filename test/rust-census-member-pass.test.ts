/**
 * The Rust census member-caller pass report (scripts/rust-census/member-pass.ts).
 *
 * 1. Contract: the member pass sits in its own column and section; the anonymous counts never move, the member
 *    totals count each tool once, a tool whose member result differs from its anonymous one is listed, and the
 *    "(option X)" refusals are counted per tool and caller, each distinct option once.
 * 2. Regression that fails it: folding member results into the anonymous totals, counting a repeated option
 *    refusal twice, or matching "(option" on a refusal that names no option, which would misstate how many
 *    tools a served member refuses on an option.
 * 3. Existing coverage: none; the census report had no test for a second caller.
 * 4. Production seam: none; the module renders census rows, which come from real CLI and serve runs.
 */
import { describe, expect, test } from 'bun:test';
import { memberCell, optionRefusals, renderMemberPass, type PassRow } from '../scripts/rust-census/member-pass.ts';

const rows: PassRow[] = [
  { surface: 'cli', name: 'remember', status: 'equal' },
  { surface: 'mcp', name: 'query', status: 'equal', sites: ['listFacts (option asOf)@src/a.ts:1', 'listFacts (option asOf)@src/a.ts:1'], member: { status: 'refused', decisive: 'storePrivacyPolicy', endSite: 'src/core/private-provenance.ts:9', sites: ['storePrivacyPolicy@src/core/private-provenance.ts:9', 'searchKeyword (option kinds)@src/b.ts:2'], note: '' } },
  { surface: 'mcp', name: 'get_page', status: 'refused', decisive: 'getPage', endSite: 'src/c.ts:3', member: { status: 'refused', decisive: 'getPage', endSite: 'src/c.ts:3', note: '' } },
  { surface: 'mcp', name: 'recall', status: 'equal', options: ['listFacts (option since)'], member: { status: 'equal', note: '', options: [] } },
];

describe('census member-caller pass', () => {
  test('optionRefusals keeps each distinct option refusal once and ignores members without an option', () => {
    expect(optionRefusals(['a (option x)@f:1', 'b@f:2', 'a (option x)@f:1', 'a (option y)@f:3', 'c (optional)@f:4'])).toEqual(['a (option x)', 'a (option y)']);
    expect(optionRefusals(undefined)).toEqual([]);
  });

  test('the member cell names the status and the site the member run ended on', () => {
    expect(memberCell(rows[1]!)).toBe('refused storePrivacyPolicy @ src/core/private-provenance.ts:9');
    expect(memberCell(rows[3]!)).toBe('equal');
    expect(memberCell(rows[0]!)).toBe('');
  });

  test('the section keeps anonymous and member totals apart and lists the tools that changed', () => {
    const md = renderMemberPass(rows, ['access owner set census-owner --json: rust exit 0']);
    expect(md).toContain('| anonymous (same tools) | 3 | 2 | 0 | 1 | 0 | 0 |');
    expect(md).toContain('| member | 3 | 1 | 0 | 2 | 0 | 0 |');
    expect(md).toContain('| query | equal | refused | storePrivacyPolicy @ src/core/private-provenance.ts:9 |');
    expect(md).not.toContain('| get_page | refused | refused');
    expect(md).toContain('Tools whose member-caller result differs from the anonymous one: 1.');
    expect(md).toContain('| storePrivacyPolicy @ src/core/private-provenance.ts:9 | 1 | query |');
    expect(md).toContain('- access owner set census-owner --json: rust exit 0');
  });

  test('the option table counts per tool and caller, preferring the recorded options over raw sites', () => {
    const md = renderMemberPass(rows, []);
    expect(md).toContain('Anonymous: 2 across 2 tools. Member: 1 across 1 tools.');
    expect(md).toContain('| query | 1 | 1 | listFacts (option asOf); searchKeyword (option kinds) |');
    expect(md).toContain('| recall | 1 | 0 | listFacts (option since) |');
  });

  test('a pass whose member setup failed lists no changed tools and says why every cell is skipped', () => {
    const md = renderMemberPass([{ surface: 'mcp', name: 'query', status: 'equal', member: { status: 'skipped', note: 'member setup failed: x' } }], []);
    expect(md).toContain('Every member cell is skipped: member setup failed: x');
    expect(md).toContain('Tools whose member-caller result differs from the anonymous one: 0.');
  });

  test('a run without member results says so', () => {
    expect(renderMemberPass([{ surface: 'mcp', name: 'query', status: 'equal' }], [])).toContain('Not run.');
  });
});
