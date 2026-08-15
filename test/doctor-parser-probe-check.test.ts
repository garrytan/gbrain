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
