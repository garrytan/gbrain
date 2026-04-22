/**
 * E2E — doctor --progress-json streaming.
 *
 * Spawns the real CLI against a real Postgres+pgvector instance. Asserts:
 *   - stderr contains one JSON event per DB check (start + heartbeats)
 *   - stdout stays clean of progress (agents that parse stdout don't see
 *     progress garbage mixed with the check results)
 *
 * Tier 1 (no API keys). Requires DATABASE_URL or .env.testing.
 * Run: DATABASE_URL=... bun test test/e2e/doctor-progress.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import { join } from 'path';
import {
  hasDatabase, setupDB, teardownDB, importFixtures,
} from './helpers.ts';

const skip = !hasDatabase();
const describeE2E = skip ? describe.skip : describe;

const CLI = join(import.meta.dir, '..', '..', 'src', 'cli.ts');

describeE2E('gbrain doctor --progress-json (E2E)', () => {
  beforeAll(async () => {
    await setupDB();
    // Seed a handful of pages so the DB checks have something to scan.
    await importFixtures();
  });

  afterAll(async () => {
    await teardownDB();
  });

  test('stderr has JSONL progress events, stdout stays clean', () => {
    const res = spawnSync('bun', [CLI, '--progress-json', 'doctor', '--json'], {
      encoding: 'utf-8',
      env: { ...process.env, NO_COLOR: '1' },
      timeout: 30_000,
    });

    // Even if some checks warn, doctor runs to completion. Failures would
    // exit non-zero, which is OK — we're testing progress wiring.
    // Require that some output happened on both streams.
    expect(res.stderr.length).toBeGreaterThan(0);
    expect(res.stdout.length).toBeGreaterThan(0);

    // Parse stderr as JSONL. Extract every line that looks like a JSON
    // object; tolerate stray non-JSON lines (warnings, dependency noise).
    const lines = res.stderr.split('\n').filter(l => l.trim().startsWith('{'));
    const events: Array<Record<string, unknown>> = [];
    for (const line of lines) {
      try {
        events.push(JSON.parse(line));
      } catch {
        // Not a progress event — could be a legacy stderr logger line.
      }
    }

    expect(events.length).toBeGreaterThan(0);

    // We expect at least one 'start' for doctor.db_checks.
    const starts = events.filter(e => e.event === 'start');
    const phases = starts.map(e => e.phase);
    expect(phases).toContain('doctor.db_checks');

    // We expect at least one 'finish' for it too.
    const finishes = events.filter(e => e.event === 'finish');
    expect(finishes.some(e => e.phase === 'doctor.db_checks')).toBe(true);

    // Every event has the canonical schema (event, phase, ts).
    for (const ev of events) {
      expect(typeof ev.event).toBe('string');
      expect(typeof ev.phase).toBe('string');
      expect(typeof ev.ts).toBe('string');
    }

    // Stdout should be doctor's --json payload (array of checks) and nothing
    // that looks like a progress event. Parse it as JSON to ensure no stray
    // progress-line pollution on stdout.
    const parsed = JSON.parse(res.stdout);
    expect(Array.isArray(parsed.checks) || Array.isArray(parsed)).toBe(true);
  });

  test('default (no --progress-json) writes human-plain progress to stderr only', () => {
    const res = spawnSync('bun', [CLI, 'doctor'], {
      encoding: 'utf-8',
      env: { ...process.env, NO_COLOR: '1' },
      timeout: 30_000,
    });

    // Stdout may contain the check summary (human-readable) but should NOT
    // contain `[doctor.db_checks]` — that's stderr territory.
    expect(res.stdout).not.toContain('[doctor.db_checks]');

    // Stderr should contain the phase bracket marker at least once.
    // Skip assertion if the DB had no pages and doctor short-circuits fast.
    if (res.stderr.length > 0) {
      expect(res.stderr).toContain('doctor.db_checks');
    }
  });

  test('--quiet suppresses progress entirely', () => {
    const res = spawnSync('bun', [CLI, '--quiet', 'doctor'], {
      encoding: 'utf-8',
      env: { ...process.env, NO_COLOR: '1' },
      timeout: 30_000,
    });

    // With --quiet the reporter emits no start/finish/tick lines on stderr.
    // Stderr may still contain warnings/errors from doctor's own logger,
    // just no progress phases.
    expect(res.stderr).not.toContain('[doctor.db_checks]');
    expect(res.stderr).not.toContain('"event":"start"');
  });
});
