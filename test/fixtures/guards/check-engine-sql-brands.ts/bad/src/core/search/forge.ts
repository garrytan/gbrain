// Guard self-test fixture (known-BAD): forges a brand by spelling its key.
import type { SqlExecutor } from "../engine-sql/executor.ts";

export function forge(executor: SqlExecutor) {
  return { ...executor, __obtainViaUnscopedExecutor: true as const };
}
