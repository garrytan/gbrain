/**
 * Each engine stores itself under this symbol. A page-transaction clone inherits it, and every forwarding proxy over an
 * engine (the autopilot guard, the shared-read wrappers) returns it through `Reflect.get`, so `engineKey` reaches the
 * engine from any of them without a registry. Kept in its own module so the engines import nothing else for it.
 */
export const ENGINE_ROOT: unique symbol = Symbol.for('gbrain.engine-root');
