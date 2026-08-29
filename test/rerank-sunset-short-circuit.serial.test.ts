/**
 * #3657 post-sunset rerank short-circuit (refs #3657, amendments X7+F3).
 *
 * Past a listed reranker provider's announced shutdown date, gateway.rerank()
 * must skip the HTTP call entirely (no transport hit — the only thing left to
 * burn is the 5s per-query timeout), throw the dedicated
 * `sunset_short_circuit` reason so applyReranker fails open immediately,
 * write ONE `rerank-failures` audit row per process per model, and emit one
 * stderr line per process. A base-URL override suppresses the short-circuit
 * (self-hosted wire-compatible endpoints outlive the hosted shutdown — same
 * rule warnSunsetOnce applies).
 *
 * X7: the check runs where the EFFECTIVE model is resolved — an ABSENT
 * per-call model landing on the configured/legacy default (the main case) is
 * covered explicitly. Date matrix (before/on/after 2026-09-04) runs on the
 * injected clock (`__setSunsetClockForTests`), never the wall clock.
 */

import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test';
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
import { readRecentRerankFailures } from '../src/core/rerank-audit.ts';
import {
  LEGACY_DEFAULT_RERANKER_MODEL,
  NEW_INSTALL_DEFAULT_RERANKER_MODEL,
  ZEROENTROPY_SUNSET_DATE,
} from '../src/core/ai/defaults.ts';
import type { SearchResult } from '../src/core/types.ts';
import { withEnv } from './helpers/with-env.ts';

// Concrete dates around the registry's 2026-09-04 sunset, derived from the
// constant so a registry change moves the matrix with it.
const BEFORE_SUNSET = new Date(Date.parse(`${ZEROENTROPY_SUNSET_DATE}T00:00:00Z`) - 1000);
const ON_SUNSET = new Date(`${ZEROENTROPY_SUNSET_DATE}T00:00:00Z`);
const AFTER_SUNSET = new Date(Date.parse(`${ZEROENTROPY_SUNSET_DATE}T00:00:00Z`) + 86_400_000);

function gwConfig(overrides: Record<string, unknown> = {}): any {
  return {
    embedding_model: 'openai:text-embedding-3-small',
    embedding_dimensions: 1536,
    env: {
      ZEROENTROPY_API_KEY: 'zk-test',
      VOYAGE_API_KEY: 'vk-test',
      OPENAI_API_KEY: 'sk-test',
    },
    ...overrides,
  };
}

/** Install a counting transport that returns a healthy rerank response. */
function installCountingTransport(): { count: () => number } {
  let calls = 0;
  __setRerankTransportForTests(async () => {
    calls++;
    return new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 0.9 }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { count: () => calls };
}

async function withFreshAuditDir(body: (dir: string) => void | Promise<void>): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-sunset-sc-'));
  try {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      await body(tmpDir);
    });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** Capture stderr writes for the duration of `body`; returns captured text. */
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
  // Serial-file hygiene: this suite reconfigures the module-global gateway
  // (fake ZE/Voyage keys) per test — restore a clean gateway so nothing
  // leaks into later files in the same process.
  resetGateway();
});

