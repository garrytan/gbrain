/**
 * #7164: on the chunk path a search/query row's text stops at
 * RESULT_CHUNK_CHARS with the snippet marker naming the read that returns the
 * rest; `snippet_chars: 0` returns the whole chunk. Evidence blocks (an implied
 * `auto` conversation or a long-page unit) keep their own budget and cap.
 * Keyword-only (search.mcp_keyword_only), PGLite, no provider.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { RESULT_CHUNK_CHARS } from '../src/core/search/snippet-cap.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { mcpCall } from './helpers/long-page-fixture.ts';
import { asOwner } from './helpers/owner-tier.ts';

const BIG_CHUNK = 'Old export. ' + 'The harbor ledger lists every pallet, the berth, the crane and the tally clerk for the shift. '.repeat(120);

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await asOwner(engine, tx => tx.putPage('notes/harbor-ledger', { type: 'note', title: 'Harbor ledger', compiled_truth: BIG_CHUNK, timeline: '', frontmatter: {} }));
  await installFixtureChunks(engine, 'notes/harbor-ledger', [{ chunk_index: 0, chunk_text: BIG_CHUNK, chunk_source: 'compiled_truth' as const }]);
}, 240_000);
afterAll(async () => { await engine?.disconnect(); }, 120_000);

describe('chunk path: one row returns at most RESULT_CHUNK_CHARS', () => {
  test('cut with the read marker; snippet_chars 0 returns the whole chunk', async () => {
    expect(BIG_CHUNK.length).toBeGreaterThan(RESULT_CHUNK_CHARS);
    for (const name of ['search', 'query'] as const) {
      const cut = (await mcpCall(engine, name, { query: 'harbor ledger pallet berth', ...(name === 'query' ? { expand: false } : {}) })).rows.find(r => r.slug === 'notes/harbor-ledger')!;
      expect((cut.chunk_text as string).startsWith(BIG_CHUNK.slice(0, RESULT_CHUNK_CHARS))).toBe(true);
      expect((cut.chunk_text as string).length).toBeLessThan(RESULT_CHUNK_CHARS + 200);
      expect(cut.chunk_text as string).toContain('get_page notes/harbor-ledger');
    }
    const whole = (await mcpCall(engine, 'search', { query: 'harbor ledger pallet berth', snippet_chars: 0 })).rows.find(r => r.slug === 'notes/harbor-ledger')!;
    expect(whole.chunk_text).toBe(BIG_CHUNK);
  });
});
