/**
 * v0.41 D2 — jobs-watch renderer + snapshot unit tests.
 *
 * Pure-function tests on renderSnapshot — no DB, no real-time. Pins:
 *   - Headers and panel order stay scannable (operator muscle memory).
 *   - Color escapes ONLY when useAnsi=true (CI logs stay clean by default).
 *   - 1h lease pressure is color-coded by severity.
 *   - Top errors only render top-5 (no panel bloat).
 *   - Budget panel only renders when there are owners with cents in flight.
 *
 * Integration test for readSnapshot (real DB) lives in
 * `test/jobs-watch-readsnapshot.test.ts` to keep the pure-function
 * suite under 50ms.
 */

import { describe, test, expect } from 'bun:test';
import { renderSnapshot, type WatchSnapshot } from '../src/commands/jobs-watch.ts';

function emptySnap(opts: Partial<WatchSnapshot> = {}): WatchSnapshot {
  return {
    ts_ms: 1779600000000,
    by_type: [],
    queue_health: { waiting: 0, active: 0, stalled: 0 },
    lease_pressure_1h: 0,
    top_errors: [],
    budget_owners: [],
    ...opts,
  };
}

describe('renderSnapshot', () => {
  test('renders header + queue panel even when nothing is happening', () => {
    const out = renderSnapshot(emptySnap(), { useAnsi: false });
    expect(out).toContain('gbrain jobs watch');
    expect(out).toContain('q to quit');
    expect(out).toContain('Queue');
    expect(out).toContain('waiting=0');
    expect(out).toContain('Lease pressure (1h)');
    expect(out).toContain('0 bounces');
  });

  test('useAnsi=false strips color escapes (CI log safety)', () => {
    const out = renderSnapshot(emptySnap(), { useAnsi: false });
    expect(out).not.toContain('\x1b[');
  });

  test('useAnsi=true includes ANSI color codes', () => {
    const out = renderSnapshot(emptySnap(), { useAnsi: true });
    expect(out).toContain('\x1b[1m'); // bold
    expect(out).toContain('\x1b[0m'); // reset
  });

  test('lease pressure color-codes by severity (no-color version still works)', () => {
    const green = renderSnapshot(emptySnap({ lease_pressure_1h: 0 }), { useAnsi: true });
    expect(green).toContain('\x1b[32m'); // green for 0
    const yellow = renderSnapshot(emptySnap({ lease_pressure_1h: 5 }), { useAnsi: true });
    expect(yellow).toContain('\x1b[33m'); // yellow for 1-99
    const red = renderSnapshot(emptySnap({ lease_pressure_1h: 200 }), { useAnsi: true });
    expect(red).toContain('\x1b[31m'); // red for 100+
  });

  test('per-type table renders when by_type non-empty', () => {
    const out = renderSnapshot(
      emptySnap({
        by_type: [
          { name: 'subagent', total: 50, completed: 45, failed: 3, dead: 2 },
          { name: 'shell', total: 10, completed: 10, failed: 0, dead: 0 },
        ],
      }),
      { useAnsi: false },
    );
    expect(out).toContain('By type (24h)');
    expect(out).toContain('subagent');
    expect(out).toContain('50');
    expect(out).toContain('shell');
  });

  test('top errors panel caps at 5 entries', () => {
    const out = renderSnapshot(
      emptySnap({
        top_errors: [
          { cluster: 'rate_lease_full', count: 89 },
          { cluster: 'prompt_too_long', count: 3 },
          { cluster: 'tool_crash', count: 2 },
          { cluster: 'malformed_json', count: 2 },
          { cluster: 'http_5xx', count: 1 },
          { cluster: 'unknown', count: 1 },
        ],
      }),
      { useAnsi: false },
    );
    const errIdx = out.indexOf('Top errors');
    const rest = out.slice(errIdx);
    expect(rest).toContain('rate_lease_full');
    expect(rest).toContain('http_5xx');
    // 'unknown' was the 6th entry — should NOT render.
    // Quick scan: the panel should have only 5 entries between the header
    // and the next blank line.
    const lines = rest.split('\n');
    const headerIdx = lines.findIndex(l => l.includes('Top errors'));
    const blankIdx = lines.findIndex((l, i) => i > headerIdx && l.trim() === '');
    expect(blankIdx - headerIdx - 1).toBe(5); // 5 entry rows between header and blank
  });

  test('budget panel renders when owners present; suppressed when empty', () => {
    const empty = renderSnapshot(emptySnap(), { useAnsi: false });
    expect(empty).not.toContain('Budget owners');

    const withBudget = renderSnapshot(
      emptySnap({
        budget_owners: [
          { owner_id: 42, remaining_cents: 280, total_spent_cents: 120 },
        ],
      }),
      { useAnsi: false },
    );
    expect(withBudget).toContain('Budget owners');
    expect(withBudget).toContain('owner=42');
    expect(withBudget).toContain('$2.80'); // remaining (280¢)
    expect(withBudget).toContain('$1.20'); // spent  (120¢)
  });

  test('snapshot determinism: same input → byte-identical render', () => {
    const snap = emptySnap({
      lease_pressure_1h: 12,
      by_type: [{ name: 'subagent', total: 5, completed: 5, failed: 0, dead: 0 }],
    });
    const a = renderSnapshot(snap, { useAnsi: false });
    const b = renderSnapshot(snap, { useAnsi: false });
    expect(a).toBe(b);
  });
});
