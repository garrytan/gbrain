/**
 * A test file that imports another *.test.ts file runs that file's tests under
 * its own name, and when both land in one bun process the imported file reports
 * no tests of its own, so the run's tree.json misses it and /ship's lane carry
 * refuses with inventory_uncovered. Shared cases go in a test/helpers module.
 * test/e2e/ wrappers are the one exception: registerPostgresTests loads unit
 * files there, and the e2e lane never runs in the same process as the unit lane.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '..', '..');
const TEST_FILE = /\.test(\.[cm]?[jt]sx?)?$/;

test('no test file outside test/e2e/ imports another test file, and no e2e wrapper imports an e2e test file', () => {
  const transpilers = { ts: new Bun.Transpiler({ loader: 'ts' }), tsx: new Bun.Transpiler({ loader: 'tsx' }), js: new Bun.Transpiler({ loader: 'js' }) };
  const bad: string[] = [];
  for (const file of new Bun.Glob('test/**/*.test.{ts,tsx,js,mjs}').scanSync({ cwd: REPO })) {
    const e2e = file.startsWith('test/e2e/');
    const transpiler = file.endsWith('.tsx') ? transpilers.tsx : file.endsWith('.ts') ? transpilers.ts : transpilers.js;
    for (const { path } of transpiler.scanImports(readFileSync(join(REPO, file), 'utf8'))) {
      if (!TEST_FILE.test(path)) continue;
      const target = relative(REPO, resolve(REPO, file, '..', path));
      if (!e2e || target.startsWith('test/e2e/')) bad.push(`${file} imports ${target}`);
    }
  }
  expect(bad).toEqual([]);
});
