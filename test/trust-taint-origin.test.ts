/**
 * #5575 CEO-1 on both engines: a derived row's `write_origin` (bound as text,
 * cast with ::text::jsonb by the attribution seam) is a JSON object whose
 * `taint_inputs` is an array, never a JSON string, and a 40-input derivation
 * keeps 32 inputs with the truncation fields while all 40 derivation_inputs
 * edges are recorded (ENG-7). Runs on PGLite, and on Postgres through
 * test/e2e/trust-taint-origin.test.ts.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { maintenanceTransaction } from '../src/core/persistence/attribution.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { derivedMaintenanceTransaction, deriveTrust } from '../src/core/trust/taint.ts';
import { TAINT_INPUT_SAMPLE_LIMIT } from '../src/core/trust/tier.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;

beforeAll(async () => {
  const backends = testBackends();
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.();
});

test('a 40-input derived fact stores a JSONB origin with a 32-entry taint sample and 40 complete edges', async () => {
  for (const engine of engines) {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    const sourceId = `taint-${randomUUID().slice(0, 8)}`;
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    const ids: number[] = [];
    for (let i = 0; i < 40; i++) {
      const page = await maintenanceTransaction(engine, tx => tx.putPage(`notes/input-${i}`, { type: 'note', title: `Input ${i}`, compiled_truth: 'Body.' }, { sourceId }),
        { tier: i === 0 ? 'external_untrusted' : 'operator_curated', origin: { channel: 'test' } });
      ids.push(page.id);
    }
    const derivation = await deriveTrust(engine, ids.map(id => ({ table: 'pages' as const, id })), { channel: 'derive:test' });
    const factId = await derivedMaintenanceTransaction(engine, derivation, async tx => {
      const fact = await tx.insertFact({ fact: 'A derived example fact.', kind: 'fact', entity_slug: null, visibility: 'private', source: 'test' }, { source_id: sourceId });
      return { result: fact.id, rows: [{ table: 'facts', id: fact.id, sourceId }] };
    });
    const [row] = await engine.executeRaw<{ tier: string; kind: string; sample: number | string; truncated: boolean; count: number | string; channel: string }>(
      `SELECT trust_tier AS tier, jsonb_typeof(write_origin->'taint_inputs') AS kind, jsonb_array_length(write_origin->'taint_inputs') AS sample,
              (write_origin->>'taint_inputs_truncated')::boolean AS truncated, write_origin->>'taint_input_count' AS count, write_origin->>'channel' AS channel
         FROM facts WHERE id=$1`, [factId]);
    expect({ ...row, sample: Number(row.sample), count: Number(row.count) })
      .toEqual({ tier: 'external_untrusted', kind: 'array', sample: TAINT_INPUT_SAMPLE_LIMIT, truncated: true, count: 40, channel: 'derive:test' });
    const [first] = await engine.executeRaw<{ id: number | string; tier: string }>(
      "SELECT write_origin->'taint_inputs'->0->>'id' AS id, write_origin->'taint_inputs'->0->>'tier' AS tier FROM facts WHERE id=$1", [factId]);
    expect({ id: Number(first.id), tier: first.tier }).toEqual({ id: ids[0], tier: 'external_untrusted' });
    const [edges] = await engine.executeRaw<{ n: number | string }>(
      "SELECT count(*) AS n FROM derivation_inputs WHERE derived_table='facts' AND derived_id=$1 AND input_table='pages'", [String(factId)]);
    expect(Number(edges.n)).toBe(40);
  }
}, 120_000);
