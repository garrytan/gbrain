/**
 * v0.42.63 — persistent `search.source_boosts` config + cache-key
 * participation (U2 of the typed-personal-streams enablement).
 *
 * Pins:
 *   1. Resolution ladder: DEFAULT_SOURCE_BOOSTS ← config ← env (env last —
 *      the emergency override that beats config).
 *   2. Malformed config entries are skipped LOUDLY (stderr warning) and
 *      never poison the rest of the map.
 *   3. knobsHash (v=13) differs across distinct boost maps and is stable
 *      across key insertion order.
 *   4. buildSourceFactorCase reflects a config-supplied prefix.
 *   5. Upgrade continuity: no config + no env resolves to exactly
 *      DEFAULT_SOURCE_BOOSTS, so its hash equals the default-map hash.
 */
import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_SOURCE_BOOSTS,
  SOURCE_BOOSTS_CONFIG_KEY,
  parseSourceBoostConfig,
  resolveSourceBoostsForEngine,
  serializeBoostMap,
} from '../src/core/search/source-boost.ts';
import { buildSourceFactorCase } from '../src/core/search/sql-ranking.ts';
import { knobsHash, resolveSearchMode } from '../src/core/search/mode.ts';

function fakeEngine(value: string | null): { getConfig(key: string): Promise<string | null> } {
  return {
    async getConfig(key: string) {
      expect(key).toBe(SOURCE_BOOSTS_CONFIG_KEY);
      return value;
    },
  };
}

/** Capture console.error calls without leaking the patch on throw. */
function withCapturedStderr<T>(fn: () => T): { result: T; warnings: string[] } {
  const warnings: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  try {
    return { result: fn(), warnings };
  } finally {
    console.error = orig;
  }
}

describe('parseSourceBoostConfig', () => {
  test('valid JSON object parses; numeric strings coerce', () => {
    const { result, warnings } = withCapturedStderr(() =>
      parseSourceBoostConfig('{"resources/":0.8,"emails/":"0.5"}'),
    );
    expect(result).toEqual({ 'resources/': 0.8, 'emails/': 0.5 });
    expect(warnings).toHaveLength(0);
  });

  test('unset / blank → empty map, no warning', () => {
    const { result, warnings } = withCapturedStderr(() => [
      parseSourceBoostConfig(null),
      parseSourceBoostConfig(undefined),
      parseSourceBoostConfig('   '),
    ]);
    expect(result).toEqual([{}, {}, {}]);
    expect(warnings).toHaveLength(0);
  });

  test('invalid JSON → empty map + loud warning', () => {
    const { result, warnings } = withCapturedStderr(() => parseSourceBoostConfig('{not json'));
    expect(result).toEqual({});
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain(SOURCE_BOOSTS_CONFIG_KEY);
  });

  test('non-object JSON (array, scalar) → empty map + warning', () => {
    const arr = withCapturedStderr(() => parseSourceBoostConfig('["resources/"]'));
    expect(arr.result).toEqual({});
    expect(arr.warnings.length).toBe(1);
    const num = withCapturedStderr(() => parseSourceBoostConfig('0.8'));
    expect(num.result).toEqual({});
    expect(num.warnings.length).toBe(1);
  });

  test('malformed entries skipped loudly; valid entries survive', () => {
    const { result, warnings } = withCapturedStderr(() =>
      parseSourceBoostConfig('{"resources/":0.8,"bad-negative/":-1,"bad-nan/":"xyz","":2,"ok/":1.5}'),
    );
    expect(result).toEqual({ 'resources/': 0.8, 'ok/': 1.5 });
    expect(warnings.length).toBe(3);
    for (const w of warnings) expect(w).toContain('skipping malformed');
  });
});

