/**
 * State 4 of a swap run: the authority switch and the route probe.
 *
 * Before the switch, nothing may still select the old engine: an engine-selecting variable set in this environment,
 * or a gbrain service definition that sets one, refuses with `route_override` (names only, never values). The switch
 * rewrites the config file atomically (`engine: rust`, `database_path` = the Rust store). Then a fresh process
 * resolves the normal caller route (`gbrain engine status --json --probe`) and must report the Rust engine at that
 * store, opened and answering. If it does not, the config is put back at once, so authority never points at an
 * unverified engine.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { loadConfigFileOnly, saveConfig, type GBrainConfig } from '../config.ts';
import { resolveServeGbrainCommand } from '../serve-service.ts';
import type { ServiceDefinition } from './plan.ts';
import { swapRefusal } from './refusals.ts';
import type { OperationError } from '../ops/contract.ts';

export interface RouteProbe { effective_engine: string | null; database_path: string | null; ok: boolean }

/** A fresh-process probe of the configured route; tests pass their own. */
export type RouteProber = () => Promise<RouteProbe>;

/** The real probe: a new gbrain process runs `engine status --json --probe` (it opens the brain as any caller would). */
export function subprocessProber(argv: string[] = resolveServeGbrainCommand(), env: NodeJS.ProcessEnv = process.env): RouteProber {
  return async () => {
    const r = spawnSync(argv[0]!, [...argv.slice(1), 'engine', 'status', '--json', '--probe'], { env, encoding: 'utf8', timeout: 120_000 });
    try {
      const doc = JSON.parse(r.stdout) as { effective_engine?: string | null; database_path?: string | null; probe?: { ok?: boolean } };
      return { effective_engine: doc.effective_engine ?? null, database_path: doc.database_path ?? null, ok: doc.probe?.ok === true };
    } catch {
      return { effective_engine: null, database_path: null, ok: false };
    }
  };
}

/** `route_override` when anything still selects the old engine. */
export function routeOverrideRefusal(envNames: readonly string[], services: readonly ServiceDefinition[]): OperationError | null {
  const selecting = envNames.filter(n => n === 'GBRAIN_DATABASE_URL' || n === 'DATABASE_URL');
  const svc = services.filter(s => s.sets.length > 0);
  if (!selecting.length && !svc.length) return null;
  const named = [...selecting.map(n => `variable ${n}`), ...svc.map(s => `${s.kind} service ${s.name} (sets ${s.sets.join(', ')})`)];
  return swapRefusal('route_override', `something still selects the current engine: ${named.join('; ')}.`,
    'A process that starts with that route would keep writing to the old engine after the switch. Remove each named override (or stop that service), then run the swap again.');
}

/** Switches the config file to the Rust store; returns the previous engine and path. */
export function switchAuthority(store: string): { engine: string; database_path: string } {
  const file = loadConfigFileOnly();
  if (!file) throw new Error('no config file to switch');
  const previous = { engine: String(file.engine ?? 'pglite'), database_path: String(file.database_path ?? '') };
  saveConfig({ ...file, engine: 'rust', database_path: resolve(store) } as GBrainConfig);
  return previous;
}

/** Puts the previous engine back (the probe failed or the run is rolled back before success). */
export function restoreAuthority(previous: { engine: string; database_path: string }): void {
  const file = loadConfigFileOnly();
  if (!file) return;
  saveConfig({ ...file, engine: previous.engine, database_path: previous.database_path } as GBrainConfig);
}

/** True when the probe shows the Rust engine at `store`, opened and answering. */
export function probePassed(p: RouteProbe, store: string): boolean {
  return p.ok && p.effective_engine === 'rust' && p.database_path !== null && resolve(p.database_path) === resolve(store);
}
