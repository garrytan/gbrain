/**
 * `gbrain search tune --apply` must report only the config changes that
 * actually landed. Before this fix the --json lane printed
 * `applied: recs.map(apply_command)` BEFORE any write ran, the text lane
 * printed a checkmark for apply commands the helper silently ignored, and a
 * mid-batch write failure dropped the revert commands for the changes that
 * had already been written.
 *
 * The recommendation builder is mocked so each case controls the exact
 * recommendation list; the engine is an in-memory config fake whose writes
 * can be made to fail on the Nth call. Everything else is the real runSearch
 * path.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { TuneRecommendation, TuneReport } from '../src/core/search/tune-recommendations.ts';

let report: TuneReport;

mock.module('../src/core/search/tune-recommendations.ts', () => ({
  TUNE_MIN_CALLS: 20,
  buildTuneRecommendations: async () => report,
}));

const { runSearch } = await import('../src/commands/search.ts');

class FakeConfigEngine {
  config = new Map<string, string>();
  calls: string[] = [];
  failOnCall: number | null = null;
  /** The failing write commits before it throws (a lost acknowledgement). */
  failAfterCommit = false;
  /** getConfig throws too, so the failed write cannot be reconciled. */
  failReads = false;

  private maybeFail(): void {
    if (this.failOnCall !== null && this.calls.length === this.failOnCall) {
      throw new Error('synthetic config write failure');
    }
  }

  async getConfig(key: string): Promise<string | null> {
    if (this.failReads) throw new Error('synthetic config read failure');
    return this.config.get(key) ?? null;
  }
  async setConfig(key: string, value: string): Promise<void> {
    this.calls.push(`set ${key} ${value}`);
    if (this.failAfterCommit) this.config.set(key, value);
    this.maybeFail();
    this.config.set(key, value);
  }
  async unsetConfig(key: string): Promise<number> {
    this.calls.push(`unset ${key}`);
    if (this.failAfterCommit) this.config.delete(key);
    this.maybeFail();
    return this.config.delete(key) ? 1 : 0;
  }
}

let engine: FakeConfigEngine;

const SET_MODE: TuneRecommendation = {
  knob: 'search.mode', current: 'conservative', suggested: 'balanced',
  reason: 'r1', apply_command: 'gbrain config set search.mode balanced',
};
const SET_THRESHOLD: TuneRecommendation = {
  knob: 'search.cache.similarity_threshold', current: 0.9, suggested: 0.94,
  reason: 'r2', apply_command: 'gbrain config set search.cache.similarity_threshold 0.94',
};
const UNSET_CACHE: TuneRecommendation = {
  knob: 'search.cache.enabled', current: false, suggested: true,
  reason: 'r3', apply_command: 'gbrain config unset search.cache.enabled',
};
const UNSUPPORTED: TuneRecommendation = {
  knob: 'search.weird', current: 'a', suggested: 'b',
  reason: 'r4', apply_command: 'gbrain config set search.weird b extra',
};

function useRecs(recs: TuneRecommendation[]): void {
  report = {
    schema_version: 2,
    status: recs.length ? 'has_recommendations' : 'no_recommendations',
    total_calls: 100,
    cache_hit_rate: 0.5,
    active_mode: 'conservative',
    coverage: { cli_invocations: 'recorded_on_clean_exit', reason: 'short-lived CLI' } as TuneReport['coverage'],
    recommendations: recs,
  };
}

beforeEach(() => {
  engine = new FakeConfigEngine();
  engine.config.set('search.mode', 'conservative');
  engine.config.set('search.cache.similarity_threshold', '0.9');
  engine.config.set('search.cache.enabled', 'false');
});

async function run(args: string[]): Promise<{ out: string; error: unknown }> {
  const original = console.log;
  const captured: string[] = [];
  console.log = (...a: unknown[]) => { captured.push(a.map(String).join(' ')); };
  let error: unknown = null;
  try {
    await runSearch(engine as never, ['tune', ...args]);
  } catch (e) {
    error = e;
  } finally {
    console.log = original;
  }
  return { out: captured.join('\n'), error };
}

const revertSection = (out: string) => {
  const lines = out.split('\n');
  const at = lines.indexOf('To revert these changes:');
  return at < 0 ? [] : lines.slice(at + 1).map(l => l.trim()).filter(Boolean);
};
const checkmarks = (out: string) => out.split('\n').filter(l => l.includes('✓')).map(l => l.trim());