describe('resolveSourceBoostsForEngine — the ladder', () => {
  test('config overrides default for a prefix; defaults survive elsewhere', async () => {
    const map = await resolveSourceBoostsForEngine(fakeEngine('{"daily/":0.4}'), undefined);
    expect(map['daily/']).toBe(0.4); // config beat the 0.8 default
    expect(map['originals/']).toBe(DEFAULT_SOURCE_BOOSTS['originals/']);
  });

  test('env overrides config for the same prefix (emergency override)', async () => {
    const map = await resolveSourceBoostsForEngine(fakeEngine('{"daily/":0.4}'), 'daily/:0.1');
    expect(map['daily/']).toBe(0.1);
  });

  test('config-only prefixes are added; env-only prefixes are added', async () => {
    const map = await resolveSourceBoostsForEngine(
      fakeEngine('{"resources/":0.8}'),
      'emails/:0.5',
    );
    expect(map['resources/']).toBe(0.8);
    expect(map['emails/']).toBe(0.5);
  });

  test('getConfig throwing falls through to defaults + env (fail-open)', async () => {
    const engine = {
      async getConfig(): Promise<string | null> {
        throw new Error('db down');
      },
    };
    const map = await resolveSourceBoostsForEngine(engine, 'daily/:0.2');
    expect(map['daily/']).toBe(0.2);
    expect(map['originals/']).toBe(DEFAULT_SOURCE_BOOSTS['originals/']);
  });

  test('no config + no env resolves to exactly DEFAULT_SOURCE_BOOSTS', async () => {
    const map = await resolveSourceBoostsForEngine(fakeEngine(null), undefined);
    expect(map).toEqual(DEFAULT_SOURCE_BOOSTS);
  });
});

describe('serializeBoostMap — canonical form', () => {
  test('stable across key insertion order; fixed decimals', () => {
    const a = serializeBoostMap({ 'b/': 0.8, 'a/': 1.2 });
    const b = serializeBoostMap({ 'a/': 1.2, 'b/': 0.8 });
    expect(a).toBe(b);
    expect(a).toBe('a/:1.2000,b/:0.8000');
  });

  test('0.85 and 0.851 serialize differently (4-decimal precision)', () => {
    expect(serializeBoostMap({ 'x/': 0.85 })).not.toBe(serializeBoostMap({ 'x/': 0.851 }));
  });
});

describe('knobsHash v=13 — boost map participates in the cache key', () => {
  const knobs = resolveSearchMode({ mode: 'balanced' });

  test('two distinct boost maps hash differently', () => {
    const h1 = knobsHash(knobs, { sourceBoosts: { 'resources/': 0.8 } });
    const h2 = knobsHash(knobs, { sourceBoosts: { 'resources/': 0.9 } });
    expect(h1).not.toBe(h2);
  });

  test('hash is stable across key insertion order', () => {
    const h1 = knobsHash(knobs, { sourceBoosts: { 'a/': 1.2, 'b/': 0.8 } });
    const h2 = knobsHash(knobs, { sourceBoosts: { 'b/': 0.8, 'a/': 1.2 } });
    expect(h1).toBe(h2);
  });

  test('undefined ctx.sourceBoosts (legacy caller) hashes differently from a threaded map', () => {
    const legacy = knobsHash(knobs);
    const threaded = knobsHash(knobs, { sourceBoosts: DEFAULT_SOURCE_BOOSTS });
    expect(legacy).not.toBe(threaded);
  });

  test('upgrade continuity: no-config/no-env resolution hashes identically to the default map', async () => {
    const resolved = await resolveSourceBoostsForEngine(fakeEngine(null), undefined);
    const h1 = knobsHash(knobs, { sourceBoosts: resolved });
    const h2 = knobsHash(knobs, { sourceBoosts: { ...DEFAULT_SOURCE_BOOSTS } });
    expect(h1).toBe(h2);
  });
});

describe('buildSourceFactorCase — config-supplied prefix reaches SQL', () => {
  test('config prefix + factor appear in the CASE fragment', async () => {
    const map = await resolveSourceBoostsForEngine(fakeEngine('{"resources/":0.8}'), undefined);
    const sql = buildSourceFactorCase('p.slug', map, undefined);
    expect(sql).toContain("LIKE 'resources/%'");
    expect(sql).toContain('THEN 0.8');
  });

  test("detail 'high' still bypasses boosts entirely", async () => {
    const map = await resolveSourceBoostsForEngine(fakeEngine('{"resources/":0.8}'), undefined);
    expect(buildSourceFactorCase('p.slug', map, 'high')).toBe('1.0');
  });
});
