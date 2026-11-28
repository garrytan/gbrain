/**
 * GST-3449: `config get` on a key no plane sets. A registered key with a machine-readable default (a write switch, a
 * preparation budget, a terminal-failure threshold) prints the value it resolves to on stdout and where it comes from on
 * stderr; any other key prints the not-found line, with a hint when the key is known.
 */
import { KNOWN_CONFIG_KEYS } from '../../core/config.ts';
import { unsetWriteSwitch } from '../../core/persistence/switches.ts';
import { DEFAULT_PREPARATION_POLICY, PREPARATION_BUDGET_KEYS } from '../../core/persistence/preparation-budget.ts';
import { TERMINAL_DEFAULTS, TERMINAL_SPIKE_FACTOR_KEY, TERMINAL_SPIKE_MIN_KEY, TERMINAL_WINDOW_KEY } from '../../core/persistence/terminal-failures.ts';

function unsetKeyDefault(key: string, env: Record<string, string | undefined>): { value: string; note: string } | null {
  const overrides = `gbrain config set ${key} <value> overrides it`;
  const sw = unsetWriteSwitch(key, env);
  if (sw) return { value: String(sw.value), note: sw.fromEnv ? `${sw.env} env (the config key is unset)` : `built-in default (unset; ${sw.env} or ${overrides})` };
  const budget = (Object.keys(PREPARATION_BUDGET_KEYS) as Array<keyof typeof PREPARATION_BUDGET_KEYS>).find(name => PREPARATION_BUDGET_KEYS[name] === key);
  if (budget) return { value: String(DEFAULT_PREPARATION_POLICY[budget]), note: `built-in default (unset; ${overrides})` };
  const terminal = { [TERMINAL_WINDOW_KEY]: TERMINAL_DEFAULTS.windowDays, [TERMINAL_SPIKE_FACTOR_KEY]: TERMINAL_DEFAULTS.spikeFactor, [TERMINAL_SPIKE_MIN_KEY]: TERMINAL_DEFAULTS.spikeMin }[key];
  if (terminal !== undefined) return { value: String(terminal), note: `built-in default (unset; ${overrides})` };
  return null;
}

/** Prints the unset key's default and returns true, or prints the not-found lines and returns false. */
export function reportUnsetKey(key: string, env: Record<string, string | undefined> = process.env): boolean {
  const unset = unsetKeyDefault(key, env);
  if (unset) {
    console.log(unset.value);
    console.error(`[config] source: ${unset.note}`);
    return true;
  }
  if (KNOWN_CONFIG_KEYS.includes(key)) console.error(`[config] ${key} is a known key with no value set, so its built-in default applies (gbrain config set ${key} <value> overrides it).`);
  console.error(`Config key not found: ${key}`);
  return false;
}
