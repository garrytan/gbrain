/**
 * Wrap an engine so every `executeRaw` / `runMigration` / `transaction` call
 * (including calls on the engine handed to a `transaction` callback) is
 * appended to `calls` as `"<method>:<sql>"`. Methods stay bound to the real
 * engine, so private state and `this.db` keep working.
 */
import type { BrainEngine } from '../../src/core/engine.ts';

export function recordingEngine<E extends BrainEngine>(target: E): { engine: E; calls: string[] } {
  const calls: string[] = [];
  const wrap = <T extends object>(t: T): T =>
    new Proxy(t, {
      get(obj, prop) {
        const v = Reflect.get(obj, prop, obj);
        if (typeof v !== 'function') return v;
        if (prop === 'transaction') {
          return (fn: (tx: BrainEngine) => Promise<unknown>) => {
            calls.push('transaction:');
            return v.call(obj, (tx: BrainEngine) => fn(wrap(tx)));
          };
        }
        if (prop === 'executeRaw' || prop === 'runMigration') {
          return (...args: unknown[]) => {
            const sql = args.find((a) => typeof a === 'string') as string | undefined;
            calls.push(`${String(prop)}:${(sql ?? '').replace(/\s+/g, ' ').trim()}`);
            return v.apply(obj, args);
          };
        }
        return v.bind(obj);
      },
    });
  return { engine: wrap(target), calls };
}
