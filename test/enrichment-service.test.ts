import { describe, test, expect } from 'bun:test';
import { enrichmentDisplayLabelForPageType } from '../src/core/entity-taxonomy.ts';
import {
  slugifyEntity,
  entityPagePath,
  extractEntities,
  enrichEntity,
  enrichEntities,
  extractAndEnrich,
} from '../src/core/enrichment-service.ts';

describe('enrichment-service', () => {
  test('enrichment stub Type labels derive from taxonomy singular', () => {
    expect(enrichmentDisplayLabelForPageType('person')).toBe('Person');
    expect(enrichmentDisplayLabelForPageType('company')).toBe('Company');
  });

  describe('slugifyEntity', () => {
    test('person names → people/ prefix', () => {
      expect(slugifyEntity('Jane Doe', 'person')).toBe('people/jane-doe');
    });

    test('company names → companies/ prefix', () => {
      expect(slugifyEntity('Acme Corp', 'company')).toBe('companies/acme-corp');
    });

    test('handles apostrophes', () => {
      expect(slugifyEntity("O'Brien", 'person')).toBe('people/obrien');
    });

    test('handles special characters', () => {
      expect(slugifyEntity('José García', 'person')).toBe('people/jos-garc-a');
    });

    test('trims leading/trailing hyphens', () => {
      expect(slugifyEntity('  Test Name  ', 'person')).toBe('people/test-name');
    });

    test('collapses multiple hyphens', () => {
      expect(slugifyEntity('Test--Name', 'person')).toBe('people/test-name');
    });
  });

  describe('entityPagePath', () => {
    test('returns same result as slugifyEntity', () => {
      expect(entityPagePath('Jane Doe', 'person')).toBe(slugifyEntity('Jane Doe', 'person'));
    });
  });

  describe('extractEntities', () => {
    test('extracts capitalized multi-word names', () => {
      const entities = extractEntities('I met with John Smith and Sarah Connor yesterday.');
      expect(entities.length).toBeGreaterThanOrEqual(2);
      const names = entities.map(e => e.name);
      expect(names).toContain('John Smith');
      expect(names).toContain('Sarah Connor');
    });

    test('classifies company names with Corp/Inc/Labs', () => {
      const entities = extractEntities('We visited Acme Corp and Beta Labs.');
      const acme = entities.find(e => e.name.includes('Acme'));
      const beta = entities.find(e => e.name.includes('Beta'));
      expect(acme?.type).toBe('company');
      expect(beta?.type).toBe('company');
    });

    test('classifies other multi-word names as person', () => {
      const entities = extractEntities('Talked to Jane Doe about the project.');
      const jane = entities.find(e => e.name === 'Jane Doe');
      expect(jane?.type).toBe('person');
    });

    test('deduplicates by name (case-insensitive)', () => {
      const entities = extractEntities('John Smith said hello. Then John Smith left.');
      const johns = entities.filter(e => e.name === 'John Smith');
      expect(johns.length).toBe(1);
    });

    test('returns empty array for text with no entities', () => {
      const entities = extractEntities('this is all lowercase text with no names');
      expect(entities.length).toBe(0);
    });

    test('includes context around each entity', () => {
      const entities = extractEntities('The CEO of StartupX, John Smith, announced the deal.');
      const john = entities.find(e => e.name === 'John Smith');
      expect(john?.context.length).toBeGreaterThan(10);
    });

    test('handles 3-4 word names', () => {
      const entities = extractEntities('Mary Jane Watson Parker joined the team.');
      expect(entities.some(e => e.name.split(' ').length >= 3)).toBe(true);
    });
  });

  describe('enrichEntity / enrichEntities', () => {
    function makeEngineMock(opts?: {
      existingSlugs?: string[];
      searchSlugs?: string[];
      failTimeline?: boolean;
      failLink?: boolean;
    }) {
      const existing = new Set(opts?.existingSlugs ?? []);
      const putCalls: Array<{ slug: string; page: unknown }> = [];
      const timelineCalls: Array<{ slug: string; entry: unknown }> = [];
      const linkCalls: Array<{ from: string; to: string; context: string; linkType?: string }> = [];

      const engine = {
        async searchKeyword() {
          return (opts?.searchSlugs ?? []).map(slug => ({ slug }));
        },
        async getPage(slug: string) {
          return existing.has(slug) ? ({ slug } as any) : null;
        },
        async putPage(slug: string, page: unknown) {
          putCalls.push({ slug, page });
          existing.add(slug);
          return { slug, ...(page as any) };
        },
        async addTimelineEntry(slug: string, entry: unknown) {
          timelineCalls.push({ slug, entry });
          if (opts?.failTimeline) throw new Error('timeline failed');
        },
        async addLink(from: string, to: string, context: string, linkType?: string) {
          linkCalls.push({ from, to, context, linkType });
          if (opts?.failLink) throw new Error('link failed');
        },
      } as any;

      return { engine, putCalls, timelineCalls, linkCalls };
    }

    test('create path: builds new page, timeline, and backlink with source-aware mention signals', async () => {
      const { engine, putCalls, timelineCalls, linkCalls } = makeEngineMock({
        searchSlugs: [
          'people/alice',
          'companies/acme',
          'meetings/board-sync',
          'media/articles/one',
          'sources/book-notes',
          'ideas/new-thesis',
          'voice-notes/daily',
          'misc/random',
        ],
      });

      const result = await enrichEntity(engine, {
        entityName: 'Jane Doe',
        entityType: 'person',
        context: 'mentioned in board recap',
        sourceSlug: 'meetings/board-sync',
      });

      expect(result.slug).toBe('people/jane-doe');
      expect(result.action).toBe('created');
      expect(result.mentionCount).toBe(8);
      expect(result.tier).toBe(1);
      expect(result.timelineAdded).toBe(true);
      expect(result.backlinkCreated).toBe(true);
      expect(result.mentionSources.sort()).toEqual(
        ['brain-ops', 'enrich', 'idea-ingest', 'media-ingest', 'meeting-ingestion', 'voice-note'].sort(),
      );
      expect(putCalls).toHaveLength(1);
      expect(timelineCalls).toHaveLength(1);
      expect(linkCalls).toHaveLength(1);
      expect(linkCalls[0]?.linkType).toBe('mentions');
      const page = putCalls[0]?.page as { compiled_truth?: string };
      expect(page?.compiled_truth).toContain('**Type:** Person');
    });

    test('update path: skips create and tolerates timeline/link insertion failures', async () => {
      const { engine, putCalls } = makeEngineMock({
        existingSlugs: ['companies/acme'],
        failTimeline: true,
        failLink: true,
      });

      const result = await enrichEntity(engine, {
        entityName: 'Acme',
        entityType: 'company',
        context: 'mentioned in memo',
        sourceSlug: 'notes/memo',
      });

      expect(result.slug).toBe('companies/acme');
      expect(result.action).toBe('updated');
      expect(result.timelineAdded).toBe(false);
      expect(result.backlinkCreated).toBe(false);
      expect(putCalls).toHaveLength(0);
    });

    test('explicit tier stays fixed; tierEscalated reflects higher suggested priority', async () => {
      const { engine } = makeEngineMock({
        searchSlugs: ['people/a', 'people/b', 'people/c', 'people/d', 'people/e', 'people/f', 'people/g', 'people/h'],
      });

      const result = await enrichEntity(engine, {
        entityName: 'Priority Person',
        entityType: 'person',
        context: 'mentioned often',
        sourceSlug: 'meetings/review',
        tier: 3,
      });

      expect(result.suggestedTier).toBe(1);
      expect(result.tier).toBe(3);
      expect(result.tierEscalated).toBe(true);
    });

    test('enrichEntities processes batch and emits progress callback', async () => {
      const { engine } = makeEngineMock();
      const progress: string[] = [];

      const results = await enrichEntities(engine, [
        { entityName: 'Jane Doe', entityType: 'person', context: 'ctx1', sourceSlug: 'notes/one' },
        { entityName: 'Acme Corp', entityType: 'company', context: 'ctx2', sourceSlug: 'notes/two' },
      ], {
        throttle: false,
        onProgress(done, total, name) {
          progress.push(`${done}/${total}:${name}`);
        },
      });

      expect(results).toHaveLength(2);
      expect(progress).toEqual(['1/2:Jane Doe', '2/2:Acme Corp']);
    });

    test('extractAndEnrich short-circuits when no entities are detected', async () => {
      const { engine, putCalls } = makeEngineMock();
      const results = await extractAndEnrich(engine, 'all lowercase text with no names', 'notes/empty');
      expect(results).toEqual([]);
      expect(putCalls).toHaveLength(0);
    });
  });
});
