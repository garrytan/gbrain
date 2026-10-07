/**
 * Registered numeric knobs for dream-cycle phases that a phase reads through
 * `engine.getConfig` at run time. One spec per key carries the accepted
 * range, so `gbrain config set` refuses a value the phase would not apply, and
 * the phase names the key when a stored value is invalid or out of range
 * instead of falling back silently. Neither the refusal nor the warning
 * echoes the stored or rejected value.
 */
import { opError, type OperationError } from '../ops/contract.ts';

export const SYNTHESIZE_CONCEPTS_BUDGET_KEY = 'cycle.synthesize_concepts.budget_usd';
export const SYNTHESIZE_CONCEPTS_DEFAULT_BUDGET_USD = 1.5;

export const PROPOSE_TAKES_CALL_TIMEOUT_KEY = 'dream.propose_takes.call_timeout_ms';
export const PROPOSE_TAKES_CALL_TIMEOUT_MIN_MS = 1_000;
/** The gateway's default chat timeout; the gateway still races its own (shorter wins). */
export const PROPOSE_TAKES_CALL_TIMEOUT_MAX_MS = 300_000;

interface PhaseConfigSpec {
  /** Human range, used in the refusal and the stored-value warnings. */
  expected: string;
  /** What applies when the key is unset or its stored value is invalid. */
  defaultText: string;
  /** The value `config set` accepts, or null. */
  parse(raw: string): number | null;
  /** A stored value the phase holds to the range instead of ignoring; null = invalid. */
  clamp?(raw: string): number | null;
}

const finitePositive = (raw: string): number | null => {
  const text = raw.trim();
  const n = Number(text);
  return text !== '' && Number.isFinite(n) && n > 0 ? n : null;
};

const SPECS: Record<string, PhaseConfigSpec> = {
  [SYNTHESIZE_CONCEPTS_BUDGET_KEY]: {
    expected: 'a finite number of US dollars above 0',
    defaultText: String(SYNTHESIZE_CONCEPTS_DEFAULT_BUDGET_USD),
    parse: finitePositive,
  },
  [PROPOSE_TAKES_CALL_TIMEOUT_KEY]: {
    expected: `a whole number of milliseconds from ${PROPOSE_TAKES_CALL_TIMEOUT_MIN_MS} to ${PROPOSE_TAKES_CALL_TIMEOUT_MAX_MS}`,
    defaultText: 'scaled with the output cap, 90000 to 300000 ms',
    parse(raw) {
      if (!/^\d+$/.test(raw.trim())) return null;
      const n = Number(raw.trim());
      return n >= PROPOSE_TAKES_CALL_TIMEOUT_MIN_MS && n <= PROPOSE_TAKES_CALL_TIMEOUT_MAX_MS ? n : null;
    },
    clamp(raw) {
      const n = finitePositive(raw);
      if (n === null) return null;
      return Math.min(PROPOSE_TAKES_CALL_TIMEOUT_MAX_MS, Math.max(PROPOSE_TAKES_CALL_TIMEOUT_MIN_MS, Math.floor(n)));
    },
  },
};

export const PHASE_CONFIG_KEYS: readonly string[] = Object.keys(SPECS);

function specFor(key: string): PhaseConfigSpec {
  const spec = SPECS[key];
  if (!spec) throw new Error(`not a phase config key: ${key}`);
  return spec;
}

/** `config set` validation: the parsed value, or an `invalid_params` refusal naming the key and range. */
export function parsePhaseConfigValue(key: string, value: string): number {
  const spec = specFor(key);
  const parsed = spec.parse(value);
  if (parsed !== null) return parsed;
  throw invalidPhaseConfig(key, spec);
}

function invalidPhaseConfig(key: string, spec: PhaseConfigSpec): OperationError {
  return opError('invalid_params', `Invalid ${key}: expected ${spec.expected}.`,
    `Set ${key} to ${spec.expected} (default: ${spec.defaultText}), or unset it to use the default.`,
    {
      why: `The phase reads ${key} on every run and would not apply this value. Nothing was written.`,
      fix: {
        argv: ['gbrain', 'config', 'set', key, '<VALUE>'],
        inputs: [{ name: 'VALUE', how: `${spec.expected[0]!.toUpperCase()}${spec.expected.slice(1)}; ask the user when the intended value is unclear.` }],
        consent: [], actor: 'agent', requires_exclusive: false,
        why: `A value in range is applied on the next run; unset the key to use the default (${spec.defaultText}).`,
        verify: { argv: ['gbrain', 'config', 'get', key] },
      },
    });
}

function storedValueWarning(key: string, spec: PhaseConfigSpec, using: string): string {
  return `${key} is set to an invalid value (expected ${spec.expected}); using ${using}. ` +
    `Fix: gbrain config set ${key} <value>, or gbrain config unset ${key}. Verify: gbrain config get ${key}`;
}

/**
 * Read one phase knob. Unset or unreadable keeps the default with no warning
 * (a config lookup never stops a maintenance phase). An accepted value is used
 * as-is; a value the spec clamps is held to the range with a warning; anything
 * else keeps the default with a warning. `value` is undefined for the default.
 */
export async function readPhaseConfigNumber(
  engine: { getConfig?(key: string): Promise<string | null> },
  key: string,
): Promise<{ value?: number; warning?: string }> {
  const spec = specFor(key);
  let raw: string | null | undefined;
  try {
    raw = await engine.getConfig?.(key);
  } catch {
    return {};
  }
  if (raw === null || raw === undefined || String(raw).trim() === '') return {};
  const text = String(raw);
  const parsed = spec.parse(text);
  if (parsed !== null) return { value: parsed };
  const clamped = spec.clamp?.(text) ?? null;
  if (clamped !== null) return { value: clamped, warning: storedValueWarning(key, spec, String(clamped)) };
  return { warning: storedValueWarning(key, spec, `the default (${spec.defaultText})`) };
}
