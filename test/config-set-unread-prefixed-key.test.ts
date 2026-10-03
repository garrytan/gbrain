/**
 * #4605 follow-up — `config set` warns when a key under an enumerated prefix
 * (`search.`, `content_sanity.`) has no reader.
 *
 * A prefix in KNOWN_CONFIG_KEY_PREFIXES admits any sub-key, so before this a
 * retired or misspelled `search.token_budget` (the reader is
 * `search.tokenBudget`) or `search.reranker.topN` (the reader is
 * `search.reranker.top_n_in`) was written silently and then never read. Now
 * an unregistered key under an enumerated prefix still saves (forward-compat)
 * but prints the nearest registered spelling. Registered keys and keys under
 * the open prefixes (`cycle.`, `models.`, ...) print nothing new.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import {
  ENUMERATED_CONFIG_KEY_PREFIXES, KNOWN_CONFIG_KEYS, KNOWN_CONFIG_KEY_PREFIXES, loadConfigWithEngine,
} from '../src/core/config.ts';
import { runConfig } from '../src/commands/config.ts';
import type { BrainEngine } from '../src/core/engine.ts';

function setStubEngine(): { engine: BrainEngine; setCalls: Array<[string, string]> } {
  const setCalls: Array<[string, string]> = [];
  const engine = {
    getConfig: async () => null,
    setConfig: async (key: string, value: string) => { setCalls.push([key, value]); },
  } as unknown as BrainEngine;
  return { engine, setCalls };
}

async function runConfigCapture(engine: BrainEngine, args: string[]): Promise<{ errs: string; exit: number | null }> {
  const errs: string[] = [];
  let exit: number | null = null;
  const logSpy = spyOn(console, 'log').mockImplementation(() => {});
  const errSpy = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errs.push(a.join(' ')); });
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exit = code ?? 0;
    throw new Error(`EXIT:${code}`);
  }) as never);
  try {
    await runConfig(engine, args);
  } catch (e) {
    if (!(e as Error).message.startsWith('EXIT:')) throw e;
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { errs: errs.join('\n'), exit };
}

describe('config set: unregistered key under an enumerated prefix', () => {
  const cases: Array<[string, string]> = [
    ['search.token_budget', 'search.tokenBudget'],
    ['search.reranker.topN', 'search.reranker.top_n_in'],
    ['search.keyword_or_fallback', 'search.keywordOrFallback'],
    ['content_sanity.bytes_warnn', 'content_sanity.bytes_warn'],
  ];
  for (const [key, registered] of cases) {
    test(`${key}: written, with a warning naming ${registered}`, async () => {
      const { engine, setCalls } = setStubEngine();
      const { errs, exit } = await runConfigCapture(engine, ['set', key, '100']);
      expect(exit).toBeNull();
      expect(setCalls).toEqual([[key, '100']]);
      expect(errs).toContain(`WARN: "${key}" is not a registered`);
      expect(errs).toContain(`Did you mean "${registered}"?`);
    });
  }

  test('--force writes it and still warns', async () => {
    const { engine, setCalls } = setStubEngine();
    const { errs, exit } = await runConfigCapture(engine, ['set', 'search.token_budget', '100', '--force']);
    expect(exit).toBeNull();
    expect(setCalls).toEqual([['search.token_budget', '100']]);
    expect(errs).toContain('Did you mean "search.tokenBudget"?');
  });

  test('a registered key under an enumerated prefix prints no warning', async () => {
    for (const key of ['search.tokenBudget', 'search.reranker.top_n_in', 'content_sanity.bytes_warn']) {
      const { engine, setCalls } = setStubEngine();
      const { errs, exit } = await runConfigCapture(engine, ['set', key, '100']);
      expect(exit).toBeNull();
      expect(setCalls).toEqual([[key, '100']]);
      expect(errs).not.toContain('is not a registered');
    }
  });

  test('a key under an open prefix is unchanged: written, no warning', async () => {
    const { engine, setCalls } = setStubEngine();
    const { errs, exit } = await runConfigCapture(engine, ['set', 'cycle.some_phase.enabled', 'true']);
    expect(exit).toBeNull();
    expect(setCalls).toEqual([['cycle.some_phase.enabled', 'true']]);
    expect(errs).not.toContain('is not a registered');
  });
});

describe('ENUMERATED_CONFIG_KEY_PREFIXES stay enumerated', () => {
  test('each is a KNOWN_CONFIG_KEY_PREFIXES entry', () => {
    for (const p of ENUMERATED_CONFIG_KEY_PREFIXES) expect(KNOWN_CONFIG_KEY_PREFIXES).toContain(p);
  });

  // The warning is only honest while every key read under these prefixes is
  // registered. search.* is pinned key-by-key in config-search-registry.test.ts;
  // this pins the DB-plane merge, the one reader of content_sanity.*.
  test('every key loadConfigWithEngine reads under them is registered', async () => {
    const read = new Set<string>();
    const engine = { getConfig: async (key: string) => { read.add(key); return null; } };
    await loadConfigWithEngine(engine as never, { engine: 'pglite' } as never);
    const underPrefix = [...read].filter((k) => ENUMERATED_CONFIG_KEY_PREFIXES.some((p) => k.startsWith(p)));
    expect(underPrefix.some((k) => k.startsWith('content_sanity.'))).toBe(true);
    expect(underPrefix.filter((k) => !KNOWN_CONFIG_KEYS.includes(k))).toEqual([]);
  });
});
