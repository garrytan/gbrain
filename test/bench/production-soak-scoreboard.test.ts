import { describe, expect, test } from 'bun:test';
import { buildScoreboard, GATES, renderScoreboard, type Ev } from '../../scripts/bench/production-soak/scoreboard.ts';

const start: Ev = { t: 0, kind: 'start', config: { rtt_ms: 65, hours: 1, commit_every_s: 180, label: 'unit' }, version: 'gbrain 0.0.0', gbrain_rev: 'abc' };
const status = (at_s: number, head: string, last_commit: string, holds: number): Ev => ({ t: at_s * 1000, kind: 'status', at_s, head, last_commit, holds, ms: 100, state: 'resumable', reason: 'pass_unfinished', hold_codes: { file_drift: holds } });

describe('production soak scoreboard', () => {
  test('every gate is record-only', () => {
    expect(GATES.every(g => g.mode === 'record')).toBe(true);
  });

  test('a watermark that stays behind HEAD while holds exist is frozen', () => {
    const events: Ev[] = [start, status(0, 'h1', 'b0', 3), status(1200, 'h2', 'b0', 5), status(2400, 'h3', 'b0', 5),
      { t: 1, kind: 'commit', n: 1, problem: true }, { t: 2, kind: 'commit', n: 2, problem: false }, { t: 3, kind: 'freshness_unresolved', n: 2, age_ms: 2_000_000 }];
    const b = buildScoreboard(events);
    expect(b.freshness.watermark_stall_max_s).toBe(2400);
    expect(b.freshness.frozen_by_hold).toBe(true);
    expect(b.freshness.after_first_hold_commit).toEqual({ commits: 1, resolved: 0 });
    expect(b.gates.find(g => g.id === 'freshness_not_frozen')!.pass).toBe(false);
  });

  test('a watermark that keeps up is not frozen, and latencies split by surface and op', () => {
    const events: Ev[] = [start, status(0, 'h1', 'h1', 2), status(1200, 'h2', 'h2', 2),
      { t: 1, kind: 'freshness', n: 1, lag_ms: 30_000, first_ms: 20_000 }, { t: 2, kind: 'freshness', n: 2, lag_ms: 90_000, first_ms: 50_000 },
      ...[100, 200, 300].map((ms, i) => ({ t: 10 + i, kind: 'read', surface: 'mcp', op: 'search', ms, ok: true })),
      { t: 20, kind: 'read', surface: 'cli', op: 'search', ms: 2500, ok: true }, { t: 21, kind: 'read', surface: 'cli', op: 'search', ms: 9000, ok: false },
      { t: 30, kind: 'write', surface: 'cli', op: 'put', ms: 4000, ok: false, outcome: 'pending' }];
    const b = buildScoreboard(events);
    expect(b.freshness.frozen_by_hold).toBe(false);
    expect(b.freshness.lag_p50_s).toBe(60);
    expect((b.reads as any).mcp.search.p50_ms).toBe(200);
    expect((b.reads as any).cli.search).toMatchObject({ n: 2, errors: 1, p50_ms: 2500 });
    expect((b.writes as any).put).toMatchObject({ n: 1, errors: 0, pending: 1 });
    expect(b.writes.error_rate).toBe(0);
    expect(renderScoreboard(b)).toContain('| freshness_p95 |');
  });

  test('a canary in a remote response counts as a leak, and pool refusals are read from the end event', () => {
    const events: Ev[] = [start, { t: 1, kind: 'privacy', op: 'search', class: 'access', leaked: true, tokens: ['zqpvaaaaaaa'] }, { t: 2, kind: 'privacy', op: 'get_page', class: 'visibility', leaked: false },
      { t: 3, kind: 'privacy_passive', op: 'query', tokens: ['zqpgbbbbbbb'] }, { t: 4, kind: 'sample', session: 26, session_active: 9, txn: 18, backends: 50, mem: {} },
      { t: 5, kind: 'end', refused: { session: 4, txn: 0 }, log_hits: { 'serve.log': 4 }, elapsed_s: 10 }];
    const b = buildScoreboard(events);
    expect(b.privacy).toMatchObject({ probes: 2, leaks: 2, by_class: { access: 1, passive: 1 } });
    expect(b.pool).toMatchObject({ session_peak: 26, session_refusals: 4 });
    expect(b.gates.find(g => g.id === 'session_refusals')!.pass).toBe(false);
  });
});
