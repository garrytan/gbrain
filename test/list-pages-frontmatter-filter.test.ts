/**
 * `listPages({ frontmatterEq })` — exact match on any frontmatter field.
 *
 * Fields a source sets beyond the promoted columns (type/title/tags/slug) live
 * in the `frontmatter` JSONB. They were stored and GIN-indexed but no filter
 * reached them, so a chat-export source's `channel_id` could not answer "list
 * every note from this channel" — you had to already know the slug.
 *
 * Runs against a real PGLite engine, not a mock: the point is the SQL.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;

const CHANNEL = 'C0EXAMPLE1';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  const seed = async (slug: string, fm: Record<string, unknown>) => {
    await engine.putPage(slug, {
      type: 'note' as never,
      title: slug,
      compiled_truth: `Content of ${slug}`,
      timeline: '',
      frontmatter: fm,
    });
  };
  await seed('notes/a', { channel_id: CHANNEL, channel: 'ai-tools' });
  await seed('notes/b', { channel_id: CHANNEL, channel: 'ai-tools' });
  await seed('notes/c', { channel_id: 'C0EXAMPLE2', channel: 'engineering' });
  await seed('notes/d', {}); // no such field at all
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

describe('listPages frontmatterEq', () => {
  test('returns exactly the pages whose field equals the value', async () => {
    const pages = await engine.listPages({ frontmatterEq: { key: 'channel_id', value: CHANNEL } });
    expect(pages.map((p) => p.slug).sort()).toEqual(['notes/a', 'notes/b']);
  });

  test('a value nobody has returns nothing, not everything', async () => {
    // The failure that matters: a filter silently degrading to "no filter"
    // looks like a working query that returns the whole brain.
    const pages = await engine.listPages({ frontmatterEq: { key: 'channel_id', value: 'C0NOBODY' } });
    expect(pages).toEqual([]);
    const missingField = await engine.listPages({ frontmatterEq: { key: 'nope', value: 'x' } });
    expect(missingField).toEqual([]);
  });

  test('composes with the other filters instead of replacing them', async () => {
    const pages = await engine.listPages({
      frontmatterEq: { key: 'channel', value: 'ai-tools' },
      slugPrefix: 'notes/a',
    });
    expect(pages.map((p) => p.slug)).toEqual(['notes/a']);
  });

  test('the key is bound as a parameter, not spliced into SQL', async () => {
    // If the key were interpolated this would be a syntax error or worse.
    const pages = await engine.listPages({
      frontmatterEq: { key: "x' OR '1'='1", value: 'anything' },
    });
    expect(pages).toEqual([]);
  });

  test('omitting the filter still lists everything', async () => {
    const pages = await engine.listPages({});
    expect(pages.length).toBe(4);
  });
});
