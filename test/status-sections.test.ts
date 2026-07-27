/**
 * Pure-function unit tests for `gbrain status` orchestrator helpers.
 *
 * Hermetic — no PGLite, no DB. Drives the exported helpers (parseSectionFlag,
 * runStatus with engine=null in thin-client-disabled mode) and asserts:
 *   - JSON envelope shape stability (schema_version: 1)
 *   - --section filter validation (unknown → exit 2)
 *   - exit code policy (0 success/degraded, 1 snapshot failure, 2 usage)
 *   - thin-client local-only-N/A render for Locks/Workers/Queue/Autopilot
 *     (we exercise this via a stubbed cfg that mimics thin-client mode)
 *
 * The E2E test at test/e2e/status-pglite.test.ts covers the full PGLite +
 * fake-minion_jobs + fake-supervisor-audit path.
 */

import { describe, test, expect } from 'bun:test';
import {
  parseSectionFlag,
  parseDeadlineFlag,
  withSectionDeadline,
  runStatus,
  FAST_DEADLINE_MS,
} from '../src/commands/status.ts';

describe('parseDeadlineFlag (#1984)', () => {
  test('no flag → undefined (no budget)', () => {
    expect(parseDeadlineFlag([])).toBeUndefined();
    expect(parseDeadlineFlag(['--json'])).toBeUndefined();
  });

  test('--fast applies the preset budget', () => {
    expect(parseDeadlineFlag(['--fast'])).toBe(FAST_DEADLINE_MS);
  });

  test('--deadline-ms in both forms', () => {
    expect(parseDeadlineFlag(['--deadline-ms', '500'])).toBe(500);
    expect(parseDeadlineFlag(['--deadline-ms=750'])).toBe(750);
  });

  test('explicit --deadline-ms wins over --fast', () => {
    expect(parseDeadlineFlag(['--fast', '--deadline-ms=100'])).toBe(100);
  });

  test('non-positive / non-numeric → usage_error', () => {
    expect(parseDeadlineFlag(['--deadline-ms', '0'])).toBe('usage_error');
    expect(parseDeadlineFlag(['--deadline-ms', '-5'])).toBe('usage_error');
    expect(parseDeadlineFlag(['--deadline-ms', 'soon'])).toBe('usage_error');
  });

  test('bare --deadline-ms with no value → usage_error (not a silent no-budget fallthrough)', () => {
    expect(parseDeadlineFlag(['--deadline-ms'])).toBe('usage_error');
    expect(parseDeadlineFlag(['--fast', '--deadline-ms'])).toBe('usage_error');
  });
});

describe('withSectionDeadline (#1984)', () => {
  test('resolves the value when it beats the budget', async () => {
    let timedOut = false;
    const v = await withSectionDeadline(Promise.resolve(42), 1000, () => { timedOut = true; });
    expect(v).toBe(42);
    expect(timedOut).toBe(false);
  });

  test('returns undefined + fires onTimeout when the budget elapses', async () => {
    let timedOut = false;
    const v = await withSectionDeadline(new Promise<number>(() => {}), 10, () => { timedOut = true; });
    expect(v).toBeUndefined();
    expect(timedOut).toBe(true);
  });

  test('no budget (undefined/<=0) awaits the promise as-is', async () => {
    expect(await withSectionDeadline(Promise.resolve('x'), undefined, () => {})).toBe('x');
    expect(await withSectionDeadline(Promise.resolve('y'), 0, () => {})).toBe('y');
  });
});

describe('parseSectionFlag', () => {
  test('no --section flag → undefined (all sections)', () => {
    expect(parseSectionFlag([])).toBeUndefined();
    expect(parseSectionFlag(['--json'])).toBeUndefined();
  });

  test('--section <name> form returns the set', () => {
    const r = parseSectionFlag(['--section', 'sync']);
    expect(r).toBeInstanceOf(Set);
    expect((r as Set<string>).has('sync')).toBe(true);
  });

  test('--section=<name> form returns the set', () => {
    const r = parseSectionFlag(['--section=cycle']);
    expect(r).toBeInstanceOf(Set);
    expect((r as Set<string>).has('cycle')).toBe(true);
  });

  test('unknown section returns usage_error', () => {
    expect(parseSectionFlag(['--section', 'bogus'])).toBe('usage_error');
    expect(parseSectionFlag(['--section=nonsense'])).toBe('usage_error');
  });

  test('every valid section is accepted', () => {
    for (const s of ['sync', 'cycle', 'locks', 'workers', 'queue', 'autopilot']) {
      const r = parseSectionFlag(['--section', s]);
      expect(r).toBeInstanceOf(Set);
      expect((r as Set<string>).has(s)).toBe(true);
    }
  });
});

describe('runStatus exit codes', () => {
  test('--section invalid → exit 2 (usage error)', async () => {
    let captured = '';
    const r = await runStatus(null, ['--section', 'bogus'], {
      stdout: () => {},
      stderr: (s: string) => {
        captured += s;
      },
    });
    expect(r.exitCode).toBe(2);
    expect(captured).toContain('invalid --section');
  });

  test('local mode with engine=null → exit 1 (snapshot failure)', async () => {
    let captured = '';
    const r = await runStatus(null, [], {
      stdout: () => {},
      stderr: (s: string) => {
        captured += s;
      },
    });
    // Without a config + engine, status can't build the local snapshot.
    expect(r.exitCode).toBe(1);
    expect(captured).toMatch(/snapshot failed|no engine connected/);
  });

  test('#1984: invalid --deadline-ms → exit 2 (usage error)', async () => {
    let captured = '';
    const r = await runStatus(null, ['--deadline-ms', '0'], {
      stdout: () => {},
      stderr: (s: string) => { captured += s; },
    });
    expect(r.exitCode).toBe(2);
    expect(captured).toContain('--deadline-ms');
  });
});
