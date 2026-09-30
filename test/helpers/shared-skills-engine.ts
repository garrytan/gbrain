import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { isolatedPersistencePostgres } from './persistence-postgres.ts';

export async function isolatedSharedSkillsEngine(databaseUrl?: string): Promise<{ engine: BrainEngine; close(): Promise<void> }> {
  if (databaseUrl) return isolatedPersistencePostgres(databaseUrl);
  const engine = new PGLiteEngine();
  try {
    await engine.connect({});
    await engine.initSchema();
    return { engine, close: () => engine.disconnect() };
  } catch (error) {
    await engine.disconnect();
    throw error;
  }
}
