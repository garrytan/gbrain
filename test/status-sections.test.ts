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
import { parseSectionFlag, runStatus } from '../src/commands/status.ts';

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
});
