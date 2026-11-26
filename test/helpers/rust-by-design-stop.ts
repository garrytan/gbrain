/**
 * Named Rust stops (docs/designs/RUST_ENGINE.md). Each rethrows the refusal, so the harness counts the stop; any other
 * error fails the case with the row named.
 */
import { isCapabilityRefusal, type EngineCapability } from '../engine-parity/arm-capabilities.ts';

function rethrowStop(error: unknown, capability: EngineCapability, member: string, row: string): never {
  const message = error instanceof Error ? error.message : String(error);
  if (!isCapabilityRefusal(error, capability) || !message.includes(member)) {
    throw new Error(`expected the named ${capability} stop on ${member} (RUST_ENGINE.md row ${row}), got: ${message}`, { cause: error });
  }
  throw error;
}

/**
 * A stop by design (D18): a raw-SQL entry point, or a raw-SQL fixture that sets up a state only a SQL brain can hold,
 * refuses on the Rust arm with `engine_capability_missing` reason `raw_sql`, naming `member`. `row` is the
 * RUST_ENGINE.md row that records why the stop is permanent.
 */
export function rethrowByDesignStop(error: unknown, member: string, row: string): never {
  return rethrowStop(error, 'raw_sql', member, row);
}

/**
 * A raw_sql stop routed to later work: the code under test still reads through `executeRaw`, no Rust caller reaches it
 * (its command refuses at dispatch), and RUST_ENGINE.md row `row` names the owner and when the family is ported.
 */
export function rethrowRoutedStop(error: unknown, member: string, row: string): never {
  return rethrowStop(error, 'raw_sql', member, row);
}

/**
 * A managed-mode stop: a managed sync on the Rust arm refuses `engine_capability_missing` reason
 * `managed_persistence`, naming `performManagedSync` (RUST_ENGINE.md row 47, the managed-mode program).
 */
export function rethrowManagedStop(error: unknown): never {
  return rethrowStop(error, 'managed_persistence', 'performManagedSync', '47');
}
