import { describe, expect, test } from 'bun:test';
import {
  compileTweetPage,
  compileBatch,
  compileAuthorPage,
} from '../src/core/x/compile.ts';
import type { FetchTweetResult, ThreadResult, ThreadReply } from '../src/core/x/types.ts';

function makeFetchResult(overrides: Partial<FetchTweetResult> = {}): FetchTweetResult {
  return {
    targetUrl: 'https://x.com/karpathy/status/123',
    tweetId: '123',
    graphqlCaptured: true,
    graphqlError: null,
    normalized: {
      id: '123',
      url: 'https://x.com/karpathy/status/123',
      text: 'LLM knowledge bases are the future of personal memory',
      author: {
        id: 'u1',
        handle: 'karpathy',
        name: 'Andrej Karpathy',
        verified: true,
      },
      createdAt: 'Mon Jan 01 00:00:00 +0000 2024',
      metrics: {
        replies: 5,
        reposts: 10,
        likes: 50,
        quotes: 2,
        bookmarks: 3,
        views: '100000',
      },
      urls: [
        {
          url: 'https://t.co/abc',
          expandedUrl: 'https://example.com/article',
          displayUrl: 'example.com/article',
        },
      ],
      media: [],
    },
    pageState: {
      title: 'Post by @karpathy',
      hasLoggedOutReadRepliesPivot: false,
      visibleTweets: [],
    },
    ...overrides,
  };
}

describe('compileTweetPage', () => {
  test('compiles a tweet into a GBrain page', () => {
    const result = makeFetchResult();
    const page = compileTweetPage(result, []);

    expect(page).not.toBeNull();
    expect(page!.slug).toMatch(/^sources\/x\//);
    expect(page!.authorHandle).toBe('karpathy');
    expect(page!.authorName).toBe('Andrej Karpathy');

    // Check frontmatter
    expect(page!.content).toContain('type: source');
    expect(page!.content).toContain('source_type: x');
    expect(page!.content).toContain('tweet_id: "123"');
    expect(page!.content).toContain('author_handle: "karpathy"');
    expect(page!.content).toContain('source_url: "https://x.com/karpathy/status/123"');

    // Check body content
    expect(page!.content).toContain(
      'LLM knowledge bases are the future of personal memory',
    );
    expect(page!.content).toContain('[Source: @karpathy on X]');

    // Check metrics
    expect(page!.content).toContain('50 likes');
    expect(page!.content).toContain('10 reposts');

    // Check linked URLs (filters out x.com/twitter.com links)
    expect(page!.content).toContain('## Linked Resources');
    expect(page!.content).toContain('example.com/article');
  });

  test('includes thread continuations', () => {
    const result = makeFetchResult();
    const thread: ThreadReply[] = [
      {
        id: '124',
        url: 'https://x.com/karpathy/status/124',
        inReplyToStatusId: '123',
        text: 'Thread continuation: here is more context',
      },
    ];

    const page = compileTweetPage(result, thread);
    expect(page!.content).toContain('## Thread');
    expect(page!.content).toContain('Thread continuation: here is more context');
    expect(page!.content).toContain('thread_count: 1');
  });

  test('returns null for tombstone tweets', () => {
    const result = makeFetchResult({
      normalized: {
        id: '999',
        url: 'https://x.com/user/status/999',
        text: 'Unavailable',
        tombstone: true,
        author: { id: null, handle: null, name: null, verified: null },
      },
    });

    expect(compileTweetPage(result, [])).toBeNull();
  });

  test('returns null when normalized is null', () => {
    const result = makeFetchResult({ normalized: null });
    expect(compileTweetPage(result, [])).toBeNull();
  });

  test('uses title overrides', () => {
    const result = makeFetchResult();
    const page = compileTweetPage(result, [], {
      titleOverrides: { '123': 'Custom Title Here' },
    });

    expect(page!.content).toContain('# Custom Title Here');
  });

  test('generates unique slugs per author-title', () => {
    const r1 = makeFetchResult();
    const r2 = makeFetchResult({
      tweetId: '456',
      targetUrl: 'https://x.com/other/status/456',
      normalized: {
        ...makeFetchResult().normalized!,
        id: '456',
        text: 'Different content entirely',
        author: { id: 'u2', handle: 'other', name: 'Other User', verified: false },
      },
    });

    const p1 = compileTweetPage(r1, []);
    const p2 = compileTweetPage(r2, []);

    expect(p1!.slug).not.toBe(p2!.slug);
  });
});

describe('compileAuthorPage', () => {
  test('generates a person page stub', () => {
    const page = compileAuthorPage('karpathy', 'Andrej Karpathy');

    expect(page.slug).toBe('people/karpathy');
    expect(page.content).toContain('type: person');
    expect(page.content).toContain('# Andrej Karpathy');
    expect(page.content).toContain('[@karpathy on X]');
    expect(page.content).toContain('x_handle: "karpathy"');
  });

  test('uses handle as fallback name', () => {
    const page = compileAuthorPage('anonymous', null);
    expect(page.content).toContain('# anonymous');
  });
});

describe('compileBatch', () => {
  test('compiles multiple tweets and collects unique authors', () => {
    const results: FetchTweetResult[] = [
      makeFetchResult(),
      makeFetchResult({
        tweetId: '456',
        targetUrl: 'https://x.com/kepano/status/456',
        normalized: {
          ...makeFetchResult().normalized!,
          id: '456',
          text: 'Obsidian is great',
          author: { id: 'u3', handle: 'kepano', name: 'Steph Ango', verified: true },
        },
      }),
    ];

    const threads: ThreadResult[] = [
      { url: results[0].targetUrl, author: 'karpathy', rootId: '123', thread: [] },
      { url: results[1].targetUrl, author: 'kepano', rootId: '456', thread: [] },
    ];

    const { pages, authors } = compileBatch(results, threads);

    expect(pages).toHaveLength(2);
    expect(authors.size).toBe(2);
    expect(authors.has('karpathy')).toBe(true);
    expect(authors.has('kepano')).toBe(true);
  });

  test('attaches threads to correct root tweets', () => {
    const results = [makeFetchResult()];
    const threads: ThreadResult[] = [
      {
        url: results[0].targetUrl,
        author: 'karpathy',
        rootId: '123',
        thread: [
          {
            id: '124',
            url: 'https://x.com/karpathy/status/124',
            inReplyToStatusId: '123',
            text: 'Thread reply',
          },
        ],
      },
    ];

    const { pages } = compileBatch(results, threads);
    expect(pages[0].content).toContain('## Thread');
    expect(pages[0].content).toContain('Thread reply');
  });

  test('skips tombstone tweets', () => {
    const results = [
      makeFetchResult({
        normalized: {
          id: '999',
          url: 'https://x.com/user/status/999',
          text: 'Deleted',
          tombstone: true,
          author: { id: null, handle: null, name: null, verified: null },
        },
      }),
    ];

    const { pages } = compileBatch(results, []);
    expect(pages).toHaveLength(0);
  });
});
