// Guard self-test fixture stub: mirrors src/core/engine-sql/brands.ts (the one place brand keys and casts live).
import type { SqlExecutor } from "./executor.ts";

export type ScopedRead = SqlExecutor & { readonly __obtainViaWithScopedReadTransaction: true };
export type LegacyUnscopedRead = SqlExecutor & { readonly __obtainViaUnscopedExecutor: true };

export function scopedRead(executor: SqlExecutor): ScopedRead {
  return executor as ScopedRead;
}

export function unscopedExecutor(executor: SqlExecutor, reason: string): LegacyUnscopedRead {
  void reason;
  return executor as LegacyUnscopedRead;
}
