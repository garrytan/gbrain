import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluate, scanTree } from '../../scripts/check-test-placeholders.mjs';

const ROOT = join(import.meta.dir, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'check-test-placeholders.mjs');
const FIXTURES = join(ROOT, 'test', 'fixtures', 'guards', 'check-test-placeholders.mjs');

function run(fixtureRoot: string) {
  const r = spawnSync('node', [SCRIPT, fixtureRoot], { cwd: ROOT, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'placeholder-guard-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}

describe('check-test-placeholders fixtures', () => {
  test('bad fixture fails with one diagnostic per placeholder form', () => {
    const { status, out } = run(join(FIXTURES, 'bad'));
    expect(status).toBe(1);
    for (const [line, form] of [[5, 'expect(true)'], [9, 'expect(true).toBe(true)'], [13, 'expect(true).toBeTruthy()'], [17, 'expect(1).toBe(1)']] as const) {
      expect(out).toContain(`test-placeholder-assertion: test/placeholders.test.fixture.ts:${line} uses \`${form}\``);
    }
    expect(out).toContain('reason: this assertion passes whatever the product does');
    expect(out).toContain('remedy: assert the observable outcome');
    expect(out).toContain('rerun: bun run check:test-placeholders');
    expect(out).toContain('docs: docs/TESTING.md#placeholder-assertions');
    expect(out).toContain('count: expected 0 placeholder(s) for this test, found 1.');
  });

  test('good fixture passes: fail sentinels, strings, templates, comments and test/fixtures are ignored', () => {
    const { status, out } = run(join(FIXTURES, 'good'));
    expect(status).toBe(0);
    expect(out).toContain('check-test-placeholders: OK (1 test files, 0 allowlisted placeholder site(s))');
  });
});

describe('check-test-placeholders allowlist', () => {
  const body = (n: number) => `import { describe, expect, test } from 'bun:test';
describe('suite', () => {
  test('marker', () => {
${'    expect(true).toBe(true);\n'.repeat(n)}  });
});
`;

  test('an allowlisted count passes; one more site fails with expected versus actual', () => {
    const dir = tree({ 'test/a.test.ts': body(2) });
    try {
      const scan = scanTree(dir, false)!;
      const entry = { path: 'test/a.test.ts', test: 'suite > marker', reason: 'r', count: 2 };
      expect(evaluate(scan.sites, [entry], dir).problems).toEqual([]);
      const over = evaluate(scan.sites, [{ ...entry, count: 1 }], dir).problems;
      expect(over).toHaveLength(2);
      expect(over[0]).toContain('test/a.test.ts:4 uses `expect(true).toBe(true)` in "suite > marker"');
      expect(over[0]).toContain('count: allowlist expects 1 placeholder(s) for this test, found 2.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('stale entries fail with a distinct message that says to shrink the allowlist', () => {
    const dir = tree({ 'test/a.test.ts': body(1) });
    try {
      const scan = scanTree(dir, false)!;
      const problems = evaluate(scan.sites, [
        { path: 'test/a.test.ts', test: 'suite > marker', reason: 'r', count: 3 },
        { path: 'test/a.test.ts', test: 'suite > renamed', reason: 'r' },
        { path: 'test/gone.test.ts', test: 'x', reason: 'r' },
      ], dir).problems;
      expect(problems).toHaveLength(3);
      expect(problems[0]).toContain('(stale allowlist entry): test/a.test.ts "suite > marker": the placeholder count dropped.');
      expect(problems[0]).toContain('count: allowlist expects 3, found 1.');
      expect(problems[1]).toContain('"suite > renamed": no placeholder remains for this test.');
      expect(problems[2]).toContain('test/gone.test.ts "x": its file no longer exists.');
      for (const p of problems) {
        expect(p).toContain('remedy: remove the entry or reduce its count in scripts/check-test-placeholders.mjs; do not restore the placeholder.');
        expect(p).toContain('rerun: bun run check:test-placeholders');
        expect(p).toContain('docs: docs/TESTING.md#placeholder-assertions');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
