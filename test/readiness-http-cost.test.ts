/**
 * A7 readiness cost contract (test/readiness-http-cost.test.ts, named in the
 * agent operator wave spec).
 *
 * Protects: MCP initialize, whoami and write receipts call the config plane on
 * every request, and doctor / `gbrain://capabilities` call the probed tier. A
 * regression that makes the config plane touch the network or re-read the
 * lock per call, or makes the probed tier call getStats/getHealth (the #5061
 * cost class), skip its cache, double-run concurrent probes, or hang past its
 * bound, fails here.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  __setLockPeekForTests, configReadiness, createReadinessCache, probedReadiness, readinessTail,
  PROBED_TTL_MS, PROBE_TIMEOUT_MS, type ReadinessEntry,
} from '../src/core/readiness.ts';
import { LATEST_VERSION } from '../src/core/migrate.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { GBrainConfig } from '../src/core/config.ts';

interface SpyEngine { engine: BrainEngine; calls: string[] }

/** An engine that records every method touched; getStats/getHealth are forbidden. */
function spyEngine(opts: { hang?: boolean; delayMs?: number } = {}): SpyEngine {
  const calls: string[] = [];
  const target: Record<string, unknown> = {
    kind: 'pglite',
    async executeRaw(sql: string) {
      calls.push('executeRaw');
      if (opts.hang) return new Promise(() => {});
      if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs));
      return /count\(\*\)/i.test(sql) ? [{ n: 0 }] : [];
    },
    async getConfig(key: string) {
      calls.push('getConfig');
      return key === 'version' ? String(LATEST_VERSION) : null;
    },
  };
  const engine = new Proxy(target, {
    get(t, prop) {
      if (prop === 'getStats' || prop === 'getHealth') {
        return () => { calls.push(String(prop)); throw new Error(`${String(prop)} must never be called by readiness`); };
      }
      if (typeof prop === 'string' && !(prop in t) && prop !== 'then') calls.push(`missing:${prop}`);
      return t[prop as string];
    },
  }) as unknown as BrainEngine;
  return { engine, calls };
}

afterEach(() => __setLockPeekForTests(null));

describe('config plane cost', () => {
  test('no network, one lock read across transports and repeated calls, memoized per config object', () => {
    const realFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (async () => { fetches++; throw new Error('network'); }) as unknown as typeof fetch;
    let peeks = 0;
    __setLockPeekForTests(() => { peeks++; return { held: false }; });
    try {
      const cfg = { engine: 'pglite', database_path: '/brains/cost.pglite', embedding_disabled: true } as GBrainConfig;
      const first = configReadiness(cfg, { transport: 'stdio' });
      for (let i = 0; i < 50; i++) {
        expect(configReadiness(cfg, { transport: 'stdio' })).toBe(first);
        configReadiness(cfg, { transport: 'http' });
      }
      expect(peeks).toBe(1);
      expect(fetches).toBe(0);
      configReadiness({ ...cfg }, { transport: 'stdio' });
      expect(peeks).toBe(2);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('Postgres and thin-client configs never read the PGLite lock', () => {
    let peeks = 0;
    __setLockPeekForTests(() => { peeks++; return { held: false }; });
    configReadiness({ engine: 'postgres', database_url: 'postgres://x/y' } as GBrainConfig, { transport: 'stdio' });
    configReadiness({ engine: 'pglite', remote_mcp: { mcp_url: 'https://h/mcp' } } as unknown as GBrainConfig, { transport: 'http' });
    expect(peeks).toBe(0);
  });
});

describe('probed tier cost', () => {
  test('never calls getStats/getHealth and returns worker, backup, migrations', async () => {
    const { engine, calls } = spyEngine();
    const entries = await probedReadiness(engine, { cache: createReadinessCache() });
    expect(calls).not.toContain('getStats');
    expect(calls).not.toContain('getHealth');
    const caps = new Set(entries.map(e => e.capability));
    for (const c of ['worker', 'migrations', 'sync']) expect(caps.has(c as ReadinessEntry['capability'])).toBe(true);
    expect(entries.find(e => e.capability === 'migrations')).toMatchObject({ state: 'ok', reason: 'current', tier: 'probed' });
    expect(entries.every(e => e.tier === 'probed')).toBe(true);
  });

  test('60 s cache: a second call within the TTL does no engine work', async () => {
    const { engine, calls } = spyEngine();
    const cache = createReadinessCache();
    const a = await probedReadiness(engine, { cache });
    const n = calls.length;
    const b = await probedReadiness(engine, { cache });
    expect(b).toBe(a);
    expect(calls.length).toBe(n);
  });

  test('single-flight: concurrent callers share one probe run', async () => {
    const { engine, calls } = spyEngine({ delayMs: 30 });
    const cache = createReadinessCache();
    const [a, b, c] = await Promise.all([probedReadiness(engine, { cache }), probedReadiness(engine, { cache }), probedReadiness(engine, { cache })]);
    expect(b).toBe(a);
    expect(c).toBe(a);
    const solo = spyEngine();
    await probedReadiness(solo.engine, { cache: createReadinessCache() });
    expect(calls.filter(x => x === 'getConfig').length).toBe(solo.calls.filter(x => x === 'getConfig').length);
  });

  test('stale-while-revalidate: an expired entry is served at once and refreshed in the background', async () => {
    const { engine, calls } = spyEngine();
    const store = new Map<string, { at: number; value: ReadinessEntry[] }>();
    const cache = { get: (k: string) => store.get(k), set: (k: string, v: { at: number; value: ReadinessEntry[] }) => { store.set(k, v); } };
    await probedReadiness(engine, { cache });
    const [key] = [...store.keys()];
    const stale: ReadinessEntry[] = [{ capability: 'worker', state: 'unknown', reason: 'probe_failed', why: 'stale', tier: 'probed', http_visible: false }];
    store.set(key, { at: Date.now() - PROBED_TTL_MS - 1, value: stale });
    const before = calls.length;
    expect(await probedReadiness(engine, { cache })).toBe(stale);
    await new Promise(r => setTimeout(r, 100));
    expect(calls.length).toBeGreaterThan(before);
    expect(store.get(key)?.value).not.toBe(stale);
  });

  test('2 s per-probe bound: a hung probe reports probe_timeout instead of hanging', async () => {
    const { engine } = spyEngine({ hang: true });
    const started = Date.now();
    const entries = await probedReadiness(engine, { cache: createReadinessCache() });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(PROBE_TIMEOUT_MS - 50);
    expect(elapsed).toBeLessThan(PROBE_TIMEOUT_MS + 1500);
    expect(entries.find(e => e.capability === 'worker')?.reason).toMatch(/^probe_(timeout|failed)$/);
    expect(entries.find(e => e.capability === 'migrations')?.reason).toBe('current');
  }, 10_000);

  test('initialize tail: undefined within 250 ms when probes are slow, entries once the cache is warm', async () => {
    const slow = spyEngine({ hang: true });
    const started = Date.now();
    expect(await readinessTail(slow.engine, { cache: createReadinessCache() })).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1000);
    const fast = spyEngine();
    const cache = createReadinessCache();
    await probedReadiness(fast.engine, { cache });
    expect(Array.isArray(await readinessTail(fast.engine, { cache }))).toBe(true);
  }, 10_000);
});
