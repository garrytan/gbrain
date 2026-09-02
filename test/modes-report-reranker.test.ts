/**
 * v0.48.2 — `gbrain search modes` surfaces the reranker knobs + a readiness
 * line, so "what reranker am I running, and is it actually running?" is
 * answerable from the dashboard (JSON and text).
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { buildModesReport, redactReadinessForRemote } from '../src/core/search/modes-report.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { _exports_for_test } from '../src/commands/search.ts';
import { DEFAULT_RERANKER_MODEL } from '../src/core/ai/defaults.ts';
import { withEnv, emptyHome } from './helpers/with-env.ts';

function engineWith(rows: Record<string, string>): any {
  return {
    async getConfig(key: string): Promise<string | null> {
      return rows[key] ?? null;
    },
  };
}

// Readiness reads the LIVE gateway plane (what rerank() consults); model each
// scenario by configuring the gateway with the keys the CLI would have folded.
function gw(env: Record<string, string>, extra: Record<string, unknown> = {}): void {
  configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-test', ...env }, ...extra });
}
beforeEach(() => resetGateway());
afterAll(() => resetGateway());

describe('buildModesReport — reranker knobs + readiness', () => {
  test('the five reranker knobs are attributed like every other knob', async () => {
    await withEnv({ VOYAGE_API_KEY: undefined, GBRAIN_HOME: emptyHome() }, async () => {
      gw({});
      const report = await buildModesReport(engineWith({}));
      for (const k of ['reranker_enabled', 'reranker_model', 'reranker_top_n_in', 'reranker_top_n_out', 'reranker_timeout_ms'] as const) {
        expect(report.resolved[k]).toBeDefined();
        expect(typeof report.resolved[k].description).toBe('string');
      }
      expect(report.resolved.reranker_model.value).toBe(DEFAULT_RERANKER_MODEL);
      expect(report.resolved.reranker_enabled.value).toBe(true); // balanced fallback
      expect(report.resolved.reranker_model.source).toBe('fallback'); // unset mode → balanced fallback bundle
    });
  });

  test('readiness block: key absent → not ready with a fix; key present → ready', async () => {
    await withEnv({ VOYAGE_API_KEY: undefined, GBRAIN_HOME: emptyHome() }, async () => {
      gw({});
      const report = await buildModesReport(engineWith({}));
      const rr = report.reranker_readiness!;
      expect(rr.model).toBe(DEFAULT_RERANKER_MODEL);
      expect(rr.enabled).toBe(true);
      expect(rr.required_key).toBe('VOYAGE_API_KEY');
      expect(rr.key_present).toBe(false);
      expect(rr.ready).toBe(false);
      expect(rr.self_hosted).toBe(false);
      expect(rr.fix).toContain('VOYAGE_API_KEY');
    });
    await withEnv({ VOYAGE_API_KEY: 'pa-test' }, async () => {
      gw({ VOYAGE_API_KEY: 'pa-test' });
      const report = await buildModesReport(engineWith({}));
      const rr = report.reranker_readiness!;
      expect(rr.key_present).toBe(true);
      expect(rr.ready).toBe(true);
      expect(rr.fix).toBeNull();
    });
  });

  test('config override is reflected (explicit model + disabled)', async () => {
    await withEnv({ VOYAGE_API_KEY: undefined, GBRAIN_HOME: emptyHome() }, async () => {
      gw({});
      const report = await buildModesReport(engineWith({
        'search.reranker.enabled': 'false',
        'search.reranker.model': 'voyage:rerank-2.5-lite',
      }));
      expect(report.resolved.reranker_model.value).toBe('voyage:rerank-2.5-lite');
      expect(report.resolved.reranker_model.source).toBe('override');
      expect(report.reranker_readiness!.enabled).toBe(false);
      expect(report.reranker_readiness!.model).toBe('voyage:rerank-2.5-lite');
    });
  });
});

describe('formatModesText — reranker lines', () => {
  test('runtime line + per-bundle reranker/autocut line', async () => {
    await withEnv({ VOYAGE_API_KEY: undefined, GBRAIN_HOME: emptyHome() }, async () => {
      gw({});
      const report = await buildModesReport(engineWith({}));
      const text = _exports_for_test.formatModesText(report);
      expect(text).toContain(`Reranker: ${DEFAULT_RERANKER_MODEL} (enabled but NOT running)`);
      expect(text).toContain('VOYAGE_API_KEY');
      expect(text).toContain(`reranker=${DEFAULT_RERANKER_MODEL} topNIn=25 autocut=true`); // balanced
      expect(text).toContain('reranker=off topNIn=30 autocut=false'); // conservative
      expect(text).toContain(`reranker=${DEFAULT_RERANKER_MODEL} topNIn=50 autocut=true`); // tokenmax
    });
    await withEnv({ VOYAGE_API_KEY: 'pa-test' }, async () => {
      gw({ VOYAGE_API_KEY: 'pa-test' });
      const report = await buildModesReport(engineWith({}));
      const text = _exports_for_test.formatModesText(report);
      expect(text).toContain(`Reranker: ${DEFAULT_RERANKER_MODEL} (enabled) — VOYAGE_API_KEY present`);
    });
    await withEnv({ VOYAGE_API_KEY: undefined, GBRAIN_HOME: emptyHome() }, async () => {
      gw({});
      const report = await buildModesReport(engineWith({ 'search.reranker.enabled': 'false' }));
      const text = _exports_for_test.formatModesText(report);
      expect(text).toContain('Reranker: off (resolved)');
    });
  });

  test('a base-URL override on the gateway plane surfaces as self_hosted=true', async () => {
    await withEnv({ GBRAIN_HOME: emptyHome(), VOYAGE_API_KEY: undefined }, async () => {
      gw({ ZEROENTROPY_API_KEY: 'zk' }, { base_urls: { zeroentropyai: 'http://127.0.0.1:8080/v1' } });
      const report = await buildModesReport(engineWith({ 'search.reranker.model': 'zeroentropyai:zerank-2' }));
      expect(report.reranker_readiness!.self_hosted).toBe(true);
    });
  });
});

describe('redactReadinessForRemote — the MCP surface never lists the host key inventory', () => {
  test('strips required_key / key_present / fix, keeps the verdict', async () => {
    await withEnv({ VOYAGE_API_KEY: undefined, GBRAIN_HOME: emptyHome() }, async () => {
      gw({});
      const report = await buildModesReport(engineWith({}));
      const redacted = redactReadinessForRemote(report);
      const rr = redacted.reranker_readiness!;
      expect(rr.model).toBe(DEFAULT_RERANKER_MODEL);
      expect(rr.enabled).toBe(true);
      expect(rr.ready).toBe(false);
      expect('required_key' in rr).toBe(false);
      expect('key_present' in rr).toBe(false);
      expect('fix' in rr).toBe(false);
      expect(rr.self_hosted).toBe(false);
      expect(JSON.stringify(redacted)).not.toContain('VOYAGE_API_KEY');
      expect(report.reranker_readiness!.required_key).toBe('VOYAGE_API_KEY');
    });
  });
});
