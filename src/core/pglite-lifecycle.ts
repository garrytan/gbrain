const openedDatastores = new WeakMap<object, string | undefined>();
const reopenListeners = new WeakMap<object, Set<(sameDatastore: boolean) => void>>();

/** Resident owners resume only after a successful open, never when close merely times out. */
export function registerPgliteReopen(engine: object, listener: (sameDatastore: boolean) => void): () => void {
  let listeners = reopenListeners.get(engine);
  if (!listeners) { listeners = new Set(); reopenListeners.set(engine, listeners); }
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function notifyPgliteOpened(engine: object, databasePath: string | undefined): void {
  const sameDatastore = !!databasePath && openedDatastores.get(engine) === databasePath;
  openedDatastores.set(engine, databasePath);
  // A listener may unregister itself and register its replacement while resuming.
  for (const listener of [...reopenListeners.get(engine) ?? []]) listener(sameDatastore);
}

/** Track datastore work so close never overlaps an admitted statement/transaction. */
export function trackPgliteDatabase<T extends object>(database: T): {
  database: T;
  stopAndDrain(): Promise<void>;
  checkpoint(): Promise<void>;
} {
  const pending = new Set<Promise<unknown>>();
  const tracked = new Set(['query', 'exec', 'transaction', 'runExclusive']);
  const originals = new WeakMap<Function, Function>();
  let accepting = true;
  const proxy = new Proxy(database, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (!tracked.has(String(property))) return value.bind(target);
      const invoke = (...args: unknown[]) => {
        if (!accepting) return Promise.reject(new Error('PGLite not connected: datastore is closing'));
        let result: Promise<unknown>;
        try { result = Promise.resolve(Reflect.apply(value, target, args)); }
        catch (error) { return Promise.reject(error); }
        pending.add(result);
        void result.then(() => pending.delete(result), () => pending.delete(result));
        return result;
      };
      originals.set(invoke, value);
      return invoke;
    },
    set(target, property, value) {
      // Restoring an instrumented method must restore the raw receiver,
      // otherwise the driver's own shutdown query would re-enter admission.
      return Reflect.set(target, property, typeof value === 'function' ? originals.get(value) ?? value : value, target);
    },
  });
  return {
    database: proxy,
    async stopAndDrain() {
      accepting = false;
      await Promise.allSettled([...pending]);
    },
    async checkpoint() {
      const query = Reflect.get(database, 'query', database);
      if (typeof query !== 'function') throw new TypeError('PGLite query method is unavailable');
      await Reflect.apply(query, database, ['CHECKPOINT']);
    },
  };
}

export class PgliteClosingError extends Error {
  readonly code = 'pglite_closing';
  readonly retryable = true;
  constructor(message = 'PGLite datastore is still closing; its kernel lock remains held until close completes or the process exits.') {
    super(message); this.name = 'PgliteClosingError';
  }
}
