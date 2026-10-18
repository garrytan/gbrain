/** scripts/q2-typing-package.ts: the one-line rewrite of ENABLED_TYPING_UNITS and the branch names. */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { packageBranchName, withEnabledUnits } from '../scripts/q2-typing-package.ts';
import { parseTypingUnits } from '../src/core/link-typing-units.ts';

// test-reads-source-ok[structural]: the package script rewrites this file's text; the test checks that rewrite on the real file.
const source = readFileSync(join(import.meta.dir, '../src/core/link-typing-units.ts'), 'utf8');

test('the package commit changes exactly the ENABLED_TYPING_UNITS line, in the given order', () => {
  const next = withEnabledUnits(source, ['U4', 'U1', 'U3']);
  const changed = next.split('\n').filter((line, i) => line !== source.split('\n')[i]);
  expect(changed).toEqual([`export const ENABLED_TYPING_UNITS: ReadonlySet<TypingUnit> = new Set<TypingUnit>(['U4', 'U1', 'U3']);`]);
  expect(withEnabledUnits(next, ['U3', 'U4', 'U1'])).toBe(source);
});

test('a joint unit expands in place and branch names say what the ref holds', () => {
  expect(parseTypingUnits(['U34', 'U1'])).toEqual(['U3', 'U4', 'U1']);
  expect(packageBranchName('abc123def', ['U3', 'U4', 'U1'], false)).toBe('q2-typing/abc123def/U3-U4-U1');
  expect(packageBranchName('abc123def', ['U3', 'U4'], true)).toBe('q2-typing/abc123def/arm-U3U4');
  expect(packageBranchName('abc123def', [], false)).toBe('q2-typing/abc123def/none');
});

test('a units file without the declaration is refused with what to restore', () => {
  expect(() => withEnabledUnits('export const X = 1;', ['U1'])).toThrow(/has no "export const ENABLED_TYPING_UNITS/);
});
