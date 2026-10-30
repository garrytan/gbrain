/**
 * #7158: `gbrain search|query --timings` — the global flag is claimed only by
 * search/query/ask, `--json --timings` wraps the rows as
 * `{ results, timings_ms, cost }` (plain `--json` keeps the bare array), and
 * the CLI phases (startup, connect, context) sit beside the op's stages.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { DEFAULT_CLI_OPTIONS, parseGlobalFlags, setCliOptions } from '../src/core/cli-options.ts';
import { captureRetrievalMeta, formatResult, resetRetrievalMetaForTests } from '../src/cli/main.ts';
import { resetCliSearchTimingsForTests, timeCliPhase } from '../src/cli/search-timings.ts';

const META = {
  timings: { total_ms: 40, stages_ms: { setup: 5, lexical: 20, embed: 10, response: 3 }, other_ms: 2, overlapped_ms: { keyword_count: 4 } },
  cost: { calls: 1, embedding: { calls: 1, input_tokens: 7, output_tokens: 0, usd: 0.000001 }, estimated_usd: 0.000001 },
};

afterEach(() => {
  setCliOptions({ ...DEFAULT_CLI_OPTIONS });
  resetRetrievalMetaForTests();
  resetCliSearchTimingsForTests();
});

describe('--timings flag', () => {
  test('search, query and ask claim it; other commands get it back in place', () => {
    for (const command of ['search', 'query', 'ask']) {
      const { cliOpts, rest } = parseGlobalFlags([command, 'widget', '--timings', '--json']);
      expect(cliOpts.timings).toBe(true);
      expect(rest).toEqual([command, 'widget', '--json']);
    }
    const list = parseGlobalFlags(['list', '--timings']);
    expect(list.cliOpts.timings).toBeUndefined();
    expect(list.rest).toEqual(['list', '--timings']);
  });
});

describe('formatResult with --timings', () => {
  test('--json --timings prints {results, timings_ms, cost} with CLI phases and op stages', async () => {
    setCliOptions({ ...DEFAULT_CLI_OPTIONS, timings: true });
    await timeCliPhase('connect', async () => {});
    await timeCliPhase('context', async () => {});
    captureRetrievalMeta('retrieval', META);
    const doc = JSON.parse(formatResult('search', [{ slug: 'notes/a', score: 1, chunk_text: 'x' }], { json: true }));
    expect(doc.results).toEqual([{ slug: 'notes/a', score: 1, chunk_text: 'x' }]);
    expect(doc.cost).toEqual(META.cost);
    const t = doc.timings_ms;
    expect(Object.keys(t).sort()).toEqual(['cli_other', 'connect', 'context', 'op', 'overlapped', 'stages', 'startup', 'total']);
    expect(t.op).toBe(40);
    expect(t.stages).toEqual({ setup: 5, lexical: 20, embed: 10, response: 3, other: 2 });
    expect(t.overlapped).toEqual({ keyword_count: 4 });
    expect(t.startup).toBeGreaterThan(0);
    expect(t.total).toBeGreaterThanOrEqual(t.startup + t.connect + t.context);
    expect(t.remote).toBeUndefined();
  });

  test('the op\'s stage parts ride along as parts', () => {
    setCliOptions({ ...DEFAULT_CLI_OPTIONS, timings: true });
    captureRetrievalMeta('retrieval', { ...META, timings: { ...META.timings, parts_ms: { response: { evidence: 1, meta: 2 } } } });
    const t = JSON.parse(formatResult('search', [], { json: true })).timings_ms;
    expect(t.parts).toEqual({ response: { evidence: 1, meta: 2 } });
    expect(t.stages).toEqual({ setup: 5, lexical: 20, embed: 10, response: 3, other: 2 });
  });

  test('a phase that did not run is absent, and a missing cost reads as zero calls', () => {
    setCliOptions({ ...DEFAULT_CLI_OPTIONS, timings: true });
    const doc = JSON.parse(formatResult('query', [], { json: true }));
    expect(doc.results).toEqual([]);
    expect(doc.cost).toEqual({ calls: 0 });
    expect(Object.keys(doc.timings_ms).sort()).toEqual(['cli_other', 'total']);
  });

  test('plain --json stays the bare result array', () => {
    captureRetrievalMeta('retrieval', META);
    expect(JSON.parse(formatResult('search', [{ slug: 'notes/a' }], { json: true }))).toEqual([{ slug: 'notes/a' }]);
  });
});
