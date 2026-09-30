// Guard self-test fixture (known-BAD): a double cast onto the executor type.
import type { SqlExecutor } from "../engine-sql/executor.ts";

export function pretend(handle: object): SqlExecutor {
  return handle as unknown as SqlExecutor;
}
