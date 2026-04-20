import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import {
  ACTION_DRAFT_CONTEXT_MAX_CHARS,
  ACTION_DRAFT_CONTEXT_PAGE_EXCERPT_MAX_CHARS,
  ACTION_DRAFT_CONTEXT_PAGE_LIMIT,
  buildActionDraftContextSource,
} from '../../src/action-brain/context-source.ts';

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

describe('buildActionDraftContextSource', () => {
  test('returns at most 3 entity slugs from keyword lookup', async () => {
    const engine = createEngine({
      searchKeyword: async () => [
        { slug: 'concepts/ignore' },
        { slug: 'people/alice' },
        { slug: 'people/alice' },
        { slug: 'companies/nova' },
        { slug: 'people/bob' },
        { slug: 'people/charlie' },
      ],
      getPage: async (slug) => ({ compiled_truth: `compiled truth for ${slug}` }),
    });

    const context = await buildActionDraftContextSource(engine, {
      source_contact: 'Alice',
      source_thread: '',
    });

    expect(context.gbrain_page_slugs.length).toBe(ACTION_DRAFT_CONTEXT_PAGE_LIMIT);
    expect(context.gbrain_page_slugs).toEqual(['people/alice', 'companies/nova', 'people/bob']);
    expect(context.excerpts.map((excerpt) => excerpt.slug)).toEqual(context.gbrain_page_slugs);
  });

  test('truncates compiled_truth excerpts to exactly 800 chars', async () => {
    const engine = createEngine({
      searchKeyword: async () => [{ slug: 'people/alice' }],
      getPage: async () => ({
        compiled_truth: `${'x'.repeat(ACTION_DRAFT_CONTEXT_PAGE_EXCERPT_MAX_CHARS)}TAIL`,
      }),
    });

    const context = await buildActionDraftContextSource(engine, {
      source_contact: 'Alice',
      source_thread: '',
    });

    expect(context.excerpts[0]?.text.length).toBe(ACTION_DRAFT_CONTEXT_PAGE_EXCERPT_MAX_CHARS);
    expect(context.excerpts[0]?.text).not.toContain('TAIL');
  });

  test('caps combined context at 4000 chars by dropping oldest thread messages first and preserving excerpts', async () => {
    const engine = createEngine({
      searchKeyword: async () => [{ slug: 'people/alice' }, { slug: 'people/bob' }, { slug: 'people/carol' }],
      getPage: async (slug) => ({
        compiled_truth: `${slug}:${'x'.repeat(1000)}`,
      }),
    });

    const context = await buildActionDraftContextSource(
      engine,
      {
        source_contact: 'Alice',
        source_thread: 'ops-thread',
      },
      {
        threadMessages: [
          { sender: 'Oldest', ts: '2026-04-20T08:00:00.000Z', text: `oldest-${'a'.repeat(1000)}` },
          { sender: 'Middle', ts: '2026-04-20T09:00:00.000Z', text: `middle-${'b'.repeat(1000)}` },
          { sender: 'Newest', ts: '2026-04-20T10:00:00.000Z', text: `newest-${'c'.repeat(1000)}` },
        ],
      }
    );

    const excerptChars = context.excerpts.reduce((sum, excerpt) => sum + excerpt.text.length, 0);
    const threadChars = context.thread.reduce((sum, message) => sum + message.text.length, 0);

    expect(excerptChars + threadChars).toBeLessThanOrEqual(ACTION_DRAFT_CONTEXT_MAX_CHARS);
    expect(context.gbrain_page_slugs).toEqual(['people/alice', 'people/bob', 'people/carol']);
    expect(context.thread[0]?.sender).not.toBe('Oldest');
    expect(context.thread.some((message) => message.text.includes('newest-'))).toBe(true);
  });

  test('returns empty gbrain arrays cleanly when gbrain is unavailable', async () => {
    const engine = createEngine({
      searchKeyword: async () => {
        throw new Error('gbrain unavailable');
      },
    });

    const context = await buildActionDraftContextSource(
      engine,
      {
        source_contact: 'Alice',
        source_thread: 'ops-thread',
      },
      {
        threadMessages: [{ sender: 'Ops', ts: '2026-04-20T10:00:00.000Z', text: 'Any update?' }],
      }
    );

    expect(context.gbrain_page_slugs).toEqual([]);
    expect(context.excerpts).toEqual([]);
    expect(context.thread).toEqual([{ sender: 'Ops', ts: '2026-04-20T10:00:00.000Z', text: 'Any update?' }]);
  });

  test('context_hash is stable across identical inputs', async () => {
    const engine = createEngine({
      searchKeyword: async () => [{ slug: 'people/alice' }, { slug: 'companies/nova' }],
      getPage: async (slug) => ({ compiled_truth: `truth-${slug}` }),
    });

    const input = {
      source_contact: 'Alice',
      source_thread: 'ops-thread',
    };
    const options = {
      threadMessages: [
        { sender: 'Alice', ts: '2026-04-20T10:00:00.000Z', text: 'Any update?' },
        { sender: 'Abhi', ts: '2026-04-20T10:05:00.000Z', text: 'Will share by EOD.' },
      ],
    };

    const first = await buildActionDraftContextSource(engine, input, options);
    const second = await buildActionDraftContextSource(engine, input, options);

    expect(first.context_hash).toBe(second.context_hash);
    expect(first).toEqual(second);
  });

  test('context_hash changes when thread content changes', async () => {
    const engine = createEngine({
      searchKeyword: async () => [{ slug: 'people/alice' }],
      getPage: async (slug) => ({ compiled_truth: `truth-${slug}` }),
    });

    const input = {
      source_contact: 'Alice',
      source_thread: 'ops-thread',
    };

    const base = await buildActionDraftContextSource(engine, input, {
      threadMessages: [{ sender: 'Alice', ts: '2026-04-20T10:00:00.000Z', text: 'message one' }],
    });
    const changed = await buildActionDraftContextSource(engine, input, {
      threadMessages: [
        { sender: 'Alice', ts: '2026-04-20T10:00:00.000Z', text: 'message one' },
        { sender: 'Alice', ts: '2026-04-20T10:01:00.000Z', text: 'message two' },
      ],
    });

    expect(changed.context_hash).not.toBe(base.context_hash);
  });
});
