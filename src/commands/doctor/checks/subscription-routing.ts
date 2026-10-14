/**
 * `subscription_routing` doctor check: when a brain has opted into a
 * single-provider route (`models.route`, written by `gbrain models route
 * <preset> --apply`), name every model surface that would leave that provider
 * — a tier, per-task key, nightly-probe slot, reranker or fallback-chain entry
 * resolving to another provider — and say what happens there: it bills that
 * provider when its key is present here, or fails for lack of one. Embeddings
 * get a separate line because `claude-cli` has no embedding model: the check
 * reports the configured embedding provider and whether it is local, keyed,
 * missing its key or unset, and points at the keyless options.
 *
 * No route set: an informational `ok` (nothing to compare against). Surfaces
 * are judged from this process's environment, like `gbrain models`. Config
 * reads only: no network, subprocess or inference call.
 */
import type { Check } from '../../doctor.ts';
import type { Action } from '../../../core/agent-output.ts';
import { checkError, doctorVerify, infoCheck } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import type { BrainEngine } from '../../../core/engine.ts';
import { ROUTE_MARKER_KEY, ROUTE_PRESETS, routeSurfaces, type RoutePresetId, type RouteSurface } from '../../models-route.ts';

const NAME = 'subscription_routing';
const DOCS = 'docs/guides/claude-subscription.md';

function describe(s: RouteSurface): string {
  const where = s.standing === 'fails_no_key' ? `fails: no ${s.missing_key}` : `bills ${s.provider}`;
  return `${s.surface} → ${s.model} [${s.source}] (${where})`;
}

function reapplyFix(preset: RoutePresetId, leaving: RouteSurface[]): Action {
  const keyed = leaving.filter(s => s.standing === 'bills_other_provider');
  return {
    argv: ['gbrain', 'models', 'route', preset, '--apply'], consent: ['paid'], actor: 'agent', requires_exclusive: false,
    verify: doctorVerify(NAME), docs: DOCS,
    why: `Re-applies the ${preset} preset to the keys it owns. ${keyed.length ? `${keyed.length} surface(s) would bill another provider while a key is present; ` : ''}surfaces the preset does not own (a per-task key, a probe slot, the reranker, a fallback entry) need their own \`gbrain config set\` or \`unset\`.`,
    user_message: `Some model surfaces leave the ${preset} route: ${leaving.map(s => s.surface).join(', ')}. Re-apply the preset, or set those keys yourself.`,
  };
}

export async function checkSubscriptionRouting(engine: BrainEngine, opts: { remote?: boolean } = {}): Promise<Check> {
  try {
    const marker = (await engine.getConfig(ROUTE_MARKER_KEY))?.trim() || null;
    const preset = marker ? ROUTE_PRESETS.get(marker as RoutePresetId) : undefined;
    if (!marker) {
      return infoCheck('subscription_routing', `No route preset is set (${ROUTE_MARKER_KEY}); every surface uses the models \`gbrain models\` shows. \`gbrain models route claude-cli\` previews a subscription-only route.`, 'not_applicable');
    }
    if (!preset) {
      return { name: 'subscription_routing', status: 'warn', message: `${ROUTE_MARKER_KEY} is "${marker}", which is not a known preset (known: ${[...ROUTE_PRESETS.keys()].join(', ')}). Unset it or apply a known preset.`,
        fix: { argv: ['gbrain', 'config', 'unset', ROUTE_MARKER_KEY], consent: [], actor: 'agent', requires_exclusive: false, verify: doctorVerify(NAME), docs: DOCS, why: 'Clears the unknown marker; routing itself is unchanged.' } };
    }
    const scan = await routeSurfaces(engine, preset.provider);
    const leaving = scan.leaving;
    const e = scan.embedding;
    const embeddingLine = e.disabled
      ? 'Embeddings are off (embedding_disabled): reads run keyword-only.'
      : e.standing === 'unset' ? `No embedding_model is set; ${preset.provider} has no embedding model, so pick a local one (ollama, llama-server) or a keyed one, or turn embeddings off.`
      : e.standing === 'local' ? `Embeddings stay off the subscription on ${e.model} (local, no key).`
      : e.standing === 'keyed' ? `Embeddings bill ${e.provider} (${e.model}); ${preset.provider} has no embedding model.`
      : `Embeddings are set to ${e.model} but ${e.missing_key} is absent here, so embedding fails; ${preset.provider} has no embedding model.`;

    if (opts.remote) {
      return { name: 'subscription_routing', status: leaving.length ? 'warn' : 'ok',
        message: `A ${preset.id} route preset is set on the brain host${leaving.length ? ` and ${leaving.length} model surface(s) leave it` : ''}. The host operator runs gbrain doctor --only ${NAME} there for the list.` };
    }
    const details = { preset: preset.id, provider: preset.provider, surfaces: scan.surfaces, leaving, embedding: e, nightly_probe: scan.nightly_probe };
    if (leaving.length === 0) {
      return { name: 'subscription_routing', status: 'ok', details,
        message: `Every chat surface stays on ${preset.provider} (${scan.surfaces.length} checked: tiers, per-task routes, reranker, fallback chain${scan.nightly_probe === 'on' ? ', nightly probe' : '; the nightly probe is off'}). ${embeddingLine}` };
    }
    return { name: 'subscription_routing', status: 'warn', details, fix: reapplyFix(preset.id, leaving),
      message: `${leaving.length} model surface(s) leave the ${preset.id} route: ${leaving.map(describe).join('; ')}. ${embeddingLine}` };
  } catch (err) {
    return checkError('subscription_routing', 'read the route preset', err);
  }
}

async function runSubscriptionRouting(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  checks.push(await checkSubscriptionRouting(connectedEngine(ctx)));
  return checks;
}

export const subscriptionRoutingEntry: DoctorEntry = {
  name: 'subscription_routing',
  emits: ['subscription_routing'],
  run: runSubscriptionRouting,
};
