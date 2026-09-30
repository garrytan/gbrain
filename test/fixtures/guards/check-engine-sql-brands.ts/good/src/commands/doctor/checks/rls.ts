// Guard self-test fixture (known-GOOD): doctor may take an unscoped read.
import { unscopedExecutor, type LegacyUnscopedRead } from "../../../core/engine-sql/brands.ts";
import type { SqlExecutor } from "../../../core/engine-sql/executor.ts";

export function doctorRead(executor: SqlExecutor): LegacyUnscopedRead {
  return unscopedExecutor(executor, "fixture: doctor inspects every source");
}
