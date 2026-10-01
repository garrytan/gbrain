// Guard self-test fixture (known-GOOD): the façade brands the executor it owns.
import { scopedRead, unscopedExecutor } from "./engine-sql/brands.ts";
import type { SqlExecutor } from "./engine-sql/executor.ts";

export function reads(tx: SqlExecutor) {
  return [scopedRead(tx), unscopedExecutor(tx, "fixture: master read unscoped")];
}
