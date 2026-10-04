/**
 * CLI glue for the consent primitive (agent operator contract v1, Lane C).
 *
 * `consentGate()` is how a CLI command handler asks for consent: it runs
 * `requireConsent()` and, on a `confirmation_required` refusal, writes the
 * refusal (the consent payload under `--json`, the `[AGENT]` block plus the
 * one-line error otherwise), sets the exit verdict to 3 and resolves `null`.
 * The handler returns without doing any work, so teardown (engine
 * disconnect, lock release) still runs through the one exit seam. Any other
 * error (e.g. `preview_changed`) propagates.
 *
 * Handlers that already call `process.exit` everywhere use
 * `consentGateOrExit()`, which exits 3 on refusal instead.
 */
import { setCliExitVerdict } from './cli-force-exit.ts';
import { isConsentRefusal, printConsentRefusal, requireConsent, type Authorization, type ConsentEnv, type ConsentRequest } from './consent.ts';
import type { BrainEngine } from './engine.ts';

export interface ConsentGateOpts {
  /** `--json` was requested: the refusal is the payload document on stdout. `--json` never implies consent. */
  json: boolean;
  env?: ConsentEnv;
}

export async function consentGate(req: ConsentRequest, opts: ConsentGateOpts): Promise<Authorization | null> {
  try {
    return await requireConsent(req, opts.env ?? {});
  } catch (e) {
    if (!isConsentRefusal(e)) throw e;
    setCliExitVerdict(printConsentRefusal(e, { json: opts.json }));
    return null;
  }
}

export async function consentGateOrExit(req: ConsentRequest, opts: ConsentGateOpts): Promise<Authorization> {
  try {
    return await requireConsent(req, opts.env ?? {});
  } catch (e) {
    if (!isConsentRefusal(e)) throw e;
    process.exit(printConsentRefusal(e, { json: opts.json }));
  }
}

/** The DB-plane `spend.posture` read requireConsent needs to honour `tokenmax`. */
export function engineConsentEnv(engine: Pick<BrainEngine, 'getConfig'> | null | undefined, extra: ConsentEnv = {}): ConsentEnv {
  return engine ? { getConfig: (key: string) => engine.getConfig(key), ...extra } : extra;
}


/**
 * `spend.posture=tokenmax` on a command that ran uncapped under it before
 * the consent wave (enrich, reindex-code): the posture keeps its documented
 * meaning there (the user removed the ceiling; spend stays ledgered, see
 * docs/operations/spend-controls.md), so an unattended run does not flip to a
 * derived-cap stop. Returns the ConsentEnv overlay that records the
 * ceiling as Infinity (a user-configured posture, so no derived-cap note);
 * callers treat a non-finite `cap_usd` as "no ceiling". Everywhere else
 * tokenmax authorizes under requireConsent's derived cap.
 */
export async function tokenmaxUncappedEnv(engine: Pick<BrainEngine, 'getConfig'>, explicitCap: boolean): Promise<ConsentEnv> {
  if (explicitCap) return {};
  const { resolveSpendPosture } = await import('./spend-posture.ts');
  return (await resolveSpendPosture(engine as BrainEngine)) === 'tokenmax' ? { configuredCapUsd: Infinity } : {};
}
