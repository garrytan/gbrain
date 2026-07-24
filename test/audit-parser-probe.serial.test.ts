/**
 * Tests for the parser-probe audit trail + the 24h rate-limit gate.
 *
 * Uses GBRAIN_AUDIT_DIR override pointed at a tmpdir for hermeticity
 * (same pattern as audit-slug-fallback.serial.test.ts). Serial because
 * the env override is process-global.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  computeParserProbeAuditFilename,
  logParserProbeEvent,
  parserProbeRanWithin,
  readRecentParserProbeEvents,
  type ParserProbeAuditEvent,
} from '../src/core/audit-parser-probe.ts';

let auditDir: string;
let savedEnv: string | undefined;

beforeEach(() => {
  auditDir = mkdtempSync(join(tmpdir(), 'parser-probe-audit-'));
  savedEnv = process.env.GBRAIN_AUDIT_DIR;
  process.env.GBRAIN_AUDIT_DIR = auditDir;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.GBRAIN_AUDIT_DIR;
  else process.env.GBRAIN_AUDIT_DIR = savedEnv;
  rmSync(auditDir, { recursive: true, force: true });
});

function makeEvent(overrides: Partial<ParserProbeAuditEvent> = {}): ParserProbeAuditEvent {
  return {
    schema_version: 1,
    ts: new Date().toISOString(),
    outcome: 'pass',
    fixtures_total: 12,
    fixtures_passed: 12,
    recall_mean: 0.98,
    participants_recall_mean: 0.97,
    adversarial_false_positives: 0,
    failed_fixture_ids: [],
    ...overrides,
  };
}

describe('parser-probe audit trail', () => {
  test('log + readRecent round-trip', () => {
    logParserProbeEvent(makeEvent({ outcome: 'fail', reason: '2 fixture(s) failed' }));
    const events = readRecentParserProbeEvents(7);
    expect(events.length).toBe(1);
    expect(events[0]!.outcome).toBe('fail');
    expect(events[0]!.reason).toBe('2 fixture(s) failed');
    const files = readdirSync(auditDir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^parser-probe-\d{4}-W\d{2}\.jsonl$/);
  });

  test('filename uses ISO-week rotation with the parser-probe prefix', () => {
    // Year-boundary edge pinned by the shared writer's own tests; here we
    // pin the prefix wiring.
    expect(computeParserProbeAuditFilename(new Date('2026-07-06T12:00:00Z'))).toBe(
      'parser-probe-2026-W28.jsonl',
    );
  });

  test('readRecent filters by window', () => {
    const old = new Date(Date.now() - 10 * 86400000).toISOString();
    logParserProbeEvent(makeEvent({ ts: old }));
    expect(readRecentParserProbeEvents(7).length).toBe(0);
  });

  test('cross-week ordering: events come back chronological so the tail is the newest run', () => {
    // Regression: the shared week-file reader walks the current week's file
    // first, then the previous week's. Without sorting, the array tail —
    // which doctor's conversation_parser_probe_health reports as "latest" —
    // was the OLDEST in-window event whenever last week's file had entries.
    // Write the two week files directly so the cross-file case is genuinely
    // exercised (the writer routes by write time, not event ts).
    const now = new Date('2026-07-23T12:00:00Z');
    const thisWeekFile = computeParserProbeAuditFilename(now);
    const prevWeekFile = computeParserProbeAuditFilename(new Date(now.getTime() - 7 * 86400000));
    writeFileSync(join(auditDir, thisWeekFile), [
      JSON.stringify(makeEvent({ ts: '2026-07-22T08:00:00Z' })),
      JSON.stringify(makeEvent({ ts: '2026-07-23T08:00:00Z' })),
    ].join('\n') + '\n');
    writeFileSync(join(auditDir, prevWeekFile), [
      JSON.stringify(makeEvent({ ts: '2026-07-17T08:00:00Z' })),
      JSON.stringify(makeEvent({ ts: '2026-07-18T08:00:00Z' })),
    ].join('\n') + '\n');
    const events = readRecentParserProbeEvents(7, now);
    expect(events.map(e => e.ts)).toEqual([
      '2026-07-17T08:00:00Z',
      '2026-07-18T08:00:00Z',
      '2026-07-22T08:00:00Z',
      '2026-07-23T08:00:00Z',
    ]);
  });
});

describe('parserProbeRanWithin — 24h rate-limit gate', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  test('false when no runs are audited', () => {
    expect(parserProbeRanWithin(DAY_MS)).toBe(false);
  });

  test('true when a run landed within the window', () => {
    logParserProbeEvent(makeEvent({ ts: new Date(Date.now() - 60_000).toISOString() }));
    expect(parserProbeRanWithin(DAY_MS)).toBe(true);
  });

  test('false when the last run is older than the window', () => {
    logParserProbeEvent(makeEvent({ ts: new Date(Date.now() - 25 * 3600_000).toISOString() }));
    expect(parserProbeRanWithin(DAY_MS)).toBe(false);
  });

  test('non-pass outcomes also hold the window (mirrors quality-probe semantics)', () => {
    logParserProbeEvent(makeEvent({
      outcome: 'no_embedding_key',
      ts: new Date(Date.now() - 3600_000).toISOString(),
    }));
    expect(parserProbeRanWithin(DAY_MS)).toBe(true);
  });
});
