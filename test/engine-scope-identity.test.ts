/**
 * An entry point that re-enters itself in its engine's scope (importFromFile, hybridSearch: needsEngineScope) must see
 * that scope as its own once inside it, whatever the engine object returns for its root key. A Proxy engine that
 * answers every property with a fresh value (the mock engines the import tests use) made engineKey differ on every
 * read, so importFromFile re-entered itself until the stack overflowed in any process that had opened an embedded
 * engine earlier (test/engine-scope-required.test.ts then test/import-file.test.ts in one shard).
 */
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { openEngine, withEngineScope } from '../src/core/engine-open.ts';
import { needsEngineScope } from '../src/core/engine-scope.ts';

test('inside withEngineScope(engine), needsEngineScope(engine) is false even when engineKey is unstable', async () => {
  const embedded = await openEngine({
    embedded_core: true, engine: 'pglite', database: {}, host: { id: randomUUID() },
    embedding: { model: 'openai:text-embedding-3-small', dimensions: 1536 }, ai: { providers: {} },
  });
  try {
    const unstable = new Proxy({}, { get: () => () => undefined });
    expect(needsEngineScope(unstable)).toBe(true);
    expect(withEngineScope(unstable, () => needsEngineScope(unstable))).toBe(false);
    expect(withEngineScope(embedded, () => needsEngineScope(embedded))).toBe(false);
  } finally {
    await embedded.disconnect();
  }
});
