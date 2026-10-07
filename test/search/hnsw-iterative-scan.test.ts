/**
 * #6132 idea: filtered vector search runs pgvector's iterative scan in
 * relaxed_order by default (strict_order drops a closer candidate found
 * late); `search.hnsw_iterative_scan` / GBRAIN_HNSW_ITERATIVE_SCAN restore
 * strict_order or off without a release. ef_search sizing is unchanged.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { withVectorSettings } from '../../src/core/search/vector-settings.ts';
import { hnswEfSearchFor } from '../../src/core/vector-index.ts';
import {
  _resetHnswIterativeScanForTests,
  readHnswIterativeScan,
  resolveHnswIterativeScan,
} from '../../src/core/search/hnsw-iterative-scan.ts';
import { searchConfigValueRefusal } from '../../src/core/search/config-values.ts';

async function appliedSettings(iterative: boolean, mode?: 'relaxed_order' | 'strict_order' | 'off'): Promise<Record<string, string>> {
  const sets: Array<[string[], string[]]> = [];
  const query = async (sql: string, params: unknown[]) => {
    if (sql.includes('set_config')) sets.push(params as [string[], string[]]);
    return (params[0] as string[]).map((name) => ({ name, value: null }));
  };
  const args: Parameters<typeof withVectorSettings> = [query, iterative, 200, 20_000, async () => 'ok', undefined];
  if (mode) args.push(mode);
  await withVectorSettings(...args);
  const [names, values] = sets[0]!;
  return Object.fromEntries(names.map((n, i) => [n, values[i]!]));
}

afterEach(() => _resetHnswIterativeScanForTests());

describe('hnsw.iterative_scan mode', () => {
  test('an iterative scan runs relaxed_order by default and keeps ef_search sizing', async () => {
    const s = await appliedSettings(true);
    expect(s['hnsw.iterative_scan']).toBe('relaxed_order');
    expect(s['hnsw.ef_search']).toBe(String(hnswEfSearchFor(200)));
    expect(s['hnsw.max_scan_tuples']).toBe('20000');
  });

  test('the override restores strict_order or turns iterative scanning off', async () => {
    expect((await appliedSettings(true, 'strict_order'))['hnsw.iterative_scan']).toBe('strict_order');
    expect((await appliedSettings(true, 'off'))['hnsw.iterative_scan']).toBe('off');
  });

  test('an engine without iterative scan support sets no iterative mode', async () => {
    expect((await appliedSettings(false))['hnsw.iterative_scan']).toBeUndefined();
  });

  test('env wins over config; config over the default; an invalid value falls back to the default', () => {
    expect(readHnswIterativeScan({ search: { hnsw_iterative_scan: 'strict_order' } }, {})).toEqual({ mode: 'strict_order', via: 'config' });
    expect(readHnswIterativeScan({ search: { hnsw_iterative_scan: 'strict_order' } }, { GBRAIN_HNSW_ITERATIVE_SCAN: 'off' })).toEqual({ mode: 'off', via: 'env' });
    expect(readHnswIterativeScan({ search: { hnsw_iterative_scan: 'sideways' } }, {})).toEqual({ mode: 'relaxed_order', via: null });
    expect(readHnswIterativeScan(null, {})).toEqual({ mode: 'relaxed_order', via: null });
  });

  test('resolved once per process', () => {
    expect(resolveHnswIterativeScan({ search: { hnsw_iterative_scan: 'strict_order' } })).toBe('strict_order');
    expect(resolveHnswIterativeScan({ search: { hnsw_iterative_scan: 'off' } })).toBe('strict_order');
  });

  test('config set refuses an invalid value with the valid modes and an example', () => {
    expect(searchConfigValueRefusal('search.hnsw_iterative_scan', 'relaxed_order')).toBeNull();
    expect(searchConfigValueRefusal('search.hnsw_iterative_scan', 'Strict_Order')).toBeNull();
    const refusal = searchConfigValueRefusal('search.hnsw_iterative_scan', 'sideways');
    expect(refusal?.message).toContain('relaxed_order | strict_order | off');
    expect(refusal?.example).toBe('relaxed_order');
  });
});
