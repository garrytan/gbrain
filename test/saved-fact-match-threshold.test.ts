/**
 * #6721: the saved-fact match applies its three-quarters-of-the-words
 * threshold and its ranking in the statement, not after a 200-row recency cap.
 *
 * 1. Protects: a saved fact that shares enough of the query's words is found
 *    even when more than 200 newer facts share just one of them, and facts
 *    sharing more of the words still rank first.
 * 2. Fails when: the threshold moves back after the cap (the qualifying fact
 *    is the 201st any-word match and is dropped), the in-statement threshold
 *    stops admitting facts that meet it, or the ranking stops putting more
 *    shared words ahead of recency.
 * 3. Existing coverage: test/search-other-names.test.ts and
 *    test/facts-arms-remote-private-pages.test.ts find a saved fact among a
 *    handful of rows; none had more than 200 any-word matches.
 * 4. Seam: none. A remote search through dispatch, as an MCP client sends it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';

let engine: PGLiteEngine;

async function savedFactsText(query: string): Promise<string> {
  const r = await dispatchToolCall(engine, 'search', { query }, { remote: true, transport: 'http', sourceId: 'default' });
  expect(r.isError).toBeFalsy();
  return r.content.slice(1).map(c => c.text ?? '').join('\n');
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // 205 recent facts share one query word ("renewal"); the only fact sharing all three is older than all of them.
  await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, valid_from)
    SELECT 'default', 'filler-' || g, 'Filler note ' || g || ' mentions a renewal reminder.', 'fact', 'world', 'user update', now() - interval '1 day'
    FROM generate_series(1, 205) g`);
  await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, valid_from) VALUES
    ('default', 'widget-co', 'Widget-co moved its renewal date to March.', 'fact', 'world', 'user update', now() - interval '30 days')`);
}, 120_000);

afterAll(async () => {
  await engine?.disconnect();
});

describe('saved-fact match threshold', () => {
  test('a qualifying fact older than 200 newer one-word matches is found', async () => {
    expect(await savedFactsText('widget renewal march')).toContain('Widget-co moved its renewal date to March.');
  });

  test('facts sharing too few of the query words are still left out', async () => {
    expect(await savedFactsText('widget renewal march')).not.toContain('Filler note');
  });

  test('a fact sharing more of the words ranks ahead of a newer one sharing fewer', async () => {
    await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, valid_from) VALUES
      ('default', 'gadget-co', 'Gadget-co billing moved to quarterly invoices in April.', 'fact', 'world', 'user update', now() - interval '60 days'),
      ('default', 'gadget-co', 'Gadget-co billing moved to quarterly terms.', 'fact', 'world', 'user update', now() - interval '2 days')`);
    const text = await savedFactsText('gadget-co billing quarterly invoices');
    const older = text.indexOf('quarterly invoices in April');
    const newer = text.indexOf('quarterly terms');
    expect(older).toBeGreaterThan(-1);
    expect(newer).toBeGreaterThan(older);
  });
});
