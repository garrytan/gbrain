/**
 * The one USD cost-cap flag parser (D19). Every command that takes a cap
 * flag (`--max-usd` canonical; legacy `--max-cost`, `--max-cost-usd`,
 * `--no-max-cost`) parses it here, so the spellings, the off words and the
 * error text cannot drift between commands.
 *
 * Values: a positive USD amount, or `off` / `unlimited` / `none` to run
 * uncapped (spend is still ledgered; runtime, call and token bounds stay).
 * A bare `0` is ambiguous (free? uncapped?) and is refused unless the
 * command declares what it means: skillopt's legacy `--max-cost-usd 0`
 * means uncapped, and `eval longmemeval --max-usd 0` is a $0 judge cap.
 * Two cap flags that disagree are refused instead of one silently winning.
 * All of this happens while parsing argv, before any paid call.
 */

export const CAP_OFF_WORDS: readonly string[] = ['off', 'unlimited', 'none'];

/** A parsed cap flag: `usd` is the cap, or null for off. `flag` is the spelling the user typed. */
export interface CapFlag {
  flag: string;
  usd: number | null;
}

export class CapFlagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapFlagError';
  }
}

export interface ParseCapOpts {
  /** What a bare 0 means for this flag. Default `reject`. */
  zero?: 'reject' | 'off' | 'cap';
}

/** Parse one cap flag value. Throws CapFlagError with a message naming the flag and the fix. */
export function parseCapFlag(flag: string, raw: string | undefined, opts: ParseCapOpts = {}): CapFlag {
  const zero = opts.zero ?? 'reject';
  const amount = zero === 'reject' ? 'a positive USD amount' : 'a non-negative USD amount';
  const value = raw?.trim() ?? '';
  if (value === '' || value.startsWith('--')) {
    throw new CapFlagError(`${flag} needs ${amount} or "off" (got nothing).`);
  }
  if (CAP_OFF_WORDS.includes(value.toLowerCase())) return { flag, usd: null };
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new CapFlagError(`${flag} must be ${amount} or "off" (got "${value}").`);
  }
  if (n === 0) {
    if (zero === 'off') return { flag, usd: null };
    if (zero === 'reject') {
      throw new CapFlagError(`${flag} 0 is ambiguous: pass ${flag} off to run uncapped, or a positive USD amount to cap the run.`);
    }
  }
  return { flag, usd: n };
}

function show(cap: CapFlag): string {
  return cap.usd === null ? `${cap.flag} off` : `${cap.flag} ${cap.usd}`;
}

/** Combine a newly parsed cap flag with an earlier one; the same value twice is fine, two different values are refused. */
export function mergeCapFlag(prev: CapFlag | undefined, next: CapFlag): CapFlag {
  if (prev && prev.usd !== next.usd) {
    throw new CapFlagError(`${show(prev)} conflicts with ${show(next)}; pass one cost cap.`);
  }
  return prev ?? next;
}

/**
 * The one-line cap notice a run prints once: the cap, where it came from and
 * how to change or remove it. `usd` null means the user turned the cap off.
 */
export function capNotice(cap: { usd: number | null; source: 'user' | 'default'; flag?: string }): string {
  if (cap.usd === null) {
    return `cap: off (${cap.flag ?? '--max-usd'} off; spend is still ledgered, runtime bounds still apply)`;
  }
  const amount = `$${cap.usd.toFixed(2)}`;
  return cap.source === 'default'
    ? `cap: ${amount} (default; change it with --max-usd <usd>, remove it with --max-usd off)`
    : `cap: ${amount} (${cap.flag ?? '--max-usd'}; remove it with --max-usd off)`;
}
