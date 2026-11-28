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
import { spawnSync } from '../spawn.ts';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfigFileOnly, saveConfig, type GBrainConfig } from '../config.ts';
import { resolveServeGbrainCommand } from '../serve-service.ts';
import type { ServiceDefinition } from './plan.ts';
import { swapRefusal } from './refusals.ts';
import type { OperationError } from '../ops/contract.ts';
import type { ServedProbeReason, ServedProbeVerdict } from './served-probe.ts';

/** The live check of the served destination a plan bound (served-probe.ts), when it bound one: no credential, ever. */
export interface ServedRouteCheck { ok: boolean; url: string; reason: ServedProbeReason | null; detail: string | null }

export interface RouteProbe { effective_engine: string | null; database_path: string | null; ok: boolean; served?: ServedRouteCheck }

/**
 * A fresh-process probe of the configured route; tests pass their own. `credential`: the swap run's probe token
 * (probe-token.ts), held in memory only, for the brain server check; the route probe itself ignores it.
 */
export type RouteProber = (credential?: { token: string }) => Promise<RouteProbe>;

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

/**
 * The route probe of a plan with a served destination (writers on many hosts): the fresh-process probe first, then, only
 * when it passed, the brain server check at the address and store brain id the plan bound. The run keeps the Rust
 * engine only when both pass (probePassed); any served verdict but `ok` gives authority back to the old engine.
 */
export function withServedCheck(base: RouteProber, served: (credential?: { token: string }) => Promise<ServedProbeVerdict>): RouteProber {
  return async (credential) => {
    const probe = await base();
    if (!probe.ok) return probe;
    const v = await served(credential);
    return { ...probe, served: v.ok ? { ok: true, url: v.url, reason: null, detail: null } : { ok: false, url: v.url, reason: v.reason, detail: v.detail } };
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

/** The previous engine the switch replaced. A `database_url` the config file held is never in it: it is kept beside
 * the run record (`previous-route-<run>.json`, 0600, under the gbrain home) and `database_url_saved` says so. */
export interface PreviousAuthority { engine: string; database_path: string; database_url_saved?: boolean }

/** Where the switch keeps the config file's database_url for one run (never printed, never in the run record). */
export interface SavedRoute { runDir: string; runId: string }

function savedRoutePath(r: SavedRoute): string {
  return join(r.runDir, `previous-route-${r.runId}.json`);
}

/** Switches the config file to the Rust store; returns the previous engine and path (never the database URL). */
export function switchAuthority(store: string, saved?: SavedRoute): PreviousAuthority {
  const file = loadConfigFileOnly();
  if (!file) throw new Error('no config file to switch');
  const previous: PreviousAuthority = { engine: String(file.engine ?? 'pglite'), database_path: String(file.database_path ?? '') };
  const next: Record<string, unknown> = { ...file, engine: 'rust', database_path: resolve(store) };
  if (file.database_url) {
    if (!saved) throw new Error('the config file holds a database_url and the switch has nowhere to keep it');
    mkdirSync(saved.runDir, { recursive: true, mode: 0o700 });
    writeFileSync(savedRoutePath(saved), JSON.stringify({ database_url: file.database_url }), { mode: 0o600 });
    delete next.database_url;
    previous.database_url_saved = true;
  }
  saveConfig(next as unknown as GBrainConfig);
  return previous;
}

/** Puts the previous engine back (the probe failed or the run is rolled back before success). */
/** The database_url the switch saved for this run (a Postgres brain), or null. Never logged. */
export function savedDatabaseUrl(saved: SavedRoute): string | null {
  const path = savedRoutePath(saved);
  if (!existsSync(path)) return null;
  return (JSON.parse(readFileSync(path, 'utf8')) as { database_url?: string }).database_url ?? null;
}

export function restoreAuthority(previous: PreviousAuthority, saved?: SavedRoute): void {
  const file = loadConfigFileOnly();
  if (!file) return;
  const next: Record<string, unknown> = { ...file, engine: previous.engine, database_path: previous.database_path };
  if (!previous.database_path) delete next.database_path;
  if (previous.database_url_saved) {
    if (!saved || !existsSync(savedRoutePath(saved))) throw new Error('the saved database_url for this run is missing');
    next.database_url = (JSON.parse(readFileSync(savedRoutePath(saved), 'utf8')) as { database_url: string }).database_url;
  }
  saveConfig(next as unknown as GBrainConfig);
}

/** True when the probe shows the Rust engine at `store`, opened and answering, and the served check (when the plan
 * bound one) passed. */
export function probePassed(p: RouteProbe, store: string): boolean {
  return p.ok && p.effective_engine === 'rust' && p.database_path !== null && resolve(p.database_path) === resolve(store)
    && (p.served === undefined || p.served.ok);
}
