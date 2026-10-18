/**
 * The `query` expansion contract: the search mode decides the default
 * (`expansion` off in all three bundles since GBRA-94, overridden by
 * `search.expansion`), an explicit `expand` wins in either direction, the
 * expander stays wired whenever expansion can resolve on (so
 * `search.expansion true` still expands), and `search` never expands.
 * Rewritten from the earlier pin ("query requests expansion in every mode")
 * when the default moved to the mode (GBRA-81 item 1b); tokenmax's default
 * turned off on the 2026-10-14 expansion-latency eval (GBRA-94).
 *
 * Serial: configures the process-global gateway with a stub embedder so the
 * vector path (where expansion runs) is reached without a provider call.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';
import * as hybrid from '../../src/core/search/hybrid.ts';
import { buildModesReport } from '../../src/core/search/modes-report.ts';
import { _exports_for_test as searchCommand } from '../../src/commands/search.ts';
import { buildTuneRecommendations } from '../../src/core/search/tune-recommendations.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { parseOpArgs } from '../../src/cli/main.ts';
import { runConfig } from '../../src/commands/config.ts';

const DIMS = 1536;
const embedTransport = (async (p: { values: string[] }) => ({
  embeddings: p.values.map(() => Array.from({ length: DIMS }, (_, j) => (j === 0 ? 1 : 0.01))), values: p.values, warnings: [], usage: { tokens: p.values.length },
})) as unknown as Parameters<typeof __setEmbedTransportForTests>[0];

let engine: PGLiteEngine;

beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'sk-test' } });
  __setEmbedTransportForTests(embedTransport);
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.putPage('notes/expansion-example', {
    type: 'note', title: 'Expansion Example', compiled_truth: 'Zirconiumneedle retrieval fixture.',
  });
  await installFixtureChunks(engine, 'notes/expansion-example', [
    { chunk_index: 0, chunk_text: 'Zirconiumneedle retrieval fixture.', chunk_source: 'compiled_truth' },
  ]);
});

afterAll(async () => {
  await engine.disconnect();
  __setEmbedTransportForTests(null);
  resetGateway();
});

function makeCtx(meta: Record<string, unknown>): OperationContext {
  return {
    engine, remote: false, sourceId: 'default',
    config: { engine: 'pglite' }, logger: console, dryRun: false,
    emitResponseMeta: (key, value) => { meta[key] = value; },
  };
}

/**
 * Spy on the op's hybrid call: record the options it passed and swap the
 * wired expander for a stub, so "expansion ran" is observable without a chat
 * provider. `variants` decides what the stub returns.
 */
function spyHybrid(variants: (q: string) => string[]) {
  const options: Array<Parameters<typeof hybrid.hybridSearchCached>[2]> = [];
  const expanderCalls: string[] = [];
  const original = hybrid.hybridSearchCached;
  const spy = spyOn(hybrid, 'hybridSearchCached').mockImplementation(async (db, query, opts) => {
    options.push(opts);
    const wired = opts?.expandFn
      ? { ...opts, expandFn: async (q: string) => { expanderCalls.push(q); return variants(q); } }
      : opts;
    return original(db, query, wired);
  });
  return { options, expanderCalls, restore: () => spy.mockRestore() };
}

async function resetSearchConfig(mode: string, expansionOverride: string | undefined): Promise<void> {
  await engine.executeRaw(`DELETE FROM config WHERE key LIKE 'search.%'`);
  await engine.setConfig('search.mode', mode);
  if (expansionOverride !== undefined) await engine.setConfig('search.expansion', expansionOverride);
  await engine.setConfig('search.reranker.enabled', 'false');
}

describe('query expansion follows the search mode', () => {
  for (const mode of ['conservative', 'balanced', 'tokenmax'] as const) {
    for (const override of [undefined, 'true', 'false'] as const) {
      const modeDefault = override === 'true';
      test(`${mode}, search.expansion=${override ?? 'unset'}: default ${modeDefault ? 'expands' : 'does not expand'}, explicit expand wins, search never expands`, async () => {
        await resetSearchConfig(mode, override);
        const probe = spyHybrid(q => [q, `${q} alternate phrasing`]);
        const meta: Record<string, unknown> = {};
        const ctx = makeCtx(meta);
        try {
          for (const expand of [undefined, false, true] as const) {
            const before = probe.expanderCalls.length;
            const results = await operationsByName.query.handler(ctx, {
              query: 'Zirconiumneedle retrieval', ...(expand === undefined ? {} : { expand }),
            });
            expect(JSON.stringify(results)).toContain('notes/expansion-example');
            const passed = probe.options.at(-1);
            // The raw param reaches hybrid search; unset stays unset so the mode decides.
            expect(passed?.expansion).toBe(expand);
            // The expander stays wired unless the caller opted out.
            expect(typeof passed?.expandFn).toBe(expand === false ? 'undefined' : 'function');
            const expected = expand ?? modeDefault;
            expect(probe.expanderCalls.length - before).toBe(expected ? 1 : 0);
            expect((meta.retrieval as { expansion_applied?: boolean }).expansion_applied).toBe(expected);
          }
          const count = probe.options.length;
          const results = await operationsByName.search.handler(ctx, { query: 'Zirconiumneedle retrieval' });
          expect(JSON.stringify(results)).toContain('notes/expansion-example');
          for (const opts of probe.options.slice(count)) {
            expect(opts?.expansion).toBe(false);
            expect(opts?.expandFn).toBeUndefined();
          }
          const report = await buildModesReport(engine);
          expect(report.resolved.expansion.value).toBe(modeDefault);
          expect(report.per_call_note).toContain('op expands when the resolved `expansion` row below is on');
          expect(report.per_call_note).toContain('`search` never expands');
          const text = searchCommand.formatModesText(report);
          expect(text.indexOf('`query` op')).toBeLessThan(text.indexOf('Resolved knobs:'));
        } finally {
          probe.restore();
        }
      });
    }
  }
});

