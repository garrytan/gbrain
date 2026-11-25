import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const ENTITY = 'things/date-free-fixture';
const INDICATOR = 'synthetic date compatibility device';
const UNDATED = INDICATOR + ' unknown event';
const recent = new Date(Date.now() - 60_000);
const old = new Date('2020-01-02T00:00:00Z');
const cases: { backend: string; engine: BrainEngine; close: () => Promise<void> }[] = [];
const backends = testBackends();

beforeAll(async () => {
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    cases.push({ backend: 'pglite', engine, close: () => engine.disconnect() });
  }
  if (backends.includes('postgres')) {
    const fixture = await isolatedPersistencePostgres(process.env.DATABASE_URL!, 'instance', 4);
    cases.push({ backend: 'postgres', engine: fixture.engine, close: fixture.close });
  }
  for (const { engine } of cases) {
    for (const [text, at] of [[UNDATED, recent], [INDICATOR + ' confirmed old event', old], [INDICATOR + ' confirmed recent event', recent]] as const) {
      await engine.insertFact({ fact: text, entity_slug: ENTITY, source: 'synthetic-recall', valid_from: at }, { source_id: 'default' });
    }
    // Exercise an existing imported NULL. This test does not change the write
    // policy or require a migration on an ordinary fresh install.
    await engine.executeRaw('ALTER TABLE facts ALTER COLUMN valid_from DROP NOT NULL');
    await engine.executeRaw('UPDATE facts SET valid_from = NULL WHERE fact = $1', [UNDATED]);
  }
}, 180_000);

afterAll(async () => {
  for (const fixture of cases) await fixture.close();
});

for (const backend of backends) {
  describe(`recall of imported undated rows (${backend})`, () => {
    const read = async (args: Record<string, unknown>) => {
      const { engine } = cases.find(testCase => testCase.backend === backend)!;
      const result = await dispatchToolCall(engine, 'recall', { grep: INDICATOR, ...args }, { remote: false, sourceId: 'default' });
      expect(result.isError).toBeFalsy();
      return (JSON.parse(result.content[0].text) as { facts: { fact: string; valid_from: string | null; created_at: string }[] }).facts;
    };

    test('no event cutoff preserves the existing NULL and its separate observation time', async () => {
      for (const args of [{}, { entity: ENTITY }]) {
        const facts = await read(args);
        expect(facts).toHaveLength(3);
        expect(facts.find(row => row.fact === UNDATED)).toMatchObject({ valid_from: null, created_at: expect.any(String) });
      }
    });

    test('event window excludes undated records and keeps a dated event in range', async () => {
      for (const args of [{}, { entity: ENTITY }]) {
        const facts = await read({ ...args, since: '1 hour ago' });
        expect(facts.map(row => row.fact)).toEqual([INDICATOR + ' confirmed recent event']);
      }
    });
  });
}