describe('search tune --apply --json', () => {
  test('zero recommendations: nothing applied, no writes', async () => {
    useRecs([]);
    const { out, error } = await run(['--apply', '--json']);
    expect(error).toBeNull();
    expect(JSON.parse(out).applied).toEqual([]);
    expect(engine.calls).toEqual([]);
  });

  test('one supported set: applied after the write landed', async () => {
    useRecs([SET_MODE]);
    const { out, error } = await run(['--apply', '--json']);
    expect(error).toBeNull();
    const r = JSON.parse(out);
    expect(r.applied).toEqual([SET_MODE.apply_command]);
    expect(engine.config.get('search.mode')).toBe('balanced');
    expect(engine.calls).toEqual(['set search.mode balanced']);
  });

  test('multiple set/unset: each applied exactly once', async () => {
    useRecs([SET_MODE, SET_THRESHOLD, UNSET_CACHE]);
    const { out, error } = await run(['--apply', '--json']);
    expect(error).toBeNull();
    const r = JSON.parse(out);
    expect(r.applied).toEqual([SET_MODE.apply_command, SET_THRESHOLD.apply_command, UNSET_CACHE.apply_command]);
    expect(engine.calls).toEqual([
      'set search.mode balanced',
      'set search.cache.similarity_threshold 0.94',
      'unset search.cache.enabled',
    ]);
    expect(engine.config.has('search.cache.enabled')).toBe(false);
  });

  test('first write fails: JSON reports nothing applied and the error, command still fails', async () => {
    useRecs([SET_MODE, SET_THRESHOLD]);
    engine.failOnCall = 1;
    const { out, error } = await run(['--apply', '--json']);
    expect((error as Error).message).toBe('synthetic config write failure');
    const r = JSON.parse(out);
    expect(r.applied).toEqual([]);
    expect(r.apply_error).toEqual({ command: SET_MODE.apply_command, message: 'synthetic config write failure' });
    expect(engine.config.get('search.mode')).toBe('conservative');
    expect(engine.calls).toEqual(['set search.mode balanced']);
  });

  test('later write fails: JSON lists only the landed change and its revert', async () => {
    useRecs([SET_MODE, SET_THRESHOLD, UNSET_CACHE]);
    engine.failOnCall = 2;
    const { out, error } = await run(['--apply', '--json']);
    expect((error as Error).message).toBe('synthetic config write failure');
    const r = JSON.parse(out);
    expect(r.applied).toEqual([SET_MODE.apply_command]);
    expect(r.revert_commands).toEqual(['gbrain config set search.mode conservative']);
    expect(r.apply_error.command).toBe(SET_THRESHOLD.apply_command);
    expect(engine.config.get('search.mode')).toBe('balanced');
    expect(engine.config.get('search.cache.similarity_threshold')).toBe('0.9');
    expect(engine.calls.length).toBe(2);
  });

  test('unsupported command shape: not reported as applied', async () => {
    useRecs([UNSUPPORTED, SET_MODE]);
    const { out, error } = await run(['--apply', '--json']);
    expect(error).toBeNull();
    const r = JSON.parse(out);
    expect(r.applied).toEqual([SET_MODE.apply_command]);
    expect(r.not_applied).toEqual([UNSUPPORTED.apply_command]);
    expect(engine.calls).toEqual(['set search.mode balanced']);
  });

  test('per-item results name what committed, what failed and what was not attempted', async () => {
    useRecs([SET_MODE, SET_THRESHOLD, UNSET_CACHE]);
    engine.failOnCall = 2;
    const { out } = await run(['--apply', '--json']);
    expect(JSON.parse(out).results).toEqual([
      { command: SET_MODE.apply_command, status: 'applied', revert_command: 'gbrain config set search.mode conservative' },
      { command: SET_THRESHOLD.apply_command, status: 'failed', message: 'synthetic config write failure' },
      { command: UNSET_CACHE.apply_command, status: 'not_attempted' },
    ]);
  });

  test('a write that committed before its error is reconciled as applied and the batch continues', async () => {
    useRecs([SET_MODE, UNSET_CACHE]);
    engine.failOnCall = 1;
    engine.failAfterCommit = true;
    const { out, error } = await run(['--apply', '--json']);
    expect(error).toBeNull();
    const r = JSON.parse(out);
    expect(r.applied).toEqual([SET_MODE.apply_command, UNSET_CACHE.apply_command]);
    expect(r.revert_commands).toEqual(['gbrain config set search.mode conservative', 'gbrain config set search.cache.enabled false']);
    expect(r.apply_error).toBeUndefined();
  });

  test('a failed write whose key cannot be re-read is outcome_unknown, never applied', async () => {
    useRecs([SET_MODE, SET_THRESHOLD]);
    engine.failOnCall = 1;
    engine.failReads = true;
    const { out, error } = await run(['--apply', '--json']);
    expect((error as Error).message).toBe('synthetic config write failure');
    const r = JSON.parse(out);
    expect(r.applied).toEqual([]);
    expect(r.results.map((x: { status: string }) => x.status)).toEqual(['outcome_unknown', 'not_attempted']);
    expect(r.revert_commands).toEqual([]);
  });

  test('without --apply: nothing applied, no writes', async () => {
    useRecs([SET_MODE, UNSET_CACHE]);
    const { out, error } = await run(['--json']);
    expect(error).toBeNull();
    const r = JSON.parse(out);
    expect(r.applied).toEqual([]);
    expect(r.recommendations.length).toBe(2);
    expect(engine.calls).toEqual([]);
  });
});

