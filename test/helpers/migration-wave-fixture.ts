import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { isolatedPersistencePostgres } from './persistence-postgres.ts';

export async function migrationWaveFixture(kind: 'pglite' | 'postgres') {
  if (kind === 'postgres') {
    const base = process.env.DATABASE_URL!;
    const fixture = await isolatedPersistencePostgres(base);
    const [row] = await fixture.engine.executeRaw<{ name: string }>('SELECT current_database() AS name');
    if (row.name === new URL(base).pathname.slice(1) || !row.name.startsWith('gbrain_test_persistence_')) {
      await fixture.close();
      throw new Error('Migration acceptance database isolation failed');
    }
    console.log(`MIGRATION_WAVE_ISOLATED_DATABASE ${row.name}`);
    return { ...fixture, database: fixture.databaseUrl };
  }
  const root = mkdtempSync(join(tmpdir(), 'migration-wave-'));
  const database = join(root, 'brain');
  const engine = new PGLiteEngine();
  await engine.connect({ database_path: database });
  await engine.initSchema();
  return { engine, database, close: async () => { await engine.disconnect(); rmSync(root, { recursive: true, force: true }); } };
}

export function observeMigrationEngine(
  engine: BrainEngine,
  after: (engine: BrainEngine, method: string, args: unknown[], result: unknown) => Promise<void>,
  before?: (engine: BrainEngine, method: string, args: unknown[]) => Promise<void>,
): BrainEngine {
  return new Proxy(engine, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (property === 'transaction') return async (run: (tx: BrainEngine) => Promise<unknown>) => {
        await before?.(target, 'transaction', [run]);
        return target.transaction(tx => run(observeMigrationEngine(tx, after, before)));
      };
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        await before?.(target, String(property), args);
        const result = await value.apply(target, args);
        await after(target, String(property), args, result);
        return result;
      };
    },
  });
}
