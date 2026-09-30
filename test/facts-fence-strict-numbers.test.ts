/**
 * Fence numeric cells parse strictly (B-15). parseFloat accepted a numeric
 * prefix of anything: `2.5M` stored 2.5 (so an ARR of 2.5M then 900k read as
 * growth), the European decimal `1,5` stored 15, and `0.9abc` confidence
 * passed. Magnitude suffixes (k/M/B) and a leading currency symbol now scale
 * explicitly; any other shape is a FACTS_TABLE_MALFORMED warning, which keeps
 * the page's existing index instead of storing a silently wrong value.
 */

import { describe, test, expect } from 'bun:test';
import { parseFactsFence } from '../src/core/facts-fence.ts';

const fence = (confidence: string, value: string) => `<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context | claim_metric | claim_value | claim_unit | claim_period |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|--------------|-------------|------------|--------------|
| 1 | ARR | fact | ${confidence} | private | high | 2026-04-12 |  | call |  | arr | ${value} | USD | annual |
<!--- gbrain:facts:end -->`;

describe('fence numeric cells', () => {
  for (const [cell, expected] of [
    ['2500000', 2500000], ['2,500,000', 2500000], ['2.5M', 2500000], ['900k', 900000],
    ['1.2B', 1200000000], ['$10M', 10000000], ['-3.5', -3.5], ['1e3', 1000], ['0.25', 0.25],
  ] as const) {
    test(`claim_value "${cell}" parses to ${expected}`, () => {
      const parsed = parseFactsFence(fence('0.9', cell));
      expect(parsed.warnings).toEqual([]);
      expect(parsed.facts[0].claimValue).toBe(expected);
    });
  }

  for (const cell of ['1,5', '0.9abc', '12,34,567', '10 million', 'n/a', '1.2.3']) {
    test(`claim_value "${cell}" is a malformed-row warning`, () => {
      const parsed = parseFactsFence(fence('0.9', cell));
      expect(parsed.facts).toEqual([]);
      expect(parsed.warnings.some(w => w.startsWith('FACTS_TABLE_MALFORMED') && w.includes(cell))).toBe(true);
    });
  }

  for (const cell of ['0.9abc', '1.0.0', '90%']) {
    test(`confidence "${cell}" is a malformed-row warning`, () => {
      const parsed = parseFactsFence(fence(cell, '5'));
      expect(parsed.facts).toEqual([]);
      expect(parsed.warnings.some(w => w.startsWith('FACTS_TABLE_MALFORMED') && w.includes(cell))).toBe(true);
    });
  }
});
