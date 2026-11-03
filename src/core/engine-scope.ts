/**
 * Which engine a call runs against, for state kept per engine by code that
 * does not take the engine as an argument: the AI gateway's configuration,
 * model cache, transports and discovery (ai/gateway.ts, ai/gateway-state.ts).
 *
 * An operation handler runs inside `withEngineScope(ctx.engine, ...)`
 * (operation-load.ts), so every gateway call it makes resolves that engine's
 * state. A host that opens two engines in one process and drives the gateway
 * directly enters the scope itself. Outside any scope, or for an engine nothing
 * was recorded against, the gateway keeps its process-wide state, which is what
 * the CLI and `gbrain serve`, one engine per process, use unchanged.
 *
 * The per-engine state itself is keyed by `engineKey` (engine-key.ts), so a
 * page transaction, a read-through view or a forwarding proxy over an engine
 * reads that engine's state.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const scope = new AsyncLocalStorage<object>();

/** Runs `fn` with `engine` as the engine every scoped module resolves its state for. */
export function withEngineScope<T>(engine: object, fn: () => T): T {
  return scope.run(engine, fn);
}

/** The engine the current call runs against, or undefined outside any scope. */
export function engineInScope(): object | undefined {
  return scope.getStore();
}

