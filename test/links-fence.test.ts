import { describe, expect, test } from 'bun:test';
import {
  LINKS_FENCE_BEGIN, LINKS_FENCE_END, maskLinksFence, parseLinksFence, readPageLinksFence, removeLinksFenceRows,
  renderLinksFence, replaceOrInsertLinksFence, upsertLinksFenceRow, LinksFenceRewriteRefusal, type LinksFenceRow,
} from '../src/core/links-fence.ts';
import { extractPageLinks } from '../src/core/link-extraction.ts';

const acme: LinksFenceRow = { to: 'companies/acme-example', type: 'works_at', source: 'manual', validFrom: '2025-03-01', context: 'met at a conference' };
const beta: LinksFenceRow = { to: 'companies/beta-example', type: '', source: 'citation-graph', context: '' };

describe('links fence', () => {
  test('renders deterministically, sorted by (to, type, source), and parses back to the same rows', () => {
    const block = renderLinksFence([beta, acme]);
    expect(block).toBe(renderLinksFence([acme, beta]));
    expect(block).toBe([
      LINKS_FENCE_BEGIN,
      '| to | type | source | valid_from | valid_until | context |',
      '|---|---|---|---|---|---|',
      '| companies/acme-example | works_at | manual | 2025-03-01 |  | met at a conference |',
      '| companies/beta-example |  | citation-graph |  |  |  |',
      LINKS_FENCE_END,
    ].join('\n'));
    const parsed = parseLinksFence(block);
    expect(parsed).toEqual({ state: 'parsed', rows: [acme, beta], warnings: [] });
    expect(renderLinksFence(parsed.rows)).toBe(block);
  });

  test('cells holding pipes, newlines and the fence markers round-trip', () => {
    const tricky: LinksFenceRow = { to: 'people/alice-example', type: 'knows', source: 'manual',
      context: `a | b\nnext line ${LINKS_FENCE_END} and gbrain&#58;links:begin` };
    const block = renderLinksFence([tricky]);
    expect(block.split('\n')).toHaveLength(5);
    expect(block.indexOf(LINKS_FENCE_END)).toBe(block.lastIndexOf(LINKS_FENCE_END));
    expect(parseLinksFence(block).rows).toEqual([tricky]);
  });

  test('the source defaults to manual, the header may reorder columns, and an absent fence is absent', () => {
    const body = ['Intro.', '', LINKS_FENCE_BEGIN, '| type | to |', '|---|---|', '| works_at | Companies/Acme-Example |', LINKS_FENCE_END].join('\n');
    expect(parseLinksFence(body).rows).toEqual([{ to: 'companies/acme-example', type: 'works_at', source: 'manual', context: '' }]);
    expect(parseLinksFence('No fence here.')).toEqual({ state: 'absent', rows: [], warnings: [] });
    expect(parseLinksFence(`${LINKS_FENCE_BEGIN}\n| to |`).state).toBe('malformed');
    expect(parseLinksFence(`${LINKS_FENCE_BEGIN}\n| to | colour |\n${LINKS_FENCE_END}`).state).toBe('malformed');
  });

  test('invalid and duplicate rows are skipped with a warning; reconciliation-managed provenances are refused', () => {
    const body = [LINKS_FENCE_BEGIN, '| to | type | source | valid_from |', '|---|---|---|---|',
      '| companies/acme-example | works_at | manual | 2025-02-30 |', '| companies/acme-example | works_at | markdown |  |',
      '| companies/beta-example |  |  |  |', '| companies/beta-example |  | manual |  |', LINKS_FENCE_END].join('\n');
    const parsed = parseLinksFence(body);
    expect(parsed.rows).toEqual([{ to: 'companies/beta-example', type: '', source: 'manual', context: '' }]);
    expect(parsed.warnings.map(w => w.split(':')[0])).toEqual(['LINKS_ROW_INVALID', 'LINKS_ROW_INVALID', 'LINKS_ROW_DUPLICATE']);
    expect(() => upsertLinksFenceRow(body, acme)).toThrow(LinksFenceRewriteRefusal);
  });

  test('a fence quoted in code is not read', () => {
    const quoted = ['```', renderLinksFence([acme]), '```'].join('\n');
    expect(parseLinksFence(quoted).state).toBe('absent');
  });

  test('upsert appends a ## Links section, updates in place, keeps omitted fields, and is idempotent', () => {
    const first = upsertLinksFenceRow('Alice works on widgets.', acme);
    expect(first.changed).toBe(true);
    expect(first.body).toBe(`Alice works on widgets.\n\n## Links\n\n${renderLinksFence([acme])}\n`);
    expect(upsertLinksFenceRow(first.body, acme)).toEqual({ body: first.body, changed: false, row: acme });
    const ended = upsertLinksFenceRow(first.body, { to: acme.to, type: acme.type, source: 'manual', context: '', validUntil: '2026-01-01' });
    expect(ended.row).toEqual({ ...acme, validUntil: '2026-01-01' });
    expect(parseLinksFence(ended.body).rows).toEqual([{ ...acme, validUntil: '2026-01-01' }]);
    expect(ended.body.startsWith('Alice works on widgets.\n\n## Links\n\n')).toBe(true);
    const second = upsertLinksFenceRow(ended.body, beta);
    expect(parseLinksFence(second.body).rows).toEqual([{ ...acme, validUntil: '2026-01-01' }, beta]);
    expect(second.body.match(/## Links/g)).toHaveLength(1);
  });

  test('a new fence goes above an unclosed code block, and into an empty body', () => {
    const body = replaceOrInsertLinksFence('Intro.\n\n```ts\nconst x = 1;', renderLinksFence([acme]));
    expect(body.indexOf('## Links')).toBeLessThan(body.indexOf('```ts'));
    expect(parseLinksFence(body).rows).toEqual([acme]);
    expect(replaceOrInsertLinksFence('', renderLinksFence([]))).toBe(`## Links\n\n${renderLinksFence([])}\n`);
  });

  test('remove drops the matching rows (by type or source when given) and leaves an empty fence', () => {
    const body = upsertLinksFenceRow(upsertLinksFenceRow('Text.', acme).body, { ...acme, source: 'citation-graph' }).body;
    const bySource = removeLinksFenceRows(body, { to: acme.to, source: 'citation-graph' });
    expect(bySource.removed).toEqual([{ ...acme, source: 'citation-graph' }]);
    expect(parseLinksFence(bySource.body).rows).toEqual([acme]);
    const all = removeLinksFenceRows(body, { to: acme.to });
    expect(all.removed).toHaveLength(2);
    expect(parseLinksFence(all.body)).toEqual({ state: 'parsed', rows: [], warnings: [] });
    expect(removeLinksFenceRows('Text.', { to: acme.to })).toEqual({ body: 'Text.', removed: [] });
    expect(removeLinksFenceRows(body, { to: 'companies/other-example' }).body).toBe(body);
  });

  test('the fence is read from the timeline when only the timeline holds one', () => {
    const block = renderLinksFence([acme]);
    expect(readPageLinksFence({ compiled_truth: 'Body.', timeline: `- **2025-01-01** | Met\n\n${block}` }).rows).toEqual([acme]);
    expect(readPageLinksFence({ compiled_truth: 'Body.', timeline: '' }).state).toBe('absent');
  });

  test('masking keeps offsets and newlines, and body link extraction ignores the fence cells', async () => {
    const body = `See [[companies/beta-example]].\n\n## Links\n\n${renderLinksFence([acme])}\n`;
    const masked = maskLinksFence(body);
    expect(masked).toHaveLength(body.length);
    expect(masked.split('\n')).toHaveLength(body.split('\n').length);
    expect(masked).not.toContain('acme-example');
    const resolver = { async resolve() { return null; } };
    const { candidates } = await extractPageLinks('people/alice-example', body, {}, 'person' as never, resolver as never);
    expect(candidates.map(c => c.targetSlug)).toEqual(['companies/beta-example']);
  });
});
