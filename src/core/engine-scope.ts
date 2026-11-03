/**
 * Which engine a call runs for, for code that reads per-engine state without taking the engine as an argument: the
 * AI gateway (ai/gateway.ts) and the Anthropic key resolver (ai/anthropic-key.ts). Every operation handler runs inside
 * its context's engine scope (operation-load.ts), and so does each persistence consumer (persistence/service.ts).
 * A host that calls core functions directly, outside an operation, wraps them in `withEngineScope(engine, fn)`.
 *
 * Only an engine `openEngine` opened changes anything: for every other engine, and in a process that never opened
 * one, the gateway keeps its process-wide state exactly as before, and no scope is even entered.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { isEmbeddedEngine, processHasEmbeddedEngines, processHoldsEmbeddedEngines } from './embedded-engine.ts';

const scope = new AsyncLocalStorage<object>();

/** Runs `fn` as a call for `engine`. A plain call in a process that holds no embedded engine. */
export function withEngineScope<T>(engine: object, fn: () => T): T {
  return processHasEmbeddedEngines() ? scope.run(engine, fn) : fn();
}

/** The engine scope the current call runs in, for deferred work to resume in with runInEngineScope. */
export function currentEngineScope(): object | undefined {
  return scope.getStore();
}

/** Run fn in a captured engine scope, or outside every scope when none was captured, whatever scope the caller is in. */
export function runInEngineScope<T>(engine: object | undefined, fn: () => T): T {
  return engine ? scope.run(engine, fn) : scope.exit(fn);
}

/** True for a call that entered no engine scope while the process holds an open embedded engine. */
export function unscopedInEmbeddedProcess(): boolean {
  return processHoldsEmbeddedEngines() && scope.getStore() === undefined;
}

/** The embedded engine the current call runs for (a page transaction, view or proxy over one counts), else undefined. */
export function embeddedEngineInScope(): object | undefined {
  if (!processHasEmbeddedEngines()) return undefined;
  const engine = scope.getStore();
  return engine && isEmbeddedEngine(engine) ? engine : undefined;
}
