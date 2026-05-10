/**
 * Lightweight probes for local AI providers. Used by the providers wizard
 * to auto-detect ready endpoints before prompting the user.
 */

export interface ProbeResult {
  reachable: boolean;
  models_endpoint_valid?: boolean;
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
    clearTimeout(timer);
    if (!res.ok) return { reachable: true, models_endpoint_valid: false, error: `HTTP ${res.status}` };
    const body = await res.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return { reachable: true, models_endpoint_valid: false, error: 'non-JSON response' };
    }
    const isList = (body as any).object === 'list' && Array.isArray((body as any).data);
    return { reachable: true, models_endpoint_valid: isList };
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
