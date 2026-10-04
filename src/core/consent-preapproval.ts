/**
 * A4 user preapprovals: `consent.preapprove.paid.max_usd_per_run` (Tier 1,
 * per run) and `consent.preapprove.persistent_install`. They live only in
 * the host file plane (~/.gbrain/config.json), written by the trusted local
 * CLI (`gbrain config set`); no MCP or HTTP operation writes that file, and a
 * `consent.*` DB-plane row is never read. `destructive` is never
 * preapprovable, and an install preapproval never covers credentials
 * (enforced by consent.ts's matrix).
 *
 * Split from consent.ts so `gbrain config` can import it without the CLI
 * flag-registry scan granting consent flags to `config`.
 */
import { shellQuote } from './agent-output.ts';
import { isConfigTruthy, loadConfigFileOnly, saveConfig } from './config.ts';
import { opError } from './ops/contract.ts';

export const CONSENT_KEY_PREFIX = 'consent.';
export const PREAPPROVE_PAID_MAX_USD_PER_RUN = 'consent.preapprove.paid.max_usd_per_run';
export const PREAPPROVE_PERSISTENT_INSTALL = 'consent.preapprove.persistent_install';
const PREAPPROVAL_KEYS = [PREAPPROVE_PAID_MAX_USD_PER_RUN, PREAPPROVE_PERSISTENT_INSTALL] as const;

export interface ConsentPreapprovals {
  paid?: { max_usd_per_run?: number };
  persistent_install?: boolean;
}

export function isConsentConfigKey(key: string): boolean {
  return key.startsWith(CONSENT_KEY_PREFIX);
}

/** Validated preapprovals from the host file plane. Garbage is ignored (fail-closed: nothing preapproved). */
export function readConsentPreapprovals(cfg: { consent?: unknown } | null = loadConfigFileOnly()): ConsentPreapprovals {
  const pre = (cfg?.consent as { preapprove?: Record<string, unknown> } | undefined)?.preapprove;
  if (!pre || typeof pre !== 'object') return {};
  const max = Number((pre.paid as Record<string, unknown> | undefined)?.max_usd_per_run);
  return {
    ...(Number.isFinite(max) && max > 0 ? { paid: { max_usd_per_run: max } } : {}),
    ...(pre.persistent_install === true ? { persistent_install: true } : {}),
  };
}

export function preapprovalCommand(key: string, value: string): string[] {
  return ['gbrain', 'config', 'set', key, value];
}

/**
 * `gbrain config set consent.*`: writes the host file plane and returns the
 * confirmation line. Remote callers are refused (actor `user`): a preapproval
 * written over MCP would let an agent consent on the user's behalf.
 */
export function setConsentPreapproval(key: string, value: string, ctx: { remote: boolean }): string {
  if (ctx.remote) {
    throw opError('permission_denied', `${key} can only be set from a terminal on the brain host; nothing was written.`,
      'Ask the user to run the command in a terminal on the brain host.',
      { why: 'A preapproval lets gbrain spend or install without asking, so only the user may grant it.',
        fix: { argv: preapprovalCommand(key, value), consent: [], actor: 'user', requires_exclusive: false,
          why: 'Preapprovals are settable only by the trusted local CLI.' } });
  }
  if (!(PREAPPROVAL_KEYS as readonly string[]).includes(key)) {
    throw opError('invalid_params', `Unknown consent key "${key}"; nothing was written.`,
      `Supported keys: ${PREAPPROVAL_KEYS.join(', ')}.`);
  }
  const cfg = (loadConfigFileOnly() ?? { engine: 'pglite' }) as Parameters<typeof saveConfig>[0];
  const consent = (cfg.consent ?? {}) as { preapprove?: ConsentPreapprovals };
  const pre: ConsentPreapprovals = { ...(consent.preapprove ?? {}) };
  if (key === PREAPPROVE_PAID_MAX_USD_PER_RUN) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) {
      throw opError('invalid_params', `${key} must be a positive USD amount (got '${value}'); nothing was written.`,
        `Example: ${shellQuote(preapprovalCommand(key, '2.00'))}`);
    }
    pre.paid = { max_usd_per_run: n };
  } else {
    pre.persistent_install = isConfigTruthy(value);
  }
  cfg.consent = { ...consent, preapprove: pre };
  saveConfig(cfg);
  return `Set ${key} = ${key === PREAPPROVE_PAID_MAX_USD_PER_RUN ? pre.paid!.max_usd_per_run : pre.persistent_install} (file plane: ~/.gbrain/config.json). Remove it with: gbrain config unset ${key}`;
}

/** Remove one preapproval; true when the file held it. */
export function unsetConsentPreapproval(key: string): boolean {
  const cfg = loadConfigFileOnly();
  const pre = (cfg?.consent as { preapprove?: Record<string, unknown> } | undefined)?.preapprove;
  if (!cfg || !pre) return false;
  if (key === PREAPPROVE_PAID_MAX_USD_PER_RUN && pre.paid !== undefined) delete pre.paid;
  else if (key === PREAPPROVE_PERSISTENT_INSTALL && pre.persistent_install !== undefined) delete pre.persistent_install;
  else return false;
  saveConfig(cfg);
  return true;
}
