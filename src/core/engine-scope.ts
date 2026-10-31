/**
 * Which engine a call runs against, for the modules that keep state per engine
 * but do not take the engine as an argument: the AI gateway's configuration,
 * model cache, transports and discovery (ai/gateway.ts), the chat-usage sink
 * (ai/chat-usage.ts) and the query-embedding cache (ai/query-embed-cache.ts).
 *
 * An operation handler runs inside `withEngineScope(ctx.engine, ...)`
 * (operation-load.ts), so every gateway call it makes resolves that engine's
 * state. A host that opens two engines in one process and drives the gateway
 * directly enters the scope itself. Outside any scope, or for an engine nothing
 * was recorded against, each module keeps its process-wide state, which is what
 * the CLI and `gbrain serve`, one engine per process, use unchanged.
 *
 * `engineOwned` resolves a value recorded against an engine from any object
 * that stands for it: a read-through view (`registerEngineView`) resolves to
 * the engine it reads through, and a page transaction is an object whose
 * prototype chain reaches the engine that opened it, so the walk covers both.
 * It is the walk persistence/identity.ts makes for an engine's host id.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { viewedEngine } from './persistence/switches.ts';

const scope = new AsyncLocalStorage<object>();

/** Runs `fn` with `engine` as the engine every scoped module resolves its state for. */
export function withEngineScope<T>(engine: object, fn: () => T): T {
  return scope.run(engine, fn);
}

/** The engine the current call runs against, or undefined outside any scope. */
export function engineInScope(): object | undefined {
  return scope.getStore();
}

/**
 * The value `owned` records for `engine`, for the engine it stands for or for an engine on its prototype chain.
 * Undefined when none was recorded.
 */
export function engineOwned<T>(owned: WeakMap<object, T>, engine: object): T | undefined {
  for (let owner: object | null = viewedEngine(engine); owner && owner !== Object.prototype; owner = Object.getPrototypeOf(owner)) {
    const value = owned.get(owner);
    if (value !== undefined) return value;
  }
  return undefined;
}
