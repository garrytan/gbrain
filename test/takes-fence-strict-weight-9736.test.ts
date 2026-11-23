import { describe, expect, test } from 'bun:test';
import { parseTakesFence, upsertTakeRow } from '../src/core/takes-fence.ts';
import { cellValid } from '../src/core/fence-repair/schema.ts';
import { scanCanonicalFences } from '../src/core/fence-repair/refusal.ts';

const fence = (weight: string) => `<!--- gbrain:takes:begin -->
| # | claim | kind | who | weight | since | source |
|---|-------|------|-----|--------|-------|--------|
| 1 | Acme-example wins the market | bet | world | ${weight} | 2026-01 | call |
<!--- gbrain:takes:end -->`;

describe('takes fence weight cell is parsed strictly (#9736)', () => {
  test('a percent weight is read as a fraction', () => {
    const r = parseTakesFence(fence('50%'));
    expect(r.warnings).toEqual([]);
    expect(r.takes[0]?.weight).toBe(0.5);
  });

  test('a weight with trailing text is malformed, not truncated', () => {
    for (const w of ['0.7abc', '50 percent', '0.5.1']) {
      const r = parseTakesFence(fence(w));
      expect(r.takes).toEqual([]);
      expect(r.warnings).toEqual([`TAKES_TABLE_MALFORMED: non-numeric weight "${w}"`]);
    }
  });

  test('plain numbers parse as before, out-of-range included', () => {
    expect(parseTakesFence(fence('0.85')).takes[0]?.weight).toBe(0.85);
    expect(parseTakesFence(fence(' 1 ')).takes[0]?.weight).toBe(1);
    expect(parseTakesFence(fence('3')).takes[0]?.weight).toBe(3);
  });

  test('the next takes write renders a percent row as its fraction, never as 50.0', () => {
    const out = upsertTakeRow(fence('50%'), { claim: 'A second take', kind: 'take', holder: 'world', weight: 0.6, active: true }).body;
    expect(out).toContain('| 1 | Acme-example wins the market | bet | world | 0.5 |');
    expect(out).not.toContain('50.0');
  });

  test('the fence-repair lane agrees with the strict parser and points at the weight cell', () => {
    for (const w of ['0.7abc', '1.', '50 percent']) {
      expect(cellValid('takes', 'weight', w)).toBe(false);
      const [defect] = scanCanonicalFences({ compiled_truth: fence(w), slug: 'notes/acme-example' }).defects;
      expect(defect).toMatchObject({ rows: [1], columns: ['weight'] });
    }
    for (const w of ['0.85', '50%', ' 1 ']) expect(cellValid('takes', 'weight', w)).toBe(true);
  });
});
