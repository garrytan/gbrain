/**
 * Lightweight probes for local AI providers. Used by the providers wizard
 * to auto-detect ready endpoints before prompting the user.
 */

export interface ProbeResult {
  reachable: boolean;
  models_endpoint_valid?: boolean;
  /** Model ids the endpoint reports as served/pulled (when the models
   *  endpoint is valid). Lets callers check "is the recipe's model actually
   *  available" instead of treating daemon-up as model-ready. */
  models?: string[];
  error?: string;
}

/**
 * Probe an OpenAI-compatible /v1/models endpoint. Per Codex C-secondary-4:
 * port-open is insufficient — a broken daemon can accept connections but
 * serve garbage. We validate the response is JSON with the expected shape.
 */
export async function probeOpenAICompat(baseUrl: string, timeoutMs: number = 1000): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(new URL('/v1/models', baseUrl).toString(), {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) {
      clearTimeout(timer);
      return { reachable: true, models_endpoint_valid: false, error: `HTTP ${res.status}` };
    }
    // Keep the abort timer live through the BODY read — a daemon that accepts,
    // returns headers, then stalls the body would otherwise hang past the
    // advertised timeout (the probe sits on init's interactive critical path).
    const body = await res.json().catch(() => null);
    clearTimeout(timer);
    if (!body || typeof body !== 'object') {
      return { reachable: true, models_endpoint_valid: false, error: 'non-JSON response' };
    }
    const isList = (body as any).object === 'list' && Array.isArray((body as any).data);
    const models = isList
      ? ((body as any).data as Array<{ id?: unknown }>)
          .map((m) => (typeof m?.id === 'string' ? m.id : ''))
          .filter(Boolean)
      : undefined;
    return { reachable: true, models_endpoint_valid: isList, models };
  } catch (e) {
    clearTimeout(timer);
    return { reachable: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function probeOllama(): Promise<ProbeResult> {
  const url = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1';
  return probeOpenAICompat(url);
}

export async function probeLMStudio(): Promise<ProbeResult> {
  const url = process.env.LMSTUDIO_BASE_URL ?? 'http://localhost:1234/v1';
  return probeOpenAICompat(url);
}

/**
 * Probe llama.cpp's `llama-server --embeddings` endpoint. Defaults to port
 * 8080 (llama-server's default; distinct from Ollama's 11434 and LM Studio's
 * 1234). Override via `LLAMA_SERVER_BASE_URL` env, or pass `baseURL` directly
 * (callers with access to `cfg.base_urls['llama-server']` should pass it so
 * probe agrees with what the gateway will actually call).
 */
export async function probeLlamaServer(baseURL?: string): Promise<ProbeResult> {
  const url = baseURL ?? process.env.LLAMA_SERVER_BASE_URL ?? 'http://localhost:8080/v1';
  return probeOpenAICompat(url);
}