describe('per-brain switch: `gbrain config set search.expansion true|false`', () => {
  async function runQueryCli(argv: string[], probe: ReturnType<typeof spyHybrid>): Promise<number> {
    const before = probe.expanderCalls.length;
    await operationsByName.query.handler(makeCtx({}), parseOpArgs(operationsByName.query, argv));
    return probe.expanderCalls.length - before;
  }

  test('unset does not expand in tokenmax, true turns it on, false pins it off, explicit flags still win, unset restores the default', async () => {
    await resetSearchConfig('tokenmax', undefined);
    const probe = spyHybrid(q => [q, `${q} alternate phrasing`]);
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(parseOpArgs(operationsByName.query, ['Zirconiumneedle retrieval'])).not.toHaveProperty('expand');
      expect((await buildModesReport(engine)).resolved.expansion).toMatchObject({ value: false });
      expect(await runQueryCli(['Zirconiumneedle retrieval'], probe)).toBe(0);
      expect(await runQueryCli(['Zirconiumneedle retrieval', '--expand'], probe)).toBe(1);

      await runConfig(engine, ['set', 'search.expansion', 'true']);
      expect(await engine.getConfig('search.expansion')).toBe('true');
      expect((await buildModesReport(engine)).resolved.expansion).toMatchObject({ value: true, source: 'override' });
      expect(await runQueryCli(['Zirconiumneedle retrieval'], probe)).toBe(1);
      expect(await runQueryCli(['Zirconiumneedle retrieval', '--no-expand'], probe)).toBe(0);

      await runConfig(engine, ['set', 'search.expansion', 'false']);
      expect((await buildModesReport(engine)).resolved.expansion).toMatchObject({ value: false, source: 'override' });
      expect(await runQueryCli(['Zirconiumneedle retrieval'], probe)).toBe(0);
      expect(await runQueryCli(['Zirconiumneedle retrieval', '--expand'], probe)).toBe(1);

      await runConfig(engine, ['unset', 'search.expansion']);
      expect(await runQueryCli(['Zirconiumneedle retrieval'], probe)).toBe(0);
    } finally {
      log.mockRestore();
      probe.restore();
    }
  });

  test('recall never expands, even with search.expansion=true', async () => {
    await resetSearchConfig('tokenmax', 'true');
    const probe = spyHybrid(q => [q, `${q} alternate phrasing`]);
    try {
      await operationsByName.recall.handler(makeCtx({}), { query: 'Zirconiumneedle retrieval' });
      expect(probe.options.length).toBeGreaterThan(0);
      for (const opts of probe.options) {
        expect(opts?.expansion).toBe(false);
        expect(opts?.expandFn).toBeUndefined();
      }
      expect(probe.expanderCalls).toEqual([]);
    } finally {
      probe.restore();
    }
  });
});

describe('CRAG escalation reads what the first pass did', () => {
  test('callerExpanded is expansion_applied, not the requested flag', async () => {
    await resetSearchConfig('balanced', undefined);
    await engine.setConfig('search.crag_escalation', 'true');
    // Variants the store cannot match keep every pass at zero results (a weak grade).
    const noVariants = spyHybrid(q => [q]);
    try {
      // expand: true, but the expander produced no variants: nothing expanded, so escalate.
      await operationsByName.query.handler(makeCtx({}), { query: 'qwertyuiop asdfghjkl nothing', expand: true });
      expect(noVariants.options.length).toBe(2);
      expect(noVariants.options[1]?.expansion).toBe(true);
    } finally {
      noVariants.restore();
    }
    const withVariants = spyHybrid(q => [q, `${q} other words`]);
    try {
      // The first pass expanded: the high-ceiling re-run would repeat it, so no escalation.
      await operationsByName.query.handler(makeCtx({}), { query: 'qwertyuiop asdfghjkl nothing', expand: true });
      expect(withVariants.options.length).toBe(1);
      // Unset in balanced: no expansion ran, so a weak result escalates once.
      await operationsByName.query.handler(makeCtx({}), { query: 'qwertyuiop asdfghjkl nothing' });
      expect(withVariants.options.length).toBe(3);
    } finally {
      withVariants.restore();
      await engine.setConfig('search.crag_escalation', 'false');
    }
  });
});

describe('tuning advice', () => {
  test('tokenmax with a Haiku subagent: balanced caps the payload (no expansion claim: neither mode expands by default)', async () => {
    await engine.executeRaw(`DELETE FROM config WHERE key LIKE 'search.%'`);
    await engine.setConfig('search.mode', 'tokenmax');
    await engine.setConfig('models.tier.subagent', 'haiku');
    await engine.setConfig('search.cache.enabled', 'false');
    await engine.executeRaw(`INSERT INTO search_telemetry
      (date, mode, intent, count, sum_results, sum_tokens, sum_budget_dropped, cache_hit, cache_miss)
      VALUES (CURRENT_DATE, 'tokenmax', 'factual', 100, 100, 1000, 0, 99, 1)
      ON CONFLICT (date, mode, intent) DO UPDATE SET count = 100, cache_hit = 99, cache_miss = 1`);
    const report = await buildTuneRecommendations(engine);
    expect(report.total_calls).toBeGreaterThanOrEqual(100);
    expect(report.recommendations.some(row => row.knob.startsWith('search.cache.'))).toBe(false);
    const mode = report.recommendations.find(row => row.knob === 'search.mode');
    expect(mode?.suggested).toBe('balanced');
    expect(mode?.reason).not.toContain('expansion');
    expect(mode?.reason).toContain('12K tokens');
  });
});
