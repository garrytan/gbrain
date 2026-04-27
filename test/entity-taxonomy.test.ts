import { describe, test, expect } from 'bun:test';

import type { PageType } from '../src/core/types.ts';

import {
  ENTITY_REFERENCE_DIRS,
  BACKLINK_ENTITY_DIRS,
  HEALTH_ENTITY_PAGE_TYPES,
  RELATIONSHIP,
  FRONTMATTER_RELATIONSHIP_MAP,
  PAGE_TYPE_INFERENCE_RULES,
  buildEntityDirRegexFragment,
  isEntityReferenceDir,
  isBacklinkEntityDir,
  isHealthEntityPageType,
  inferPageTypeFromPath,
  inferFsLinkTypeByTopDirs,
} from '../src/core/entity-taxonomy.ts';

describe('entity-taxonomy (contract)', () => {
  test('ENTITY_REFERENCE_DIRS is exact and ordered', () => {
    expect(ENTITY_REFERENCE_DIRS).toEqual([
      'people',
      'companies',
      'meetings',
      'concepts',
      'deal',
      'civic',
      'project',
      'projects',
      'source',
      'media',
      'yc',
      'tech',
      'finance',
      'personal',
      'openclaw',
      'entities',
    ]);
  });

  test('BACKLINK_ENTITY_DIRS is exact', () => {
    expect(BACKLINK_ENTITY_DIRS).toEqual(['people', 'companies']);
  });

  test('HEALTH_ENTITY_PAGE_TYPES is exact', () => {
    expect(HEALTH_ENTITY_PAGE_TYPES).toEqual(['person', 'company']);
  });

  test('RELATIONSHIP values are exact', () => {
    expect(RELATIONSHIP).toEqual({
      MENTIONS: 'mentions',
      WORKS_AT: 'works_at',
      INVESTED_IN: 'invested_in',
      FOUNDED: 'founded',
      ADVISES: 'advises',
      ATTENDED: 'attended',
      SOURCE: 'source',
      RELATED_TO: 'related_to',
      DISCUSSED_IN: 'discussed_in',
      YC_PARTNER: 'yc_partner',
      LED_ROUND: 'led_round',
      INVOLVED_IN: 'involved_in',
      DEAL_FOR: 'deal_for',
    });
  });

  test('FRONTMATTER_RELATIONSHIP_MAP matches link-extraction.ts behavior', () => {
    expect(FRONTMATTER_RELATIONSHIP_MAP).toEqual([
      // Person pages → companies
      { fields: ['company', 'companies'], pageType: 'person', type: 'works_at', direction: 'outgoing', dirHint: 'companies' },
      { fields: ['founded'], pageType: 'person', type: 'founded', direction: 'outgoing', dirHint: 'companies' },
      // Company pages (incoming relationships — subject of the verb lives elsewhere)
      { fields: ['key_people'], pageType: 'company', type: 'works_at', direction: 'incoming', dirHint: 'people' },
      { fields: ['partner'], pageType: 'company', type: 'yc_partner', direction: 'incoming', dirHint: 'people' },
      { fields: ['investors'], pageType: 'company', type: 'invested_in', direction: 'incoming', dirHint: ['companies', 'funds', 'people'] },
      // Deal pages (all incoming — deals are the object)
      { fields: ['investors'], pageType: 'deal', type: 'invested_in', direction: 'incoming', dirHint: ['companies', 'funds', 'people'] },
      { fields: ['lead'], pageType: 'deal', type: 'led_round', direction: 'incoming', dirHint: ['companies', 'funds', 'people'] },
      // Meeting pages
      { fields: ['attendees'], pageType: 'meeting', type: 'attended', direction: 'incoming', dirHint: 'people' },
      // Any page type
      { fields: ['sources'], type: 'discussed_in', direction: 'incoming', dirHint: ['source', 'media'] },
      { fields: ['source'], type: 'source', direction: 'outgoing', dirHint: '' },
      { fields: ['related', 'see_also'], type: 'related_to', direction: 'outgoing', dirHint: '' },
    ]);
  });

  test('buildEntityDirRegexFragment generates the same pattern used by link extraction', () => {
    expect(buildEntityDirRegexFragment()).toBe(
      '(?:people|companies|meetings|concepts|deal|civic|project|projects|source|media|yc|tech|finance|personal|openclaw|entities)',
    );
  });

  test('dir membership helpers are consistent', () => {
    expect(isEntityReferenceDir('people')).toBe(true);
    expect(isEntityReferenceDir('funds')).toBe(false);

    expect(isBacklinkEntityDir('people')).toBe(true);
    expect(isBacklinkEntityDir('companies')).toBe(true);
    expect(isBacklinkEntityDir('meetings')).toBe(false);
  });

  test('isHealthEntityPageType narrows correctly', () => {
    expect(isHealthEntityPageType('person')).toBe(true);
    expect(isHealthEntityPageType('company')).toBe(true);
    expect(isHealthEntityPageType('concept')).toBe(false);
  });

  test('PAGE_TYPE_INFERENCE_RULES matches markdown.ts inferType behavior (high-signal cases)', () => {
    // This mainly asserts that the rules exist and are ordered as expected.
    // Detailed behavior is verified via inferPageTypeFromPath below.
    expect(PAGE_TYPE_INFERENCE_RULES.length).toBeGreaterThan(0);
    expect(PAGE_TYPE_INFERENCE_RULES[0]?.type).toBe('writing');
  });

  test.each([
    ['projects/blog/writing/essay.md', 'writing'],
    ['tech/wiki/analysis/foo.md', 'analysis'],
    ['tech/wiki/guides/foo.md', 'guide'],
    ['tech/wiki/guide/foo.md', 'guide'],
    ['tech/wiki/hardware/foo.md', 'hardware'],
    ['tech/wiki/architecture/foo.md', 'architecture'],
    ['tech/wiki/concepts/foo.md', 'concept'],
    ['tech/wiki/concept/foo.md', 'concept'],
    ['people/alice.md', 'person'],
    ['person/alice.md', 'person'],
    ['companies/acme.md', 'company'],
    ['company/acme.md', 'company'],
    ['deals/acme-seed.md', 'deal'],
    ['deal/acme-seed.md', 'deal'],
    ['yc/fund-a.md', 'yc'],
    ['civic/city.md', 'civic'],
    ['projects/foo.md', 'project'],
    ['project/foo.md', 'project'],
    ['sources/foo.md', 'source'],
    ['source/foo.md', 'source'],
    ['media/foo.md', 'media'],
    ['emails/em-0001.md', 'email'],
    ['slack/sl-0001.md', 'slack'],
    ['cal/ev-0001.md', 'calendar-event'],
    ['calendar/ev-0001.md', 'calendar-event'],
    ['notes/n-0001.md', 'note'],
    ['note/n-0001.md', 'note'],
    ['meetings/m-0001.md', 'meeting'],
    ['meeting/m-0001.md', 'meeting'],
  ])('inferPageTypeFromPath(%s) = %s', (path, expected) => {
    expect(inferPageTypeFromPath(path)).toBe(expected as PageType);
  });

  test('inferFsLinkTypeByTopDirs matches extract.ts inferTypeByDir behavior', () => {
    expect(inferFsLinkTypeByTopDirs('people', 'companies', {})).toBe('works_at');
    expect(inferFsLinkTypeByTopDirs('people', 'companies', { founded: ['acme'] })).toBe('founded');
    expect(inferFsLinkTypeByTopDirs('people', 'deals', {})).toBe('involved_in');
    expect(inferFsLinkTypeByTopDirs('deals', 'companies', {})).toBe('deal_for');
    expect(inferFsLinkTypeByTopDirs('meetings', 'people', {})).toBe('attended');
    expect(inferFsLinkTypeByTopDirs('concepts', 'people', {})).toBe('mentions');
  });
});

