/**
 * Throw-only host-brain connect. `connectEngine` in cli.ts wraps it and keeps
 * the CLI's exit behaviour (no config, thin client, failed PGLite repair);
 * the status-only serve paths (`runStatusModeServe`, both transports) call it
 * directly, so a config removed between a re-probe and the connect, or a
 * repair that fails, throws a classified error into the status daemon instead
 * of exiting it. An engine that connected but failed a later startup step is
 * disconnected before the error propagates, so its PGLite lock is released.
 *
 * Host brain only: mounts route through cli.ts's `connectMountEngine`, and
 * status-only serve applies to the host brain alone.
 */
import type { BrainEngine } from './engine.ts';
import { isAbsolute } from 'node:path';
import { configPath, isThinClient, loadConfig, toEngineConfig, type GBrainConfig } from './config.ts';
import { buildGatewayConfig } from './ai/build-gateway-config.ts';
import { opError } from './ops/contract.ts';
import { openRequestConfigSnapshot, type RequestConfigSnapshot } from './config-snapshot.ts';

/** The CLI-owned pieces the connect records into (cli.ts passes its dispatch context). */
export interface EngineConnectHooks {
  /** The config each connected engine was opened with; read by startup completion and makeContext. */
  SELECTED_CONFIG_BY_ENGINE: WeakMap<BrainEngine, GBrainConfig>;
  /** Migrations, retired-marker cleanup and the DB-plane config merge after the connect. */
  completeStartup(engine: BrainEngine, opts?: EngineConnectOptions): Promise<void>;
}

/**
 * PGLite `shared_buffers` for a process that runs one read operation and exits.
 * The backend zero-fills its whole buffer pool at start (emscripten's anonymous
 * mmap), about 55 ms for the data directory's 128 MB default, and one read
 * never fills it. 32 MB keeps about 90% of that saving. Serve, writes and
 * every other command keep the default.
 */
export const ONE_SHOT_READ_SHARED_BUFFERS = '32MB';

/**
 * Postgres connections for a process that runs one read operation and exits. Each connection a pool opens is a
 * TCP and auth handshake behind a remote pooler, and a cold `gbrain search` opened five with the default pool for
 * statements that mostly wait on one another. Two keep the read's parallel arms overlapping (the same wall clock as
 * ten at 40 ms RTT) for three fewer handshakes. GBRAIN_POOL_SIZE still sets it.
 */
export const ONE_SHOT_READ_POOL_MAX = 2;

export interface EngineConnectOptions {
  /** get_health, `upgrade --status`, doctor's migration_wedge check: never start or wait on migrations. */
  probeOnly?: boolean;
  /**
   * The process runs one read-scope operation and exits: sizes PGLite's buffer pool (see above), reads the
   * config table once for the whole startup (each key read is a round trip behind a remote pooler, #7147;
   * pending migrations run outside the snapshot, reading and writing config live) and skips the
   * retired-marker cleanup, which only filesystem-guarded writes depend on. The CLI then builds the read's
   * context and runs it under the same snapshot (`takeStartupConfigSnapshot`): nothing between startup and the
   * read writes config, and a migration that ran drops the snapshot's rows, so the read takes fresh ones.
   */
  oneShotRead?: boolean;
  /**
   * The command only reads (a one-shot read, `oneShotRead`, counts too): a Rust brain whose store is missing or moved is refused with `brain_missing` and nothing is
   * created. Unset, a command may still create a brand-new Rust brain's store, but never replaces one that was there
   * (`rustStoreGuard`, src/commands/doctor/missing-brain.ts).
   */
  readOnly?: boolean;
  /** The command named in a refusal (`gbrain <command>`). */
  command?: string;
}

/** No config on this machine: the classified error with the keyless-init fix. */
export function noBrainError() {
  return opError('no_brain', 'No brain configured. Run: gbrain init', 'Run `gbrain init --pglite --no-embedding` for a local keyless brain, or `gbrain init --help` for hosted and Postgres options.', {
    fix: { argv: ['gbrain', 'init', '--pglite', '--no-embedding'], consent: [], actor: 'agent', requires_exclusive: false,
      why: 'Creates a local PGLite brain with no API keys; nothing leaves this machine.' },
  });
}

/** The config snapshot each one-shot read's startup ran under, until the CLI takes it for the read itself. */
const startupSnapshots = new WeakMap<BrainEngine, RequestConfigSnapshot>();

/** The snapshot a `oneShotRead` connect's startup read config through, handed over once; the taker closes it. */
export function takeStartupConfigSnapshot(engine: BrainEngine): RequestConfigSnapshot | undefined {
  const snapshot = startupSnapshots.get(engine);
  startupSnapshots.delete(engine);
  return snapshot;
}

export async function connectEngineForServe(hooks: EngineConnectHooks, opts: EngineConnectOptions = {}): Promise<BrainEngine> {
  const config = loadConfig();
  if (!config) throw noBrainError();
  if (isThinClient(config) && !config.database_url) {
    throw opError('requires_local_engine', `This install is a thin client of ${config.remote_mcp!.mcp_url}; it has no local brain to open.`,
      'Run the server on the brain host, or connect this agent to the remote MCP URL.');
  }
  // The gateway is configured before the connect: initSchema needs the embedding dimensions.
  const { configureGateway } = await import('./ai/gateway.ts');
  configureGateway(buildGatewayConfig(config));
  // A Rust brain's store is judged before anything opens: a read never creates it, and a write creates it only for a
  // brain that never had one (a moved or missing store is never quietly replaced by an empty one).
  let createStore: boolean | undefined;
  if (config.engine === 'rust' && config.database_path && isAbsolute(config.database_path)) {
    const { rustStoreGuard } = await import('../commands/doctor/missing-brain.ts');
    const verdict = rustStoreGuard(config.database_path, configPath(), opts.command ?? 'serve', opts.readOnly !== true && opts.oneShotRead !== true);
    if (typeof verdict !== 'string') throw verdict;
    createStore = verdict === 'create';
  }
  const { createEngine } = await import('./engine-factory.ts');
  const baseConfig = createStore === undefined ? toEngineConfig(config) : { ...toEngineConfig(config), create_store: createStore };
  const engineConfig = !opts.oneShotRead ? baseConfig
    : config.engine === 'pglite' ? { ...baseConfig, pglite_shared_buffers: ONE_SHOT_READ_SHARED_BUFFERS }
    : { ...baseConfig, ...(process.env.GBRAIN_POOL_SIZE ? {} : { pool_max: ONE_SHOT_READ_POOL_MAX }) };
  const engine = await createEngine(engineConfig);
  hooks.SELECTED_CONFIG_BY_ENGINE.set(engine, config);
  const noRetry = process.argv.includes('--no-retry-connect') || process.env.GBRAIN_NO_RETRY_CONNECT === '1';
  const { connectWithRetry } = await import('./db.ts');
  await connectWithRetry(engine, engineConfig, { noRetry });
  try {
    // Engine graduation: a fenced target or a cut-over source refuses every connect but the run's own.
    await (await import('./persistence/graduation-custody.ts')).gateGraduationConnect(engine);
    if (opts.probeOnly !== true && opts.oneShotRead) {
      const snapshot = openRequestConfigSnapshot(engine);
      startupSnapshots.set(engine, snapshot);
      await snapshot.run(() => hooks.completeStartup(engine, opts));
    } else if (opts.probeOnly !== true) {
      await hooks.completeStartup(engine, opts);
    }
  } catch (e) {
    takeStartupConfigSnapshot(engine)?.close();
    await engine.disconnect().catch(() => {});
    throw e;
  }
  return engine;
}
