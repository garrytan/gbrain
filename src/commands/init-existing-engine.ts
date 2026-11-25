/**
 * `gbrain init` on a brain whose config already names an engine. Bare `init` used to route every engine that is
 * not postgres/supabase into the PGLite branch, which rewrote `engine: 'rust'` to `pglite`, and `--non-interactive`
 * skipped that branch and demanded `--url`. An explicit engine flag (`--pglite`, `--supabase`, `--url`,
 * `--prefer-postgres`) still chooses the engine; this only decides what happens when none is given.
 */
import { configPath, isThinClient, type GBrainConfig } from '../core/config.ts';
import type { readInitConfigState } from '../core/agent-install/init-state.ts';
import { setInitJsonResult } from './init-json.ts';

/** The engines whose brain lives on this machine; a postgres config keeps its own preservation path in init.ts. */
const LOCAL_ENGINES: readonly string[] = ['rust', 'pglite'];

/** The existing config when it names the rust or pglite engine and no engine flag overrides it, else null. */
export function keptEngineConfig(state: ReturnType<typeof readInitConfigState>, explicitEngineChoice: boolean): GBrainConfig | null {
  if (explicitEngineChoice || state.kind !== 'present' || isThinClient(state.config)) return null;
  return LOCAL_ENGINES.includes(state.config.engine) ? state.config : null;
}

/** A configured Rust brain is reported and left alone: init never opens the Rust store or rewrites its config. */
export function reportKeptRustBrain(config: GBrainConfig, jsonOutput: boolean): void {
  if (jsonOutput) {
    setInitJsonResult({ status: 'success', engine: 'rust', path: config.database_path, mode: 'existing', config_unchanged: true });
    return;
  }
  console.log(`Existing rust brain at ${config.database_path ?? '(default location)'} kept; ${configPath()} is unchanged.`);
  console.log('To switch engines, pass --pglite, --supabase or --url.');
}
