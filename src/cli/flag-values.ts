/**
 * Agent contract v1 (D4): strict numeric values for CLI-only command flags.
 * A malformed, out-of-range or missing value is a usage error
 * (`invalid_params`, exit 2 through renderCliError) naming the flag, what it
 * accepts and a valid example, instead of a silent NaN/parseInt fallback.
 * Absorbs the community numeric-flag fixes (#5936 #5934 #5933 #5931 #5930
 * #5909) behind one rule set.
 */
import { inertText } from '../core/agent-output.ts';
import type { OperationError } from '../core/ops/contract.ts';
import { usageError } from './cli-error.ts';

export interface NumericFlagRule {
  min?: number;
  max?: number;
  /** A valid value for the suggestion. */
  example: number;
}

function requirement(kind: 'integer' | 'number', r: NumericFlagRule): string {
  if (r.min !== undefined && r.max !== undefined) return `${kind === 'integer' ? 'an integer' : 'a number'} from ${r.min} to ${r.max}`;
  if (r.min === 1 && kind === 'integer') return 'a positive integer';
  if (r.min === 0) return `a non-negative ${kind}`;
  return kind === 'integer' ? 'an integer' : 'a finite number';
}

/** The usage error for a bad flag value (also used by commands with their own rules). */
export function flagValueError(flag: string, raw: string | undefined, accepts: string, example: number | string): OperationError {
  const missing = raw === undefined || raw.trim() === '' || raw.startsWith('--');
  return usageError(
    missing ? `${flag} requires a value: ${accepts}.` : `${flag} must be ${accepts}; got '${inertText(raw, 40)}'.`,
    `Pass ${accepts}, e.g. ${flag} ${example}.`,
  );
}

/** Digits only (a leading sign when negatives are allowed), a safe integer, within [min, max]. */
export function intFlagValue(raw: string | undefined, flag: string, rule: NumericFlagRule): number {
  const text = raw?.trim() ?? '';
  const signed = rule.min === undefined || rule.min < 0;
  const n = Number(text);
  if ((signed ? /^[+-]?\d+$/ : /^\+?\d+$/).test(text) && Number.isSafeInteger(n)
    && n >= (rule.min ?? -Infinity) && n <= (rule.max ?? Infinity)) return n;
  throw flagValueError(flag, raw, requirement('integer', rule), rule.example);
}

/** A finite number within [min, max]. */
export function numberFlagValue(raw: string | undefined, flag: string, rule: NumericFlagRule): number {
  const text = raw?.trim() ?? '';
  const n = Number(text);
  if (text !== '' && Number.isFinite(n) && n >= (rule.min ?? -Infinity) && n <= (rule.max ?? Infinity)) return n;
  throw flagValueError(flag, raw, requirement('number', rule), rule.example);
}
