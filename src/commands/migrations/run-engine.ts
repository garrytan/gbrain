/**
 * One PGLite engine for consecutive migrations of one apply-migrations run.
 *
 * Each orchestrator used to open and close the brain itself, and a PGLite open
 * starts a new embedded Postgres (about 130 ms each). Inside a run session the
 * runner enables sharing only for a migration flagged `sharesRunEngine`
 * (types.ts): its opens through `connectMigrationEngine` return the run's one
 * engine and its close is deferred. Before a migration that is not flagged,
 * before a `gbrain` child that needs the brain (`releaseRunEngine`), and when
 * the session ends, the engine is closed, so nothing else ever finds the
 * datastore lock held. Outside a session, or on Postgres, every open is a new
 * engine closed by its caller, exactly as before.
 */
import type { GBrainConfig } from '../../core/config.ts';
import { toEngineConfig } from '../../core/config.ts';
import type { BrainEngine } from '../../core/engine.ts';
import { createEngine } from '../../core/engine-factory.ts';

interface RunSession { sharing: boolean; engine: BrainEngine | null; path: string | undefined }
let session: RunSession | null = null;

/** Opened brain plus its close: a no-op for the shared engine, which the session closes. */
export interface MigrationEngine { engine: BrainEngine; close: () => Promise<void> }

async function openEngine(config: GBrainConfig): Promise<BrainEngine> {
  const engineConfig = toEngineConfig(config);
  const engine = await createEngine(engineConfig);
  try { await engine.connect(engineConfig); }
  catch (error) { await engine.disconnect().catch(() => {}); throw error; }
  return engine;
}

/** Connect the configured brain (the run's shared engine when sharing is enabled on PGLite). */
export async function connectMigrationEngine(config: GBrainConfig): Promise<MigrationEngine> {
  if (!session?.sharing || config.engine !== 'pglite' || !config.database_path) {
    const engine = await openEngine(config);
    return { engine, close: () => engine.disconnect() };
  }
  if (session.engine && session.path !== config.database_path) await releaseRunEngine();
  if (!session.engine) {
    session.engine = await openEngine(config);
    session.path = config.database_path;
  }
  return { engine: session.engine, close: async () => {} };
}

/**
 * Close the shared engine now (a later shared open reopens it). Call before
 * spawning a `gbrain` child. Best-effort like the orchestrators' own closes: a
 * close that fails leaves the next open to report the held lock.
 */
export async function releaseRunEngine(): Promise<void> {
  const engine = session?.engine;
  if (!session || !engine) return;
  session.engine = null;
  await engine.disconnect().catch(() => {});
}

/** Enable or disable sharing for what runs next; disabling closes the shared engine first. */
export async function setRunEngineSharing(sharing: boolean): Promise<void> {
  if (!session) return;
  if (!sharing) await releaseRunEngine();
  session.sharing = sharing;
}

/** Run `fn` as one apply-migrations run session; the shared engine is closed when it ends. */
export async function withRunEngineSession<T>(fn: () => Promise<T>): Promise<T> {
  session = { sharing: false, engine: null, path: undefined };
  try { return await fn(); }
  finally {
    await releaseRunEngine();
    session = null;
  }
}
