/**
 * Pure household logic (agent platform plan, H1): record validation, the placement table and the due assessment.
 * Synthetic data only.
 */
import { describe, expect, test } from 'bun:test';

import { accountNumberFields, addMonths, cadenceDays, looksLikeAccountNumber, readHouseholdRecord, strictDate, strictMonthDay } from '../src/core/household/record.ts';
import { HOUSEHOLD_GROUPS, audienceReaders, placeRecord, placementFolderRules } from '../src/core/household/placement.ts';
import { assessHouseholdRecord, calendarDay, rankAssessments, type PolicyAdvisor } from '../src/core/household/assess.ts';
import { AGENT_VERBS } from '../src/core/agent-verbs.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { codeEntry, exitCodeForCode } from '../src/core/error-catalogue.ts';

const rec = (fm: Record<string, unknown>, slug = 'household/supplies/milk') => {
  const read = readHouseholdRecord({ slug, source_id: 'default', title: String(fm.title ?? 'x'), frontmatter: { type: 'household', household_schema: 1, ...fm } });
  if (!read.record) throw new Error(JSON.stringify(read.issues));
  return read.record;
};

describe('record validation', () => {
  test('dates are strict: no rollover, no free text', () => {
    expect(strictDate('2026-12-01')).toBe('2026-12-01');
    expect(strictDate('2026-02-30')).toBeNull();
    expect(strictDate('next tuesday')).toBeNull();
    expect(strictMonthDay('02-29')).toBe('02-29');
    expect(strictMonthDay('13-01')).toBeNull();
  });

  test('month arithmetic clamps to the last day', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-11-30', 3)).toBe('2027-02-28');
  });

  test('cadence parses days, weeks, months and years', () => {
    expect(cadenceDays('14d')).toBe(14);
    expect(cadenceDays('2w')).toBe(14);
    expect(cadenceDays('nonsense')).toBeNull();
  });

  test('account numbers are caught in any field, dates and amounts are not', () => {
    expect(looksLikeAccountNumber('4111 1111 1111 1111')).toBe(true);
    expect(looksLikeAccountNumber('acct 000123456789')).toBe(true);
    expect(looksLikeAccountNumber('2026-12-01')).toBe(false);
    expect(looksLikeAccountNumber('Pay 60 USD')).toBe(false);
    expect(accountNumberFields({ title: 'ok', notes: { a: 'routing 021000021 acct 123456789012' } })).toEqual(['notes.a']);
  });

  test('a number used as a key is caught and never echoed in the field path (follow-up outside#4)', () => {
    for (const fm of [{ '4111111111111111': 'card' }, { notes: { '4111 1111 1111 1111': { last: 'x' } } }, { notes: { '000123456789': 'acct' } }]) {
      const fields = accountNumberFields(fm);
      expect(fields.length).toBe(1);
      expect(fields.join(' ')).not.toMatch(/\d{4}/);
    }
  });

  test('date ranges and plain bank or card names are not account numbers (follow-up adversarial-native#4)', () => {
    for (const range of ['2026-12-03 - 2027-01-03', '2026-12-04 - 2026-12-18', '2026-12-08 - 2026-12-22', '2026-12-08 - 2027-01-08']) {
      expect(looksLikeAccountNumber(range)).toBe(false);
      expect(looksLikeAccountNumber(`Trip ${range}, booked`)).toBe(false);
    }
    expect(accountNumberFields({ bank: 'Acme Credit Union', card: 'visa' })).toEqual([]);
    expect(accountNumberFields({ card_number: '1234', iban: 'x' })).toEqual(['card_number', 'iban']);
  });

  test('keys that name the number still count, and a date inside a longer number does not hide it (follow-up final review)', () => {
    for (const key of ['account', 'acct', 'iban_number', 'iban_no', 'routing_id', 'routing']) expect(accountNumberFields({ [key]: '021000021' })).toEqual([key]);
    expect(looksLikeAccountNumber('Card 4111-1111-2026-12-04 on file')).toBe(true);
  });

  test('a record with a bad field reports an issue at read time instead of throwing', () => {
    const read = readHouseholdRecord({ slug: 'household/x', source_id: 'default', frontmatter: { type: 'household', household_schema: 1, kind: 'bill', due: 'soon' } });
    expect(read.record).toBeNull();
    expect(read.issues.length).toBeGreaterThan(0);
  });
});

describe('placement table', () => {
  test('money and returns are adults only; supplies and birthdays are shared', () => {
    expect(placeRecord({ kind: 'bill', subjects: [] })).toEqual({ folder: 'household/money/bill/', audience: 'adults', basis: 'kind' });
    expect(placeRecord({ kind: 'return', subjects: [] }).audience).toBe('adults');
    expect(placeRecord({ kind: 'supply', subjects: ['not_child'] }).audience).toBe('shared');
    expect(placeRecord({ kind: 'deadline', school: true, subjects: [] }).folder).toBe('household/school/');
  });

  test('a child subject sends any kind to household/kids/ and adults only', () => {
    expect(placeRecord({ kind: 'supply', subjects: ['not_child', 'child'] })).toEqual({ folder: 'household/kids/supply/', audience: 'adults', basis: 'child_subject' });
  });

  test('an unclassified subject fails closed to adults only', () => {
    expect(placeRecord({ kind: 'birthday', subjects: ['unclassified'] })).toMatchObject({ audience: 'adults', basis: 'unclassified_subject' });
  });

  test('a caller can narrow a shared record to adults but never widen an adults record', () => {
    expect(placeRecord({ kind: 'supply', subjects: [], requested: 'adults' })).toMatchObject({ audience: 'adults', basis: 'requested' });
    expect(placeRecord({ kind: 'bill', subjects: [], requested: 'shared' }).audience).toBe('adults');
    expect(placeRecord({ kind: 'mystery', subjects: [] })).toMatchObject({ audience: 'adults', basis: 'unknown_kind' });
  });

  test('readers name the owner and the namespaced household groups only', () => {
    expect(audienceReaders('adults', 'alice-example')).toEqual(['group:household-adults', 'member:alice-example']);
    expect(audienceReaders('shared', null)).toEqual(Object.values(HOUSEHOLD_GROUPS).map(g => 'group:' + g).sort());
    const rules = placementFolderRules('alice-example');
    expect(rules.find(r => r.prefix === 'household/kids/birthday/')!.readable_by).not.toContain('group:household-helpers');
    expect(rules.find(r => r.prefix === 'household/supplies/')!.readable_by).toContain('group:household-helpers');
  });
});

