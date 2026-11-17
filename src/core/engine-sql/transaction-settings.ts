/**
 * Transaction-local settings (`current_setting` / `set_config(..., true)`) that carry write
 * attribution and trust declarations to the database triggers: one SQL implementation for
 * both engines. Both statements run on the executor they are given, so a transaction engine
 * reads and sets them inside its own transaction. The names are code constants, never user
 * input; they are still bound as parameters and checked against the setting-name alphabet.
 */
import type { LegacyUnscopedRead } from './brands.ts';
import type { SqlExecutor } from './executor.ts';
import { sqlFragment } from './fragment.ts';

const SETTING_NAME = /^[a-z_][a-z0-9_.]*$/;
function assertSettingNames(names: readonly string[]): void {
  for (const name of names) if (!SETTING_NAME.test(name)) throw new Error(`Invalid transaction setting name: ${name}`);
}

/** The current value of each setting, in `names` order; null where it was never set. */
export async function readTransactionSettings(exec: LegacyUnscopedRead, names: readonly string[]): Promise<Array<string | null>> {
  assertSettingNames(names);
  if (names.length === 0) return [];
  const { rows } = await exec.run<{ value: string | null }>(sqlFragment`SELECT current_setting(t.name, true) AS value
    FROM unnest(${[...names]}::text[]) WITH ORDINALITY AS t(name, position) ORDER BY t.position`);
  return names.map((_, index) => rows[index]?.value ?? null);
}

/** Sets each setting to the value at the same index, for the rest of the current transaction (`set_config(name, value, true)`), in one statement. */
export async function applyTransactionSettings(exec: SqlExecutor, names: readonly string[], values: readonly string[]): Promise<void> {
  assertSettingNames(names);
  if (names.length === 0) return;
  await exec.run(sqlFragment`SELECT set_config(t.name, t.value, true) FROM unnest(${[...names]}::text[], ${[...values]}::text[]) AS t(name, value)`);
}
