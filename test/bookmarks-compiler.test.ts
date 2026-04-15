import { describe, test, expect } from 'bun:test';
import { buildBookmarkPages } from '../src/bookmarks/compiler.ts';

const dataset = {
  id: 'karpathy-kb-cluster',
  title: 'Karpathy LLM Knowledge Base Cluster',
  description: 'Seed collection of bookmarked X posts about agent knowledge bases.',
  sourceType: 'x',
  sourcePath: '/tmp/source.json',
  threadPath: '/tmp/threads.json',
};

describe('bookmark compiler', () => {
  test('builds subject-first pages instead of source-format directories', () => {
    const pages = buildBookmarkPages(
      dataset,
      {
        results: [
          {
            targetUrl: 'https://x.com/karpathy/status/2039805659525644595',
            tweetId: '2039805659525644595',
            normalized: {
              createdAt: 'Thu Apr 02 20:42:21 +0000 2026',
              text: 'LLM Knowledge Bases. I use Obsidian as the frontend for a markdown wiki.',
              author: {
                handle: 'karpathy',
                name: 'Andrej Karpathy',
              },
            },
          },
          {
            targetUrl: 'https://x.com/kepano/status/2039819092035780633',
            tweetId: '2039819092035780633',
            normalized: {
              createdAt: 'Thu Apr 02 21:35:44 +0000 2026',
              text: 'More and more people are using Obsidian as a local wiki. @karpathy',
              author: {
                handle: 'kepano',
                name: 'kepano',
              },
            },
          },
        ],
      },
      [
        {
          rootId: '2039819092035780633',
          thread: [
            {
              id: '2039819457720430919',
              url: 'https://x.com/kepano/status/2039819457720430919',
              text: 'Obsidian Web Clipper and CLI matter.',
            },
          ],
        },
      ],
      { generatedAt: '2026-04-15' },
    );

    const paths = pages.map((page) => page.path).sort();
    expect(paths).toContain('people/karpathy.md');
    expect(paths).toContain('people/kepano.md');
    expect(paths).toContain('concepts/obsidian-workflow.md');
    expect(paths).toContain('concepts/llm-wikis.md');
    expect(paths).toContain('collections/karpathy-llm-knowledge-base-cluster.md');
    expect(paths.some((page) => page.startsWith('10 Sources/'))).toBeFalse();
    expect(paths.some((page) => page.startsWith('15 Authors/'))).toBeFalse();
  });

  test('emits markdown links and inline source citations', () => {
    const pages = buildBookmarkPages(
      dataset,
      {
        results: [
          {
            targetUrl: 'https://x.com/kepano/status/2039819092035780633',
            tweetId: '2039819092035780633',
            normalized: {
              createdAt: 'Thu Apr 02 21:35:44 +0000 2026',
              text: 'More and more people are using Obsidian as a local wiki to read things your agents are researching and writing. @karpathy',
              author: {
                handle: 'kepano',
                name: 'kepano',
              },
            },
          },
        ],
      },
      [],
      { generatedAt: '2026-04-15' },
    );

    const conceptPage = pages.find((page) => page.path === 'concepts/obsidian-workflow.md');
    expect(conceptPage).toBeTruthy();
    expect(conceptPage!.content).toContain('[kepano](../people/kepano.md)');
    expect(conceptPage!.content).toContain('[karpathy](../people/karpathy.md)');
    expect(conceptPage!.content).toContain('[Source: X, https://x.com/kepano/status/2039819092035780633]');
    expect(conceptPage!.content).toContain('## Timeline');
  });

  test('normalizes handles with leading or trailing underscores', () => {
    const pages = buildBookmarkPages(
      dataset,
      {
        results: [
          {
            targetUrl: 'https://x.com/_avichawla/status/2041798871383441807',
            tweetId: '2041798871383441807',
            normalized: {
              createdAt: 'Thu Apr 09 18:11:00 +0000 2026',
              text: 'Compiled wiki as persistent memory.',
              author: {
                handle: '_avichawla',
                name: 'Avi Chawla',
              },
            },
          },
          {
            targetUrl: 'https://x.com/VibeMarketer_/status/2042226854271099342',
            tweetId: '2042226854271099342',
            normalized: {
              createdAt: 'Fri Apr 10 22:00:00 +0000 2026',
              text: 'follow-up resource link',
              author: {
                handle: 'VibeMarketer_',
                name: 'Vibe Marketer',
              },
            },
          },
        ],
      },
      [],
      { generatedAt: '2026-04-15' },
    );

    const paths = pages.map((page) => page.path);
    expect(paths).toContain('people/avichawla.md');
    expect(paths).toContain('people/vibemarketer.md');
    expect(paths).not.toContain('people/-avichawla.md');
    expect(paths).not.toContain('people/vibemarketer-.md');
  });
});
