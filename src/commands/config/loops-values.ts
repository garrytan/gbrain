/**
 * `config set` value checks for `loops.*` keys: nothing is written when a
 * value is one the reader would not accept.
 */
import { exitCliError, usageError } from '../../cli/cli-error.ts';
import { LOOPS_EXTRACT_MAX_USD_PER_DAY_KEY, validateLoopsSpendConfigValue } from '../../core/google/loops-spend.ts';
import { LOOPS_UPDATES_RECIPROCITY_KEY, validateLoopsReciprocityConfigValue } from '../../core/google/loops-reciprocity.ts';

export function refuseInvalidLoopsConfigValue(key: string, value: string): void {
  const reciprocity = validateLoopsReciprocityConfigValue(key, value);
  if (reciprocity) {
    exitCliError(usageError(reciprocity, `Re-run with true or false, e.g. gbrain config set ${LOOPS_UPDATES_RECIPROCITY_KEY} true (false, the default, turns the rule off).`, {
      why: 'The detector reads this key as a boolean; any other value would leave the rule off.',
      fix: { argv: ['gbrain', 'config', 'get', key], consent: [], actor: 'agent', why: 'Shows the value in effect; nothing was written.', requires_exclusive: false },
    }), 'config');
  }
  const err = validateLoopsSpendConfigValue(key, value);
  if (!err) return;
  exitCliError(usageError(err, `Re-run with a non-negative USD amount, e.g. gbrain config set ${LOOPS_EXTRACT_MAX_USD_PER_DAY_KEY} 2.00 (0 queues no paid loop extraction).`, {
    why: 'The daily loop-extraction cap is read as USD; any other value would leave the cap at its default.',
    fix: { argv: ['gbrain', 'config', 'get', key], consent: [], actor: 'agent', why: 'Shows the value in effect; nothing was written.', requires_exclusive: false },
  }), 'config');
}
