/**
 * The search arms' stderr warnings name only the failure class, never the error's text or code.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  1. Protects: when the keyword, title, embed or vector arm of a search fails (or the keyword arm is skipped
 *     after a timeout), the one-per-process warning on stderr says which arm failed and the class (`timeout`,
 *     `provider_error`, `skipped_after_timeout`) and nothing else. A driver's message can carry a connection
 *     string or password, and the supersession warning already prints the class only (#9903).
 *  2. Regression: `${err.message}` / `String(err)` interpolated into those warnings in
 *     src/core/search/hybrid/arms.ts.
 *  3. Existing coverage misses it: keyword-arm-timeout-cli-7171 and supersede-check-currency read the degraded
 *     marker and the supersession warning; nothing reads what the arm warnings print.
 *  4. Seam: engine.searchKeyword / searchTitles / searchVector patched to throw an error whose message holds a
 *     URL query value (VALUECANARY) and whose code is SQLSTATE 57P01; queryEmbedFn throws the same; a stubbed
 *     fetch for the multimodal embed. The canary has no `user:password@` part so the secrets scan stays clean.
 *     Real PGLite brain; console.warn and console.error captured and restored in finally. The zero-row fallback
 *     line must not carry the search text either: the query is a canary (QUERYCANARY) that never reaches stderr.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { KeywordSkippedAfterTimeoutError } from '../../src/core/postgres-engine/keyword-timeout-cache.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import { _resetWarnOnceForTests } from '../../src/core/utils.ts';
import { withEnv } from '../helpers/with-env.ts';

const CANARY = 'VALUECANARY';
const CODE = '57P01';
const driverError = () => Object.assign(new Error(`connection terminated postgresql://db.example/brain?app=${CANARY}`), { code: CODE });
const timeoutError = () => Object.assign(new Error(`canceling statement due to statement timeout postgresql://db.example/brain?app=${CANARY}`), { code: '57014' });

describe('search arm warnings print the failure class only (PGLite)', () => {
  let engine: PGLiteEngine;
  const real = {
    searchKeyword: PGLiteEngine.prototype.searchKeyword,
    searchTitles: PGLiteEngine.prototype.searchTitles,
    searchVector: PGLiteEngine.prototype.searchVector,
  };
  const origWarn = console.warn;
  const origError = console.error;
  const origFetch = globalThis.fetch;
  let printed: string[] = [];

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
    await importFromContent(engine, 'notes/tapir', '# Tapir\n\nThe tapirword notes.');
  }, 120_000);
  afterAll(async () => { if (engine) await engine.disconnect(); });

  beforeEach(() => {
    _resetWarnOnceForTests();
    printed = [];
    console.warn = (...args: unknown[]) => { printed.push(args.map(String).join(' ')); };
    console.error = (...args: unknown[]) => { printed.push(args.map(String).join(' ')); };
  });
  afterEach(async () => {
    console.warn = origWarn;
    console.error = origError;
    globalThis.fetch = origFetch;
    engine.searchKeyword = real.searchKeyword;
    engine.searchTitles = real.searchTitles;
    engine.searchVector = real.searchVector;
    await engine.setConfig('search.unified_multimodal', 'false');
    resetGateway();
    _resetWarnOnceForTests();
  });

  const embedOk = async () => new Float32Array(1536).fill(0.01);
  const embedBroken = async (): Promise<Float32Array> => { throw driverError(); };
  const lineFor = (needle: string) => printed.find(l => l.includes(needle));
  const expectClassOnly = (line: string | undefined, cls: string) => {
    expect(line).toBeDefined();
    expect(line).toContain(cls);
    expect(line).not.toContain(CANARY);
    expect(line).not.toContain('://');
    expect(line).not.toContain(CODE);
    expect(line).not.toContain('57014');
  };
  const search = (opts: Record<string, unknown> = {}, query = 'tapirword') =>
    hybridSearch(engine, query, { limit: 5, useCache: false, queryEmbedFn: embedOk, ...opts } as never);

  test('keyword arm failure names provider_error, not the driver message or code', async () => {
    engine.searchKeyword = async () => { throw driverError(); };
    await search();
    expectClassOnly(lineFor('searchKeyword arm failed'), 'provider_error');
  });

  test('keyword arm statement timeout names timeout, not the message or SQLSTATE', async () => {
    engine.searchKeyword = async () => { throw timeoutError(); };
    await search();
    expectClassOnly(lineFor('searchKeyword arm failed'), 'timeout');
  });

  test('keyword arm skipped after a timeout names skipped_after_timeout, not the error text or code', async () => {
    engine.searchKeyword = async () => { throw new KeywordSkippedAfterTimeoutError(30); };
    await search();
    const line = lineFor('searchKeyword arm skipped');
    expectClassOnly(line, 'skipped_after_timeout');
    expect(line).not.toContain('keyword_skipped_after_timeout');
    expect(line).not.toContain('search.keyword');
  });

  test('title arm failure names provider_error, not the driver message or code', async () => {
    engine.searchTitles = async () => { throw driverError(); };
    await search();
    expectClassOnly(lineFor('searchTitles arm failed'), 'provider_error');
  });

  test('query embed failure (salvage on) names provider_error, not the driver message or code', async () => {
    await search({ queryEmbedFn: embedBroken });
    expectClassOnly(lineFor('query embeds failed'), 'provider_error');
  });

  test('query embed failure (salvage off) names provider_error, not the driver message or code', async () => {
    await withEnv({ GBRAIN_SEARCH_SALVAGE: 'off' }, async () => { await search({ queryEmbedFn: embedBroken }); });
    expectClassOnly(lineFor('embed/vector fan-out failed'), 'provider_error');
  });

  test('vector arm failure names provider_error, not the driver message or code', async () => {
    engine.searchVector = async () => { throw driverError(); };
    await search();
    expectClassOnly(lineFor('searchVector arms failed'), 'provider_error');
  });

  describe('cross-modal fall-open lines', () => {
    beforeEach(() => {
      globalThis.fetch = (async () => new Response(JSON.stringify({
        data: [{ embedding: Array.from({ length: 1024 }, () => 0.1), index: 0 }],
      }), { status: 200 })) as unknown as typeof fetch;
      configureGateway({
        embedding_model: 'openai:text-embedding-3-large',
        embedding_dimensions: 1536,
        embedding_multimodal_model: 'voyage:voyage-multimodal-3',
        env: { OPENAI_API_KEY: 'test', VOYAGE_API_KEY: 'test' },
      });
    });

    test('image-side failure names provider_error, not the driver message or code', async () => {
      engine.searchVector = async () => { throw driverError(); };
      await search({ crossModal: 'image' });
      expectClassOnly(lineFor('image-side embed failed'), 'provider_error');
    });

    test('unified-multimodal failure names provider_error, not the driver message or code', async () => {
      await engine.setConfig('search.unified_multimodal', 'true');
      engine.searchVector = async () => { throw driverError(); };
      await search();
      expectClassOnly(lineFor('unified_multimodal embed failed'), 'provider_error');
    });

    test('unified-multimodal zero-row fallback prints no query text, so a search never reaches the server log', async () => {
      const QUERY_CANARY = 'QUERYCANARY';
      await engine.setConfig('search.unified_multimodal', 'true');
      engine.searchVector = async () => [];
      await search({}, `tapirword ${QUERY_CANARY}`);
      const line = lineFor('unified_multimodal returned zero rows');
      expect(line).toBeDefined();
      expect(line).toContain('Falling back to dual-column text path');
      expect(printed.join('\n')).not.toContain(QUERY_CANARY);
      expect(printed.join('\n')).not.toContain('tapirword');
      expect(line).not.toContain('query=');
    });
  });
});
