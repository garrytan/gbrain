import * as segmentedWritesImpl from '../../src/core/engine-sql/segmented-writes.ts';

/**
 * A proxied engine's segmented-write member (engine-sql/segmented-writes.ts) run against the proxy itself, so the
 * statement goes through the proxy's executeRaw and a stub there still sees the SQL. Undefined for any other property.
 */
export function segmentedWriteThrough(prop: string | symbol, receiver: object): ((...args: unknown[]) => unknown) | undefined {
  const fn = typeof prop === 'string' ? (segmentedWritesImpl as Record<string, unknown>)[prop] : undefined;
  return typeof fn === 'function' ? (...args: unknown[]) => (fn as (...a: unknown[]) => unknown)(receiver, ...args) : undefined;
}
