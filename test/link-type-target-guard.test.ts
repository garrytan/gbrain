/**
 * #6191 — a role verb near a link only types the edge when the target can
 * take that role: `works_at` never points at a person, meeting, calendar or
 * media page, and `founded`/`invested_in` never at a meeting, calendar or
 * media page. Such a link keeps scanning lower-precedence verbs, then falls
 * back to `mentions`; employer targets (companies, pack-defined org types)
 * keep `works_at`.
 * Fails when: "VP of Sales" beside a meeting link types it works_at again.
 * Pure: inferLinkType only.
 */
import { describe, expect, test } from 'bun:test';
import { inferLinkType } from '../src/core/link-extraction.ts';

describe('inferLinkType target guard (#6191)', () => {
  test('works_at never points at a meeting or person page', () => {
    expect(inferLinkType('person', 'Discussed pricing with the VP of Sales at [Q3 Kickoff](meetings/2026-q3-kickoff).', undefined,
      'meetings/2026-q3-kickoff', 'meeting')).toBe('mentions');
    expect(inferLinkType('person', 'She is Head of Platform, reporting to [Bob](people/bob-example).', undefined,
      'people/bob-example', 'person')).toBe('mentions');
    expect(inferLinkType('concept', 'The head of research presented at [Offsite](meetings/offsite).', undefined,
      'meetings/offsite', undefined)).toBe('mentions');
  });

  test('an unknown type falls back to the slug: people/, meetings/ and calendar/ are not employers', () => {
    expect(inferLinkType('person', 'Engineer at [Bob](people/bob-example).', undefined, 'people/bob-example', null)).toBe('mentions');
    expect(inferLinkType('person', 'Engineer at [Standup](calendar/standup).', undefined, 'calendar/standup', null)).toBe('mentions');
  });

  test('employers keep works_at', () => {
    expect(inferLinkType('person', 'Alice is an engineer at [Acme](companies/acme-example).', undefined, 'companies/acme-example', 'company')).toBe('works_at');
    expect(inferLinkType('person', 'Alice works at [Acme Labs](orgs/acme-labs).', undefined, 'orgs/acme-labs', 'organization')).toBe('works_at');
  });

  test('founded and invested_in never point at a meeting', () => {
    expect(inferLinkType('person', 'Founded the company right after [Kickoff](meetings/kickoff).', undefined, 'meetings/kickoff', 'meeting')).toBe('mentions');
    expect(inferLinkType('person', 'She founded it with [Bob](people/bob-example).', undefined, 'people/bob-example', 'person')).toBe('founded');
  });

  test('a person target keeps its own verb in "works at [A] and advises [B]"', () => {
    const ctx = 'Alice works at [Acme](companies/acme-example) and advises [Bob](people/bob-example).';
    expect(inferLinkType('person', ctx, undefined, 'companies/acme-example', 'company')).toBe('works_at');
    expect(inferLinkType('person', ctx, undefined, 'people/bob-example', 'person')).toBe('advises');
  });
});
