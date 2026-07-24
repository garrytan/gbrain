import { describe, test, expect } from 'bun:test';
import {
  computeDurabilityPushCheck,
  parsePushLogFailures,
  type DurabilityRepoProbe,
} from '../src/commands/doctor.ts';

const probe = (over: Partial<DurabilityRepoProbe> = {}): DurabilityRepoProbe => ({
  sourceId: 'default',
  ahead: 0,
  upstreamMissing: false,
  dirty: 0,
  ...over,
});
const noFailures = { failures: 0, lastFailure: null };

describe('computeDurabilityPushCheck', () => {
  test('no hardened sources → ok not-applicable with enable hint', () => {
    const c = computeDurabilityPushCheck([], noFailures);
    expect(c.status).toBe('ok');
    expect(c.message).toContain('not applicable');
    expect(c.message).toContain('sources harden');
  });

  test('all pushed → ok naming the count', () => {
    const c = computeDurabilityPushCheck([probe(), probe({ sourceId: 'wiki' })], noFailures);
    expect(c.status).toBe('ok');
    expect(c.message).toContain('2 hardened source(s): 2 pushed');
  });

  test('unpushed commits → warn naming the source and recovery', () => {
    const c = computeDurabilityPushCheck([probe({ ahead: 4 })], noFailures);
    expect(c.status).toBe('warn');
    expect(c.message).toContain('default: 4 commit(s) local-only');
    expect(c.message).toContain('brain-push.log');
  });

  test('missing upstream → warn even with ahead unknown', () => {
    const c = computeDurabilityPushCheck([probe({ ahead: null, upstreamMissing: true })], noFailures);
    expect(c.status).toBe('warn');
    expect(c.message).toContain('no upstream');
  });

  test('recent push failures → warn carrying the last log line', () => {
    const c = computeDurabilityPushCheck(
      [probe()],
      { failures: 3, lastFailure: '2026-07-18T01:00:00Z [push] LOCAL-ONLY, NEEDS ATTENTION: main @ abc123' },
    );
    expect(c.status).toBe('warn');
    expect(c.message).toContain('3 push failure(s)');
    expect(c.message).toContain('LOCAL-ONLY');
  });

  test('probe failure (all null) stays ok but is named unverified, never counted as pushed', () => {
    const c = computeDurabilityPushCheck([probe({ ahead: null, dirty: null })], noFailures);
    expect(c.status).toBe('ok');
    expect(c.message).toContain('unverified');
    expect(c.message).toContain('default');
    expect(c.message).not.toContain('1 pushed');
  });

  test('dirty files are informational on ok, appended on warn', () => {
    const ok = computeDurabilityPushCheck([probe({ dirty: 2 })], noFailures);
    expect(ok.status).toBe('ok');
    expect(ok.message).toContain('default=2');
    const warn = computeDurabilityPushCheck([probe({ ahead: 1, dirty: 2 })], noFailures);
    expect(warn.status).toBe('warn');
    expect(warn.message).toContain('default=2');
  });
});

describe('parsePushLogFailures', () => {
  const now = new Date('2026-07-18T12:00:00Z');

  test('counts LOCAL-ONLY and lock-timeout inside the window, keeps the last', () => {
    const log = [
      '2026-07-17T01:00:00Z [push] ok main abc123',
      '2026-07-17T02:00:00Z [push] lock-timeout main',
      '2026-07-17T03:00:00Z [push] rejected; rebase-pull main',
      '2026-07-18T04:00:00Z [push] LOCAL-ONLY, NEEDS ATTENTION: main @ def456 could not reach origin.',
    ].join('\n');
    const r = parsePushLogFailures(log, now);
    expect(r.failures).toBe(2);
    expect(r.lastFailure).toContain('def456');
  });

  test('a later successful push clears earlier failures (latest terminal state wins)', () => {
    const log = [
      '2026-07-18T01:00:00Z [push] LOCAL-ONLY, NEEDS ATTENTION: main @ abc could not reach origin.',
      '2026-07-18T02:00:00Z [push] ok main abc',
    ].join('\n');
    expect(parsePushLogFailures(log, now).failures).toBe(0);
    const stillFailing = [
      '2026-07-18T01:00:00Z [push] ok main abc',
      '2026-07-18T02:00:00Z [push] LOCAL-ONLY, NEEDS ATTENTION: main @ def could not reach origin.',
    ].join('\n');
    expect(parsePushLogFailures(stillFailing, now).failures).toBe(1);
  });

  test('failures outside the window are ignored', () => {
    const log = '2026-06-01T00:00:00Z [push] LOCAL-ONLY, NEEDS ATTENTION: main @ old000';
    expect(parsePushLogFailures(log, now).failures).toBe(0);
  });

  test('ok and transient rebase lines never count; garbage lines ignored', () => {
    const log = [
      '2026-07-18T01:00:00Z [push] ok main abc',
      '2026-07-18T01:01:00Z [push] ok-after-rebase main abc',
      'not a timestamped line LOCAL-ONLY',
      '',
    ].join('\n');
    expect(parsePushLogFailures(log, now).failures).toBe(0);
  });

  test('long failure lines are truncated for the doctor message', () => {
    const log = `2026-07-18T01:00:00Z [push] LOCAL-ONLY, NEEDS ATTENTION: ${'x'.repeat(300)}`;
    const r = parsePushLogFailures(log, now);
    expect(r.failures).toBe(1);
    expect((r.lastFailure as string).length).toBeLessThanOrEqual(161);
  });
});
