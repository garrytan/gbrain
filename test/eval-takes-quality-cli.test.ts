/**
 * eval-takes-quality CLI — sub-subcommand dispatch + brain-routing
 * (codex review #10).
 *
 * The dispatch helper is pure so we test it directly. The "replay works
 * without DATABASE_URL" assertion is end-to-end in test/e2e/eval-takes-quality.test.ts.
 */
import { describe, test, expect } from 'bun:test';
import { parseSubcmd, runReplayNoBrain } from '../src/commands/eval-takes-quality.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('parseSubcmd — sub-subcommand dispatch', () => {
  test('"" or --help → help', () => {
    expect(parseSubcmd([]).subcmd).toBe('help');
    expect(parseSubcmd(['--help']).subcmd).toBe('help');
    expect(parseSubcmd(['-h']).subcmd).toBe('help');
  });

  test('run / replay / trend / regress all parse', () => {
    expect(parseSubcmd(['run']).subcmd).toBe('run');
    expect(parseSubcmd(['replay', 'foo.json']).subcmd).toBe('replay');
    expect(parseSubcmd(['trend']).subcmd).toBe('trend');
    expect(parseSubcmd(['regress', '--against', 'p']).subcmd).toBe('regress');
  });

  test('unknown subcmd → help', () => {
    expect(parseSubcmd(['frobnicate']).subcmd).toBe('help');
  });

  test('passes argv tail to the subcommand', () => {
    const r = parseSubcmd(['run', '--limit', '50', '--json']);
    expect(r.argv).toEqual(['--limit', '50', '--json']);
    expect(r.json).toBe(true);
  });
});

describe('runReplayNoBrain — codex review #10 brain-routing', () => {
  let tmpDir: string;
  beforeAll(() => { tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-cli-test-')); });
  afterAll(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  test('exits 2 with usage when no path given', async () => {
    const exit = await runReplayNoBrain([]);
    expect(exit).toBe(2);
  });

  test('reads and renders a valid receipt — exit 0 on PASS', async () => {
    const path = join(tmpDir, 'pass.json');
    writeFileSync(path, JSON.stringify({
      schema_version: 1,
      ts: '2026-05-09T22:00:00Z',
      rubric_version: 'v1.0', rubric_sha8: 'r0001',
      corpus: { source: 'db', n_takes: 5, slug_prefix: null, corpus_sha8: 'c0001' },
      prompt_sha8: 'p0001', models_sha8: 'm0001',
      models: ['openai:gpt-4o'],
      cycles_run: 1, successes_per_cycle: [1],
      verdict: 'pass',
      scores: {}, overall_score: 8, cost_usd: 0.5,
    }));
    const exit = await runReplayNoBrain([path, '--json']);
    expect(exit).toBe(0);
  });

  test('exit 1 on FAIL receipt', async () => {
    const path = join(tmpDir, 'fail.json');
    writeFileSync(path, JSON.stringify({
      schema_version: 1, ts: '2026-05-09T22:00:00Z',
      rubric_version: 'v1.0', rubric_sha8: 'r0001',
      corpus: { source: 'db', n_takes: 5, slug_prefix: null, corpus_sha8: 'c0001' },
      prompt_sha8: 'p0001', models_sha8: 'm0001',
      models: ['openai:gpt-4o'],
      cycles_run: 1, successes_per_cycle: [1],
      verdict: 'fail',
      scores: {}, overall_score: 5, cost_usd: 0.5,
    }));
    const exit = await runReplayNoBrain([path, '--json']);
    expect(exit).toBe(1);
  });

  test('exit 2 on INCONCLUSIVE receipt', async () => {
    const path = join(tmpDir, 'inc.json');
    writeFileSync(path, JSON.stringify({
      schema_version: 1, ts: '2026-05-09T22:00:00Z',
      rubric_version: 'v1.0', rubric_sha8: 'r0001',
      corpus: { source: 'db', n_takes: 5, slug_prefix: null, corpus_sha8: 'c0001' },
      prompt_sha8: 'p0001', models_sha8: 'm0001',
      models: ['openai:gpt-4o'],
      cycles_run: 1, successes_per_cycle: [0],
      verdict: 'inconclusive',
      scores: {}, overall_score: 0, cost_usd: 0.5,
    }));
    const exit = await runReplayNoBrain([path]);
    expect(exit).toBe(2);
  });

  test('exits 1 on missing receipt file (no silent DB fallback)', async () => {
    const exit = await runReplayNoBrain([join(tmpDir, 'absent.json')]);
    expect(exit).toBe(1);
  });
});

// We import beforeAll / afterAll from bun:test; re-declare for the inner suite.
import { beforeAll, afterAll } from 'bun:test';
