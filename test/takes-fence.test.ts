import { describe, test, expect } from 'bun:test';
import {
  parseTakesFence,
  renderTakesFence,
  upsertTakeRow,
  supersedeRow,
  stripTakesFence,
  TAKES_FENCE_BEGIN,
  TAKES_FENCE_END,
} from '../src/core/takes-fence.ts';

const SAMPLE_BODY = `# Alice Example

Some prose at the top.

## Takes

${TAKES_FENCE_BEGIN}
| # | claim | kind | who | weight | since | source |
|---|-------|------|-----|--------|-------|--------|
| 1 | CEO of Acme | fact | world | 1.0 | 2017-01 | Crustdata |
| 2 | Strong technical founder | take | garry | 0.85 | 2026-04-29 | OH 2026-04-29 |
| 3 | ~~Will reach $50B~~ | bet | garry | 0.7 | 2026-04-29 → 2026-06 | superseded by #4 |
| 4 | Will reach $30B | bet | garry | 0.55 | 2026-06 | revised after Q2 |
${TAKES_FENCE_END}

## Notes

Other content below the fence.
`;

describe('parseTakesFence', () => {
  test('parses canonical-form table', () => {
    const { takes, warnings } = parseTakesFence(SAMPLE_BODY);
    expect(warnings).toEqual([]);
    expect(takes).toHaveLength(4);
    expect(takes[0]).toMatchObject({
      rowNum: 1,
      claim: 'CEO of Acme',
      kind: 'fact',
      holder: 'world',
      weight: 1.0,
      sinceDate: '2017-01',
      source: 'Crustdata',
      active: true,
    });
  });

  test('strikethrough → active=false; claim text stripped', () => {
    const { takes } = parseTakesFence(SAMPLE_BODY);
    const row3 = takes.find(t => t.rowNum === 3)!;
    expect(row3.active).toBe(false);
    expect(row3.claim).toBe('Will reach $50B');
  });

  test('date range splits into since + until', () => {
    const { takes } = parseTakesFence(SAMPLE_BODY);
    const row3 = takes.find(t => t.rowNum === 3)!;
    expect(row3.sinceDate).toBe('2026-04-29');
    expect(row3.untilDate).toBe('2026-06');
  });

  test('returns empty + no warnings when no fence present', () => {
    const { takes, warnings } = parseTakesFence('# Just prose\n\nNo takes here.');
    expect(takes).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test('warns on unbalanced fence (missing end)', () => {
    const body = `## Takes\n\n${TAKES_FENCE_BEGIN}\n| # | claim | kind | who | weight | since | source |\n`;
    const { takes, warnings } = parseTakesFence(body);
    expect(takes).toEqual([]);
    expect(warnings.some(w => w.includes('TAKES_FENCE_UNBALANCED'))).toBe(true);
  });

  test('skips malformed rows + records TAKES_TABLE_MALFORMED warnings', () => {
    const body = `${TAKES_FENCE_BEGIN}
| # | claim | kind | who | weight | since | source |
|---|-------|------|-----|--------|-------|--------|
| 1 | Valid row | fact | world | 1.0 | 2026-01 | source |
| 2 | Bad weight | take | garry | not-a-number | 2026-01 | x |
| 3 | Unknown kind | wibble | garry | 0.5 | 2026-01 | x |
| zzz | Bad rownum | fact | world | 1.0 | 2026-01 | x |
${TAKES_FENCE_END}`;
    const { takes, warnings } = parseTakesFence(body);
    expect(takes).toHaveLength(1);
    expect(takes[0].claim).toBe('Valid row');
    expect(warnings.length).toBeGreaterThanOrEqual(3);
    expect(warnings.some(w => w.includes('non-numeric weight'))).toBe(true);
    expect(warnings.some(w => w.includes('unknown kind'))).toBe(true);
    expect(warnings.some(w => w.includes('invalid row_num'))).toBe(true);
  });

  test('flags TAKES_ROW_NUM_COLLISION on duplicate row_num', () => {
    const body = `${TAKES_FENCE_BEGIN}
| # | claim | kind | who | weight | since | source |
|---|-------|------|-----|--------|-------|--------|
| 1 | First | fact | world | 1.0 |  |  |
| 1 | Duplicate | fact | world | 1.0 |  |  |
${TAKES_FENCE_END}`;
    const { takes, warnings } = parseTakesFence(body);
    expect(takes).toHaveLength(1);
    expect(warnings.some(w => w.includes('TAKES_ROW_NUM_COLLISION'))).toBe(true);
  });
});

describe('renderTakesFence', () => {
  test('round-trip preserves all fields', () => {
    const original = parseTakesFence(SAMPLE_BODY);
    const rendered = renderTakesFence(original.takes);
    expect(rendered.startsWith(TAKES_FENCE_BEGIN)).toBe(true);
    expect(rendered.endsWith(TAKES_FENCE_END)).toBe(true);
    // Re-parse the rendered fence and confirm round-trip equivalence.
    const reparsed = parseTakesFence(rendered);
    expect(reparsed.warnings).toEqual([]);
    expect(reparsed.takes).toHaveLength(original.takes.length);
    for (let i = 0; i < original.takes.length; i++) {
      const before = original.takes[i];
      const after = reparsed.takes[i];
      expect(after.rowNum).toBe(before.rowNum);
      expect(after.claim).toBe(before.claim);
      expect(after.kind).toBe(before.kind);
      expect(after.holder).toBe(before.holder);
      expect(after.weight).toBe(before.weight);
      expect(after.active).toBe(before.active);
      expect(after.sinceDate).toBe(before.sinceDate);
      expect(after.untilDate).toBe(before.untilDate);
      expect(after.source).toBe(before.source);
    }
  });
});

describe('upsertTakeRow', () => {
  test('appends to existing fence at next row_num', () => {
    const { body, rowNum } = upsertTakeRow(SAMPLE_BODY, {
      claim: 'Best founder I have met this batch',
      kind: 'take',
      holder: 'garry',
      weight: 0.95,
      sinceDate: '2026-05-01',
      source: 'OH 2026-05-01',
      active: true,
    });
    expect(rowNum).toBe(5);
    const { takes } = parseTakesFence(body);
    expect(takes).toHaveLength(5);
    expect(takes[4].claim).toBe('Best founder I have met this batch');
    expect(takes[4].rowNum).toBe(5);
  });

  test('creates a new Takes section when no fence exists', () => {
    const fresh = '# New Page\n\nSome content.\n';
    const { body, rowNum } = upsertTakeRow(fresh, {
      claim: 'First take',
      kind: 'fact',
      holder: 'world',
      weight: 1.0,
      active: true,
    });
    expect(rowNum).toBe(1);
    expect(body).toContain('## Takes');
    expect(body).toContain(TAKES_FENCE_BEGIN);
    const { takes } = parseTakesFence(body);
    expect(takes).toHaveLength(1);
  });

  test('row_num is monotonic — never reuses gaps', () => {
    // Body where rows 2 and 4 are present (1 and 3 deleted by hand-edit)
    const body = `## Takes

${TAKES_FENCE_BEGIN}
| # | claim | kind | who | weight | since | source |
|---|-------|------|-----|--------|-------|--------|
| 2 | Two | fact | world | 1.0 | 2026-01 | x |
| 4 | Four | fact | world | 1.0 | 2026-01 | x |
${TAKES_FENCE_END}
`;
    const { rowNum } = upsertTakeRow(body, {
      claim: 'Five',
      kind: 'fact',
      holder: 'world',
      weight: 1.0,
      active: true,
    });
    expect(rowNum).toBe(5); // max(2,4)+1, NOT 1 (gap-fill would break refs)
  });
});

describe('supersedeRow', () => {
  test('strikes old row + appends new at end', () => {
    const { body, oldRowNum, newRowNum } = supersedeRow(SAMPLE_BODY, 2, {
      claim: 'Strongest technical founder I have met',
      kind: 'take',
      holder: 'garry',
      weight: 0.95,
      sinceDate: '2026-05-01',
      source: 'OH 2026-05-01',
    });
    expect(oldRowNum).toBe(2);
    expect(newRowNum).toBe(5);
    const { takes } = parseTakesFence(body);
    const old = takes.find(t => t.rowNum === 2)!;
    expect(old.active).toBe(false);
    const fresh = takes.find(t => t.rowNum === 5)!;
    expect(fresh.claim).toBe('Strongest technical founder I have met');
    expect(fresh.active).toBe(true);
  });

  test('throws when target row not found', () => {
    expect(() =>
      supersedeRow(SAMPLE_BODY, 999, {
        claim: 'x',
        kind: 'fact',
        holder: 'world',
        weight: 1.0,
      }),
    ).toThrow();
  });
});

describe('stripTakesFence', () => {
  test('removes the fence block from the body (privacy fix)', () => {
    const stripped = stripTakesFence(SAMPLE_BODY);
    expect(stripped).not.toContain(TAKES_FENCE_BEGIN);
    expect(stripped).not.toContain(TAKES_FENCE_END);
    expect(stripped).not.toContain('Strong technical founder');
    expect(stripped).not.toContain('Will reach $50B');
    // Surrounding prose preserved.
    expect(stripped).toContain('Some prose at the top.');
    expect(stripped).toContain('## Notes');
    expect(stripped).toContain('Other content below the fence.');
  });

  test('returns body unchanged when no fence present', () => {
    const body = '# Plain page\n\nNo takes here.';
    expect(stripTakesFence(body)).toBe(body);
  });
});
