/**
 * Which engine a call runs for, for code that reads per-engine state without taking the engine as an argument: the
 * AI gateway (ai/gateway.ts) and the Anthropic key resolver (ai/anthropic-key.ts). Every operation handler runs inside
 * its context's engine scope (operation-load.ts), and so does each persistence consumer (persistence/service.ts).
 * A host that calls core functions directly, outside an operation, wraps them in `withEngineScope(engine, fn)`; the
 * engine-taking entry points a host calls (hybridSearch, the import paths) enter it themselves (needsEngineScope).
 *
 * A call decides by scope presence alone. In an embedded engine's scope it uses that engine's state; in a local scope
 * (withLocalScope, which the CLI, gbrain serve and the jobs worker enter, or any other engine's scope) the process
 * gateway; with no scope while the process holds an open embedded engine it refuses `engine_scope_required`. In a
 * process that never opened an embedded engine nothing changes, and withEngineScope enters no scope at all.
 */
import { isEmbeddedEngine, processHasEmbeddedEngines, processHoldsEmbeddedEngines } from './embedded-engine.ts';
import { engineScopeStore as scope } from './engine-scope-store.ts';

export { withLocalScope } from './engine-scope-store.ts';

/** Runs `fn` as a call for `engine`. A plain call in a process that holds no embedded engine. */
export function withEngineScope<T>(engine: object, fn: () => T): T {
  return processHasEmbeddedEngines() ? scope.run(engine, fn) : fn();
}

/** True when `engine` was opened from settings and the call does not run in its scope yet: the entry point re-enters itself in it. */
export function needsEngineScope(engine: object): boolean {
  return isEmbeddedEngine(engine) && scope.getStore() !== engine;
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
