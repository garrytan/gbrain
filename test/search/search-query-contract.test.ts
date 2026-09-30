import { afterAll, beforeAll, describe, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { seedSearchQueryContract, verifyKeywordTieOrder, verifyMixedCjkCase, verifySearchDateBounds } from '../helpers/search-query-contract.ts';

describe('search query contract on PGLite', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await seedSearchQueryContract(engine);
  }, 120_000);
  afterAll(async () => { await engine.disconnect(); });
  test('all arms preserve inclusive bounds and strict legacy microsecond precision', async () => { await verifySearchDateBounds(engine); });
  test('keyword page pools and chunk pagination have deterministic tie ordering', async () => { await verifyKeywordTieOrder(engine); });
  test('mixed CJK and Latin terms remain case-insensitive', async () => { await verifyMixedCjkCase(engine); });
});
