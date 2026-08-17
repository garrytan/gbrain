/**
 * serve-health.ts — serve /health probe + scopes version-skew floor, peeled
 * from harness.ts (cathedral-6: the agent-register lane needs these without
 * dragging the whole harness in). harness.ts re-exports this entire surface
 * (peeled-façade rule: import sites never chase the peel). fetchFn stays an
 * explicit argument — no ambient fetch, no engine, no config.
 */

export interface ServeHealth {
  ok: boolean;
  engine?: string;
  version?: string;
  detail?: string;
}

export async function probeServeHealth(
  mcpUrl: string,
  fetchFn: typeof fetch,
  timeoutMs = 3000,
): Promise<ServeHealth> {
  const base = mcpUrl.replace(/\/mcp$/, '');
  try {
    const res = await fetchFn(`${base}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, detail: `GET ${base}/health → ${res.status}` };
    const body = (await res.json()) as { status?: string; version?: string; engine?: string };
    if (body.status !== 'ok') return { ok: false, detail: `health status: ${body.status ?? 'unknown'}` };
    return { ok: true, version: body.version, engine: body.engine };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

/** The scopes-honoring release: any serve older verifies scoped tokens as full access. */
/** The first release whose verify path honors the scopes column. PINNED — a
 * comparison against the moving CLI VERSION would false-flag every scope-aware
 * serve as soon as the next release ships (ship-review P3). */
export const SCOPES_MIN_SERVE_VERSION = '0.45.14.0';

export function isServeOlderThanScopes(serveVersion: string): boolean {
  const parse = (v: string): number[] => v.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const a = parse(serveVersion);
  const b = parse(SCOPES_MIN_SERVE_VERSION);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}
