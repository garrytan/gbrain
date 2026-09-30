// Guard self-test fixture (known-BAD): casts straight to a brand outside brands.ts.
import type { ScopedRead } from "../engine-sql/brands.ts";
import type { SqlExecutor } from "../engine-sql/executor.ts";

export function widen(executor: SqlExecutor): ScopedRead {
  return executor as ScopedRead;
}
