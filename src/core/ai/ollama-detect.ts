/**
 * Cheap, non-blocking Ollama availability probe for the default embedding
 * model (`ollama:bge-m3`).
 *
 * Called exactly ONCE per `gbrain init` (the resolved choice persists into
 * config.json, so embed calls never probe) and on demand by
 * `gbrain doctor`'s fallback re-check. Bounded by a short timeout and
 * fail-open: any error means "not available", never a thrown exception —
 * a probe bug must not break an install.
 *
 * Leaf module (no SDK imports) so init/doctor can load it without pulling
 * the full gateway.
 */

export interface OllamaProbeResult {
  /** Server reachable AND the model is pulled. */
  ok: boolean;
  /** Server responded to /api/tags at all. */
  serverUp: boolean;
  reason: 'ok' | 'model_missing' | 'unreachable';
}

/**
 * Ollama's native API base (NOT the /v1 OpenAI-compat suffix the recipe's
 * base_url_default carries). Honors OLLAMA_BASE_URL — the same env var the
 * gateway's openai-compat transport uses — with any trailing `/v1` stripped
 * so both spellings work.
 */
export function ollamaApiBase(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.OLLAMA_BASE_URL?.trim() || 'http://localhost:11434';
  return raw.replace(/\/+$/, '').replace(/\/v1$/, '');
}

/**
 * Probe `{base}/api/tags` and check the given model is pulled. Matches
 * bare names against Ollama's `name:tag` form (`bge-m3` matches
 * `bge-m3:latest` and `bge-m3:567m`).
 */
/** Test seam (same pattern as gateway's __setEmbedTransportForTests). */
let probeOverride: ((model: string) => Promise<OllamaProbeResult>) | null = null;
export function __setOllamaProbeForTests(fn: typeof probeOverride): void {
  probeOverride = fn;
}

export async function probeOllamaModel(
  model: string,
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<OllamaProbeResult> {
  if (probeOverride) return probeOverride(model);
  const base = ollamaApiBase(opts.env ?? process.env);
  try {
    const res = await fetch(`${base}/api/tags`, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? 1500),
    });
    if (!res.ok) return { ok: false, serverUp: false, reason: 'unreachable' };
    const body = (await res.json()) as { models?: Array<{ name?: string }> };
    const names = (body.models ?? []).map(m => m.name ?? '');
    const has = names.some(n => n === model || n.split(':')[0] === model);
    return has
      ? { ok: true, serverUp: true, reason: 'ok' }
      : { ok: false, serverUp: true, reason: 'model_missing' };
  } catch {
    return { ok: false, serverUp: false, reason: 'unreachable' };
  }
}
