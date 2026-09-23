import { afterAll, beforeAll, describe, test } from 'bun:test';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { seedSearchQueryContract, verifyKeywordTieOrder, verifyMixedCjkCase, verifySearchDateBounds } from '../helpers/search-query-contract.ts';

describe('search query contract on PGLite', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    // The seed uses 1536-d vectors; pin that before initSchema instead of inheriting the prior file's gateway (see doctor-hidden-by-search-policy.test.ts).
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { ...process.env } });
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await seedSearchQueryContract(engine);
  }, 120_000);
  afterAll(async () => { await engine.disconnect(); resetGateway(); });
  test('all arms preserve inclusive bounds and strict legacy microsecond precision', async () => { await verifySearchDateBounds(engine); });
  test('keyword page pools and chunk pagination have deterministic tie ordering', async () => { await verifyKeywordTieOrder(engine); });
  test('mixed CJK and Latin terms remain case-insensitive', async () => { await verifyMixedCjkCase(engine); });
});
