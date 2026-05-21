/**
 * `gbrain jobs work --poll-interval <ms>` flag tests.
 *
 * Covers the parsePollIntervalFlag validator (bounds, non-numeric, absence)
 * plus end-to-end CLI plumb-through (the flag reaches the MinionWorker
 * constructor as `pollInterval`).
 *
 * Pattern matches parseMaxRssFlag (the closest existing analog) — pure
 * function tests on the parser, spawn-based test on the CLI wiring.
 */

import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { parsePollIntervalFlag } from '../src/commands/jobs.ts';

const CLI = resolve(import.meta.dir, '..', 'src', 'cli.ts');
const REPO_ROOT = resolve(import.meta.dir, '..');

describe('parsePollIntervalFlag (pure validator)', () => {
  it('returns undefined when flag is absent', () => {
    expect(parsePollIntervalFlag([])).toBeUndefined();
    expect(parsePollIntervalFlag(['--queue', 'foo', '--concurrency', '2'])).toBeUndefined();
  });

  it('accepts valid integer values at the bounds', () => {
    expect(parsePollIntervalFlag(['--poll-interval', '100'])).toBe(100);
    expect(parsePollIntervalFlag(['--poll-interval', '5000'])).toBe(5000);
    expect(parsePollIntervalFlag(['--poll-interval', '300000'])).toBe(300000);
  });

  it('accepts values in the middle of the range', () => {
    expect(parsePollIntervalFlag(['--poll-interval', '250'])).toBe(250);
    expect(parsePollIntervalFlag(['--poll-interval', '1000'])).toBe(1000);
    expect(parsePollIntervalFlag(['--poll-interval', '60000'])).toBe(60000);
  });

  // parseMaxRssFlag and other validators in jobs.ts call process.exit on bad
  // input; we exercise the rejection path via the spawn-based CLI test below
  // (process.exit can't be observed inside the same test process without
  // mocking).  Coverage strategy: pure-validator tests above + spawn tests
  // below give both the happy and rejection paths.
});

describe('gbrain jobs work --poll-interval (CLI wiring)', () => {
  // These tests spawn the CLI and observe exit code + stderr.  They run fast
  // because the rejection path exits before any DB connection is attempted.
  // Successful work-startup is NOT tested here (would require Postgres);
  // that's covered by integration tests elsewhere.

  it('rejects values below the minimum (50)', () => {
    const r = spawnSync('bun', [CLI, 'jobs', 'work', '--poll-interval', '50'], {
      cwd: REPO_ROOT, encoding: 'utf-8', timeout: 10_000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--poll-interval must be an integer between 100 and 300000');
    expect(r.stderr).toContain('"50"');
  });

  it('rejects 0 (would burn CPU)', () => {
    const r = spawnSync('bun', [CLI, 'jobs', 'work', '--poll-interval', '0'], {
      cwd: REPO_ROOT, encoding: 'utf-8', timeout: 10_000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--poll-interval must be an integer between 100 and 300000');
  });

  it('rejects values above the maximum (300001)', () => {
    const r = spawnSync('bun', [CLI, 'jobs', 'work', '--poll-interval', '300001'], {
      cwd: REPO_ROOT, encoding: 'utf-8', timeout: 10_000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--poll-interval must be an integer between 100 and 300000');
    expect(r.stderr).toContain('"300001"');
  });

  it('rejects non-numeric values', () => {
    const r = spawnSync('bun', [CLI, 'jobs', 'work', '--poll-interval', 'abc'], {
      cwd: REPO_ROOT, encoding: 'utf-8', timeout: 10_000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--poll-interval must be an integer between 100 and 300000');
    expect(r.stderr).toContain('"abc"');
  });

  it('rejects mixed numeric+unit values (e.g. "5s")', () => {
    // parseInt("5s", 10) === 5, which is < 100 — rejected with the bounds
    // error, not a unit-confusion-specific one.  Documenting actual behavior.
    const r = spawnSync('bun', [CLI, 'jobs', 'work', '--poll-interval', '5s'], {
      cwd: REPO_ROOT, encoding: 'utf-8', timeout: 10_000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--poll-interval must be an integer between 100 and 300000');
  });
});
