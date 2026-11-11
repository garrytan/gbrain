/**
 * The ratchet baselines (scripts/*.tsv) are parsed by splitting on LF. Git for Windows checks out with
 * core.autocrlf=true, which would leave "\r" on each row and make verify report every baseline row as a
 * new violation on a clean checkout (#8641), so .gitattributes pins every tracked TSV to eol=lf.
 */
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..', '..');
const git = (...args: string[]) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });

test('every tracked TSV checks out with LF endings whatever core.autocrlf says', () => {
  const tsvs = git('ls-files', '-z', '--', '*.tsv').split('\0').filter(Boolean);
  expect(tsvs).toContain('scripts/function-size-baseline.tsv');
  const attrs = git('check-attr', '-z', 'eol', '--', ...tsvs).split('\0');
  const notLf: string[] = [];
  for (let i = 0; i + 2 < attrs.length; i += 3) if (attrs[i + 2] !== 'lf') notLf.push(`${attrs[i]}: ${attrs[i + 2]}`);
  expect(notLf).toEqual([]);
});