describe('due assessment', () => {
  const AS_OF = '2026-12-01';

  test('a paid monthly bill is next due on its next occurrence', () => {
    const a = assessHouseholdRecord(rec({ kind: 'bill', title: 'Rent', due: '2026-12-01', recurs: 'monthly', done_through: '2026-12-01' }, 'household/money/bill/rent'), AS_OF);
    expect(a).toMatchObject({ state: 'ok', next_due: '2027-01-01' });
  });

  test('a supply never bought is unknown, not overdue', () => {
    expect(assessHouseholdRecord(rec({ kind: 'supply', title: 'Soap', cadence: '30d' }), AS_OF).state).toBe('unknown');
  });

  test('a leap-day birthday falls on Feb 28 in a common year', () => {
    const a = assessHouseholdRecord(rec({ kind: 'birthday', title: 'Leap', on: '02-29' }, 'household/birthdays/leap'), '2027-02-20');
    expect(a.next_due).toBe('2027-02-28');
  });

  test('d2: an allow from the policy never clears requires_approval; advice rides in policy_advice', () => {
    const allow: PolicyAdvisor = () => ({ decision: 'allow', rule_id: 'r-1', enforcement: 'advisory' });
    const seen = new Set<string>();
    for (const fm of [
      { kind: 'appointment', title: 'Dentist', due: '2026-12-03' },
      { kind: 'bill', title: 'Water', due: '2026-12-02', amount: 60, currency: 'USD' },
      { kind: 'birthday', title: 'Bob', on: '12-03' },
      { kind: 'supply', title: 'Milk', cadence: '7d', last_done: '2026-11-25' },
      { kind: 'return', title: 'Boots', due: '2026-12-02' },
      { kind: 'deadline', title: 'Plumber', due: '2026-12-02', proposed_action: { verb: 'call', note: 'Call the plumber about the leak' } },
      { kind: 'birthday', title: 'Casey', on: '12-04', proposed_action: { verb: 'send', note: 'Send a card' } },
    ]) {
      const a = assessHouseholdRecord(rec(fm, 'household/x/' + fm.title.toLowerCase()), AS_OF, { advice: allow });
      expect(a.proposed_action).not.toBeNull();
      expect(a.proposed_action!.requires_approval).toBe(true);
      expect(a.proposed_action!.policy_advice).toEqual({ decision: 'allow', rule_id: 'r-1', enforcement: 'advisory' });
      expect(AGENT_VERBS as readonly string[]).toContain(a.proposed_action!.verb);
      seen.add(a.proposed_action!.verb);
    }
    for (const verb of ['book', 'call', 'send', 'spend']) expect(seen).toContain(verb);
  });

  test('ranking breaks ties by next due, then slug', () => {
    const a = assessHouseholdRecord(rec({ kind: 'supply', title: 'B', cadence: '7d', last_done: '2026-11-26' }, 'household/supplies/b'), AS_OF);
    const b = assessHouseholdRecord(rec({ kind: 'supply', title: 'A', cadence: '7d', last_done: '2026-11-26' }, 'household/supplies/a'), AS_OF);
    expect(rankAssessments([a, b]).map(x => x.slug)).toEqual(['household/supplies/a', 'household/supplies/b']);
  });

  test('the calendar day is the household\'s own zone', () => {
    const ms = Date.UTC(2026, 11, 2, 5, 0, 0);
    expect(calendarDay(ms, 'America/Los_Angeles')).toBe('2026-12-01');
    expect(calendarDay(ms, 'UTC')).toBe('2026-12-02');
  });
});

describe('household error codes', () => {
  const guide = readFileSync(join(import.meta.dir, '..', 'docs', 'guides', 'household.md'), 'utf8');
  for (const code of ['household_exists', 'household_scale', 'household_transition', 'account_number_key']) {
    test(code + ' is registered with a why, a suggestion and a docs anchor that resolves', () => {
      const entry = codeEntry(code) as { class: string; why: string; suggestion: string; docs: string } | undefined;
      expect(entry).toBeDefined();
      expect(entry!.class).toBe('caller');
      expect(entry!.why.length).toBeGreaterThan(20);
      expect(entry!.suggestion.length).toBeGreaterThan(10);
      expect(entry!.docs).toBe('docs/guides/household.md#' + code);
      expect(guide).toContain('\n## ' + code + '\n');
      expect(typeof exitCodeForCode(code)).toBe('number');
    });
  }
});
