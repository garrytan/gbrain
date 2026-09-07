/**
 * v0.48.2 — `no_key` reranker preflight (fail-open, audit-only, once per
 * process per model).
 *
 * With the default reranker now keyed on VOYAGE_API_KEY, a keyless balanced
 * brain reaches gateway.rerank() on every search. Pins:
 *  - the HTTP call is skipped and RerankError('no_key') is thrown;
 *  - ONE audit row per process per model across repeated calls, and NO
 *    stderr line (a shell-per-query agent must not see a line per search);
 *  - `_resetSunsetWarningsForTest()` clears the memo (test seam);
 *  - sunset keeps precedence over no_key (explicit ZE model after the date,
 *    no ZE key → sunset_short_circuit);
 *  - HTTP 401/403 with the key present stays `auth` (key present but rejected);
 *  - applyReranker passes results through unchanged, adds no per-query row,
 *    and fires `onSkip('no_key')` so hybrid.ts can stamp `reranker_skipped`.
 *
 * Serial: reconfigures the module-global gateway + the once-per-process memo.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  configureGateway,
  resetGateway,
  rerank,
  RerankError,
  __setRerankTransportForTests,
  __setSunsetClockForTests,
  _resetSunsetWarningsForTest,
} from '../src/core/ai/gateway.ts';
import { applyReranker } from '../src/core/search/rerank.ts';
import { BudgetTracker, BudgetExhausted } from '../src/core/budget/budget-tracker.ts';
import { withBudgetTracker } from '../src/core/ai/gateway.ts';
import { readRecentRerankFailures } from '../src/core/rerank-audit.ts';
import {
  DEFAULT_RERANKER_MODEL,
  LEGACY_DEFAULT_RERANKER_MODEL,
  ZEROENTROPY_SUNSET_DATE,
} from '../src/core/ai/defaults.ts';
import type { SearchResult } from '../src/core/types.ts';
import { withEnv } from './helpers/with-env.ts';

const AFTER_SUNSET = new Date(Date.parse(`${ZEROENTROPY_SUNSET_DATE}T00:00:00Z`) + 86_400_000);

/** Gateway config with an OpenAI embedding key and NO reranker key. */
function keylessGw(overrides: Record<string, unknown> = {}): any {
  return {
    embedding_model: 'openai:text-embedding-3-small',
    embedding_dimensions: 1536,
    env: { OPENAI_API_KEY: 'sk-test' },
    ...overrides,
  };
}

function installCountingTransport(status = 200): { count: () => number } {
  let calls = 0;
  __setRerankTransportForTests(async () => {
    calls++;
    return new Response(
      status === 200 ? JSON.stringify({ results: [{ index: 0, relevance_score: 0.9 }] }) : 'Unauthorized',
      { status, headers: { 'content-type': 'application/json' } },
    );
  });
  return { count: () => calls };
}

async function withFreshAuditDir(body: (dir: string) => void | Promise<void>): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-no-key-'));
  try {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      await body(tmpDir);
    });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function captureStderr(body: () => Promise<void>): Promise<string> {
  const orig = process.stderr.write.bind(process.stderr);
  let captured = '';
  (process.stderr as any).write = (chunk: any, ...rest: any[]) => {
    captured += typeof chunk === 'string' ? chunk : String(chunk);
    return orig(chunk, ...rest);
  };
  try {
    await body();
  } finally {
    (process.stderr as any).write = orig;
  }
  return captured;
}

function mkResults(): SearchResult[] {
  return [
    { slug: 'a', page_id: 1, title: 'A', type: 'note', chunk_text: 'alpha', chunk_source: 'compiled_truth', chunk_id: 1, chunk_index: 0, score: 0.9, stale: false },
    { slug: 'b', page_id: 2, title: 'B', type: 'note', chunk_text: 'beta', chunk_source: 'compiled_truth', chunk_id: 2, chunk_index: 0, score: 0.8, stale: false },
  ] as SearchResult[];
}

beforeEach(() => {
  _resetSunsetWarningsForTest();
});

afterEach(() => {
  __setRerankTransportForTests(null);
  __setSunsetClockForTests(null);
});

afterAll(() => {
  _resetSunsetWarningsForTest();
  resetGateway();
});

