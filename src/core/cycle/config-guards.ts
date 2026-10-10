/**
 * Fix wave 11 `config set` guards for cycle keys that are not numeric phase
 * knobs (those live in phase-config-values.ts): `cycle.lint_exclude` refuses
 * a path (#6134), `dream.patterns.last_run` is state the patterns phase
 * records, so it can only be unset (#6177), and `dream.attribution_checks`
 * takes a boolean word (#5425). Each throws an `invalid_params`
 * OperationError whose fix is a real command; nothing is written.
 */
import { opError } from '../ops/contract.ts';
import { CYCLE_LINT_EXCLUDE_KEY, parseCycleLintExclude } from './lint-fix-setting.ts';
import { PATTERNS_LAST_RUN_KEY } from './patterns-plan.ts';
import { ATTRIBUTION_CHECKS_KEY, parseAttributionChecks } from './attribution-checks.ts';

export const CYCLE_GUARDED_KEYS: readonly string[] = [CYCLE_LINT_EXCLUDE_KEY, PATTERNS_LAST_RUN_KEY, ATTRIBUTION_CHECKS_KEY];

export function assertCycleConfigValue(key: string, value: string): void {
  if (key === CYCLE_LINT_EXCLUDE_KEY) { parseCycleLintExclude(value); return; }
  if (key === ATTRIBUTION_CHECKS_KEY) {
    if (parseAttributionChecks(value) !== null) return;
    throw opError('invalid_params', `Invalid ${ATTRIBUTION_CHECKS_KEY}: expected true or false.`,
      `Set ${ATTRIBUTION_CHECKS_KEY} to true or false (default: false), or unset it to use the default.`, {
        why: 'The dream phases read this switch on every run and would treat any other word as off. Nothing was written.',
        fix: { argv: ['gbrain', 'config', 'set', ATTRIBUTION_CHECKS_KEY, '<VALUE>'],
          inputs: [{ name: 'VALUE', how: 'true or false; ask the user when unclear.' }], consent: [], actor: 'agent', requires_exclusive: false,
          why: 'Turns the mechanical attribution checks on or off for the next dream run.',
          verify: { argv: ['gbrain', 'config', 'get', ATTRIBUTION_CHECKS_KEY] } },
      });
  }
  if (key !== PATTERNS_LAST_RUN_KEY) return;
  throw opError('invalid_params', `${PATTERNS_LAST_RUN_KEY} is recorded by the patterns phase and cannot be set.`,
    `To forget the recorded run cost, unset it: gbrain config unset ${PATTERNS_LAST_RUN_KEY}`, {
      why: 'The phase sizes in-cycle runs from the cost of the last child it ran; a hand-written value would mis-size them. Nothing was written.',
      fix: { argv: ['gbrain', 'config', 'unset', PATTERNS_LAST_RUN_KEY], consent: [], actor: 'agent', requires_exclusive: false,
        why: 'Unsetting resets the record; the next in-cycle run submits a conservative first batch.',
        verify: { argv: ['gbrain', 'config', 'get', PATTERNS_LAST_RUN_KEY] } },
    });
}
