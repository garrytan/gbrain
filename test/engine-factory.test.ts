import { describe, test, expect } from 'bun:test';
import { createEngine } from '../src/core/engine-factory.ts';

describe('createEngine', () => {
  test('returns PGLiteEngine for pglite', async () => {
    const engine = await createEngine({ engine: 'pglite' });
    expect(engine.constructor.name).toBe('PGLiteEngine');
  });

  test('returns PostgresEngine for postgres', async () => {
    const engine = await createEngine({ engine: 'postgres' });
    expect(engine.constructor.name).toBe('PostgresEngine');
  });

  test('defaults to PostgresEngine when engine is undefined', async () => {
    const engine = await createEngine({});
    expect(engine.constructor.name).toBe('PostgresEngine');
  });

  test('throws for sqlite with helpful message', async () => {
    await expect(createEngine({ engine: 'sqlite' as any })).rejects.toThrow('pglite');
  });

  test('throws for unknown engine', async () => {
    await expect(createEngine({ engine: 'mysql' as any })).rejects.toThrow('Unknown engine');
  });
});