describe('gateway.rerank no_key preflight (v0.48.2)', () => {
  test('default voyage model, no VOYAGE_API_KEY → RerankError(no_key) before any HTTP call', async () => {
    await withFreshAuditDir(async () => {
      configureGateway(keylessGw());
      const transport = installCountingTransport();

      let err: unknown;
      try {
        await rerank({ query: 'q', documents: ['d1', 'd2'] });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(RerankError);
      expect((err as RerankError).reason).toBe('no_key');
      expect((err as Error).message).toContain('VOYAGE_API_KEY');
      expect((err as Error).message).toContain('search.reranker.enabled false');
      expect(transport.count()).toBe(0);
    });
  });

  test('ONE no_key audit row per process per model across repeated calls, and NO stderr line', async () => {
    await withFreshAuditDir(async () => {
      configureGateway(keylessGw());
      installCountingTransport();

      const stderrText = await captureStderr(async () => {
        for (let i = 0; i < 3; i++) {
          await expect(rerank({ query: `q${i}`, documents: ['d'] })).rejects.toMatchObject({ reason: 'no_key' });
        }
      });

      const rows = readRecentRerankFailures(7).filter((r) => r.reason === 'no_key');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.model).toBe(DEFAULT_RERANKER_MODEL);
      expect(rows[0]!.error_summary).toContain('VOYAGE_API_KEY not set');
      expect(rows[0]!.error_summary).toContain('search.reranker.enabled false');
      expect(stderrText).not.toContain('VOYAGE_API_KEY');
    });
  });

  test('the once-per-process memo is per MODEL, and the test seam clears it', async () => {
    await withFreshAuditDir(async () => {
      configureGateway(keylessGw());
      installCountingTransport();

      await expect(rerank({ query: 'q', documents: ['d'] })).rejects.toMatchObject({ reason: 'no_key' });
      await expect(rerank({ query: 'q', documents: ['d'], model: 'voyage:rerank-2.5-lite' })).rejects.toMatchObject({ reason: 'no_key' });
      expect(readRecentRerankFailures(7).filter((r) => r.reason === 'no_key')).toHaveLength(2);

      _resetSunsetWarningsForTest();
      await expect(rerank({ query: 'q', documents: ['d'] })).rejects.toMatchObject({ reason: 'no_key' });
      expect(readRecentRerankFailures(7).filter((r) => r.reason === 'no_key')).toHaveLength(3);
    });
  });

  test('sunset keeps precedence: explicit ZE model after the date with no ZE key → sunset_short_circuit, not no_key', async () => {
    await withFreshAuditDir(async () => {
      configureGateway(keylessGw({ reranker_model: LEGACY_DEFAULT_RERANKER_MODEL }));
      installCountingTransport();
      __setSunsetClockForTests(() => AFTER_SUNSET);

      await expect(rerank({ query: 'q', documents: ['d'] })).rejects.toMatchObject({ reason: 'sunset_short_circuit' });
      const rows = readRecentRerankFailures(7);
      expect(rows.map((r) => r.reason)).toEqual(['sunset_short_circuit']);
    });
  });

  test('under a cost cap, a skipped rerank reserves NOTHING (no leaked projection, no spurious budget failure)', async () => {
    await withFreshAuditDir(async (dir) => {
      configureGateway(keylessGw());
      installCountingTransport();
      // A cap so tight that ANY reservation would throw BudgetExhausted
      // before the call — if the reserve still ran ahead of the preflights,
      // the first keyless call would fail with reason 'budget', not 'no_key'.
      const tracker = new BudgetTracker({ maxCostUsd: 1e-9, label: 'no-key-budget', auditPath: path.join(dir, 'budget.jsonl') });
      for (let i = 0; i < 3; i++) {
        await expect(
          withBudgetTracker(tracker, () => rerank({ query: `q${i}`, documents: ['d'] })),
        ).rejects.toMatchObject({ reason: 'no_key' });
      }
      expect(tracker.totalSpent).toBe(0);
    });
  });

  test('key present + exhausted cap → BudgetExhausted BEFORE the transport call; applyReranker files a `budget` row', async () => {
    await withFreshAuditDir(async (dir) => {
      configureGateway(keylessGw({ env: { OPENAI_API_KEY: 'sk-test', VOYAGE_API_KEY: 'pa-test' } }));
      const transport = installCountingTransport();
      const tracker = new BudgetTracker({ maxCostUsd: 1e-9, label: 'cap', auditPath: path.join(dir, 'b.jsonl') });
      await expect(withBudgetTracker(tracker, () => rerank({ query: 'q', documents: ['d'] }))).rejects.toBeInstanceOf(BudgetExhausted);
      expect(transport.count()).toBe(0);
      const out = await withBudgetTracker(tracker, () => applyReranker('q', mkResults(), { enabled: true, topNIn: 30, topNOut: null }));
      expect(out.map((r) => r.slug)).toEqual(['a', 'b']);
      expect(readRecentRerankFailures(7).map((r) => r.reason)).toEqual(['budget']);
    });
  });

  test('key present but rejected (HTTP 401) stays `auth`', async () => {
    await withFreshAuditDir(async () => {
      configureGateway(keylessGw({ env: { OPENAI_API_KEY: 'sk-test', VOYAGE_API_KEY: 'pa-bad' } }));
      const transport = installCountingTransport(401);

      await expect(rerank({ query: 'q', documents: ['d'] })).rejects.toMatchObject({ reason: 'auth' });
      expect(transport.count()).toBe(1);
      // The gateway writes no row for auth — applyReranker does, per query.
      expect(readRecentRerankFailures(7)).toHaveLength(0);
    });
  });

  test('key present → the call goes through (no row, no skip)', async () => {
    await withFreshAuditDir(async () => {
      configureGateway(keylessGw({ env: { OPENAI_API_KEY: 'sk-test', VOYAGE_API_KEY: 'pa-test' } }));
      const transport = installCountingTransport();

      const out = await rerank({ query: 'q', documents: ['d'] });
      expect(out).toEqual([{ index: 0, relevanceScore: 0.9 }]);
      expect(transport.count()).toBe(1);
      expect(readRecentRerankFailures(7)).toHaveLength(0);
    });
  });
});

