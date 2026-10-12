/**
 * #5304: the sentence a provider 404 (`model_not_found`) gets after the model
 * id: which config key selected the failing model and the one command that
 * changes it. The gateway records each touchpoint's resolution provenance in
 * `gateway-model-sources.ts`; this module renders it so `normalizeAIError`
 * can append it to the 404 fix. Nothing here is consulted for other errors.
 */
import { getGatewayModelSource, type GatewayModelSource } from './gateway-model-sources.ts';

type Touchpoint = 'expansion' | 'chat';

const TIER_KEY: Record<Touchpoint, string> = { expansion: 'models.tier.utility', chat: 'models.tier.reasoning' };
const CONFIG_KEY: Record<Touchpoint, string> = { expansion: 'models.expansion', chat: 'models.chat' };

/** The route sentence for a recorded provenance; `touchpoint` names the tier key a built-in default should be replaced through. */
export function modelRouteHint(route: GatewayModelSource, touchpoint: Touchpoint): string {
  const { source, origin } = route;
  switch (source) {
    case 'config_key':
    case 'models_default':
    case 'tier_config':
      return `Selected via ${origin}. Fix: gbrain config set ${origin} <provider>:<model>`;
    case 'deprecated_key':
      return `Selected via ${origin} (deprecated key). Fix: gbrain config unset ${origin}, then gbrain config set ${CONFIG_KEY[touchpoint]} <provider>:<model>`;
    case 'cli_flag':
      return `Selected via ${origin}. Fix: pass a model the provider serves.`;
    case 'env':
      return `Selected via the ${origin} environment variable. Fix: unset ${origin} or point it at a model the provider serves.`;
    case 'file_config': {
      const key = origin.split(' ')[0];
      return `Selected via ${key} in ~/.gbrain/config.json. Fix: remove ${key} there or set it to a model the provider serves.`;
    }
    case 'tier_default':
    case 'fallback':
      return `Selected via the built-in default. Fix: gbrain config set ${TIER_KEY[touchpoint]} <provider>:<model>`;
  }
}

/** The route sentence for the gateway's own `expansion` / `chat` model, or '' when its provenance is unrecorded or stale. */
export function gatewayModelNotFoundHint(touchpoint: Touchpoint, model: string): string {
  const route = getGatewayModelSource(touchpoint, model);
  return route ? modelRouteHint(route, touchpoint) : '';
}

/** The embedding model is always `embedding_model`, a schema-sizing key: changing it re-embeds the brain, so the fix routes through doctor. */
export function embeddingModelNotFoundHint(): string {
  return 'Selected via embedding_model. Changing it changes the vector column, so check `gbrain doctor --only embedding_health` and `gbrain config get embedding_model` before setting another model.';
}
