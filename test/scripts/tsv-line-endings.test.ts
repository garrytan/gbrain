/**
 * The ratchet baselines (scripts/*.tsv) are parsed by splitting rows on LF. A
 * CRLF checkout (Git for Windows defaults to core.autocrlf=true) leaves "\r" on
 * each row's last field, and the engine-sql and function-size ratchets then
 * report every grandfathered row as a new violation. .gitattributes pins *.tsv
 * to eol=lf so the checkout is LF on every platform; this pins that rule.
 */
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const git = (...args: string[]) => {
  const res = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout;
};

test('every tracked TSV checks out with LF endings regardless of core.autocrlf', () => {
  const tracked = git('ls-files', '-z', '--', '*.tsv').split('\0').filter(Boolean);
  expect(tracked).toContain('scripts/engine-sql-baseline.tsv');
  expect(tracked).toContain('scripts/function-size-baseline.tsv');

  // check-attr -z prints <path> NUL <attribute> NUL <value> NUL per path.
  const fields = git('check-attr', '-z', 'eol', '--', ...tracked).split('\0');
  const eolByPath = new Map<string, string>();
  for (let i = 0; i + 2 < fields.length; i += 3) eolByPath.set(fields[i], fields[i + 2]);

  expect(eolByPath.size).toBe(tracked.length);
  const notLf = tracked.filter((p) => eolByPath.get(p) !== 'lf');
  expect(notLf).toEqual([]);
});
