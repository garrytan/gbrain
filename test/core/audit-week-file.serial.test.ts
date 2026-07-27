/**
 * v0.37.x — single source of truth for ISO-week audit filenames.
 *
 * Pins year-boundary correctness so the four migrated callers
 * (shell-audit, phantom-audit, slug-fallback-audit, dream-budget,
 * budget-tracker) don't drift apart on filename shapes.
 */

import { describe, test, expect } from 'bun:test';
import { isoWeek, isoWeekFilename, resolveAuditDir } from '../../src/core/audit-week-file.ts';

describe('isoWeek', () => {
  test('mid-year date returns 1..53 within the calendar year', () => {
    const { year, week } = isoWeek(new Date(Date.UTC(2026, 5, 15))); // 2026-06-15 (Mon)
    expect(year).toBe(2026);
    expect(week).toBeGreaterThan(20);
    expect(week).toBeLessThan(28);
  });

  test('2025-01-01 (Wednesday) belongs to 2025-W01', () => {
    const { year, week } = isoWeek(new Date(Date.UTC(2025, 0, 1)));
    expect(year).toBe(2025);
    expect(week).toBe(1);
  });

  test('2024-12-30 (Monday) belongs to 2025-W01 (rollover into next ISO year)', () => {
    const { year, week } = isoWeek(new Date(Date.UTC(2024, 11, 30)));
    expect(year).toBe(2025);
    expect(week).toBe(1);
  });

  test('2026-01-01 (Thursday) belongs to 2026-W01', () => {
    const { year, week } = isoWeek(new Date(Date.UTC(2026, 0, 1)));
    expect(year).toBe(2026);
    expect(week).toBe(1);
  });

  test('2020-12-28 (Mon) is 2020-W53 (the 53-week year)', () => {
    const { year, week } = isoWeek(new Date(Date.UTC(2020, 11, 28)));
    expect(year).toBe(2020);
    expect(week).toBe(53);
  });
});

describe('isoWeekFilename', () => {
  test('produces <prefix>-YYYY-Www.jsonl with two-digit week', () => {
    expect(isoWeekFilename('budget', new Date(Date.UTC(2025, 0, 1)))).toBe('budget-2025-W01.jsonl');
    expect(isoWeekFilename('shell-jobs', new Date(Date.UTC(2020, 11, 28)))).toBe('shell-jobs-2020-W53.jsonl');
  });

  test('default now arg uses current date (smoke)', () => {
    const name = isoWeekFilename('budget');
    expect(name).toMatch(/^budget-\d{4}-W\d{2}\.jsonl$/);
  });
});

describe('resolveAuditDir', () => {
  test('honors GBRAIN_AUDIT_DIR override', () => {
    const prev = process.env.GBRAIN_AUDIT_DIR;
    process.env.GBRAIN_AUDIT_DIR = '/tmp/test-audit-override';
    try {
      expect(resolveAuditDir()).toBe('/tmp/test-audit-override');
    } finally {
      if (prev === undefined) delete process.env.GBRAIN_AUDIT_DIR;
      else process.env.GBRAIN_AUDIT_DIR = prev;
    }
  });
});
