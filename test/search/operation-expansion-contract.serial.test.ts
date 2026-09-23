import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';
import * as hybrid from '../../src/core/search/hybrid.ts';
import { buildModesReport } from '../../src/core/search/modes-report.ts';
import { _exports_for_test as searchCommand } from '../../src/commands/search.ts';
import { MODE_PICKER_MENU, runModePicker } from '../../src/commands/init-mode-picker.ts';
import { buildTuneRecommendations } from '../../src/core/search/tune-recommendations.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
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

afterAll(async () => { await engine.disconnect(); });

describe('operation expansion remains independent of mode bundles', () => {
  for (const mode of ['conservative', 'balanced', 'tokenmax'] as const) {
    for (const override of ['true', 'false']) {
      test(`${mode}, search.expansion=${override}: query default, explicit opt-out and search`, async () => {
        await engine.setConfig('search.mode', mode);
        await engine.setConfig('search.expansion', override);
        await engine.setConfig('search.reranker.enabled', 'false');
        const options: Array<Parameters<typeof hybrid.hybridSearchCached>[2]> = [];
        const original = hybrid.hybridSearchCached;
        const spy = spyOn(hybrid, 'hybridSearchCached').mockImplementation(async (db, query, opts) => {
          options.push(opts);
          return original(db, query, opts);
        });
        const meta: Record<string, unknown> = {};
        const ctx: OperationContext = {
          engine, remote: false, sourceId: 'default',
          config: { engine: 'pglite' }, logger: console, dryRun: false,
          emitResponseMeta: (key, value) => { meta[key] = value; },
        };
        try {
          for (const expand of [undefined, false, true]) {
            const results = await operationsByName.query.handler(ctx, {
              query: 'Zirconiumneedle', ...(expand === undefined ? {} : { expand }),
            });
            expect(JSON.stringify(results)).toContain('notes/expansion-example');
            expect(options.at(-1)?.expansion).toBe(expand !== false);
            expect(typeof options.at(-1)?.expandFn).toBe(expand === false ? 'undefined' : 'function');
            expect(meta.retrieval).toMatchObject({ expansion_applied: false, vector_enabled: false });
          }
          const count = options.length;
          const results = await operationsByName.search.handler(ctx, { query: 'Zirconiumneedle' });
          expect(JSON.stringify(results)).toContain('notes/expansion-example');
          for (const opts of options.slice(count)) {
            expect(opts?.expansion).toBe(false);
            expect(opts?.expandFn).toBeUndefined();
          }
          const report = await buildModesReport(engine);
          expect(report.resolved.expansion.value).toBe(override === 'true');
          expect(report.per_call_note).toContain('default on in every mode');
          expect(report.per_call_note).toContain('Neither inherits `search.expansion`');
          const text = searchCommand.formatModesText(report);
          expect(text.indexOf('`query` op')).toBeLessThan(text.indexOf('Resolved knobs:'));
        } finally {
          spy.mockRestore();
        }
      });
    }
  }

  test('the install picker does not promise mode-specific expansion or cache savings', () => {
    expect(MODE_PICKER_MENU).not.toContain('no LLM expansion');
    expect(MODE_PICKER_MENU).not.toContain('LLM query expansion ON');
    expect(MODE_PICKER_MENU).not.toContain('cache hits skip downstream');
    expect(MODE_PICKER_MENU).toContain('gbrain query requests expansion in every mode');
    expect(MODE_PICKER_MENU).toContain('keyless');
  });

  test('tuning advice does not promise expansion savings from modes or an unavailable cache', async () => {
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
    expect(mode?.reason).toContain('does not disable query expansion');
    expect(mode?.reason).toContain('12K tokens');
  });

  test('keyless noninteractive initialization reports the effective expansion policy', async () => {
    const lines: string[] = [];
    const output = spyOn(console, 'log').mockImplementation((...args) => { lines.push(args.join(' ')); });
    try {
      expect(await runModePicker(engine, { force: true })).toBe('conservative');
      expect(await engine.getConfig('search.mode')).toBe('conservative');
      expect(lines.join('\n')).toContain('query requests expansion in every mode');
      expect(lines.join('\n')).toContain('Keyless retrieval skips expansion');
    } finally {
      output.mockRestore();
    }
  });
});
