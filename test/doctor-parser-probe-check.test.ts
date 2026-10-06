/**
 * Tests for computeConversationParserProbeHealthCheck — the pure function
 * behind doctor's conversation_parser_probe_health check, which replaced
 * the v0.41.13.0 hardcoded "Skipped" stub when the autopilot wiring
 * landed. Mirrors the branch coverage style of the quality-probe check.
 */
import { describe, expect, test } from 'bun:test';

import { computeConversationParserProbeHealthCheck } from '../src/commands/doctor.ts';

const ev = (outcome: string, reason?: string, ts = new Date().toISOString()) => ({
  outcome,
  ts,
  ...(reason !== undefined ? { reason } : {}),
});

describe('computeConversationParserProbeHealthCheck', () => {
  test('disabled + no events → ok with paste-ready enable hint', () => {
    const check = computeConversationParserProbeHealthCheck(false, []);
    expect(check.status).toBe('ok');
    expect(check.message).toContain('gbrain config set autopilot.conversation_parser_probe.enabled true');
  });

  test('enabled + no events yet → ok, next run by autopilot', () => {
    const check = computeConversationParserProbeHealthCheck(true, []);
    expect(check.status).toBe('ok');
    expect(check.message).toContain('no probe events');
  });

  test('disabled flag but events exist (tokenmax mode-gate ran it) → events win over the hint', () => {
    const check = computeConversationParserProbeHealthCheck(false, [ev('pass')]);
    expect(check.status).toBe('ok');
    expect(check.message).toContain('all pass');
  });

  test('a skipped run (fixtures unreadable) → warn naming the skip and its reason, not ok (C-N6)', () => {
    const check = computeConversationParserProbeHealthCheck(true, [
      ev('skipped', 'fixture_unavailable: /$bunfs/root/all.jsonl is not readable'),
    ]);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('latest: skipped (fixture_unavailable: /$bunfs/root/all.jsonl is not readable)');
  });

  test('enabled with no events no longer blames a source-checkout install (C-N6)', () => {
    expect(computeConversationParserProbeHealthCheck(true, []).message).not.toContain('source-checkout');
  });

  test('any non-pass outcome in the window → warn, latest surfaced with reason', () => {
    const check = computeConversationParserProbeHealthCheck(true, [
      ev('pass'),
      ev('adversarial_false_positive', '1 adversarial fixture(s) parsed to non-empty'),
    ]);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('adversarial_false_positive');
    expect(check.message).toContain('parsed to non-empty');
  });

  test('all pass → ok with run count', () => {
    const check = computeConversationParserProbeHealthCheck(true, [ev('pass'), ev('pass')]);
    expect(check.status).toBe('ok');
    expect(check.message).toContain('2 probe run(s)');
  });
});
