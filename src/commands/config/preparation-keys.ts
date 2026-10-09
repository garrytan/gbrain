/**
 * #6278: `config set` validation for the preparation budget family
 * (persistence/preparation-budget.ts): each key's range, and the ceiling rule
 * across the sibling keys, refused as a usage error (exit 2) with the value in
 * effect as the read-only fix; nothing is written.
 */
import type { BrainEngine } from '../../core/engine.ts';
import { PREPARATION_BUDGET_CONFIG_KEYS, readPreparationConfigValues, validatePreparationConfigValue } from '../../core/persistence/preparation-budget.ts';
import { exitCliError, usageError } from '../../cli/cli-error.ts';

export async function refuseInvalidPreparationValue(engine: BrainEngine, key: string, value: string): Promise<void> {
  if (!PREPARATION_BUDGET_CONFIG_KEYS.includes(key)) return;
  const refusal = validatePreparationConfigValue(key, value, await readPreparationConfigValues(engine));
  if (!refusal) return;
  exitCliError(usageError(refusal.message, refusal.suggestion,
    { fix: { argv: ['gbrain', 'config', 'get', key], consent: [], actor: 'agent', why: 'Shows the value in effect; nothing was written.', requires_exclusive: false } }), 'config');
}
