import { describe, expect, test } from 'bun:test';
import { parseTakesFence, upsertTakeRow } from '../src/core/takes-fence.ts';

const mk = (w: string) => `<!--- gbrain:takes:begin -->
| # | claim | kind | who | weight | since | source |
|---|-------|------|-----|--------|-------|--------|
| 1 | Acme-example wins the market | bet | world | ${w} | 2026-01 | call |
<!--- gbrain:takes:end -->`;

describe('takes fence strict weight cell', () => {
  test('N% is read as N/100', () => {
    const r = parseTakesFence(mk('50%'));
    expect(r.warnings).toEqual([]);
    expect(r.takes[0]?.weight).toBeCloseTo(0.5);
  });
  test('trailing junk is malformed', () => {
    const r = parseTakesFence(mk('0.7abc'));
    expect(r.takes.length).toBe(0);
    expect(r.warnings.some(w => w.startsWith('TAKES_TABLE_MALFORMED'))).toBe(true);
  });
  test('upsert does not rewrite 50% as 50.0', () => {
    const out = upsertTakeRow(mk('50%'), { claim: 'A second take', kind: 'take', holder: 'world', weight: 0.6, active: true });
    expect(JSON.stringify(out)).not.toContain('50.0');
  });
});
