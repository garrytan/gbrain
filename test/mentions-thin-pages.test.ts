/**
 * Mention resolution against thin pages: frontmatter handles and aliases are
 * explicit claims, a bare first name never links a person alone.
 *
 * Protects: an X handle in frontmatter links only where the text writes
 * `@handle`; a placeholder handle (`unknown`, `0`) is no handle; a page of
 * another kind titled with the handle keeps its title; two pages claiming one
 * handle link neither through it; a one-word person title that is another
 * person's first name links nothing, while a one-word person title nobody
 * shares and a one-word company title still link. Regression: a handle or
 * nickname mention landing on a thin page whose title is the handle or
 * nickname; a bare first name linking to a thin first-name page; a page retired
 * into another (merged_into, superseded_by, canonical: false) keeping its names.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildGazetteer, findMentionedEntities, frontmatterHandle } from '../src/core/by-mention.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { serializeMarkdown } from '../src/core/markdown.ts';
import { mentionBrain, resetMentionBrain } from './helpers/mention-brain.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = await mentionBrain(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetMentionBrain(engine); });

const put = (slug: string, type: string, title: string, frontmatter: Record<string, unknown> = {}) =>
  importFromContent(engine, slug, serializeMarkdown(frontmatter, 'Stub.', '', { type: type as never, title, tags: [] }), { noEmbed: true });

async function links(text: string): Promise<string[]> {
  const gazetteer = await buildGazetteer(engine);
  return findMentionedEntities(text, gazetteer, { fromSlug: 'notes/x', fromSourceId: 'default' }).map(m => m.slug);
}

describe('frontmatterHandle', () => {
  test('reads a handle, an @handle and an X or Twitter profile URL', () => {
    expect(frontmatterHandle('@AliceTweets')).toBe('alicetweets');
    expect(frontmatterHandle(' alice_t ')).toBe('alice_t');
    expect(frontmatterHandle('https://x.com/alicetweets')).toBe('alicetweets');
    expect(frontmatterHandle('twitter.com/alicetweets?lang=en')).toBe('alicetweets');
  });
  test('placeholders, ids and prose are not handles', () => {
    for (const v of ['unknown', 'Unknown', 'none', 'n/a', '0', '000', '12345', '', '  ', 'Alice Example', 'a-very-long-handle-name', 'true', 'false']) {
      expect(frontmatterHandle(v)).toBeNull();
    }
    expect(frontmatterHandle(null)).toBeNull();
  });
});

describe('frontmatter handles', () => {
  test('a handle links where the text writes @handle, not as a bare word', async () => {
    await put('people/alice-example', 'person', 'Alice Example', { x_handle: 'alicetweets' });
    expect(await links('A thread from @alicetweets.')).toEqual(['people/alice-example']);
    expect(await links('alicetweets is a made-up word here.')).toEqual([]);
  });

  test('a thin person page titled with the handle yields it, @handle or bare', async () => {
    await put('people/alice-example', 'person', 'Alice Example', { twitter: '@alicetweets' });
    await put('people/alicetweets', 'person', 'alicetweets');
    expect(await links('A thread from @alicetweets.')).toEqual(['people/alice-example']);
    expect(await links('Quoted alicetweets again.')).toEqual(['people/alice-example']);
  });

  test('a placeholder handle is no handle', async () => {
    await put('people/alice-example', 'person', 'Alice Example', { x_handle: 'unknown' });
    expect(await links('Owner: @unknown.')).toEqual([]);
  });

  test('a company titled with a person\'s handle keeps its title; @handle reaches the person', async () => {
    await put('people/alice-example', 'person', 'Alice Example', { x_handle: 'quorvex' });
    await put('companies/quorvex', 'company', 'Quorvex');
    expect(await links('Quorvex shipped.')).toEqual(['companies/quorvex']);
    expect(await links('Shipped, says @quorvex.')).toEqual(['people/alice-example']);
  });

  test('two pages claiming one handle: neither links through it and the thin page keeps its title', async () => {
    await put('people/alice-example', 'person', 'Alice Example', { x_handle: 'sharedhandle' });
    await put('people/bob-example', 'person', 'Bob Example', { x_handle: 'sharedhandle' });
    await put('people/sharedhandle', 'person', 'sharedhandle');
    expect(await links('From @sharedhandle.')).toEqual(['people/sharedhandle']);
  });
});

describe('frontmatter aliases and bare first names', () => {
  test('a thin person page titled with another person\'s frontmatter alias yields it', async () => {
    await put('people/alice-example', 'person', 'Alice Example', { aliases: ['Ally'] });
    await put('people/ally', 'person', 'Ally');
    expect(await links('Ally sent the deck.')).toEqual(['people/alice-example']);
  });

  test('a page claiming its own title keeps it', async () => {
    await put('people/alice-example', 'person', 'Alice Example', { aliases: ['Ally'] });
    await put('people/ally', 'person', 'Ally', { aliases: ['Ally'] });
    expect(await links('Ally sent the deck.')).toEqual(['people/ally']);
  });

  test('a one-word person title that is another person\'s first name links nothing', async () => {
    await put('people/alice-example', 'person', 'Alice Example');
    await put('people/alice', 'person', 'Alice');
    expect(await links('Lunch with Alice.')).toEqual([]);
    expect(await links('Lunch with Alice Example.')).toEqual(['people/alice-example']);
  });

  test('a one-word person title nobody shares, and a one-word company title, still link', async () => {
    await put('people/alice-example', 'person', 'Alice Example');
    await put('people/zorbinsky', 'person', 'Zorbinsky');
    await put('companies/alice', 'company', 'Alice');
    expect(await links('Zorbinsky called.')).toEqual(['people/zorbinsky']);
    expect(await links('Alice the company called.')).toEqual(['companies/alice']);
  });

  test('a one-word person title keeps linking when only its own alias starts with it', async () => {
    await put('people/zorbinsky', 'person', 'Zorbinsky', { aliases: ['Zorbinsky Example'] });
    expect(await links('Zorbinsky called.')).toEqual(['people/zorbinsky']);
  });

  test('a thin title keeps its name when the claimant alias is dropped by a later guard', async () => {
    await put('companies/acme', 'company', 'Acme');
    await put('companies/acme-holdings', 'company', 'Acme Holdings', { aliases: ['Acme'] });
    expect(await links('We met Acme today.')).toEqual(['companies/acme']);
  });

  test('a YAML boolean in a handle field is no handle', async () => {
    await put('people/alice-example', 'person', 'Alice Example', { x: true });
    expect(await links('Posted by @true today.')).toEqual([]);
  });
});

describe('retired pages', () => {
  test('a page retired into another (merged_into) collects no mentions, even with the same alias and handle', async () => {
    await put('people/alice-example', 'person', 'Alice Example', { aliases: ['Ally'], x_handle: 'allytweets' });
    await put('people/ally', 'person', 'Ally', { aliases: ['Ally'], x_handle: 'allytweets', merged_into: 'people/alice-example' });
    expect(await links('Ally sent the deck.')).toEqual(['people/alice-example']);
    expect(await links('A thread from @allytweets.')).toEqual(['people/alice-example']);
  });

  test('a superseded or non-canonical page keeps no title entry of its own', async () => {
    await put('people/alice-example', 'person', 'Alice Example');
    await put('people/alice-q-example', 'person', 'Alice Q Example', { superseded_by: 'people/alice-example' });
    await put('people/alice-r-example', 'person', 'Alice R Example', { canonical: false });
    expect(await links('Met Alice Q Example and Alice R Example.')).toEqual([]);
    expect(await links('Met Alice Example.')).toEqual(['people/alice-example']);
  });
});

