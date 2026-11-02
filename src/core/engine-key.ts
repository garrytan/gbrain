import { ENGINE_ROOT } from './engine-root.ts';
import { viewedEngine } from './persistence/switches.ts';
import { engineCacheKey } from './statement-deadline.ts';

/**
 * The object a per-engine cache keys on: the engine itself, reached through `ENGINE_ROOT` from a page-transaction clone
 * or any forwarding proxy, and otherwise by walking a page-transaction clone (an object whose prototype is the engine
 * that opened it), a read-through view (`registerEngineView`) or a statement-deadline wrapper.
 * A process with several engines (mounted brains) keeps one entry per engine, and a transaction or view shares its
 * engine's entry, so per-brain settings and buffers never cross brains.
 */
export function engineKey(engine: object): object {
  const root = (engine as { [ENGINE_ROOT]?: object })[ENGINE_ROOT];
  if (root) return root;
  let key = engine;
  for (;;) {
    const transaction = Object.hasOwn(key, '_pageTransaction') && (key as { _pageTransaction?: unknown })._pageTransaction === true;
    const next = transaction ? Object.getPrototypeOf(key) as object | null : viewedEngine(engineCacheKey(key));
    if (next === null || next === key) return key;
    key = next;
  }
}
