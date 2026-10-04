/**
 * `gbrain doctor --probe`: the only way doctor calls a model provider. Plain
 * doctor (and `--only`, `--remediation-plan`, MCP `run_doctor`) reports the
 * embedding provider as configured but not probed. The probe goes through the
 * consent matrix (`paid` + `egress`); an unauthorized non-TTY run exits 3
 * before any check. A local provider that bills nothing (ollama,
 * llama-server, lmstudio) needs no consent.
 */
import type { BrainEngine } from '../../core/engine.ts';
import { setCliExitVerdict } from '../../core/cli-force-exit.ts';

/** A one-request provider probe: a fraction of a cent, rounded up so a per-run preapproval compares sanely. */
const PROVIDER_PROBE_EST_USD = 0.0001;

/** False when consent refused (the exit-3 payload is already printed). */
export async function authorizeProviderProbe(engine: BrainEngine | null, args: string[], json: boolean): Promise<boolean> {
  const { embeddingProviderIsFree } = await import('../../core/embed-consent.ts');
  if (await embeddingProviderIsFree()) return true;
  const { requireConsent, isConsentRefusal, printConsentRefusal } = await import('../../core/consent.ts');
  const end = args.indexOf('--');
  const argv = ['gbrain', 'doctor', ...(end >= 0 ? args.slice(0, end) : args).filter(a => a !== '--yes')];
  try {
    await requireConsent({
      command: 'doctor',
      effects: ['paid', 'egress'],
      actor: 'agent',
      what: 'Probing the embedding provider',
      why: 'The probe sends one short fixed test string (no brain content) to the configured embedding provider to confirm the key, model and dimensions work.',
      risk: 'One provider request; it costs a fraction of a cent and sends no brain content.',
      user_message: 'To confirm your embedding provider works, gbrain can send it one tiny test request (well under a cent). OK to run it?',
      argv,
      est_usd: PROVIDER_PROBE_EST_USD,
      args,
    }, { getConfig: engine ? (key) => engine.getConfig(key) : undefined });
    return true;
  } catch (e) {
    if (!isConsentRefusal(e)) throw e;
    setCliExitVerdict(printConsentRefusal(e, { json }));
    return false;
  }
}
