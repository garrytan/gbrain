/**
 * `config set` refuses an unregistered key under an enumerated prefix
 * (`search.`, `content_sanity.`), as it refuses an unknown chronicle.* leaf.
 *
 * A prefix in KNOWN_CONFIG_KEY_PREFIXES admits any sub-key, so before this a
 * retired or misspelled `search.token_budget` (the reader is
 * `search.tokenBudget`) or `search.reranker.topN` (the reader is
 * `search.reranker.top_n_in`) was written silently and then never read. Now
 * it is a usage error (exit 2, agent contract) naming the nearest registered
 * spelling, and nothing is written; --force still writes it (a key a newer
 * gbrain reads), with a warning. Registered keys and keys under the open
 * prefixes (`cycle.`, `models.`, ...) behave as before.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { KNOWN_CONFIG_KEYS, loadConfigWithEngine } from '../src/core/config.ts';
import { runConfig } from '../src/commands/config.ts';
import type { BrainEngine } from '../src/core/engine.ts';

function stubEngine(): { engine: BrainEngine; setCalls: Array<[string, string]>; unsetCalls: string[] } {
  const setCalls: Array<[string, string]> = [];
  const unsetCalls: string[] = [];
  const engine = {
    getConfig: async () => null,
    setConfig: async (key: string, value: string) => { setCalls.push([key, value]); },
    unsetConfig: async (key: string) => { unsetCalls.push(key); return 1; },
  } as unknown as BrainEngine;
  return { engine, setCalls, unsetCalls };
}

async function runConfigCapture(engine: BrainEngine, args: string[]): Promise<{ errs: string; exit: number | null }> {
  const errs: string[] = [];
  let exit: number | null = null;
  const logSpy = spyOn(console, 'log').mockImplementation(() => {});
  const errSpy = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errs.push(a.join(' ')); });
  const writeSpy = spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => { errs.push(String(chunk)); return true; }) as never);
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
    writeSpy.mockRestore();
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
    test(`${key}: refused (exit 2), nothing written, naming ${registered}`, async () => {
      const { engine, setCalls } = stubEngine();
      const { errs, exit } = await runConfigCapture(engine, ['set', key, '100']);
      expect(exit).toBe(2);
      expect(setCalls).toEqual([]);
      expect(errs).toContain(`Error [invalid_params]: Unknown config key "${key}". Did you mean "${registered}"? Nothing was written.`);
      expect(errs).toContain(`Fix: gbrain config set ${registered} '<VALUE>'`);
      expect(errs).toContain(`Why: Every ${key.split('.')[0]}.* key gbrain reads is registered, so nothing would read this one.`);
      expect(errs).not.toContain('100');
    });
  }

  test('a key with no near registered spelling is refused without a suggestion', async () => {
    const { engine, setCalls } = stubEngine();
    const { errs, exit } = await runConfigCapture(engine, ['set', 'search.zzzzzzzzzzzz', '1']);
    expect(exit).toBe(2);
    expect(setCalls).toEqual([]);
    expect(errs).toContain('Error [invalid_params]: Unknown config key "search.zzzzzzzzzzzz". Nothing was written.');
    expect(errs).toContain(`Fix: gbrain config set '<KEY>' '<VALUE>'`);
    expect(errs).not.toContain('Did you mean');
  });

  test('a control character in the key is rendered inert', async () => {
    const { engine, setCalls } = stubEngine();
    const { errs, exit } = await runConfigCapture(engine, ['set', 'search.zz\nError [fake]: injected', '1']);
    expect(exit).toBe(2);
    expect(setCalls).toEqual([]);
    expect(errs).not.toContain('\nError [fake]');
  });

  test('--force writes it, with a warning naming the registered spelling', async () => {
    const { engine, setCalls } = stubEngine();
    const { errs, exit } = await runConfigCapture(engine, ['set', 'search.token_budget', '100', '--force']);
    expect(exit).toBeNull();
    expect(setCalls).toEqual([['search.token_budget', '100']]);
    expect(errs).toContain('WARN: writing unregistered search.* key "search.token_budget" with --force.');
    expect(errs).toContain('Did you mean "search.tokenBudget"?');
  });

  test('a registered key under an enumerated prefix is written with no message', async () => {
    for (const key of ['search.tokenBudget', 'search.reranker.top_n_in', 'content_sanity.bytes_warn']) {
      const { engine, setCalls } = stubEngine();
      const { errs, exit } = await runConfigCapture(engine, ['set', key, '100']);
      expect(exit).toBeNull();
      expect(setCalls).toEqual([[key, '100']]);
      expect(errs).not.toContain('Unknown config key');
      expect(errs).not.toContain('unregistered');
    }
  });

  test('a key under an open prefix is unchanged: written, no message', async () => {
    const { engine, setCalls } = stubEngine();
    const { errs, exit } = await runConfigCapture(engine, ['set', 'cycle.some_phase.enabled', 'true']);
    expect(exit).toBeNull();
    expect(setCalls).toEqual([['cycle.some_phase.enabled', 'true']]);
    expect(errs).not.toContain('Unknown config key');
  });

  test('a key written before this change can still be unset', async () => {
    const { engine, unsetCalls } = stubEngine();
    const { exit } = await runConfigCapture(engine, ['unset', 'search.token_budget']);
    expect(exit).toBeNull();
    expect(unsetCalls).toEqual(['search.token_budget']);
  });
});

// The refusal is only safe while every key read under these prefixes is
// registered. search.* is pinned key by key in config-search-registry.test.ts;
// this pins the DB-plane merge, the one reader of content_sanity.*.
test('every key loadConfigWithEngine reads under search.* or content_sanity.* is registered', async () => {
  const read = new Set<string>();
  const engine = { getConfig: async (key: string) => { read.add(key); return null; } };
  await loadConfigWithEngine(engine as never, { engine: 'pglite' } as never);
  const underPrefix = [...read].filter((k) => k.startsWith('search.') || k.startsWith('content_sanity.'));
  expect(underPrefix.some((k) => k.startsWith('content_sanity.'))).toBe(true);
  expect(underPrefix.filter((k) => !KNOWN_CONFIG_KEYS.includes(k))).toEqual([]);
});
