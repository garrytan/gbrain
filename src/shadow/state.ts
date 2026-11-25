/**
 * Shadow mode state (docs/designs/RUST_ENGINE.md, "Shadow mode and swap"; plan PR S1).
 *
 * Every byte shadow mode keeps lives under `<configDir()>/shadow/<brain>/`, so GBRAIN_HOME moves it with the rest of
 * the gbrain home. Shadow mode writes nothing to the brain database, its config table or the brain repo.
 *
 *   state.json          on/off and the settings `engine shadow start` confirmed (this module)
 *   store/              the Rust engine's own store, owned by the shadow child
 *   ledger/YYYY-MM-DD.jsonl  one content-free row per comparison (ledger.ts)
 *   summary.json        running counts per operation and outcome (ledger.ts)
 *   faults.jsonl        child exits, restarts and the reason mirroring stopped (supervisor.ts)
 *   reports/            the provisional report (report.ts)
 *
 * `<brain>` is the engine kind plus the first 12 hex characters of a SHA-256 over the brain's identity: the resolved
 * `database_path` for PGLite, or the user name, host, port and database name of `database_url` for Postgres (a pooler
 * routes by user name, so it is part of the hash; it is never stored or shown, and the password is never used). The engine factory reads `state.json` on every engine it builds, so `shadowStateFor` is an existsSync
 * and, only when the file exists, one small JSON read.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { configDir } from '../core/config.ts';
import type { EngineConfig } from '../core/types.ts';
import type { ManagedStorageRecord } from './managed-gate.ts';

export const SHADOW_STATE_VERSION = 1;
/** Default share of eligible reads mirrored (`shadow.read_sample` in the plan). */
export const DEFAULT_SHADOW_SAMPLE_RATE = 0.1;
/** Default bound on queued mirror events in the serving process. */
export const DEFAULT_SHADOW_QUEUE_BOUND = 256;

export interface ShadowState {
  version: number;
  enabled: boolean;
  /** ISO time `start --yes` ran. */
  started_at: string;
  /** ISO time `stop` ran, when it has. */
  stopped_at?: string;
  sample_rate: number;
  queue_bound: number;
  /** The plan hash `start --yes --expect` confirmed. */
  plan_hash: string;
  /** The `<brain>` directory name. */
  brain: string;
  /** The primary engine kind at start. */
  primary_engine: string;
  /** Whether the brain used managed storage when `start` read it. Absent in a state written before this field existed. */
  storage?: ManagedStorageRecord;
  /**
   * The start of the writer-evidence epoch: the first `start --yes` of the current seed. A later `start` keeps it (and the
   * seed it names), so a restart cannot move the eligibility window past evidence already gathered; a new seed begins a new one.
   */
  writer_evidence_since?: string;
  /** The seed id the epoch belongs to (null: no seed yet at that start). */
  writer_evidence_seed?: string | null;
  /**
   * Set by `start` when it continues an existing epoch (an enabled restart, a start after stop, or an older state file). Hooks
   * were replaced or were off at some point, and no record proves otherwise, so eligibility counts it as an unknown writer path
   * while it is inside the window (a file, no database needed).
   */
  writer_coverage_restarted_at?: string;
  /** Set by `stop` before it removes the hooks. Counted like the restart time, and the state itself counts while shadow mode is off. */
  writer_coverage_stopped_at?: string;
}

/** The identity of the brain a config opens, without credentials. Null when the config names no brain store. */
export function brainIdentity(config: Pick<EngineConfig, 'engine' | 'database_path' | 'database_url'>): { engine: string; identity: string } | null {
  const engine: NonNullable<EngineConfig['engine']> = config.engine ?? (config.database_url ? 'postgres' : 'pglite');
  switch (engine) {
    case 'postgres': {
      if (!config.database_url) return null;
      try {
        const url = new URL(config.database_url);
        // The user name stays: a pooler routes by it (Supabase `postgres.<project>`), so two brains share host, port and database. It is only hashed, never stored or shown.
        const user = url.username ? `${decodeURIComponent(url.username)}@` : '';
        return { engine, identity: `postgres://${user}${url.hostname}:${url.port || '5432'}/${decodeURIComponent(url.pathname.replace(/^\//, ''))}` };
      } catch {
        return null;
      }
    }
    case 'pglite':
      if (!config.database_path) return null;
      return { engine, identity: `pglite:${resolve(config.database_path)}` };
    case 'rust':
      return null; // shadow mode follows a PGLite or Postgres brain; a Rust brain has no primary to mirror
    default: {
      const unreachable: never = engine;
      return unreachable;
    }
  }
}

/** `<engine>-<12 hex>`, the directory name of a brain's shadow state. */
export function shadowBrainKey(config: Pick<EngineConfig, 'engine' | 'database_path' | 'database_url'>): string | null {
  const id = brainIdentity(config);
  if (!id) return null;
  return `${id.engine}-${createHash('sha256').update(id.identity).digest('hex').slice(0, 12)}`;
}

export function shadowRoot(): string {
  return join(configDir(), 'shadow');
}

/** True once this home has a shadow directory (shadow mode or shadow replay used it); one existsSync. */
export function shadowHomeUsed(): boolean {
  return existsSync(shadowRoot());
}

export function shadowDirFor(brainKey: string): string {
  return join(shadowRoot(), brainKey);
}

export function shadowStatePath(dir: string): string {
  return join(dir, 'state.json');
}

/** The parsed state file, or null when it is absent or unreadable (an unreadable file reads as off). */
export function readShadowState(dir: string): ShadowState | null {
  const path = shadowStatePath(dir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as ShadowState;
    if (!parsed || typeof parsed !== 'object' || parsed.version !== SHADOW_STATE_VERSION) return null;
    // A hand-edited file with a bad rate or bound reads as off, never as an unbounded or always-on mirror.
    if (!(parsed.sample_rate > 0 && parsed.sample_rate <= 1) || !Number.isInteger(parsed.queue_bound) || parsed.queue_bound < 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Writes the state file atomically (temp file plus rename), mode 0600, creating the directory 0700. */
export function writeShadowState(dir: string, state: ShadowState): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = shadowStatePath(dir);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * The engine factory's check: the shadow directory and state when shadow mode is on for the brain `config` opens,
 * else null. Cheap when off: one existsSync on the shadow root for a home that never used shadow mode. The shadow
 * child (GBRAIN_SHADOW_CHILD=1) never shadows.
 */
export function shadowStateFor(config: EngineConfig): { dir: string; state: ShadowState } | null {
  if (process.env.GBRAIN_SHADOW_CHILD === '1') return null;
  if (!existsSync(shadowRoot())) return null;
  const key = shadowBrainKey(config);
  if (!key) return null;
  const dir = shadowDirFor(key);
  const state = readShadowState(dir);
  return state?.enabled ? { dir, state } : null;
}
