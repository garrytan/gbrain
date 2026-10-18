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
import { isThinClient, loadConfig, toEngineConfig, type GBrainConfig } from './config.ts';
import { buildGatewayConfig } from './ai/build-gateway-config.ts';
import { opError } from './ops/contract.ts';

/** The CLI-owned pieces the connect records into (cli.ts passes its dispatch context). */
export interface EngineConnectHooks {
  /** The config each connected engine was opened with; read by startup completion and makeContext. */
  SELECTED_CONFIG_BY_ENGINE: WeakMap<BrainEngine, GBrainConfig>;
  /** Migrations, retired-marker cleanup and the DB-plane config merge after the connect. */
  completeStartup(engine: BrainEngine): Promise<void>;
}

/**
 * PGLite `shared_buffers` for a process that runs one read operation and exits.
 * The backend zero-fills its whole buffer pool at start (emscripten's anonymous
 * mmap), about 55 ms for the data directory's 128 MB default, and one read
 * never fills it. 32 MB keeps about 90% of that saving. Serve, writes and
 * every other command keep the default.
 */
export const ONE_SHOT_READ_SHARED_BUFFERS = '32MB';

export interface EngineConnectOptions {
  /** get_health, `upgrade --status`, doctor's migration_wedge check: never start or wait on migrations. */
  probeOnly?: boolean;
  /** The process runs one read-scope operation and exits (sizes PGLite's buffer pool, see above). */
  oneShotRead?: boolean;
}

/** No config on this machine: the classified error with the keyless-init fix. */
export function noBrainError() {
  return opError('no_brain', 'No brain configured. Run: gbrain init', 'Run `gbrain init --pglite --no-embedding` for a local keyless brain, or `gbrain init --help` for hosted and Postgres options.', {
    fix: { argv: ['gbrain', 'init', '--pglite', '--no-embedding'], consent: [], actor: 'agent', requires_exclusive: false,
      why: 'Creates a local PGLite brain with no API keys; nothing leaves this machine.' },
  });
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
  const { createEngine } = await import('./engine-factory.ts');
  const engineConfig = opts.oneShotRead && config.engine === 'pglite'
    ? { ...toEngineConfig(config), pglite_shared_buffers: ONE_SHOT_READ_SHARED_BUFFERS }
    : toEngineConfig(config);
  const engine = await createEngine(engineConfig);
  hooks.SELECTED_CONFIG_BY_ENGINE.set(engine, config);
  const noRetry = process.argv.includes('--no-retry-connect') || process.env.GBRAIN_NO_RETRY_CONNECT === '1';
  const { connectWithRetry } = await import('./db.ts');
  await connectWithRetry(engine, engineConfig, { noRetry });
  try {
    // Engine graduation: a fenced target or a cut-over source refuses every connect but the run's own.
    await (await import('./persistence/graduation-custody.ts')).gateGraduationConnect(engine);
    if (opts.probeOnly !== true) await hooks.completeStartup(engine);
  } catch (e) {
    await engine.disconnect().catch(() => {});
    throw e;
  }
  return engine;
}
