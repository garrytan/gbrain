import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import {
  ACTION_DRAFT_CONTEXT_MAX_CHARS,
  ACTION_DRAFT_CONTEXT_PAGE_EXCERPT_MAX_CHARS,
  ACTION_DRAFT_CONTEXT_PAGE_LIMIT,
  buildActionDraftContext,
} from '../../src/action-brain/context.ts';

interface MockPage {
  compiled_truth: string;
}

function createEngine(overrides: {
  searchKeyword?: (query: string) => Promise<Array<{ slug: string }>>;
  getPage?: (slug: string) => Promise<MockPage | null>;
} = {}): BrainEngine {
  const searchKeyword = overrides.searchKeyword ?? (async () => []);
  const getPage = overrides.getPage ?? (async () => null);

  return {
    searchKeyword: async (query: string) => searchKeyword(query),
    getPage: async (slug: string) => (await getPage(slug)) as any,
  } as BrainEngine;
}

describe('buildActionDraftContext', () => {
  test('bounds keyword lookup to at most 3 entity slugs', async () => {
    const getPageCalls: string[] = [];

    const engine = createEngine({
      searchKeyword: async () => [
        { slug: 'concepts/ignore' },
        { slug: 'people/alice' },
        { slug: 'people/alice' },
        { slug: 'companies/nova' },
        { slug: 'people/bob' },
        { slug: 'people/charlie' },
      ],
      getPage: async (slug) => {
        getPageCalls.push(slug);
        return {
          compiled_truth: `compiled truth for ${slug}`,
        };
      },
    });

    const context = await buildActionDraftContext(engine, {
      source_contact: 'Alice',
      source_thread: '',
    });

    expect(context.pages.length).toBe(ACTION_DRAFT_CONTEXT_PAGE_LIMIT);
    expect(context.pages.map((page) => page.slug)).toEqual(['people/alice', 'companies/nova', 'people/bob']);
    expect(getPageCalls).toEqual(['people/alice', 'companies/nova', 'people/bob']);
  });

  test('truncates each compiled_truth excerpt to 800 chars', async () => {
    const longTruth = `${'x'.repeat(ACTION_DRAFT_CONTEXT_PAGE_EXCERPT_MAX_CHARS)}TAIL`;
    const engine = createEngine({
      searchKeyword: async () => [{ slug: 'people/alice' }],
      getPage: async () => ({ compiled_truth: longTruth }),
    });

    const context = await buildActionDraftContext(engine, {
      source_contact: 'Alice',
      source_thread: '',
    });

    expect(context.pages[0]?.excerpt.length).toBe(ACTION_DRAFT_CONTEXT_PAGE_EXCERPT_MAX_CHARS);
    expect(context.pages[0]?.excerpt).not.toContain('TAIL');
  });

  test('caps combined context at 4000 chars by dropping oldest content first', async () => {
    const engine = createEngine({
      searchKeyword: async () => [{ slug: 'people/alice' }, { slug: 'people/bob' }, { slug: 'people/carol' }],
      getPage: async (slug) => ({ compiled_truth: `OLD-${slug}-${'x'.repeat(1700)}` }),
    });

    const context = await buildActionDraftContext(
      engine,
      {
        source_contact: 'Alice',
        source_thread: 'Ops Thread',
      },
      {
        threadMessages: [
          {
            id: 'm-1',
            sender: 'Alice',
            ts: '2026-04-20T08:00:00.000Z',
            text: `NEWEST-${'z'.repeat(2800)}`,
          },
        ],
      }
    );

    expect(context.context.length).toBeLessThanOrEqual(ACTION_DRAFT_CONTEXT_MAX_CHARS);
    expect(context.context).toContain('NEWEST-');
    expect(context.context).not.toContain('OLD-people/alice-');
  });

  test('returns empty gbrain context cleanly when gbrain lookup fails', async () => {
    const engine = createEngine({
      searchKeyword: async () => {
        throw new Error('gbrain down');
      },
    });

    const context = await buildActionDraftContext(engine, {
      source_contact: 'Alice',
      source_thread: '',
    });

    expect(context.gbrainAvailable).toBe(false);
    expect(context.pages).toEqual([]);
    expect(context.gbrainContext).toBe('');
    expect(context.context_snapshot.gbrain_page_slugs).toEqual([]);
    expect(context.context).toBe('');
  });

  test('produces stable context_hash across identical inputs', async () => {
    const engine = createEngine({
      searchKeyword: async () => [{ slug: 'people/alice' }, { slug: 'companies/nova' }],
      getPage: async (slug) => ({ compiled_truth: `truth-${slug}` }),
    });

    const source = {
      source_contact: 'Alice',
      source_thread: 'ops-thread',
    };
    const options = {
      threadMessages: [
        {
          id: 'msg-1',
          sender: 'Alice',
          ts: '2026-04-20T08:00:00.000Z',
          text: 'Any update on this?',
        },
        {
          id: 'msg-2',
          sender: 'Abhi',
          ts: '2026-04-20T09:00:00.000Z',
          text: 'Will share by EOD.',
        },
      ],
    };

    const first = await buildActionDraftContext(engine, source, options);
    const second = await buildActionDraftContext(engine, source, options);

    expect(first.context_hash).toBe(second.context_hash);
    expect(first.context_snapshot).toEqual(second.context_snapshot);
    expect(first.context).toBe(second.context);
  });
});
