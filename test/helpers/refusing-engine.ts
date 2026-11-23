/**
 * A real engine that refuses like a Rust brain: raw SQL (or any named member) throws the real
 * `engine_capability_missing` refusal while every typed member still answers from the wrapped engine.
 */
import type { BrainEngine } from '../../src/core/engine.ts';
import { capabilityMissing } from '../../src/core/rust-engine/errors.ts';

/** The refusal a Rust brain raises for a statement it has not typed. */
export const rawSqlRefusal = (): Error => capabilityMissing('raw_sql', 'executeRaw');

/**
 * `engine` whose `executeRaw` throws `error()` for a statement containing `needle` (every statement when `needle` is
 * absent, none when it is null), and whose members named in `members` throw it too. Members bind to the wrapped engine, so the typed members
 * the wrapped engine runs on itself never meet the refusal.
 */
export function refusingEngine(engine: BrainEngine, opts: { needle?: string | null; members?: readonly string[]; error?: () => Error } = {}): BrainEngine {
  const error = opts.error ?? rawSqlRefusal;
  return new Proxy(engine, {
    get(target, property) {
      if (property === 'executeRaw') {
        return async (sql: string, ...rest: unknown[]) => {
          if (opts.needle === undefined || (opts.needle !== null && sql.includes(opts.needle))) throw error();
          return (target.executeRaw as (...a: unknown[]) => Promise<unknown>).call(target, sql, ...rest);
        };
      }
      if (typeof property === 'string' && opts.members?.includes(property)) return async () => { throw error(); };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
