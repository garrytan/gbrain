/**
 * #6278: `config set` validation for the preparation budget family
 * (persistence/preparation-budget.ts): each key's range, and the ceiling rule
 * across the sibling keys, refused as a usage error (exit 2) with the value in
 * effect as the read-only fix; nothing is written. #6650 adds the terminal-failure thresholds.
 */
import type { BrainEngine } from '../../core/engine.ts';
import { PREPARATION_BUDGET_CONFIG_KEYS, readPreparationConfigValues, validatePreparationConfigValue } from '../../core/persistence/preparation-budget.ts';
import { exitCliError, usageError } from '../../cli/cli-error.ts';
import { validateTerminalConfigValue } from '../../core/persistence/terminal-failures.ts';

export async function refuseInvalidPreparationValue(engine: BrainEngine, key: string, value: string): Promise<void> {
  const getFix = { fix: { argv: ['gbrain', 'config', 'get', key], consent: [], actor: 'agent' as const, why: 'Shows the value in effect; nothing was written.', requires_exclusive: false } };
  // #6650: the terminal-failure thresholds (persistence/terminal-failures.ts) share this persistence.* refusal.
  const terminal = validateTerminalConfigValue(key, value);
  if (terminal) exitCliError(usageError(terminal, `Set ${key} to a value in that range, e.g. gbrain config set ${key} ${key.endsWith('window_days') ? 14 : key.endsWith('spike_factor') ? 3 : 25}.`, getFix), 'config');
  if (!PREPARATION_BUDGET_CONFIG_KEYS.includes(key)) return;
  const refusal = validatePreparationConfigValue(key, value, await readPreparationConfigValues(engine));
  if (!refusal) return;
  exitCliError(usageError(refusal.message, refusal.suggestion,
    getFix), 'config');
}
