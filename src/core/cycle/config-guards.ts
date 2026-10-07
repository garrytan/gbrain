/**
 * Fix wave 11 `config set` guards for cycle keys that are not numeric phase
 * knobs (those live in phase-config-values.ts): `cycle.lint_exclude` refuses
 * a path (#6134), and `dream.patterns.last_run` is state the patterns phase
 * records, so it can only be unset (#6177). Each throws an `invalid_params`
 * OperationError whose fix is a real command; nothing is written.
 */
import { opError } from '../ops/contract.ts';
import { CYCLE_LINT_EXCLUDE_KEY, parseCycleLintExclude } from './lint-fix-setting.ts';
import { PATTERNS_LAST_RUN_KEY } from './patterns-plan.ts';

export const CYCLE_GUARDED_KEYS: readonly string[] = [CYCLE_LINT_EXCLUDE_KEY, PATTERNS_LAST_RUN_KEY];

export function assertCycleConfigValue(key: string, value: string): void {
  if (key === CYCLE_LINT_EXCLUDE_KEY) { parseCycleLintExclude(value); return; }
  if (key !== PATTERNS_LAST_RUN_KEY) return;
  throw opError('invalid_params', `${PATTERNS_LAST_RUN_KEY} is recorded by the patterns phase and cannot be set.`,
    `To forget the recorded run cost, unset it: gbrain config unset ${PATTERNS_LAST_RUN_KEY}`, {
      why: 'The phase sizes in-cycle runs from the cost of the last child it ran; a hand-written value would mis-size them. Nothing was written.',
      fix: { argv: ['gbrain', 'config', 'unset', PATTERNS_LAST_RUN_KEY], consent: [], actor: 'agent', requires_exclusive: false,
        why: 'Unsetting resets the record; the next in-cycle run submits a conservative first batch.',
        verify: { argv: ['gbrain', 'config', 'get', PATTERNS_LAST_RUN_KEY] } },
    });
}
