import { test, expect, describe } from 'bun:test';
import { loadSearchModeConfig, SEARCH_MODE_CONFIG_KEYS } from '../src/core/search/mode.ts';
import { snapshotConfigReader } from '../src/core/config-snapshot.ts';

/**
 * loadSearchModeConfig resolves 32 override keys plus the mode key, one
 * `SELECT value FROM config WHERE key = $1` each. config-snapshot.ts exists to
 * collapse that into a single whole-table read and is already used by
 * loadConfigWithEngine and the gateway — the search path just never adopted it.
 *
 * Measured on a 232k-chunk PGLite brain before this wiring: 34 per-key reads,
 * 314 ms, on every uncached search, before any retrieval work. Warm the same
 * call is ~4 ms; the cold cost is what every one-shot `gbrain query` pays.
 */
function countingEngine(rows: Record<string, string>) {
  const calls = { getConfig: 0, getAllConfig: 0 };
  return {
    calls,
    async getConfig(key: string) { calls.getConfig++; return rows[key] ?? null; },
    async getAllConfig() { calls.getAllConfig++; return { ...rows }; },
  };
}

describe('search mode config reads', () => {
  test('the raw engine is read once per key — the behaviour this wiring replaces', async () => {
    const engine = countingEngine({ 'search.mode': 'balanced' });
    await loadSearchModeConfig(engine);
    expect(engine.calls.getConfig).toBe(SEARCH_MODE_CONFIG_KEYS.length + 1);
    expect(engine.calls.getAllConfig).toBe(0);
  });

  test('through snapshotConfigReader it is one whole-table read and no per-key reads', async () => {
    const engine = countingEngine({ 'search.mode': 'balanced' });
    const reader = (await snapshotConfigReader(engine))!;
    engine.calls.getAllConfig = 0; // de snapshot zelf telt niet mee
    await loadSearchModeConfig(reader);
    expect(engine.calls.getConfig).toBe(0);
    expect(engine.calls.getAllConfig).toBe(0);
  });

  test('the snapshot returns the same values as per-key reads', async () => {
    const rows = {
      'search.mode': 'balanced',
      'search.reranker.top_n_in': '15',
      'search.autocut_jump': '1.0',
    };
    const direct = await loadSearchModeConfig(countingEngine(rows));
    const viaSnapshot = await loadSearchModeConfig((await snapshotConfigReader(countingEngine(rows)))!);
    expect(viaSnapshot).toEqual(direct);
  });

  test('an engine without getAllConfig still works, at the old cost', async () => {
    // Engines implemented outside this repo may not have the bulk read.
    const engine = countingEngine({ 'search.mode': 'balanced' });
    const noBulk = { getConfig: engine.getConfig };
    const reader = (await snapshotConfigReader(noBulk as never))!;
    const out = await loadSearchModeConfig(reader);
    expect(out.mode).toBe('balanced');
  });
});
