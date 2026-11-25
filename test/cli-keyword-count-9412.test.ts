/**
 * #9412: the CLI prints the literal keyword-match count. `gbrain search` and
 * `gbrain query` write one stderr line saying how many pages contain the
 * query's words (the signal MCP `search` already carried), so an agent on
 * the CLI can tell "the brain has no record of this" from "a few pages
 * matched by meaning". `--json` stays the bare result array; the count rides
 * the `--json --timings` document as `keyword_matches`, where a number,
 * a capped count and an unavailable count are three distinct outcomes. The
 * query op now runs the same strict count as search.
 *
 * Keyless PGLite brain, no repository, no model calls.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations } from '../src/core/operations.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { DEFAULT_CLI_OPTIONS, setCliOptions } from '../src/core/cli-options.ts';
import { captureRetrievalMeta, formatResult, resetRetrievalMetaForTests } from '../src/cli/main.ts';
import { resetCliSearchTimingsForTests } from '../src/cli/search-timings.ts';
import { KEYWORD_COUNT_CAP } from '../src/core/search/keyword-statement.ts';
import { withEnv } from './helpers/with-env.ts';
import { searchCtx, seedPage } from './helpers/keyword-paging-fixture.ts';

const ZERO_LINE = 'No page contains these words (literal match). The rows below matched only by meaning.';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (let i = 0; i < 3; i++) await seedPage(engine, `notes/widget-${i}`, `Note ${i}: the halcyonite gasket shipped to acme-example.`);
  await seedPage(engine, 'meetings/widget-review', 'Review of the halcyonite gasket with alice-example.', { type: 'meeting' });
  await seedPage(engine, 'notes/unrelated', 'A note about the weather.');
  await seedPage(engine, 'people/bob-example', 'Bob Example runs procurement.', { type: 'person', title: 'Bob Example' });
  await seedPage(engine, 'notes/brindle-old', 'The brindlewort order from last decade.', { frontmatter: { date: '2020-01-05', status: 'archived' } });
  for (let i = 0; i < 2; i++) await seedPage(engine, `notes/brindle-${i}`, `Brindlewort order ${i} this year.`, { frontmatter: { date: '2026-06-01', status: 'active' } });
}, 120_000);

afterAll(async () => { await engine?.disconnect(); });

afterEach(() => {
  setCliOptions({ ...DEFAULT_CLI_OPTIONS });
  resetRetrievalMetaForTests();
  resetCliSearchTimingsForTests();
});

const queryOp = operations.find(o => o.name === 'query')!;
async function callQuery(params: Record<string, unknown>, remote = false) {
  const ctx = searchCtx(engine, remote);
  const rows = await queryOp.handler(ctx, params) as Array<Record<string, unknown>>;
  return { rows, retrieval: (ctx.captured.retrieval ?? {}) as Record<string, unknown> };
}

describe('query op: the same strict keyword count as search', () => {
  test('a term in four pages counts 4; an absent term counts 0', async () => {
    const hit = await callQuery({ query: 'halcyonite' });
    expect(hit.retrieval.keyword_total).toBe(4);
    const miss = await callQuery({ query: 'quantumtoasterxyz' });
    expect(miss.retrieval.keyword_total).toBe(0);
  });

  test('the count honours the type filter and remote callers get it too', async () => {
    expect((await callQuery({ query: 'halcyonite', types: ['meeting'] })).retrieval.keyword_total).toBe(1);
    expect((await callQuery({ query: 'halcyonite' }, true)).retrieval.keyword_total).toBe(4);
  });

  test('the count covers the same set the query filters: since, until and frontmatter where', async () => {
    expect((await callQuery({ query: 'brindlewort' })).retrieval.keyword_total).toBe(3);
    expect((await callQuery({ query: 'brindlewort', since: '2026-01-01' })).retrieval.keyword_total).toBe(2);
    expect((await callQuery({ query: 'brindlewort', until: '2021-01-01' })).retrieval.keyword_total).toBe(1);
    expect((await callQuery({ query: 'brindlewort', where: { status: 'archived' } })).retrieval.keyword_total).toBe(1);
  });

  test('a query that names an entity marks the count, so zero literal matches never reads as meaning-only', async () => {
    const named = await callQuery({ query: 'Bob Example zzabsentword' });
    expect(named.retrieval.keyword_total).toBe(0);
    expect(named.retrieval.query_entity_resolved).toBe(true);
    const plain = await callQuery({ query: 'zzabsentword' });
    expect(plain.retrieval.query_entity_resolved).toBeUndefined();
  });

  test('MCP query shows the count line, pointing at search for the full list', async () => {
    const res = await withEnv({ GBRAIN_BACKUP_CHECK: '0' }, () => dispatchToolCall(engine, 'query', { query: 'halcyonite' }, { remote: true, transport: 'http', sourceId: 'default' }));
    const line = res.content.map(c => c.text).find(t => t.startsWith('[gbrain search] ')) ?? '';
    expect(line).toContain('Keyword matches: 4 pages');
    expect(line).toContain('List every keyword match with the search tool and match: "keyword".');
  });
});

/** Runs formatResult with the given captured meta; returns stdout and every stderr write. */
function render(op: 'search' | 'query', rows: unknown[], meta: Record<string, unknown> | null, params: Record<string, unknown> = {}) {
  if (meta) captureRetrievalMeta('retrieval', meta);
  const writes: string[] = [];
  const spy = spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => { writes.push(String(chunk)); return true; }) as never);
  try {
    return { out: formatResult(op, rows, params), err: writes.join('') };
  } finally {
    spy.mockRestore();
  }
}