describe('applyReranker on no_key (v0.48.2)', () => {
  test('results pass through unchanged, no per-query rows, onSkip fires with no_key', async () => {
    await withFreshAuditDir(async () => {
      configureGateway(keylessGw());
      const transport = installCountingTransport();

      const results = mkResults();
      const snapshot = results.map((r) => r.slug);
      const skips: string[] = [];
      const opts = { enabled: true, topNIn: 30, topNOut: null, onSkip: (reason: string) => skips.push(reason) };

      const out1 = await applyReranker('query one', results, opts);
      const out2 = await applyReranker('query two', results, opts);

      expect(out1.map((r) => r.slug)).toEqual(snapshot);
      expect(out2.map((r) => r.slug)).toEqual(snapshot);
      expect(out1[0]!.rerank_score).toBeUndefined();
      expect(transport.count()).toBe(0);
      expect(skips).toEqual(['no_key', 'no_key']);

      // ONE gateway row for the process; applyReranker adds none.
      const rows = readRecentRerankFailures(7);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.reason).toBe('no_key');
    });
  });

  test('a throwing onSkip hook never breaks search', async () => {
    await withFreshAuditDir(async () => {
      configureGateway(keylessGw());
      installCountingTransport();
      const results = mkResults();
      const out = await applyReranker('q', results, {
        enabled: true,
        topNIn: 30,
        topNOut: null,
        onSkip: () => { throw new Error('hook bug'); },
      });
      expect(out.map((r) => r.slug)).toEqual(['a', 'b']);
    });
  });

  test('a genuine failure (auth) does NOT fire onSkip and DOES write a per-query row', async () => {
    await withFreshAuditDir(async () => {
      configureGateway(keylessGw({ env: { OPENAI_API_KEY: 'sk-test', VOYAGE_API_KEY: 'pa-bad' } }));
      installCountingTransport(401);
      const skips: string[] = [];
      const out = await applyReranker('q', mkResults(), {
        enabled: true, topNIn: 30, topNOut: null, onSkip: (r: string) => skips.push(r),
      });
      expect(out.map((r) => r.slug)).toEqual(['a', 'b']);
      expect(skips).toEqual([]);
      expect(readRecentRerankFailures(7).map((r) => r.reason)).toEqual(['auth']);
    });
  });
});
