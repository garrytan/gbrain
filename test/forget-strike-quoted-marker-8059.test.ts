/**
 * #8059: `strikeFenceRow` splices at the parser's own code-aware locator.
 *
 * 1. Protects: on a page whose prose quotes the facts begin marker in an inline code span above the real fence (the
 *    shape the `quote_marker` repair writes), striking a row rewrites only the real fence; the prose above it stays.
 * 2. Fails when: the splice finds the begin marker by a raw indexOf, so everything from the quoted mention to the real
 *    fence is replaced by the table (#8020's forget item).
 * 3. Pure.
 */
import { expect, test } from 'bun:test';
import { FACTS_FENCE_BEGIN as B, FACTS_FENCE_END as E, parseFactsFence } from '../src/core/facts-fence.ts';
import { strikeFenceRow } from '../src/core/facts/forget.ts';

const HEADER = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |';
const SEP = '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|';
const row = (n: number) => `| ${n} | Acme Example claim ${n} | fact | 0.9 | private | medium | 2024-01-01 |  | note | ctx |`;

test('a row strike on a page that quotes the begin marker in code above the fence keeps the prose', () => {
  const prose = `I typed \`${B}\` into my note.\n\nA second paragraph about it.\n\n`;
  const body = `${prose}${[B, HEADER, SEP, row(1), row(2), E].join('\n')}\n`;
  const struck = strikeFenceRow(body, 2, fact => ({ ...fact, validUntil: '2026-01-01' }));
  expect(struck).not.toBeNull();
  expect(struck!.startsWith(`${prose}${B}`)).toBe(true);
  expect(parseFactsFence(struck!).facts.map(f => f.rowNum)).toEqual([1, 2]);
});
