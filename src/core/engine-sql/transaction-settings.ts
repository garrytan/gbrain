/**
 * Transaction-local settings (`current_setting` / `set_config(..., true)`) that carry write
 * attribution and trust declarations to the database triggers: one SQL implementation for
 * both engines. Both statements run on the executor they are given, so a transaction engine
 * reads and sets them inside its own transaction. The names are code constants, never user
 * input; they are interpolated into the statement text exactly as the callers did.
 */
import type { LegacyUnscopedRead } from './brands.ts';
import type { SqlExecutor } from './executor.ts';

const SETTING_NAME = /^[a-z_][a-z0-9_.]*$/;
function assertSettingNames(names: readonly string[]): void {
  for (const name of names) if (!SETTING_NAME.test(name)) throw new Error(`Invalid transaction setting name: ${name}`);
}

/** The current value of each setting, in `names` order; null where it was never set. */
export async function readTransactionSettings(exec: LegacyUnscopedRead, names: readonly string[]): Promise<Array<string | null>> {
  assertSettingNames(names);
  const [row] = await exec.executeRaw<Record<string, string | null>>(
    `SELECT ${names.map((name, index) => `current_setting('${name}',true) AS s${index}`).join(',')}`);
  return names.map((_, index) => row?.[`s${index}`] ?? null);
}

/** Sets each setting to the value at the same index, for the rest of the current transaction (`set_config(name, value, true)`), in one statement. */
export async function applyTransactionSettings(exec: SqlExecutor, names: readonly string[], values: readonly string[]): Promise<void> {
  assertSettingNames(names);
  await exec.executeRaw(`SELECT ${names.map((name, index) => `set_config('${name}',$${index + 1},true)`).join(',')}`, [...values]);
}
