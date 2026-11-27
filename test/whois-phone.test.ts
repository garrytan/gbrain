/**
 * whois by phone number (GST-3256): a phone-shaped query matches a page whose `phone` / `phones` value is the same
 * number in canonical form (phone-key.ts), however either side is written; never a partial number, never a name hit for
 * digits, and a remote caller never sees a private page by phone. Synthetic pages only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
afterAll(async () => { await engine.disconnect(); });

const page = (slug: string, title: string, frontmatter: Record<string, unknown>, sourceId = 'source-a') =>
  engine.putPage(slug, { type: 'person', title, compiled_truth: `${title}.`, timeline: '', frontmatter } as never, { sourceId } as never);
beforeEach(async () => {
  await resetPgliteState(engine);
  __resetPrivateVisibilityCacheForTests();
  await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('source-a','source-a'),('source-b','source-b') ON CONFLICT DO NOTHING");
  await page('people/alice-example', 'Alice Example', { phone: '(555) 555-0100' });
  await page('people/bob-example', 'Bob Example', { phones: ['+1 555-555-0101', '555.555.0102'] });
  await page('people/carol-example', 'Carol Example', { phones: ['+44 20 7946 0958'] }, 'source-b');
  await page('people/dana-example', 'Dana Example', { phone: '555-555-0103', visibility: 'private' });
  await page('people/erin-example', 'Erin Example', { phone: '555-555-0104' });
  await page('people/frank-example', 'Frank Example', { phone: '+1 (555) 555-0104' }, 'source-b');
});

const ctx = (overrides: Partial<OperationContext> = {}) => ({ engine, config: {}, logger: { info: () => {}, warn: () => {}, error: () => {} }, dryRun: false, remote: false, ...overrides }) as unknown as OperationContext;
const remote = () => ctx({ remote: true, transport: 'stdio', sourceId: 'source-a', auth: { allowedSources: ['source-a'] } as never });
interface Result { query_kind: string; matches: Array<{ slug: string; source_id: string; match: string }>; ambiguous: boolean }
const whois = async (c: OperationContext, query: string) => await operationsByName['whois']!.handler(c, { query }) as Result;
const hits = (r: Result) => r.matches.map(m => `${m.source_id}:${m.slug}:${m.match}`);

describe('whois by phone', () => {
  test.each([
    ['+1 555 555 0100'], ['555-555-0100'], ['(555) 555-0100'], ['15555550100'], ['+15555550100'], ['001 555 555 0100'],
  ])('%s finds the page holding the same number', async (query) => {
    const r = await whois(ctx(), query);
    expect(r.query_kind).toBe('phone');
    expect(hits(r)).toEqual(['source-a:people/alice-example:phone']);
  });

  test('every value of a phones list matches, and a number with its own country code matches across formats', async () => {
    expect(hits(await whois(ctx(), '555 555 0102'))).toEqual(['source-a:people/bob-example:phone']);
    expect(hits(await whois(ctx(), '+44 20 7946 0958'))).toEqual(['source-b:people/carol-example:phone']);
  });

  test('two pages with the number are ambiguous', async () => {
    const r = await whois(ctx(), '555-555-0104');
    expect(r.ambiguous).toBe(true);
    expect(hits(r).sort()).toEqual(['source-a:people/erin-example:phone', 'source-b:people/frank-example:phone']);
  });

  test('a partial number, the last digits or a different number never match', async () => {
    for (const query of ['555-0100', '0100', '5550100', '555-555-0109']) expect((await whois(ctx(), query)).matches).toEqual([]);
  });

  test('a remote caller never sees a private page or an ungranted source by phone', async () => {
    expect((await whois(remote(), '555-555-0103')).matches).toEqual([]);
    expect((await whois(remote(), '+44 20 7946 0958')).matches).toEqual([]);
    expect(hits(await whois(ctx(), '555-555-0103'))).toEqual(['source-a:people/dana-example:phone']);
  });
});
