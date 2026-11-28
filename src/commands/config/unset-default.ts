/**
 * GST-3449: `config get` on a key no plane sets. A registered key with a machine-readable default (a write switch, a
 * preparation budget, a terminal-failure threshold) prints the value the runtime resolves it to on stdout and where it
 * comes from on stderr; any other key prints the not-found line, with a hint when the key is known.
 */
import type { BrainEngine } from '../../core/engine.ts';
import { KNOWN_CONFIG_KEYS } from '../../core/config.ts';
import { unsetWriteSwitch } from '../../core/persistence/switches.ts';
import { PREPARATION_BUDGET_KEYS, readPreparationConfigValues, resolvePreparationPolicy } from '../../core/persistence/preparation-budget.ts';
import { readTerminalThresholds, TERMINAL_SPIKE_FACTOR_KEY, TERMINAL_SPIKE_MIN_KEY, TERMINAL_WINDOW_KEY } from '../../core/persistence/terminal-failures.ts';

async function unsetKeyDefault(engine: BrainEngine, key: string, env: Record<string, string | undefined>): Promise<{ value: string; note: string } | null> {
  const overrides = `gbrain config set ${key} <value> overrides it`;
  const sw = unsetWriteSwitch(key, env);
  if (sw) return { value: String(sw.value), note: sw.fromEnv ? `${sw.env} env (the config key is unset)` : `built-in default (unset; ${sw.env} or ${overrides})` };
  const budget = (Object.keys(PREPARATION_BUDGET_KEYS) as Array<keyof typeof PREPARATION_BUDGET_KEYS>).find(name => PREPARATION_BUDGET_KEYS[name] === key);
  if (budget) return { value: String(resolvePreparationPolicy(await readPreparationConfigValues(engine))[budget]), note: `value in effect (unset, resolved with its sibling budgets; ${overrides})` };
  if (key !== TERMINAL_WINDOW_KEY && key !== TERMINAL_SPIKE_FACTOR_KEY && key !== TERMINAL_SPIKE_MIN_KEY) return null;
  const t = await readTerminalThresholds(engine);
  if (key === TERMINAL_WINDOW_KEY) return { value: String(t.windowDays), note: `value in effect (unset${t.clamped ? `; capped at the ${t.retentionDays}-day receipt retention` : ''}; ${overrides})` };
  return { value: String(key === TERMINAL_SPIKE_FACTOR_KEY ? t.spikeFactor : t.spikeMin), note: `built-in default (unset; ${overrides})` };
}

/** Prints the unset key's value in effect and returns true, or prints the not-found lines and returns false. */
export async function reportUnsetKey(engine: BrainEngine, key: string, env: Record<string, string | undefined> = process.env): Promise<boolean> {
  const unset = await unsetKeyDefault(engine, key, env);
  if (unset) {
    console.log(unset.value);
    console.error(`[config] source: ${unset.note}`);
    return true;
  }
  if (KNOWN_CONFIG_KEYS.includes(key)) console.error(`[config] ${key} is a known key with no value set, so its built-in default applies (gbrain config set ${key} <value> overrides it).`);
  console.error(`Config key not found: ${key}`);
  return false;
}