const ROW = { slug: 'notes/a', score: 0.5, chunk_text: 'x', page_id: 1 };

describe('CLI stderr: the literal keyword count', () => {
  test('a counted hybrid search names the count and how to list every match', () => {
    const { err } = render('search', [ROW], { keyword_total: 3, keyword_truncated: true });
    expect(err).toContain('Keyword matches: 3 pages (pages containing these words, not a count of these rows). List them all with: gbrain search <words> --match keyword');
  });

  test('zero matches and no resolved entity: the rows matched only by meaning', () => {
    for (const op of ['search', 'query'] as const) {
      const { err } = render(op, [ROW], { keyword_total: 0, keyword_truncated: false });
      expect(err).toContain(ZERO_LINE);
      resetRetrievalMetaForTests();
    }
  });

  test('zero matches with rows from the any-word retry: the rows contain some of the words', () => {
    const relaxedLine = 'No page contains all these words (literal match). The rows below contain only some of them, or matched by meaning.';
    expect(render('search', [{ ...ROW, keyword_relaxed: true }], { keyword_total: 0, keyword_truncated: false }).err).toContain(relaxedLine);
    resetRetrievalMetaForTests();
    const carried = render('query', [ROW], { keyword_total: 0, keyword_truncated: false, degraded: [{ stage: 'keyword_relaxed_carried' }] }).err;
    expect(carried).toContain(relaxedLine);
    expect(carried).not.toContain(ZERO_LINE);
  });

  test('zero matches with a resolved entity keeps the plain count (the entity matched by name)', () => {
    const { err } = render('query', [ROW], { keyword_total: 0, keyword_truncated: false, query_entity_resolved: true });
    expect(err).not.toContain(ZERO_LINE);
    expect(err).toContain('Keyword matches: 0 pages');
  });

  test('zero matches and zero rows: No results. on stdout, the count on stderr', () => {
    const { out, err } = render('search', [], { keyword_total: 0, keyword_truncated: false });
    expect(out.startsWith('No results.')).toBe(true);
    expect(err).toContain('Keyword matches: 0 pages');
    expect(err).not.toContain(ZERO_LINE);
  });

  test('a capped count says it is a floor', () => {
    const { err } = render('search', [ROW], { keyword_total: KEYWORD_COUNT_CAP, keyword_truncated: true, keyword_total_capped: true });
    expect(err).toContain(`Keyword matches: ${KEYWORD_COUNT_CAP}+ pages`);
  });

  test('an unavailable count never reads as zero', () => {
    const { err } = render('search', [ROW], { keyword_total: null, degraded: [{ stage: 'keyword_count_unavailable', reason: 'timeout' }] });
    expect(err).toContain('Keyword match count unavailable (timed out; not a count of zero)');
    expect(err).not.toContain(ZERO_LINE);
  });

  test('--match keyword names the total and the next offset', () => {
    const { err } = render('search', [ROW], { match: 'keyword', total: 30, truncated: true, shown_from: 1, shown_to: 10, next: { query: 'x', match: 'keyword', cursor: 'c' } });
    expect(err).toContain('Keyword matches: 30 pages; showing 1-10. More: rerun with --offset 10.');
    resetRetrievalMetaForTests();
    const last = render('search', [ROW], { match: 'keyword', total: 30, truncated: false, shown_from: 21, shown_to: 30 });
    expect(last.err).toContain('Keyword matches: 30 pages; showing 21-30. No more keyword matches.');
  });

  test('no count in the meta (an image query, an older server): no line', () => {
    const { err } = render('query', [ROW], { returned_count: 1 });
    expect(err).not.toContain('Keyword match');
    expect(err).not.toContain(ZERO_LINE);
  });
});

describe('--json stays a bare array; --json --timings carries keyword_matches', () => {
  test('plain --json is the bare row array, and the count still goes to stderr', () => {
    const { out, err } = render('search', [ROW], { keyword_total: 0, keyword_truncated: false }, { json: true });
    expect(JSON.parse(out)).toEqual([ROW]);
    expect(err).toContain(ZERO_LINE);
  });

  test('a number, capped and unavailable are three distinct outcomes', () => {
    setCliOptions({ ...DEFAULT_CLI_OPTIONS, timings: true });
    const doc = (meta: Record<string, unknown>) => { resetRetrievalMetaForTests(); return JSON.parse(render('query', [ROW], meta, { json: true }).out); };
    expect(doc({ keyword_total: 0, keyword_truncated: false }).keyword_matches).toEqual({ status: 'counted', total: 0 });
    expect(doc({ keyword_total: 7, keyword_truncated: true }).keyword_matches).toEqual({ status: 'counted', total: 7 });
    expect(doc({ keyword_total: KEYWORD_COUNT_CAP, keyword_truncated: true, keyword_total_capped: true }).keyword_matches)
      .toEqual({ status: 'capped', total: KEYWORD_COUNT_CAP, cap: KEYWORD_COUNT_CAP });
    expect(doc({ keyword_total: null, degraded: [{ stage: 'keyword_count_unavailable', reason: 'timeout' }] }).keyword_matches)
      .toEqual({ status: 'unavailable', stage: 'keyword_count_unavailable', reason: 'timeout' });
    expect(doc({ keyword_total: null, degraded: [{ stage: 'keyword_count_unavailable' }] }).keyword_matches)
      .toEqual({ status: 'unavailable', stage: 'keyword_count_unavailable', reason: 'error' });
    expect(doc({ match: 'keyword', total: 30, truncated: true, shown_from: 1, shown_to: 10 }).keyword_matches).toEqual({ status: 'counted', total: 30 });
    expect('keyword_matches' in doc({ returned_count: 1 })).toBe(false);
  });
});
