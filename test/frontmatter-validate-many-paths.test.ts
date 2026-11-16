import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { runFrontmatter } from '../src/commands/frontmatter.ts';
import { currentExitCode, _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'fm-many-')); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

interface Report { ok: boolean; total_files: number; targets?: string[]; results: Array<{ path: string; failed: boolean }> }

async function validate(args: string[]): Promise<{ json: Report | null; verdict: number }> {
  const logOrig = console.log;
  const errOrig = console.error;
  const prevExitCode = process.exitCode;
  const out: string[] = [];
  _resetCliExitVerdictForTests();
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(' ')); };
  console.error = () => {};
  try {
    await runFrontmatter(['validate', ...args, '--json']);
  } finally {
    console.log = logOrig;
    console.error = errOrig;
  }
  const verdict = currentExitCode();
  _resetCliExitVerdictForTests();
  process.exitCode = prevExitCode ?? 0;
  return { json: out.length ? JSON.parse(out.join('\n')) as Report : null, verdict };
}

function files() {
  mkdirSync(join(tmp, 'a'));
  mkdirSync(join(tmp, 'b'));
  const good = join(tmp, 'a', 'good.md');
  const bad = join(tmp, 'b', 'bad.md');
  writeFileSync(good, '---\ntitle: Good\n---\nbody\n');
  writeFileSync(bad, '---\ntitle: [unclosed\n---\nbody\n');
  return { good, bad };
}

test('a bad file named before a good one fails the run instead of reporting ok', async () => {
  const { good, bad } = files();
  const { json, verdict } = await validate([bad, good]);
  expect(json!.ok).toBe(false);
  expect(verdict).toBe(1);
  expect(json!.total_files).toBe(2);
  expect(json!.targets).toEqual([bad, good]);
  expect(json!.results.map(r => [r.path, r.failed])).toEqual([[bad, true], [good, false]]);
});

test('every directory named is walked, and a file named twice is checked once', async () => {
  const { good, bad } = files();
  const { json, verdict } = await validate([join(tmp, 'b'), join(tmp, 'a'), good]);
  expect(verdict).toBe(1);
  expect(json!.total_files).toBe(2);
  expect(json!.results.map(r => r.path).sort()).toEqual([bad, good].sort());
});

test('a missing path anywhere in the list refuses before anything is checked', async () => {
  const { good } = files();
  const { json, verdict } = await validate([good, join(tmp, 'missing.md')]);
  expect(verdict).toBe(1);
  expect(json).toBeNull();
});
