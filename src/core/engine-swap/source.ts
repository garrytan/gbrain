/**
 * Which engine a swap run moves the brain from. A `database_url` (from the config file or an engine-selecting
 * environment variable, as `loadConfig` resolves it) is a Postgres brain; otherwise the configured engine, PGLite by
 * default. A Rust brain is not a swap source: it is already on the Rust engine.
 */
import type { GBrainConfig } from '../config.ts';

export type SwapSourceKind = 'pglite' | 'postgres' | 'rust';

const BY_ENGINE: Readonly<Record<GBrainConfig['engine'], SwapSourceKind>> = { pglite: 'pglite', postgres: 'postgres', rust: 'rust' };

export function swapSourceKind(config: Pick<GBrainConfig, 'engine' | 'database_url'>): SwapSourceKind {
  if (config.database_url) return 'postgres';
  return (Object.hasOwn(BY_ENGINE, config.engine) ? BY_ENGINE[config.engine] : undefined) ?? 'pglite';
}
