/**
 * Ontology revert with the same provenance (eval wave N1-2).
 *
 * Lisbon (2020) → Porto (2022) → Lisbon (2024), all from one provenance, must
 * make Lisbon current again and keep Porto for its own window. The dedup key
 * carries the stint's valid_from, so the return is a new interval instead of
 * colliding with the first one, while retries stay idempotent.
 *
 * Synthetic data only.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
const E = 'people/alice-example';

const ctx = () => ({
  engine, config: {} as never, dryRun: false, remote: false, sourceId: 'default',
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}) as OperationContext;
const propose = (value: string, valid_from?: string) =>
  operationsByName.ontology_propose.handler(ctx(), { entity: E, dimension: 'location', value, visibility: 'world', ...(valid_from ? { valid_from } : {}) }) as Promise<{ action: string }>;
const locationAt = async (asof?: string) =>
  ((await operationsByName.ontology_get.handler(ctx(), { entity: E, ...(asof ? { asof } : {}) })) as Array<{ dimension: string; value: string }>)
    .find(r => r.dimension === 'location')?.value ?? null;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine.disconnect(); }, 60_000);
beforeEach(async () => { await resetPgliteState(engine); });

describe('ontology revert to an earlier value with the same provenance', () => {
  test('A → B → A records a new interval and makes A current again', async () => {
    expect((await propose('Lisbon', '2020-01-01')).action).toBe('inserted');
    expect((await propose('Porto', '2022-01-01')).action).toBe('superseded_prior');
    expect((await propose('Lisbon', '2024-01-01')).action).toBe('superseded_prior');
    expect(await locationAt()).toBe('Lisbon');
    expect(await locationAt('2021-06-01')).toBe('Lisbon');
    expect(await locationAt('2023-06-01')).toBe('Porto');
    expect(await locationAt('2024-06-01')).toBe('Lisbon');
  });

  test('replaying any step of the chain is a noop', async () => {
    for (const [v, d] of [['Lisbon', '2020-01-01'], ['Porto', '2022-01-01'], ['Lisbon', '2024-01-01']]) await propose(v, d);
    const [{ n }] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM facts');
    for (const [v, d] of [['Lisbon', '2020-01-01'], ['Porto', '2022-01-01'], ['Lisbon', '2024-01-01'], ['Lisbon', '2024-03-01']]) {
      expect((await propose(v, d)).action).toBe('noop');
    }
    expect((await propose('Lisbon')).action).toBe('noop');
    const [{ n: after }] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM facts');
    expect(after).toBe(n);
    expect(await locationAt()).toBe('Lisbon');
  });

  test('an undated return to an earlier value supersedes the current one', async () => {
    await propose('Lisbon', '2020-01-01');
    await propose('Porto', '2022-01-01');
    expect((await propose('Lisbon')).action).toBe('superseded_prior');
    expect(await locationAt()).toBe('Lisbon');
    expect(await locationAt('2023-06-01')).toBe('Porto');
  });
});
