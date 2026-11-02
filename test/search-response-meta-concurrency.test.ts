/**
 * #6721: the independent reads behind a search's response meta run at once.
 *
 * 1. Protects: on a pooled Postgres the safe-index check, projection
 *    readiness, saved-fact match and held-file coverage cost one round trip
 *    of wall time, not one each.
 * 2. Fails when: buildRetrievalResponseMeta awaits those reads one after
 *    another again (the saved-fact probe would only start once the
 *    safe-index statement has answered).
 * 3. Existing coverage: test/dispatch-response-meta.serial.test.ts and
 *    test/search-other-names.test.ts pin what the meta says, not when its
 *    reads are issued.
 * 4. Seam: none. Statement start and finish are observed on the PGLite
 *    handle the engine uses; a remote search through dispatch drives them.
 *    Contributed by @troyhoffman-oss (#6734).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { serializeMarkdown } from '../src/core/markdown.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';

let engine: PGLiteEngine;
const events: Array<{ at: 'start' | 'end'; sql: string }> = [];
let failSafeIndex = false;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await importFromContent(engine, 'notes/widget-renewal', serializeMarkdown({}, 'Widget renewal terms are net 30.', '', { type: 'note', title: 'Widget renewal', tags: [] }), { noEmbed: true, forceRechunk: true });
  await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source) VALUES
    ('default', 'widget-co', 'Widget-co renewal terms moved to net 45.', 'fact', 'world', 'user update')`);
  const db = engine.db as unknown as { query: (sql: string, ...rest: unknown[]) => Promise<unknown> };
  const query = db.query.bind(db);
  db.query = (sql: string, ...rest: unknown[]) => {
    const text = sql.replace(/\s+/g, ' ').trim();
    events.push({ at: 'start', sql: text });
    if (failSafeIndex && text.includes('AND p.chunker_version <')) return Promise.reject(new Error('safe-index sentinel'));
    return query(sql, ...rest).finally(() => events.push({ at: 'end', sql: text }));
  };
}, 120_000);

afterAll(async () => {
  await engine?.disconnect();
});

describe('search response meta', () => {
  test('the saved-fact match is issued before the safe-index check has answered', async () => {
    events.length = 0;
    const r = await dispatchToolCall(engine, 'search', { query: 'widget renewal terms' }, { remote: true, transport: 'http', sourceId: 'default' });
    expect(r.isError).toBeFalsy();
    const safeIndexEnd = events.findIndex(e => e.at === 'end' && e.sql.includes('AND p.chunker_version <'));
    // The saved-fact match's first statement (its existence probe, or the match itself once the probe is gone).
    const factProbeStart = events.findIndex(e => e.at === 'start' && /^(SELECT|WITH) .*\bFROM facts f(, k)? WHERE f\.source_id = ANY\(\$1::text\[\]\)/.test(e.sql));
    expect(safeIndexEnd).toBeGreaterThan(-1);
    expect(factProbeStart).toBeGreaterThan(-1);
    expect(factProbeStart).toBeLessThan(safeIndexEnd);
    // Same answer as before: the saved fact is still reported beside the results.
    expect(r.content.slice(1).map(c => c.text ?? '').join('\n')).toContain('Widget-co renewal terms moved to net 45.');
  });

  test('a failing read keeps to its own catch: the others still answer', async () => {
    failSafeIndex = true;
    try {
      const r = await dispatchToolCall(engine, 'search', { query: 'widget renewal terms' }, { remote: true, transport: 'http', sourceId: 'default' });
      expect(r.isError).toBeFalsy();
      expect(events.some(e => e.sql.includes('AND p.chunker_version <'))).toBe(true);
      expect(r.content.slice(1).map(c => c.text ?? '').join('\n')).toContain('Widget-co renewal terms moved to net 45.');
    } finally {
      failSafeIndex = false;
    }
  });
});
