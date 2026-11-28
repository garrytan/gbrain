import { describe, expect, test } from 'bun:test';
import { inferLinkType } from '../src/core/link-extraction.ts';
import { targetTakesVerb } from '../src/core/link-target-roles.ts';

const typeOf = (pageType: string, context: string, slug: string, targetType?: string | null) =>
  inferLinkType(pageType as any, context, undefined, slug, targetType, context.indexOf(slug));

describe('#9727: founded, invested_in and advises never type an edge to a meeting or a document', () => {
  test('invested_in toward an email stays mentions', () => {
    const slug = 'emails/2024/07/2024-07-18-intro-acme-example';
    expect(typeOf('company', `Acme-example invested in a new round [Source: email, [[${slug}]]].`, slug, 'email')).toBe('mentions');
  });

  test('founded toward a source document stays mentions', () => {
    const slug = 'sources/2026-09-14-screening-call';
    expect(typeOf('company', `Founded in 2023 by alice-example [Source: [[${slug}]]]`, slug, 'source')).toBe('mentions');
  });

  test('advises toward a meeting stays mentions, by type and by slug', () => {
    const slug = 'meetings/2026-10-19-team-sync';
    expect(typeOf('company', `alice-example advised cutting the deck [[${slug}]]`, slug, 'meeting')).toBe('mentions');
    expect(typeOf('company', `alice-example advised cutting the deck [[${slug}]]`, slug, undefined)).toBe('mentions');
  });

  test('document targets refuse the verbs by slug prefix when the type is unknown', () => {
    for (const verb of ['founded', 'invested_in', 'advises']) {
      for (const slug of ['emails/x', 'conversations/x', 'sources/x', 'notes/x', 'inbox/x', 'meetings/x']) {
        expect(targetTakesVerb(verb, slug, undefined)).toBe(false);
      }
    }
  });

  test('companies and people keep the verbs', () => {
    expect(typeOf('person', 'alice-example advises [[companies/acme-example]] on pricing.', 'companies/acme-example', 'company')).toBe('advises');
    expect(typeOf('person', 'alice-example invested in [[companies/acme-example]] in 2024.', 'companies/acme-example', 'company')).toBe('invested_in');
    for (const verb of ['founded', 'invested_in', 'advises']) {
      expect(targetTakesVerb(verb, 'people/bob-example', 'person')).toBe(true);
      expect(targetTakesVerb(verb, 'companies/acme-example', 'company')).toBe(true);
    }
  });
});
