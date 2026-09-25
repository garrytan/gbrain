/**
 * #5304: which resolution step produced the current chat / expansion model.
 *
 * A provider 404 (model_not_found) names the model id but not the config
 * key that selected it — even though `resolveModelDetailed` computed that
 * provenance moments earlier and dropped it. The gateway stamps
 * `_modelProvenance` during `reconfigureGatewayWithEngine` (the only place
 * the full precedence chain runs), and chat/expand failures call
 * `enrichModelNotFoundError` to append "Selected via <key>. Fix: gbrain
 * config set <key> <provider>:<model>" — or the discovery command when the
 * call carried an explicit per-call model we did not resolve.
 *
 * `key` is the editable config key (or a descriptive `env:` / `cli flag`
 * label); null when the tier default won — in which case the right fix is
 * pinning `models.tier.<tier>`.
 */
import { AIConfigError, type AIServiceError } from './errors.ts';
import { describeModelSource, type ModelTier, type ResolveSource, type EffectiveModelSource } from '../model-config.ts';

export const _modelProvenance: {
  chat?: { key: string | null; source: string };
  expansion?: { key: string | null; source: string };
} = {};

/**
 * Stamp provenance for one surface after reconfigure. `effSource` is the
 * file-plane effective resolver's source when it ran (tier_default/fallback
 * DB outcome); otherwise the DB-plane `resolveModelDetailed` source maps via
 * `describeModelSource` with the caller's configKey/tier context.
 */
export function stampModelProvenance(
  surface: 'chat' | 'expansion',
  eff: { source: EffectiveModelSource } | null,
  detailed: { source: ResolveSource },
  opts: { configKey: string; tier: ModelTier },
): void {
  _modelProvenance[surface] = eff
    ? { key: describeModelSource(eff.source, { tier: opts.tier }), source: eff.source }
    : { key: describeModelSource(detailed.source, { configKey: opts.configKey, tier: opts.tier }), source: detailed.source };
}

/** Test seam: inspect the provenance recorded by the last reconfigure. */
export function __getModelProvenanceForTests() {
  return _modelProvenance;
}

export function enrichModelNotFoundError(
  err: AIServiceError,
  surface: 'chat' | 'expansion' | null,
): AIServiceError {
  const status = err.apiErrorStatus ?? err.status;
  if (!(err instanceof AIConfigError) || status !== 404) return err;
  if (err.fix?.includes('Selected via') || err.fix?.includes('Find which key')) return err;
  const tier: ModelTier = surface === 'expansion' ? 'utility' : 'reasoning';
  const p = surface ? _modelProvenance[surface] : undefined;
  let suffix: string;
  if (p?.key && !p.key.includes(' ') && !p.key.startsWith('env:')) {
    suffix = `Selected via ${p.key}. Fix: gbrain config set ${p.key} <provider>:<model> (or clear the key to fall back to the tier default).`;
  } else if (p?.key?.startsWith('env:')) {
    suffix = `Selected via ${p.key} — update or unset that variable, or pin models.tier.${tier} via gbrain config set.`;
  } else if (p?.key) {
    suffix = `Selected via ${p.key}. Fix: gbrain config set models.tier.${tier} <provider>:<model> to pin a replacement.`;
  } else if (p) {
    suffix = `Selected via ${p.source} (tier default in effect). Fix: gbrain config set models.tier.${tier} <provider>:<model> to pin a replacement.`;
  } else {
    suffix = `Find which key selected this model: gbrain config get models.tier.${tier} / gbrain doctor.`;
  }
  const enriched = new AIConfigError(
    err.message,
    `${err.fix ?? ''} ${suffix}`.trim(),
    err.cause,
  );
  enriched.apiErrorStatus = err.apiErrorStatus;
  enriched.status = err.status;
  return enriched;
}
