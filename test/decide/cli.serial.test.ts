/**
 * `gbrain decide` end to end through the real CLI on a fresh PGLite brain:
 * engine-free help, status --json golden (keyless, all off), catalogued
 * refusals (no_provider, no_key), decide.* config validation and the
 * effective-mode line, receipts --what-if-threshold replay on seeded receipts
 * (including a binding min_keep), and disable --all. Serial: the tests share one
 * subprocess brain across it() boundaries and seed its database directly.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../helpers/cli-spawn.ts';
import { IDENTITY, expectGolden } from '../helpers/golden.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';

let home: string;
const KEYLESS = { TYPESAFE_API_KEY: undefined, JEV_TYPESAFE_API_KEY: undefined, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
const cli = (args: string[]) => runCli(args, { home, env: KEYLESS, timeoutMs: 120_000 });

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-decide-cli-'));
  const init = await cli(['init', '--pglite', '--no-embedding']);
  expect(init.exitCode).toBe(0);
}, 180_000);

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('gbrain decide CLI', () => {
  test('--help answers without a brain', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'gbrain-decide-nobrain-'));
    try {
      const r = await runCli(['decide', '--help'], { home: empty, env: KEYLESS });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('Usage: gbrain decide');
      expect(r.stdout).toContain('enable <slot>');
      expect(r.stdout).toContain('sweep --slot conflict');
      expect(r.stdout).toContain('proposals list');
      expect(r.stdout).toContain('judge-agreement --suite <longmemeval|grounding>');
    } finally { rmSync(empty, { recursive: true, force: true }); }
  });

  test('status --json on a keyless all-off brain (golden)', async () => {
    const r = await cli(['decide', 'status', '--json']);
    expect(r.exitCode).toBe(0);
    const status = JSON.parse(r.stdout);
    expect(status.slots.every((s: { mode: string }) => s.mode === 'off')).toBe(true);
    expectGolden('decide/status-keyless-all-off', status, IDENTITY);
  }, 120_000);

  test('enable refuses with catalogued reasons and writes nothing', async () => {
    const noProvider = await cli(['decide', 'enable', 'evidence', '--yes']);
    expect(noProvider.exitCode).toBe(1);
    expect(noProvider.stderr).toContain('no_provider');
    const noKey = await cli(['decide', 'enable', 'rerank', '--yes']);
    expect(noKey.exitCode).toBe(1);
    expect(noKey.stderr).toContain('no_key');
    const status = JSON.parse((await cli(['decide', 'status', '--json'])).stdout);
    expect(status.provider).toBe('none');
  }, 120_000);

  test('config set validates decide keys and prints the effective-mode line', async () => {
    const bad = await cli(['config', 'set', 'decide.slots.evidence.mode', 'maybe']);
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain('must be one of off, on, shadow');
    const ok = await cli(['config', 'set', 'decide.slots.evidence.mode', 'on']);
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toContain('evidence: requested: on / effective: off / cause: no_provider');
    const off = await cli(['decide', 'disable', '--all']);
    expect(off.exitCode).toBe(0);
    expect(off.stdout).toContain('Every slot is off');
  }, 120_000);

  test('sweep and proposals on an all-off brain change nothing', async () => {
    const sweep = await cli(['decide', 'sweep', '--slot', 'conflict']);
    expect(sweep.exitCode).toBe(1);
    expect(sweep.stdout).toContain('the contradiction slot is off');
    const json = JSON.parse((await cli(['decide', 'sweep', '--slot', 'conflict', '--json'])).stdout);
    expect(json.sweeps.every((s: { mode: string; facts: number; proposals: number }) => s.mode === 'off' && s.facts === 0 && s.proposals === 0)).toBe(true);
    const badSlot = await cli(['decide', 'sweep', '--slot', 'triage']);
    expect(badSlot.exitCode).toBe(1);
    const list = await cli(['decide', 'proposals', 'list', '--json']);
    expect(list.exitCode).toBe(0);
    expect(JSON.parse(list.stdout)).toEqual({ status: 'pending', proposals: [], review_proposals: [] });
    const missing = await cli(['decide', 'proposals', 'accept', '999']);
    expect(missing.exitCode).toBe(1);
    expect(missing.stdout).toContain('proposal 999: not found');
  }, 120_000);

  test('receipts --what-if-threshold replays seeded S3 receipts, including a binding min_keep', async () => {
    const cfg = JSON.parse(readFileSync(join(home, '.gbrain', 'config.json'), 'utf8'));
    const engine = new PGLiteEngine();
    await engine.connect({ database_path: cfg.database_path });
    try {
      await engine.initSchema();
      const rows = [[0.2, 0], [0.3, 1], [0.9, 2]];
      for (const [v, rank] of rows) {
        await engine.executeRaw(
          `INSERT INTO decision_receipts (decision_id, slot, mode, provider, outcome, call_site, lane, answer_value, rank, min_keep, protected)
           VALUES ('d1', 'evidence', 'on', 'typesafe:jev-1.13.0', $1, 'search', 'hot', $2, $3, 2, false)`,
          [v! >= 0.5 ? 'kept' : rank === 1 ? 'kept' : 'pruned', v, rank],
        );
      }
    } finally { await engine.disconnect(); }
    const r = await cli(['decide', 'receipts', '--slot', 'evidence', '--what-if-threshold', '0.5', '--json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.receipts).toBe(3);
    expect(out.what_if).toEqual({ kept: 2, pruned: 1, margin_hold: 0 });
    const notReproducible = await cli(['decide', 'receipts', '--slot', 'rerank', '--what-if-threshold', '0.5']);
    expect(notReproducible.exitCode).toBe(1);
    expect(notReproducible.stderr).toContain('not reproducible');
    const stats = await cli(['decide', 'receipts', '--json']);
    expect(JSON.parse(stats.stdout).rows.length).toBeGreaterThan(0);
  }, 180_000);
});