describe('gateway.rerank post-sunset short-circuit (#3657)', () => {
  test('ABSENT per-call model resolves to the legacy default and short-circuits after the date — no transport call', async () => {
    await withFreshAuditDir(async () => {
      // No reranker_model in config → effective model is the legacy
      // DEFAULT_RERANKER_MODEL (zerank family) — the X7 main case.
      configureGateway(gwConfig());
      const transport = installCountingTransport();
      __setSunsetClockForTests(() => AFTER_SUNSET);

      let err: unknown;
      try {
        await rerank({ query: 'q', documents: ['d1', 'd2'] });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(RerankError);
      expect((err as RerankError).reason).toBe('sunset_short_circuit');
      expect((err as RerankError).message).toContain(ZEROENTROPY_SUNSET_DATE);
      expect((err as RerankError).message).toContain(NEW_INSTALL_DEFAULT_RERANKER_MODEL);
      expect(transport.count()).toBe(0);
    });
  });

  test('EXPLICIT sunset model short-circuits even when the configured default is live', async () => {
    await withFreshAuditDir(async () => {
      configureGateway(gwConfig({ reranker_model: NEW_INSTALL_DEFAULT_RERANKER_MODEL }));
      const transport = installCountingTransport();
      __setSunsetClockForTests(() => AFTER_SUNSET);

      await expect(
        rerank({ query: 'q', documents: ['d'], model: LEGACY_DEFAULT_RERANKER_MODEL }),
      ).rejects.toMatchObject({ reason: 'sunset_short_circuit' });
      expect(transport.count()).toBe(0);
    });
  });

  test('base-URL override SUPPRESSES the short-circuit (self-host continuity) — transport is called', async () => {
    await withFreshAuditDir(async () => {
      configureGateway(gwConfig({
        base_urls: { zeroentropyai: 'http://127.0.0.1:9099/v1' },
      }));
      const transport = installCountingTransport();
      __setSunsetClockForTests(() => AFTER_SUNSET);

      const out = await rerank({ query: 'q', documents: ['d'], model: LEGACY_DEFAULT_RERANKER_MODEL });
      expect(out).toEqual([{ index: 0, relevanceScore: 0.9 }]);
      expect(transport.count()).toBe(1);
    });
  });

  test('date matrix: BEFORE the sunset the call goes through; ON and AFTER it short-circuits', async () => {
    await withFreshAuditDir(async () => {
      configureGateway(gwConfig());
      const transport = installCountingTransport();

      __setSunsetClockForTests(() => BEFORE_SUNSET);
      const out = await rerank({ query: 'q', documents: ['d'] });
      expect(out).toEqual([{ index: 0, relevanceScore: 0.9 }]);
      expect(transport.count()).toBe(1);

      // ON the date: the provider "shuts down ON this date" (same semantics
      // as doctor's provider_sunset check) — already short-circuited.
      __setSunsetClockForTests(() => ON_SUNSET);
      await expect(rerank({ query: 'q', documents: ['d'] }))
        .rejects.toMatchObject({ reason: 'sunset_short_circuit' });
      expect(transport.count()).toBe(1);

      __setSunsetClockForTests(() => AFTER_SUNSET);
      await expect(rerank({ query: 'q', documents: ['d'] }))
        .rejects.toMatchObject({ reason: 'sunset_short_circuit' });
      expect(transport.count()).toBe(1);
    });
  });

  test('a LIVE model after the date is untouched (registry is prefix-scoped)', async () => {
    await withFreshAuditDir(async () => {
      configureGateway(gwConfig());
      const transport = installCountingTransport();
      __setSunsetClockForTests(() => AFTER_SUNSET);

      const out = await rerank({ query: 'q', documents: ['d'], model: NEW_INSTALL_DEFAULT_RERANKER_MODEL });
      expect(out).toEqual([{ index: 0, relevanceScore: 0.9 }]);
      expect(transport.count()).toBe(1);
    });
  });

  test('F3 audit trail: ONE sunset_short_circuit row per process per model + one stderr line, across repeated calls', async () => {
    await withFreshAuditDir(async () => {
      configureGateway(gwConfig());
      installCountingTransport();
      __setSunsetClockForTests(() => AFTER_SUNSET);

      const stderrText = await captureStderr(async () => {
        for (let i = 0; i < 3; i++) {
          await expect(rerank({ query: `q${i}`, documents: ['d'] }))
            .rejects.toMatchObject({ reason: 'sunset_short_circuit' });
        }
      });

      const rows = readRecentRerankFailures(7);
      const scRows = rows.filter((r) => r.reason === 'sunset_short_circuit');
      expect(scRows).toHaveLength(1);
      expect(scRows[0]!.model).toBe(LEGACY_DEFAULT_RERANKER_MODEL);
      expect(scRows[0]!.error_summary).toContain(ZEROENTROPY_SUNSET_DATE);
      expect(scRows[0]!.error_summary).toContain(NEW_INSTALL_DEFAULT_RERANKER_MODEL);

      const stderrHits = stderrText.split('\n').filter((l) => l.includes('provider sunset'));
      expect(stderrHits).toHaveLength(1);
      expect(stderrHits[0]).toContain(LEGACY_DEFAULT_RERANKER_MODEL);
    });
  });
});

describe('applyReranker fail-open on post-sunset short-circuit (#3657)', () => {
  test('results pass through unchanged and unre-ranked; no per-query audit rows pile up', async () => {
    await withFreshAuditDir(async () => {
      configureGateway(gwConfig());
      const transport = installCountingTransport();
      __setSunsetClockForTests(() => AFTER_SUNSET);

      const results = mkResults();
      const snapshot = results.map((r) => r.slug);

      // Two searches — the gateway writes its one process-level row; the
      // applyReranker layer must not add per-query rows for this reason.
      const out1 = await applyReranker('query one', results, { enabled: true, topNIn: 30, topNOut: null });
      const out2 = await applyReranker('query two', results, { enabled: true, topNIn: 30, topNOut: null });

      expect(out1.map((r) => r.slug)).toEqual(snapshot);
      expect(out2.map((r) => r.slug)).toEqual(snapshot);
      expect(out1[0]!.rerank_score).toBeUndefined();
      expect(transport.count()).toBe(0);

      const rows = readRecentRerankFailures(7);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.reason).toBe('sunset_short_circuit');
    });
  });

  test('before the date applyReranker still reranks through the transport', async () => {
    await withFreshAuditDir(async () => {
      configureGateway(gwConfig());
      const transport = installCountingTransport();
      __setSunsetClockForTests(() => BEFORE_SUNSET);

      const results = mkResults();
      const out = await applyReranker('query', results, { enabled: true, topNIn: 30, topNOut: null });
      expect(transport.count()).toBe(1);
      expect(out[0]!.rerank_score).toBe(0.9);
      expect(readRecentRerankFailures(7)).toHaveLength(0);
    });
  });
});
