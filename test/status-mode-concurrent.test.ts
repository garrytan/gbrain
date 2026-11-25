/**
 * Roadmap PR 2: gbrain_status for lock_held (src/mcp/status-mode.ts). A second stdio serve on a brain another agent
 * session's stdio serve holds (Claude Code and Codex open at once) is the ordinary case: the answer names the owner's
 * PID and start time, says nothing needs fixing and carries expected: true. A shared HTTP server or a non-serve
 * process holding the brain keeps the plain answer, with no expected flag. The decisions are unchanged.
 */
import { describe, expect, test } from 'bun:test';
import { statusHeadline, statusPayload, type StatusModeState } from '../src/mcp/status-mode.ts';

const base = (lock_owner: StatusModeState['lock_owner']): StatusModeState => ({
  reason: 'lock_held', brain_path: '/tmp/brain-example/brain.pglite', config_path: '/tmp/brain-example/config.json',
  checked_at: Date.parse('2026-11-25T10:00:05.000Z'), lock_owner, recovered: false,
});

describe('lock_held status for a second agent session', () => {
  test('a stdio serve owner: named with PID and start time, expected, nothing needs fixing', () => {
    const state = base({ pid: 4242, transport: 'stdio', serve: true, started_at: '2026-11-25T10:00:00.000Z' });
    expect(statusHeadline(state)).toContain('(PID 4242, started 2026-11-25T10:00:00.000Z)');
    expect(statusHeadline(state)).toContain('nothing is broken and nothing needs fixing');
    const p = statusPayload(state) as Record<string, any>;
    expect(p.expected).toBe(true);
    expect(p.user_message).toContain("That's expected with two agent sessions open, and nothing needs fixing");
    expect(p.fix.why.startsWith('Nothing needs fixing')).toBe(true);
    expect(p.decisions[0].options.map((o: { id: string }) => o.id)).toEqual(['close_owner', 'share_http']);
  });

  test('a shared HTTP server or a non-serve process keeps the plain answer', () => {
    for (const owner of [{ pid: 7, transport: 'http' as const, serve: true, started_at: '2026-11-25T10:00:00.000Z' }, { pid: 8, transport: 'unknown' as const, serve: false }]) {
      const p = statusPayload(base(owner)) as Record<string, any>;
      expect(p.expected).toBeUndefined();
      expect(String(p.why)).not.toContain('nothing needs fixing');
      expect(String(p.user_message)).not.toContain('nothing needs fixing');
    }
  });
});