describe('search tune --apply (text)', () => {
  test('all writes succeed: one checkmark per change and its revert', async () => {
    useRecs([SET_MODE, UNSET_CACHE]);
    const { out, error } = await run(['--apply']);
    expect(error).toBeNull();
    expect(checkmarks(out)).toEqual([`✓ ${SET_MODE.apply_command}`, `✓ ${UNSET_CACHE.apply_command}`]);
    expect(out).toContain('To revert these changes:');
    expect(out).toContain('gbrain config set search.mode conservative');
    expect(out).toContain('gbrain config set search.cache.enabled false');
    expect(engine.calls.length).toBe(2);
  });

  test('later write fails: checkmark only for the landed change, failure shown, its revert kept', async () => {
    useRecs([SET_MODE, SET_THRESHOLD, UNSET_CACHE]);
    engine.failOnCall = 2;
    const { out, error } = await run(['--apply']);
    expect((error as Error).message).toBe('synthetic config write failure');
    expect(checkmarks(out)).toEqual([`✓ ${SET_MODE.apply_command}`]);
    expect(out).toContain(`✗ ${SET_THRESHOLD.apply_command}`);
    expect(revertSection(out)).toEqual(['gbrain config set search.mode conservative']);
    expect(engine.calls.length).toBe(2);
  });

  test('first write fails: no checkmark and no revert section', async () => {
    useRecs([SET_MODE]);
    engine.failOnCall = 1;
    const { out, error } = await run(['--apply']);
    expect((error as Error).message).toBe('synthetic config write failure');
    expect(checkmarks(out)).toEqual([]);
    expect(out).toContain(`✗ ${SET_MODE.apply_command}`);
    expect(out).not.toContain('To revert these changes:');
  });

  test('unsupported command shape: no checkmark, reported as not applied', async () => {
    useRecs([UNSUPPORTED]);
    const { out, error } = await run(['--apply']);
    expect(error).toBeNull();
    expect(checkmarks(out)).toEqual([]);
    expect(out).toContain(`✗ ${UNSUPPORTED.apply_command}`);
    expect(out).not.toContain('To revert these changes:');
    expect(engine.calls).toEqual([]);
  });

  test('without --apply: no writes, apply hint kept', async () => {
    useRecs([SET_MODE]);
    const { out } = await run([]);
    expect(engine.calls).toEqual([]);
    expect(out).toContain('Run `gbrain search tune --apply`');
  });

  test('--help stays read-only', async () => {
    useRecs([SET_MODE]);
    const original = console.log;
    const captured: string[] = [];
    console.log = (...a: unknown[]) => { captured.push(a.map(String).join(' ')); };
    try {
      await runSearch(engine as never, ['tune', '--help']);
    } finally {
      console.log = original;
    }
    expect(captured.join('\n')).toContain('Usage:');
    expect(engine.calls).toEqual([]);
  });
});
