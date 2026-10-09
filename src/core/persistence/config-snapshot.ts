/**
 * One read of the brain config for a single write's preparation (Phase 4.3).
 * Preparation runs outside every lock and reads a dozen config keys one
 * round trip at a time; this view answers `getConfig` and the equivalent
 * `SELECT value FROM config WHERE key=$1` from one `SELECT key,value FROM
 * config` taken when preparation starts, as one batch's shared reads do
 * (page-mutations.ts `batchSharedReads`). Every other call reaches the engine
 * unchanged (`getAllConfig` answers from the same read). Publication reads its config again inside its transaction.
 */
import type { BrainEngine } from '../engine.ts';
import { registerEngineView } from './switches.ts';

const KEY_READ = 'SELECT value FROM config WHERE key=$1';
const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim();

export async function preparationConfigView(engine: BrainEngine): Promise<BrainEngine> {
  const rows = await engine.executeRaw<{ key: string; value: string }>('SELECT key,value FROM config');
  const values = new Map(rows.map(row => [row.key, row.value]));
  const value = (key: string) => values.has(key) ? values.get(key)! : null;
  return registerEngineView(new Proxy(engine, { get(target, key) {
    if (key === 'getConfig') return async (name: string) => value(name);
    if (key === 'getAllConfig') return async () => Object.fromEntries(values);
    if (key === 'executeRaw') return (sql: string, params?: unknown[], opts?: { signal?: AbortSignal }) =>
      flat(sql) === KEY_READ && typeof params?.[0] === 'string'
        ? Promise.resolve(values.has(params[0]) ? [{ value: values.get(params[0]) }] : [])
        : target.executeRaw(sql, params, opts);
    const member = Reflect.get(target, key, target);
    return typeof member === 'function' ? member.bind(target) : member;
  } }), engine);
}
