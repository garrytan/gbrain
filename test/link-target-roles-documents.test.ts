import { describe, expect, test } from 'bun:test';
import { inferLinkType } from '../src/core/link-extraction.ts';

const t = (pt: any, ctx: string, slug: string, tt: string) =>
  inferLinkType(pt, ctx, undefined, slug, tt, ctx.indexOf(slug));

describe('role verbs skip document and meeting targets', () => {
  test('invested_in to an email stays mentions', () => {
    const slug = 'emails/2024/07/2024-07-18-intro-abc123';
    expect(t('company', `Acme is a Fund I portfolio company [Source: email, [[${slug}]]]. It is a portfolio company, fund status active.`, slug, 'email')).toBe('mentions');
  });
  test('founded to a source stays mentions', () => {
    const slug = 'sources/meetings/2026-09-14-screening-call-transcript';
    expect(t('company', `Trained on simulation [Source: [[${slug}]]] - **Founded:** 2023 by Jane Doe`, slug, 'source')).toBe('mentions');
  });
  test('advises to a meeting stays mentions', () => {
    const slug = 'meetings/2026-10-19-team-decisions';
    expect(t('company', `Jane advised cutting jargon from the deck - **2026-10-19** | [[${slug}]] — confirmed`, slug, 'meeting')).toBe('mentions');
  });
  test('controls keep their verbs', () => {
    expect(t('person', 'Alice advises [[companies/acme]] on go-to-market.', 'companies/acme', 'company')).toBe('advises');
    expect(t('person', 'Alice invested in [[companies/acme]] in 2024.', 'companies/acme', 'company')).toBe('invested_in');
  });
});
