/**
 * A backdated ontology observation whose value equals the current open value
 * is an earlier stint, not a corroboration of the current one. It must stay
 * live so as-of reads see it, exactly like a backdated observation of a
 * different value; a same-or-later observation of the current value still
 * corroborates. (gbrain-evals N3 temporal-asof, bug 1.)
 *
 * Synthetic data only.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations } from '../src/core/operations.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
const E = 'people/alice-example';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

afterAll(async () => {
  await engine.disconnect();
});

const op = (name: string, p: object) => {
  const ctx = { engine, config: { engine: 'pglite', database_path: ':memory:' }, logger: console, dryRun: false, remote: false, sourceId: 'default' } as any;
  return operations.find(o => o.name === name)!.handler(ctx, p as any);
};
const employerAt = async (asof: string) =>
  ((await op('ontology_get', { entity: E, asof })) as any[]).find(r => r.dimension === 'employer')?.value ?? null;

describe('mergeOntologyFact: backdated observation of the current value', () => {
  test('a late-learned first stint with the current value stays visible as of its window', async () => {
    await op('ontology_propose', { entity: E, dimension: 'employer', value: 'startup-1', valid_from: '2023-01-01', source: 'notes/b' });
    await op('ontology_propose', { entity: E, dimension: 'employer', value: 'startup-0', valid_from: '2024-01-01', source: 'notes/c' });
    const res = await op('ontology_propose', { entity: E, dimension: 'employer', value: 'startup-0', valid_from: '2022-01-01', source: 'notes/a' }) as any;
    expect(res.action).toBe('inserted');
    expect(await employerAt('2022-06-01')).toBe('startup-0');
    expect(await employerAt('2023-06-01')).toBe('startup-1');
    expect(await employerAt('2024-06-01')).toBe('startup-0');
  });

  test('a backdated same value with no intervening stint extends the as-of window back', async () => {
    await op('ontology_propose', { entity: E, dimension: 'employer', value: 'startup-0', valid_from: '2024-01-01', source: 'notes/c' });
    await op('ontology_propose', { entity: E, dimension: 'employer', value: 'startup-0', valid_from: '2022-01-01', source: 'notes/a' });
    expect(await employerAt('2023-01-01')).toBe('startup-0');
    expect(await employerAt('2021-06-01')).toBeNull();
  });

  test('a same-value observation at or after the current start still corroborates', async () => {
    await op('ontology_propose', { entity: E, dimension: 'employer', value: 'startup-0', valid_from: '2024-01-01', source: 'notes/c' });
    const later = await op('ontology_propose', { entity: E, dimension: 'employer', value: 'startup-0', valid_from: '2024-03-01', source: 'notes/d' }) as any;
    expect(later.action).toBe('corroborated');
    const undated = await op('ontology_propose', { entity: E, dimension: 'employer', value: 'startup-0', source: 'notes/e' }) as any;
    expect(undated.action).toBe('corroborated');
  });
});
