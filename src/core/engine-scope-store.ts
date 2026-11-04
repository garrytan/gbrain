/**
 * The store engine-scope.ts reads, the local scope the CLI, gbrain serve and the jobs worker enter at their entry
 * points, and the embedded-engine lookup for leaf readers (search/private-visibility.ts). A leaf (no imports beyond
 * node), so the CLI entry and the chunker graph pay nothing for it.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export const engineScopeStore = new AsyncLocalStorage<object>();

const LOCAL = Object.freeze({});

/** Set by embedded-engine.ts when it loads (so before any engine is opened from settings): its engineKey, else undefined. */
let embeddedKeyOf: (engine: object) => object | undefined = () => undefined;
/** Set with it: whether an embedded engine is open in this process. */
let holdsEmbedded: () => boolean = () => false;

export function setEmbeddedKeyResolver(resolve: (engine: object) => object | undefined, holds: () => boolean): void {
  embeddedKeyOf = resolve;
  holdsEmbedded = holds;
}

/** True for a call that entered no scope while an embedded engine is open: its brain is unknown, so a reader takes the strict policy. */
export function unscopedWithOpenEmbeddedEngines(): boolean {
  return engineScopeStore.getStore() === undefined && holdsEmbedded();
}

/** The engineKey of `engine` when it was opened from settings, else undefined. */
export function embeddedKey(engine: object): object | undefined {
  return embeddedKeyOf(engine);
}

/** The engineKey of the embedded engine the current call runs for, else undefined. */
export function embeddedKeyInScope(): object | undefined {
  const engine = engineScopeStore.getStore();
  return engine ? embeddedKeyOf(engine) : undefined;
}

/** Runs `fn` as a call that belongs to no embedded engine: its AI calls use the process gateway, as before embedded engines existed. */
export function withLocalScope<T>(fn: () => T): T {
  return engineScopeStore.run(LOCAL, fn);
}
