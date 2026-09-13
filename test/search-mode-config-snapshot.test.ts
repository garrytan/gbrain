import { test, expect, describe } from 'bun:test';
import { loadSearchModeConfig, SEARCH_MODE_CONFIG_KEYS } from '../src/core/search/mode.ts';

/**
 * loadSearchModeConfig resolves the mode key plus every per-knob override key.
 * Read one key per round trip and that is 33 `SELECT value FROM config WHERE
 * key = $1` queries on every uncached search (66 on the cached path, which
 * resolves the mode twice). On a hosted Postgres with the default pool of 10
 * that is ~4 sequential RTT rounds and 33 pooler-slot grabs before any
 * retrieval work runs. config-snapshot.ts exists to collapse exactly this
 * shape into one whole-table read; these tests pin that the loader uses it
 * and falls back to per-key reads when it cannot.
 */
function countingEngine(rows: Record<string, string>) {
  const calls = { getConfig: 0, getAllConfig: 0 };
  return {
    calls,
    async getConfig(key: string): Promise<string | null> {
      calls.getConfig++;
      return rows[key] ?? null;
    },
    async getAllConfig(): Promise<Record<string, string>> {
      calls.getAllConfig++;
      return { ...rows };
    },
  };
}

function perKeyOnlyEngine(rows: Record<string, string>) {
  const { calls, getConfig } = countingEngine(rows);
  return { calls, getConfig };
}

describe('loadSearchModeConfig config reads', () => {
  test('an engine with getAllConfig is read once, with no per-key reads', async () => {
    const engine = countingEngine({ 'search.mode': 'balanced' });
    const out = await loadSearchModeConfig(engine);
    expect(out.mode).toBe('balanced');
    expect(engine.calls.getAllConfig).toBe(1);
    expect(engine.calls.getConfig).toBe(0);
  });

  test('an engine without getAllConfig falls back to one read per key', async () => {
    // Engines implemented outside this repo may not have the bulk read.
    const engine = perKeyOnlyEngine({ 'search.mode': 'balanced' });
    const out = await loadSearchModeConfig(engine);
    expect(out.mode).toBe('balanced');
    expect(engine.calls.getConfig).toBe(SEARCH_MODE_CONFIG_KEYS.length + 1);
  });

  test('the snapshot path returns the same values as per-key reads', async () => {
    const rows = {
      'search.mode': 'tokenmax',
      'search.reranker.top_n_in': '15',
      'search.autocut_jump': '1.0',
      'search.limit': '7',
    };
    const viaSnapshot = await loadSearchModeConfig(countingEngine(rows));
    const perKey = await loadSearchModeConfig(perKeyOnlyEngine(rows));
    expect(viaSnapshot).toEqual(perKey);
    expect(viaSnapshot.mode).toBe('tokenmax');
  });

  test('a failing getAllConfig falls back to per-key reads and still resolves the mode', async () => {
    const engine = countingEngine({ 'search.mode': 'conservative' });
    engine.getAllConfig = async () => {
      engine.calls.getAllConfig++;
      throw new Error('relation "config" does not exist');
    };
    const out = await loadSearchModeConfig(engine);
    expect(out.mode).toBe('conservative');
    expect(engine.calls.getAllConfig).toBe(1);
    expect(engine.calls.getConfig).toBe(SEARCH_MODE_CONFIG_KEYS.length + 1);
  });
});
