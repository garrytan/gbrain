import { describe, test, expect } from 'bun:test';

import type { PageType, Link, GraphPath } from '../src/core/types.ts';
import type { LinkBatchInput } from '../src/core/engine.ts';

import {
  ENTITY_TYPES,
  ENTITY_REFERENCE_DIRS,
  BACKLINK_ENTITY_DIRS,
  HEALTH_ENTITY_PAGE_TYPES,
  ENRICHMENT_ENTITY_TYPES,
  ENRICHMENT_REFERENCE_DIRS,
  RELATIONSHIP,
  FRONTMATTER_RELATIONSHIP_MAP,
  FS_LINK_TYPE_RULES,
  PAGE_TYPE_INFERENCE_RULES,
  DIR_PATTERN,
  buildEntityDirRegexFragment,
  isEntityReferenceDir,
  isBacklinkEntityDir,
  isHealthEntityPageType,
  inferPageTypeFromPath,
  inferFsLinkTypeByTopDirs,
  asStoredLinkType,
  type InferredLinkType,
} from '../src/core/entity-taxonomy.ts';

describe('entity-taxonomy (contract)', () => {
  test('ENTITY_TYPES is a readable fillable form for entity behavior decisions', () => {
    expect(ENTITY_TYPES.map(e => ({
      key: e.key,
      singular: e.singular,
      plural: e.plural,
      dirs: e.referenceDirs,
      pageType: 'pageType' in e ? e.pageType : undefined,
      customBehavior: e.customBehavior,
      enrichment: 'enrichment' in e ? e.enrichment : undefined,
    }))).toEqual([
      {
        key: 'person',
        singular: 'person',
        plural: 'people',
        dirs: ['people'],
        pageType: 'person',
        customBehavior: { backlinks: true, healthMetrics: true },
        enrichment: true,
      },
      {
        key: 'company',
        singular: 'company',
        plural: 'companies',
        dirs: ['companies'],
        pageType: 'company',
        customBehavior: { backlinks: true, healthMetrics: true },
        enrichment: true,
      },
      {
        key: 'meeting',
        singular: 'meeting',
        plural: 'meetings',
        dirs: ['meetings'],
        pageType: 'meeting',
        customBehavior: { backlinks: false, healthMetrics: false },
        enrichment: undefined,
      },
      {
        key: 'concept',
        singular: 'concept',
        plural: 'concepts',
        dirs: ['concepts'],
        pageType: 'concept',
        customBehavior: { backlinks: false, healthMetrics: false },
        enrichment: undefined,
      },
      {
        key: 'deal',
        singular: 'deal',
        plural: 'deals',
        dirs: ['deal'],
        pageType: 'deal',
        customBehavior: { backlinks: false, healthMetrics: false },
        enrichment: undefined,
      },
      {
        key: 'civic',
        singular: 'civic',
        plural: 'civic',
        dirs: ['civic'],
        pageType: 'civic',
        customBehavior: { backlinks: false, healthMetrics: false },
        enrichment: undefined,
      },
      {
        key: 'project',
        singular: 'project',
        plural: 'projects',
        dirs: ['project', 'projects'],
        pageType: 'project',
        customBehavior: { backlinks: false, healthMetrics: false },
        enrichment: undefined,
      },
      {
        key: 'source',
        singular: 'source',
        plural: 'sources',
        dirs: ['source'],
        pageType: 'source',
        customBehavior: { backlinks: false, healthMetrics: false },
        enrichment: undefined,
      },
      {
        key: 'media',
        singular: 'media item',
        plural: 'media',
        dirs: ['media'],
        pageType: 'media',
        customBehavior: { backlinks: false, healthMetrics: false },
        enrichment: undefined,
      },
      {
        key: 'yc',
        singular: 'yc page',
        plural: 'yc pages',
        dirs: ['yc'],
        pageType: 'yc',
        customBehavior: { backlinks: false, healthMetrics: false },
        enrichment: undefined,
      },
      {
        key: 'tech',
        singular: 'tech page',
        plural: 'tech pages',
        dirs: ['tech'],
        pageType: undefined,
        customBehavior: { backlinks: false, healthMetrics: false },
        enrichment: undefined,
      },
      {
        key: 'finance',
        singular: 'finance page',
        plural: 'finance pages',
        dirs: ['finance'],
        pageType: undefined,
        customBehavior: { backlinks: false, healthMetrics: false },
        enrichment: undefined,
      },
      {
        key: 'personal',
        singular: 'personal page',
        plural: 'personal pages',
        dirs: ['personal'],
        pageType: undefined,
        customBehavior: { backlinks: false, healthMetrics: false },
        enrichment: undefined,
      },
      {
        key: 'openclaw',
        singular: 'openclaw page',
        plural: 'openclaw pages',
        dirs: ['openclaw'],
        pageType: undefined,
        customBehavior: { backlinks: false, healthMetrics: false },
        enrichment: undefined,
      },
      {
        key: 'legacy-entity',
        singular: 'legacy entity',
        plural: 'legacy entities',
        dirs: ['entities'],
        pageType: undefined,
        customBehavior: { backlinks: false, healthMetrics: false },
        enrichment: undefined,
      },
    ]);
  });

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

  test('enrichment entity keys and reference dirs are derived from enrichable rows', () => {
    expect(ENRICHMENT_ENTITY_TYPES.map(e => e.key)).toEqual(['person', 'company']);
    expect(ENRICHMENT_REFERENCE_DIRS).toEqual(['people', 'companies']);
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

  test('DIR_PATTERN is the canonical alternation exported for link extraction', () => {
    expect(DIR_PATTERN).toBe(buildEntityDirRegexFragment());
    expect(DIR_PATTERN).toBe(
      '(?:companies|concepts|entities|meetings|openclaw|personal|projects|finance|project|people|source|civic|media|deal|tech|yc)',
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
    expect(FS_LINK_TYPE_RULES).toEqual([
      { fromDir: 'people', toDir: 'companies', type: 'founded', whenFrontmatterArrayField: 'founded' },
      { fromDir: 'people', toDir: 'companies', type: 'works_at' },
      { fromDir: 'people', toDir: 'deals', type: 'involved_in' },
      { fromDir: 'deals', toDir: 'companies', type: 'deal_for' },
      { fromDir: 'meetings', toDir: 'people', type: 'attended' },
    ]);
    expect(inferFsLinkTypeByTopDirs('people', 'companies', {})).toBe('works_at');
    expect(inferFsLinkTypeByTopDirs('people', 'companies', { founded: ['acme'] })).toBe('founded');
    expect(inferFsLinkTypeByTopDirs('people', 'deals', {})).toBe('involved_in');
    expect(inferFsLinkTypeByTopDirs('deals', 'companies', {})).toBe('deal_for');
    expect(inferFsLinkTypeByTopDirs('meetings', 'people', {})).toBe('attended');
    expect(inferFsLinkTypeByTopDirs('concepts', 'people', {})).toBe('mentions');
  });

  test('InferredLinkType is derived from RELATIONSHIP values', () => {
    for (const v of Object.values(RELATIONSHIP)) {
      const label: InferredLinkType = v;
      expect(label).toBe(v);
    }
  });

  test('asStoredLinkType bridges inferred labels to stored strings (identity)', () => {
    expect(asStoredLinkType(RELATIONSHIP.WORKS_AT)).toBe('works_at');
    const inferred: InferredLinkType = RELATIONSHIP.MENTIONS;
    const stored: string = inferred;
    expect(stored).toBe('mentions');
  });

  test('DB/API link surfaces remain arbitrary strings, not InferredLinkType-only', () => {
    const link = {
      from_slug: 'a',
      to_slug: 'b',
      link_type: 'legacy_custom_type',
      context: '',
    } as Link;
    const fromRow: string = link.link_type;
    expect(fromRow).toBe('legacy_custom_type');

    const path = {
      from_slug: 'x',
      to_slug: 'y',
      link_type: 'filter_value',
      context: '',
      depth: 1,
    } as GraphPath;
    expect(path.link_type).toBe('filter_value');

    const batch: LinkBatchInput = {
      from_slug: 'p',
      to_slug: 'q',
      link_type: 'arbitrary_api_input',
    };
    expect(batch.link_type).toBe('arbitrary_api_input');
  });
});

