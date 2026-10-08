/**
 * Phase 4.2: a per-process cache of the pre-admission reads that admission
 * rechecks under lock, for foreground page writes on Postgres.
 *
 * Cached: the brain identity (admission's protocol statement returns it under
 * the brain row lock and must match), the source row (admission locks it
 * FOR SHARE and checks incarnation and archived), the worktree binding
 * (admission locks the worktree FOR SHARE and checks the binding's
 * worktree, incarnation and topology generation, publication rechecks the
 * owner) and the local writer registration (admission locks the writer row
 * FOR SHARE and checks revocation, lane and grant). An absence is never
 * cached: no row, a source without a local path, a binding without this
 * host's path, a revoked writer. Entries are kept per engine (one database
 * connection identity) under the brain id they were read for, for at most
 * PREADMIT_TTL_MS. When admission refuses a write the cache might explain
 * (`preadmitRecheckFailed`), the caller drops this engine's entries and runs
 * the whole pre-admission again uncached, once, so the write refuses (or
 * routes) exactly as without the cache.
 */
import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { registerEngineView, writeSwitchOn } from './switches.ts';

export const PREADMIT_TTL_MS = 30_000;
const BRAIN_SQL = 'SELECT brain_id FROM persistence_brain WHERE singleton=1';
const SOURCE_SQL = "SELECT incarnation,archived,local_path,config->>'kind' AS kind FROM sources WHERE id=$1";
const BINDING_SQL = 'SELECT s.source_id,s.source_incarnation,s.worktree_id,s.relative_path, s.topology_generation::text AS topology_generation,w.owner_host_id,w.owner_epoch::text AS owner_epoch,w.state, h.local_path,h.coordination_path FROM persistence_source_bindings s JOIN persistence_worktrees w ON w.id=s.worktree_id LEFT JOIN persistence_host_bindings h ON h.worktree_id=w.id AND h.host_id=$2::uuid WHERE s.source_id=$1';
const WRITER_SQL = new Set([
  'SELECT revoked_at,credential_hash,lane FROM persistence_local_writers WHERE id=$1::uuid',
  'SELECT lane,credential_hash,grant_ceiling,revoked_at FROM persistence_local_writers WHERE id=$1::uuid',
  'SELECT lane,revoked_at,grant_ceiling FROM persistence_local_writers WHERE id=$1::uuid',
]);
/** Whether a read's rows are a presence worth keeping. */
function present(sql: string, rows: Array<Record<string, unknown>>): boolean {
  const row = rows[0];
  if (rows.length !== 1 || !row) return false;
  if (sql === BRAIN_SQL) return typeof row.brain_id === 'string';
  if (sql === SOURCE_SQL) return row.archived === false && typeof row.local_path === 'string' && row.local_path !== '';
  if (sql === BINDING_SQL) return typeof row.local_path === 'string' && row.local_path !== '' && row.state === 'active';
  return WRITER_SQL.has(sql) && row.revoked_at == null;
}

interface EngineCache { brainId?: { id: string; at: number }; reads: Map<string, { at: number; rows: unknown[] }> }
const caches = new WeakMap<object, EngineCache>();
const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim();

export function dropPreadmitCache(engine: BrainEngine): void { caches.delete(engine); }

/** The brain id the cached reads of `engine` were taken for; admission must see the same one. */
export function cachedPreadmitBrain(engine: BrainEngine): string | undefined { return caches.get(engine)?.brainId?.id; }

/**
 * `engine` seen through the cache when the `preadmit_cache` switch is on (Postgres only),
 * else null. Statements outside the cached set pass through unchanged.
 */
export async function preadmitReads(engine: BrainEngine, now: () => number = Date.now): Promise<BrainEngine | null> {
  if (engine?.kind !== 'postgres' || !await writeSwitchOn(engine, 'preadmit_cache').catch(() => false)) return null;
  let cache = caches.get(engine);
  if (!cache) { cache = { reads: new Map() }; caches.set(engine, cache); }
  const held = cache;
  const read = async (sql: string, params: unknown[] | undefined, opts: { signal?: AbortSignal } | undefined): Promise<unknown[]> => {
    if (caches.get(engine) !== held) return engine.executeRaw(sql, params, opts);
    if (sql === BRAIN_SQL) {
      if (held.brainId && now() - held.brainId.at < PREADMIT_TTL_MS) return [{ brain_id: held.brainId.id }];
      const rows = await engine.executeRaw<Record<string, unknown>>(sql, params, opts);
      if (present(sql, rows) && caches.get(engine) === held) {
        if (held.brainId && held.brainId.id !== rows[0]!.brain_id) held.reads.clear();
        held.brainId = { id: String(rows[0]!.brain_id), at: now() };
      }
      return rows;
    }
    const key = JSON.stringify([held.brainId?.id ?? null, sql, params ?? null]);
    const hit = held.reads.get(key);
    if (hit && now() - hit.at < PREADMIT_TTL_MS) return hit.rows.map(row => ({ ...(row as object) }));
    const rows = await engine.executeRaw<Record<string, unknown>>(sql, params, opts);
    if (held.brainId && present(sql, rows) && caches.get(engine) === held) held.reads.set(key, { at: now(), rows: rows.map(row => ({ ...row })) });
    else held.reads.delete(key);
    return rows;
  };
  // Every cached read is filed under the brain it was taken for, which admission checks.
  if (!held.brainId || now() - held.brainId.at >= PREADMIT_TTL_MS) await read(BRAIN_SQL, undefined, undefined);
  return registerEngineView(new Proxy(engine, { get(target, key) {
    if (key === 'executeRaw') return (sql: string, params?: unknown[], opts?: { signal?: AbortSignal }) => {
      const text = flat(sql);
      return text === BRAIN_SQL || text === SOURCE_SQL || text === BINDING_SQL || WRITER_SQL.has(text) ? read(text, params, opts) : target.executeRaw(sql, params, opts);
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } }), engine);
}

/** Thrown by admission when the brain behind the connection is not the one the cached reads came from; never leaves the retry. */
export class PreadmitBrainChanged extends Error {
  constructor() { super('The brain behind this connection changed since its identity was cached; the write is prepared again.'); this.name = 'PreadmitBrainChanged'; }
}

/** Admission refusals a stale cached read can cause: retried once without the cache. */
export function preadmitRecheckFailed(error: unknown): boolean {
  return error instanceof PreadmitBrainChanged || error instanceof OperationError && ['source_changed', 'permission_denied'].includes(error.code);
}
