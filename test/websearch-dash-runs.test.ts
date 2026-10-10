import { installFixtureChunks } from './helpers/page-projection.ts';
/**
 * A query holding a markdown rule or setext underline of 32+ dashes
 * (`-----...`, `- - - ...`) used to fail the keyword and title arms:
 * websearch_to_tsquery reads every dash as one more NOT and its operator
 * stack holds 32 entries (`tsquery stack too small`). Pasted passages hit it;
 * the eval readiness probe quotes the start of a session's longest turn, and
 * assistant turns open with `Section\n-----` headings.
 *
 * `collapseWebsearchDashRuns` collapses such a run to its parity (the tsquery
 * a deeper stack would build) and leaves every shorter run, so every query
 * that parses today, byte-identical. Real in-memory PGLite.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import * as SR from '../src/core/search/sql-ranking.ts';

let engine: PGLiteEngine;
const { boundWebsearchQuery } = SR as any; const collapseWebsearchDashRuns = (SR as any).collapseWebsearchDashRuns ?? ((q: string) => q); const MAX_WEBSEARCH_DASH_RUN = 31;
const parse = async (q: string) => (await engine.executeRaw<{ q: string }>(`SELECT websearch_to_tsquery('english', $1)::text AS q`, [q]))[0]!.q;
const RULE = '-'.repeat(73);
const PASSAGE = `Sure, here is an outline for the pandas module:\n\nTime series analysis using Pandas\n${RULE}\n\n### Background:\n\nAs a data analyst you review banking transaction data`;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.putPage('conversations/outline', { type: 'note', title: 'Time series analysis using Pandas', compiled_truth: PASSAGE });
  await installFixtureChunks(engine, 'conversations/outline', [{ chunk_index: 0, chunk_text: PASSAGE, chunk_source: 'compiled_truth' }]);
  await engine.putPage('conversations/other', { type: 'note', title: 'Garden notes', compiled_truth: 'Repotting a fern in spring.' });
  await installFixtureChunks(engine, 'conversations/other', [{ chunk_index: 0, chunk_text: 'Repotting a fern in spring.', chunk_source: 'compiled_truth' }]);
});

afterAll(async () => {
  await engine.disconnect();
}, 30_000);

describe('collapseWebsearchDashRuns', () => {
  test('a run websearch_to_tsquery can parse passes through byte-identical', async () => {
    for (const q of ['x y', 'x - y', 'x -y', 'foo-bar', `x ${'-'.repeat(MAX_WEBSEARCH_DASH_RUN)} y`, `x ${'- '.repeat(MAX_WEBSEARCH_DASH_RUN)}y`, 'Pandas\n-----\n\n### Background', '']) {
      expect(collapseWebsearchDashRuns(q)).toBe(q);
      await parse(q);
    }
  });

  test('a longer run used to overflow the operator stack and now parses as its parity', async () => {
    for (const n of [MAX_WEBSEARCH_DASH_RUN + 1, 40, 41, 73, 200]) {
      for (const run of ['-'.repeat(n), Array(n).fill('-').join(' ')]) {
        const q = `x ${run} y`;
        await expect(parse(q)).rejects.toThrow('tsquery stack too small');
        const parity = n % 2 === 1 ? `x - y` : `x y`;
        expect(await parse(collapseWebsearchDashRuns(q))).toBe(await parse(parity));
      }
    }
  });

  test('boundWebsearchQuery (the title arm) collapses the run too', () => {
    expect(boundWebsearchQuery(`x ${'-'.repeat(40)} y`)).toBe('x   y');
  });
});

describe('keyword and title arms on a passage holding a 73-dash rule', () => {
  test('raw websearch_to_tsquery fails on the passage (the bug)', async () => {
    await expect(parse(PASSAGE)).rejects.toThrow('tsquery stack too small');
  });

  test('searchKeyword returns the page instead of failing', async () => {
    const hits = await engine.searchKeyword(PASSAGE, { limit: 10 });
    expect(hits.map(h => h.slug)).toEqual(['conversations/outline']);
  });

  test('searchKeywordChunks returns the chunk instead of failing', async () => {
    const hits = await engine.searchKeywordChunks(PASSAGE, { limit: 10 });
    expect(hits.map(h => h.slug)).toEqual(['conversations/outline']);
  });

  test('searchTitles no longer fails on the passage', async () => {
    await engine.searchTitles(PASSAGE, { limit: 10 });
  });
});
