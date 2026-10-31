/**
 * #7175: a rare exact phrase in one chunk of a long page ranked below short pages that merely repeat the
 * phrase's words, in keyword mode too, because ts_rank has no phrase term. With the opt-in search.keyword_phrase,
 * the keyword arm multiplies a chunk that matches the query as a phrase (KEYWORD_PHRASE_FACTOR). Off by default.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { buildKeywordPagesStatement } from '../../src/core/search/keyword-statement.ts';
import { operationsByName } from '../../src/core/operations.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';

let engine: PGLiteEngine;
const filler = (i: number) => 'Speaker ' + (i % 2 + 1) + ': we went over the agenda, the budget review, the hiring plan and the offsite schedule for item ' + i + '. '.repeat(1);
const long = Array.from({ length: 120 }, (_, i) => filler(i) + filler(i + 1) + filler(i + 2)).join('\n\n')
  + '\n\nSpeaker 2: one last thing, the copper lantern protocol is what we agreed for the vendor handoff.';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();
  await importFromContent(engine, 'meetings/2026-01-05-acme-example-sync', '---\ntype: meeting\ntitle: Weekly sync\n---\n' + long, { noEmbed: true });
  for (let i = 0; i < 6; i++) {
    await importFromContent(engine, 'notes/inventory-' + i, '# Inventory ' + i + '\nCopper wire, copper pipe, a lantern, another lantern. The shipping protocol and the storage protocol. Copper again, lantern again, protocol again.', { noEmbed: true });
  }
}, 120_000);
afterAll(async () => { if (engine) await engine.disconnect(); });

describe('#7175 keyword phrase factor', () => {
  test('opted in, the keyword arm ranks the chunk holding the exact phrase first', async () => {
    const rows = await engine.searchKeyword('copper lantern protocol', { limit: 10, keywordPhrase: true });
    expect(rows[0]?.slug).toBe('meetings/2026-01-05-acme-example-sync');
  });

  test('opted in, keyword mode (match: keyword pages) ranks it first too', async () => {
    const st = buildKeywordPagesStatement('copper lantern protocol', { keywordPhrase: true }, { limit: 10 })!;
    const rows = await engine.executeRaw<{ slug: string }>(st.sql, st.params);
    expect(rows[0]?.slug).toBe('meetings/2026-01-05-acme-example-sync');
  });

  test('off by default; search.keyword_phrase true turns it on through match: keyword', async () => {
    const off = await engine.searchKeyword('copper lantern protocol', { limit: 10 });
    expect(off[0]?.slug.startsWith('notes/inventory-')).toBe(true);
    const ctx = { engine, remote: false, sourceId: 'default', config: { engine: 'pglite', embedding_disabled: true }, dryRun: false,
      logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
    const byDefault = await operationsByName.search.handler(ctx, { query: 'copper lantern protocol', match: 'keyword' }) as Array<{ slug: string }>;
    expect(byDefault[0]?.slug.startsWith('notes/inventory-')).toBe(true);
    await engine.setConfig('search.keyword_phrase', 'true');
    try {
      const rows = await operationsByName.search.handler(ctx, { query: 'copper lantern protocol', match: 'keyword' }) as Array<{ slug: string }>;
      expect(rows[0]?.slug).toBe('meetings/2026-01-05-acme-example-sync');
    } finally { await engine.setConfig('search.keyword_phrase', 'false'); }
  });

  test('a one-word query keeps its order: every match gets the same factor', async () => {
    const rows = await engine.searchKeyword('lantern', { limit: 10, keywordPhrase: true });
    expect(rows[0]?.slug.startsWith('notes/inventory-')).toBe(true);
  });
});
